import { spawn, type ChildProcess } from 'node:child_process';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest, type RequestOptions as HttpsRequestOptions } from 'node:https';
import { createServer, isIP, type Server, type Socket } from 'node:net';
import { writeSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const MAX_DOCUMENT_BYTES = 1_048_576;

export type EgressAttempt = { host: string; port: number; decision: 'deny' };
export type IsolatedDocument = { status: number; headers: Record<string, string>; body: Buffer };
export type DialRecord = { id: number; pid: number; address: string; port: number };

const HEADER_LIMIT = 8192;
const COMMAND_LIMIT = 16_384;
const RESULT_LIMIT = 2_500_000;
const DENIAL = 'HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n';
const BAD_REQUEST = 'HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n';
const HOP_BY_HOP = new Set(['transfer-encoding', 'connection', 'keep-alive', 'content-length']);
const FETCH_FIELDS = new Set(['op', 'id', 'address', 'family', 'port', 'https', 'servername', 'hostHeader', 'path', 'timeoutMs', 'transport']);

// Chromium must dial this process. Loopback is not an implicit bypass. QUIC, HTTP/3,
// DNS prefetch and WebRTC's non-proxied UDP are disabled, and Chromium cannot resolve
// hostnames itself. Hostile resolver rules and QUIC overrides in the base arguments are
// removed. The deny listener never opens an outbound socket. Document bytes are dialed
// only by the fetch command below, and only to an IP literal supplied by the parent.
export function isolatedChromiumArgs(port: number): string[] {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Egress proxy port is invalid.');
  return [
    `--proxy-server=http://127.0.0.1:${port}`,
    '--proxy-bypass-list=<-loopback>',
    '--disable-quic',
    '--disable-http3',
    '--dns-prefetch-disable',
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1',
  ];
}

const OWNED_SWITCH = /^(?:--(?:proxy-server|proxy-bypass-list|host-resolver-rules|origin-to-force-quic-on|force-webrtc-ip-handling-policy|webrtc-ip-handling-policy)=|--(?:enable-quic|disable-quic|enable-http3|disable-http3|dns-prefetch-disable|no-proxy-server)$)/;

// Isolation switches are appended last and replace conflicting base switches.
export function mandatoryChromiumArgs(port: number, base: readonly string[] = []): string[] {
  return [...base.filter(arg => !OWNED_SWITCH.test(arg)), ...isolatedChromiumArgs(port)];
}

function destination(method: string, target: string): { host: string; port: number } | undefined {
  if (method === 'CONNECT') {
    const v6 = /^\[([^\]]+)\]:(\d+)$/.exec(target);
    if (v6) return { host: v6[1], port: Number(v6[2]) };
    const hostPort = /^([^:]+):(\d+)$/.exec(target);
    if (!hostPort) return undefined;
    return { host: hostPort[1], port: Number(hostPort[2]) };
  }
  let url: URL;
  try { url = new URL(target); } catch { return undefined; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  return { host: url.hostname, port };
}

export function startDenyEgressProxy(options: { onAttempt?: (attempt: EgressAttempt) => void } = {}) {
  const attempts: EgressAttempt[] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    let handled = false;
    const finish = (status: string, attempt?: EgressAttempt) => {
      if (handled) return;
      handled = true;
      if (attempt) {
        attempts.push(attempt);
        options.onAttempt?.(attempt);
      }
      socket.end(status);
    };
    socket.on('data', chunk => {
      if (handled) return;
      buffer = Buffer.concat([buffer, chunk]);
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) {
        if (buffer.length > HEADER_LIMIT) finish(BAD_REQUEST);
        return;
      }
      const [requestLine] = buffer.subarray(0, headerEnd).toString('latin1').split('\r\n');
      const match = /^(CONNECT|GET|POST|PUT|DELETE|HEAD|OPTIONS|PATCH)\s+(\S+)\s+HTTP\/1\.[01]$/i.exec(requestLine ?? '');
      if (!match) { finish(BAD_REQUEST); return; }
      const target = destination(match[1].toUpperCase(), match[2]);
      if (!target || target.port < 1 || target.port > 65535) { finish(BAD_REQUEST); return; }
      finish(DENIAL, { host: target.host, port: target.port, decision: 'deny' });
    });
  });

  return new Promise<{ address: string; port: number; attempts: EgressAttempt[]; close: () => Promise<void> }>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const bound = server.address();
      if (!bound || typeof bound === 'string') {
        reject(new Error('Egress proxy failed to bind.'));
        return;
      }
      resolve({
        address: bound.address,
        port: bound.port,
        attempts,
        close: () => new Promise((done, fail) => {
          for (const socket of sockets) socket.destroy();
          server.close(error => error ? fail(error) : done());
        }),
      });
    });
  });
}

type FetchCommand = {
  id: number;
  address: string;
  family: 4 | 6;
  port: number;
  https: boolean;
  servername: string;
  hostHeader: string;
  path: string;
  timeoutMs: number;
};

function headerMap(response: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(response.headers)) {
    if (HOP_BY_HOP.has(key)) continue;
    if (typeof value === 'string') headers[key] = value;
    else if (Array.isArray(value)) headers[key] = value.join(', ');
  }
  return headers;
}

function isUnsupported(value: unknown): boolean {
  if (!value || typeof value !== 'object') return true;
  const command = value as Record<string, unknown>;
  if (command.op !== 'fetch') return true;
  if (command.transport !== undefined && command.transport !== 'tcp') return true;
  if ('udp' in command || 'quic' in command || 'dns' in command || 'lookup' in command) return true;
  return Object.keys(command).some(key => !FETCH_FIELDS.has(key));
}

function parseFetch(value: unknown): FetchCommand | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const command = value as Record<string, unknown>;
  if (command.op !== 'fetch' || (command.transport !== undefined && command.transport !== 'tcp')) return undefined;
  if (!Number.isInteger(command.id) || (command.id as number) < 1) return undefined;
  if (command.family !== 4 && command.family !== 6) return undefined;
  if (typeof command.address !== 'string' || isIP(command.address) !== command.family) return undefined;
  if (!Number.isInteger(command.port) || (command.port as number) < 1 || (command.port as number) > 65535) return undefined;
  if (typeof command.https !== 'boolean') return undefined;
  if (typeof command.servername !== 'string' || typeof command.hostHeader !== 'string' || typeof command.path !== 'string') return undefined;
  if ([command.servername, command.hostHeader, command.path].some(part => part.length > 2048 || /[\r\n\0]/.test(part))) return undefined;
  if (!command.path.startsWith('/') || command.path.startsWith('//')) return undefined;
  if (!Number.isInteger(command.timeoutMs) || (command.timeoutMs as number) < 1 || (command.timeoutMs as number) > 120_000) return undefined;
  return {
    id: command.id as number,
    address: command.address,
    family: command.family,
    port: command.port as number,
    https: command.https,
    servername: command.servername,
    hostHeader: command.hostHeader,
    path: command.path,
    timeoutMs: command.timeoutMs as number,
  };
}

// The pinned literal is the socket destination. This callback never calls the system resolver.
function fetchPinned(command: FetchCommand, onDial: () => void): { done: Promise<IsolatedDocument>; destroy: () => void } {
  let requestDestroy = () => {};
  const done = new Promise<IsolatedDocument>((resolve, reject) => {
    let settled = false;
    let dialed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error, value?: IsolatedDocument) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value!);
    };
    const send = command.https ? httpsRequest : httpRequest;
    const options = {
      host: command.address,
      port: command.port,
      path: command.path,
      method: 'GET',
      headers: { host: command.hostHeader, accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', connection: 'close' },
      autoSelectFamily: false,
      family: command.family,
      rejectUnauthorized: true,
      servername: command.https ? command.servername : undefined,
      lookup: (hostname: string, lookupOptions: { all?: boolean }, callback: (error: Error | null, address: string | { address: string; family: number }[], family?: number) => void) => {
        if (hostname !== command.address) {
          callback(new Error('DNS lookup is not available in the document fetcher.'), '', 0);
          return;
        }
        if (lookupOptions?.all) callback(null, [{ address: command.address, family: command.family }]);
        else callback(null, command.address, command.family);
      },
    } as HttpsRequestOptions;
    const request = send(options, response => {
      const status = response.statusCode ?? 0;
      const headers = headerMap(response);
      if (status >= 300 && status < 400) {
        response.destroy();
        finish(undefined, { status, headers, body: Buffer.alloc(0) });
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_DOCUMENT_BYTES) {
          request.destroy();
          finish(new Error('Document exceeds 1 MiB.'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => finish(undefined, { status, headers, body: Buffer.concat(chunks) }));
      response.on('error', () => finish(new Error('Navigation failed.')));
    });
    timer = setTimeout(() => {
      request.destroy();
      finish(new Error('Browser operation timed out.'));
    }, command.timeoutMs);
    request.on('socket', socket => {
      const announce = () => {
        if (dialed || settled) return;
        dialed = true;
        onDial();
      };
      if (socket.connecting) socket.once('connect', announce);
      else announce();
    });
    request.on('error', () => finish(new Error('Navigation failed.')));
    request.end();
    requestDestroy = () => {
      request.destroy();
      finish(new Error('Browser operation timed out.'));
    };
  });
  return { done, destroy: () => requestDestroy() };
}

function emit(message: unknown) {
  const line = Buffer.from(`${JSON.stringify(message)}\n`);
  if (line.length > RESULT_LIMIT) return;
  let offset = 0;
  while (offset < line.length) {
    const written = writeSync(1, line, offset, Math.min(line.length - offset, 64 * 1024));
    if (written <= 0) return;
    offset += written;
  }
}

const activeFetches = new Map<number, { destroy: () => void }>();

function handleCommand(line: string) {
  let message: Record<string, unknown>;
  try { message = JSON.parse(line) as Record<string, unknown>; }
  catch { emit({ event: 'fetch-error', id: 0, message: 'Navigation failed.' }); return; }
  const id = Number.isInteger(message.id) ? message.id as number : 0;
  if (message.op === 'cancel') {
    activeFetches.get(id)?.destroy();
    return;
  }
  if (isUnsupported(message)) {
    emit({ event: 'fetch-error', id, message: 'Unsupported network operation.' });
    return;
  }
  const command = parseFetch(message);
  if (!command) {
    const addressRejected = typeof message.address === 'string' && isIP(message.address) === 0;
    emit({ event: 'fetch-error', id, message: addressRejected ? 'Pinned address is not a literal IP.' : 'Navigation failed.' });
    return;
  }
  if (activeFetches.size > 0) {
    emit({ event: 'fetch-error', id, message: 'Navigation failed.' });
    return;
  }
  const attempt = fetchPinned(command, () => emit({
    event: 'dial', id: command.id, pid: process.pid, address: command.address, port: command.port,
  }));
  activeFetches.set(command.id, attempt);
  void attempt.done.then(document => emit({
    event: 'fetch-result', id: command.id, status: document.status, headers: document.headers,
    body: document.body.toString('base64'),
  })).catch(error => emit({
    event: 'fetch-error', id: command.id, message: error instanceof Error ? error.message : 'Navigation failed.',
  })).finally(() => activeFetches.delete(command.id));
}

function readCommands() {
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    buffer += chunk;
    if (buffer.length > COMMAND_LIMIT * 4) {
      buffer = '';
      emit({ event: 'fetch-error', id: 0, message: 'Navigation failed.' });
      return;
    }
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.length > COMMAND_LIMIT) emit({ event: 'fetch-error', id: 0, message: 'Navigation failed.' });
      else if (line.trim()) handleCommand(line);
      newline = buffer.indexOf('\n');
    }
  });
}

export type IsolatedNetwork = {
  port: number;
  pid: number;
  dials: DialRecord[];
  denials: EgressAttempt[];
  request(command: Record<string, unknown>, signal?: AbortSignal): Promise<IsolatedDocument>;
  close(): Promise<void>;
};

function publicDocument(message: Record<string, unknown>): IsolatedDocument {
  if (message.event === 'fetch-error') throw new Error(typeof message.message === 'string' ? message.message : 'Navigation failed.');
  if (message.event !== 'fetch-result' || !Number.isInteger(message.status) || (message.status as number) < 100 || (message.status as number) > 599) {
    throw new Error('Navigation failed.');
  }
  if (typeof message.body !== 'string') throw new Error('Navigation failed.');
  const body = Buffer.from(message.body, 'base64');
  if (body.length > MAX_DOCUMENT_BYTES) throw new Error('Document exceeds 1 MiB.');
  const headers: Record<string, string> = {};
  if (message.headers && typeof message.headers === 'object') {
    for (const [key, value] of Object.entries(message.headers as Record<string, unknown>)) {
      if (typeof value === 'string' && !HOP_BY_HOP.has(key.toLowerCase()) && key.length <= 100 && value.length <= HEADER_LIMIT) {
        headers[key.toLowerCase()] = value;
      }
    }
  }
  return { status: message.status as number, headers, body };
}

export function startIsolatedNetwork(): Promise<IsolatedNetwork> {
  const child: ChildProcess = spawn(process.execPath, ['--experimental-strip-types', fileURLToPath(import.meta.url)], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH ?? '', TMPDIR: process.env.TMPDIR ?? '/tmp', LANG: process.env.LANG ?? 'C' },
  });
  const dials: DialRecord[] = [];
  const denials: EgressAttempt[] = [];
  const pending = new Map<number, (error: Error | undefined, message?: Record<string, unknown>) => void>();
  let stdout = '';
  let stderr = '';
  let nextId = 0;
  let ready = false;
  let startupFailed = false;
  let closed = false;
  let chain: Promise<void> = Promise.resolve();
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveReady: ((network: IsolatedNetwork) => void) | undefined;
  let rejectReady: ((error: Error) => void) | undefined;
  const shutdown = () => { if (child.exitCode === null && !child.killed) child.kill('SIGTERM'); };
  process.on('exit', shutdown);

  const failPending = (error: Error) => {
    for (const settle of pending.values()) settle(error);
    pending.clear();
  };
  function close(): Promise<void> {
    if (closed) return Promise.resolve();
    closed = true;
    clearTimeout(startupTimer);
    process.off('exit', shutdown);
    failPending(new Error('Navigation failed.'));
    child.stdin?.end();
    if (child.exitCode === null) child.kill('SIGTERM');
    return new Promise(resolve => {
      if (child.exitCode !== null) { resolve(); return; }
      const timer = setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
        resolve();
      }, 1_000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
  function failStartup(error: Error) {
    if (ready || startupFailed) return;
    startupFailed = true;
    clearTimeout(startupTimer);
    rejectReady?.(error);
    void close();
  }
  function handle(message: Record<string, unknown>) {
    if (message.event === 'listening' && !ready && !startupFailed) {
      ready = true;
      clearTimeout(startupTimer);
      if (!Number.isInteger(message.port) || !Number.isInteger(message.pid)) {
        failStartup(new Error('Egress proxy failed to start.'));
        return;
      }
      resolveReady?.({ port: message.port as number, pid: message.pid as number, dials, denials, request, close });
      return;
    }
    if (message.event === 'dial' && Number.isInteger(message.id) && Number.isInteger(message.pid)) {
      dials.push({ id: message.id as number, pid: message.pid as number, address: String(message.address), port: Number(message.port) });
      return;
    }
    if (message.event === 'deny' && typeof message.host === 'string' && Number.isInteger(message.port)) {
      denials.push({ host: message.host, port: message.port as number, decision: 'deny' });
      return;
    }
    if ((message.event === 'fetch-result' || message.event === 'fetch-error') && pending.has(message.id as number)) {
      pending.get(message.id as number)?.(undefined, message);
      pending.delete(message.id as number);
    }
  }
  function request(command: Record<string, unknown>, signal?: AbortSignal): Promise<IsolatedDocument> {
    const run = chain.then(() => send(command, signal));
    chain = run.then(() => undefined, () => undefined);
    return run;
  }
  function send(command: Record<string, unknown>, signal?: AbortSignal): Promise<IsolatedDocument> {
    if (closed || !child.stdin?.writable) return Promise.reject(new Error('Navigation failed.'));
    if (signal?.aborted) return Promise.reject(new Error('Browser operation timed out.'));
    const id = ++nextId;
    const timeoutMs = Number.isInteger(command.timeoutMs) ? command.timeoutMs as number : 20_000;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error, message?: Record<string, unknown>) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        pending.delete(id);
        if (error) reject(error);
        else {
          try { resolve(publicDocument(message ?? {})); }
          catch (parseError) { reject(parseError instanceof Error ? parseError : new Error('Navigation failed.')); }
        }
      };
      const onAbort = () => {
        child.stdin?.write(`${JSON.stringify({ op: 'cancel', id })}\n`);
        finish(new Error('Browser operation timed out.'));
      };
      const timer = setTimeout(() => onAbort(), Math.min(120_000, timeoutMs + 1_000));
      pending.set(id, finish);
      signal?.addEventListener('abort', onAbort, { once: true });
      child.stdin?.write(`${JSON.stringify({ ...command, id })}\n`);
    });
  }

  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', chunk => {
    stdout += chunk;
    if (stdout.length > RESULT_LIMIT * 2) {
      stdout = '';
      failPending(new Error('Navigation failed.'));
      return;
    }
    let newline = stdout.indexOf('\n');
    while (newline >= 0) {
      const line = stdout.slice(0, newline);
      stdout = stdout.slice(newline + 1);
      if (line) {
        try { handle(JSON.parse(line) as Record<string, unknown>); } catch { /* Ignore a malformed diagnostic line. */ }
      }
      newline = stdout.indexOf('\n');
    }
  });
  child.stderr?.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-4_000); });
  child.once('error', error => failStartup(error));
  child.once('exit', code => {
    if (!ready) failStartup(new Error(stderr.trim() || `Egress proxy exited ${code ?? 'unknown'}.`));
    else failPending(new Error('Navigation failed.'));
  });

  return new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
    startupTimer = setTimeout(() => failStartup(new Error(`Egress proxy did not start. ${stderr}`)), 5_000);
  });
}

const isDirectRun = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  readCommands();
  startDenyEgressProxy({ onAttempt: attempt => emit({ event: 'deny', host: attempt.host, port: attempt.port }) })
    .then(proxy => emit({ event: 'listening', port: proxy.port, pid: process.pid }))
    .catch(error => {
      process.stderr.write(`${error instanceof Error ? error.message : 'Egress proxy failed.'}\n`);
      process.exit(1);
    });
}

import { randomUUID } from 'node:crypto';
import type { Browser, Page } from 'playwright';
import { z } from 'zod';
import { launchBrowser } from './browser.ts';
import { fixtureUrl, interactionFixture } from './interaction-fixture.ts';

const target = { role: z.enum(['button', 'textbox', 'checkbox', 'radio', 'link']), name: z.string().min(1).max(100) };
const session = { sessionId: z.string().uuid() };
export const interactionInput = z.discriminatedUnion('action', [
  z.object({ action: z.literal('start') }).strict(),
  z.object({ action: z.literal('click'), ...session, ...target }).strict(),
  z.object({ action: z.literal('type'), ...session, ...target, text: z.string().max(1000) }).strict(),
  z.object({ action: z.literal('snapshot'), ...session }).strict(),
  z.object({ action: z.literal('close'), ...session }).strict(),
]);
type Input = z.infer<typeof interactionInput>;
type Session = { id: string; owner: string; browser?: Browser; page?: Page; expires: number;
  actions: number; busy: boolean; closed: boolean; closing?: Promise<void>; timer?: NodeJS.Timeout };

// In-process, short-lived fixture sessions, not durable browser handles. No URL,
// selector, keypress, upload, script or policy override is exposed to the agent.
export function createInteractionTools(options: {
  launch?: () => Promise<Browser>; lifetimeMs?: number; idleMs?: number;
  operationMs?: number; maxActions?: number; maxSessions?: number;
} = {}) {
  const sessions = new Map<string, Session>();
  const lifetime = options.lifetimeMs ?? 60_000;
  const idle = options.idleMs ?? 20_000;
  const operation = options.operationMs ?? 10_000;
  const maxActions = options.maxActions ?? 10;
  const launch = options.launch ?? launchBrowser;

  async function close(s: Session) {
    s.closed = true;
    clearTimeout(s.timer);
    // Retain the capacity reservation until browser teardown has settled.
    if (s.browser) await (s.closing ??= s.browser.close());
    sessions.delete(s.id);
  }
  function arm(s: Session) {
    clearTimeout(s.timer);
    s.timer = setTimeout(() => { void close(s).catch(() => {}); }, Math.max(0, Math.min(idle, s.expires - Date.now())));
    s.timer.unref();
  }
  async function snapshot(s: Session) {
    return { sessionId: s.id, mode: 'controlled_local_fixture' as const,
      evidenceId: randomUUID(), capturedAt: new Date().toISOString(),
      expiresAt: new Date(s.expires).toISOString(), remainingActions: maxActions - s.actions,
      title: await s.page!.title(), url: s.page!.url(),
      accessibility: (await s.page!.locator('body').ariaSnapshot()).slice(0, 18_000) };
  }
  async function run(owner: string, raw: Input, signal?: AbortSignal) {
    const input = interactionInput.parse(raw);
    if (!owner) throw new Error('An owning Eve session is required.');
    signal?.throwIfAborted();
    let s: Session;
    if (input.action === 'start') {
      if (sessions.size >= (options.maxSessions ?? 4) || [...sessions.values()].some(item => item.owner === owner)) {
        throw new Error('Browser session capacity reached; close the existing session.');
      }
      s = { id: randomUUID(), owner, expires: Date.now() + lifetime, actions: 0, busy: false, closed: false };
      sessions.set(s.id, s);
    } else {
      const found = sessions.get(input.sessionId);
      if (!found || found.owner !== owner) throw new Error('Unknown browser session.');
      s = found;
      if (s.closed || Date.now() >= s.expires) { await close(s); throw new Error('Browser session expired.'); }
    }
    if (s.busy) throw new Error('Browser session is busy.');
    s.busy = true;
    clearTimeout(s.timer);
    let timer: NodeJS.Timeout | undefined;
    let onAbort: () => void = () => {};
    const deadline = new Promise<never>((_, reject) => {
      onAbort = () => { reject(new Error('Browser operation cancelled.')); void close(s).catch(() => {}); };
      signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => { reject(new Error('Browser operation timed out.')); void close(s).catch(() => {}); },
        Math.max(0, Math.min(operation, s.expires - Date.now())));
    });
    const work = async () => {
      if (input.action === 'close') { await close(s); return { sessionId: s.id, closed: true }; }
      if (input.action === 'start') {
        s.browser = await launch();
        if (s.closed) { await close(s); throw new Error('Browser session expired during startup.'); }
        const context = await s.browser.newContext({ javaScriptEnabled: false, serviceWorkers: 'block',
          acceptDownloads: false, viewport: { width: 1280, height: 900 } });
        context.setDefaultTimeout(Math.min(operation, 3000));
        await context.routeWebSocket('**/*', socket => socket.close());
        s.page = await context.newPage();
        const page = s.page;
        context.on('page', popup => { if (popup !== page) void popup.close().catch(() => {}); });
        page.on('dialog', dialog => { void dialog.dismiss().catch(() => {}); });
        page.on('download', download => { void download.cancel().catch(() => {}); });
        let served = false;
        await context.route('**/*', async route => {
          const request = route.request();
          // No request ever reaches the network. Only the initial, exact virtual
          // document is fulfilled; frames, redirects, resources and later GETs fail closed.
          if (!s.closed && !served && request.url() === fixtureUrl && request.method() === 'GET' &&
              request.isNavigationRequest() && request.frame() === page.mainFrame()) {
            served = true;
            await route.fulfill({ contentType: 'text/html', body: interactionFixture, headers: {
              'content-security-policy': "default-src 'none'; script-src 'none'; form-action 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'",
            } });
          } else await route.abort();
        });
        await page.goto(fixtureUrl, { waitUntil: 'domcontentloaded' });
      } else if (input.action === 'click' || input.action === 'type') {
        if (s.actions >= maxActions) throw new Error('Browser action limit reached.');
        const locator = s.page!.getByRole(input.role, { name: input.name, exact: true });
        if (await locator.count() !== 1) throw new Error('Target must match exactly one accessible element.');
        if (!(await locator.isVisible()) || !(await locator.isEnabled())) throw new Error('Target is not visible and enabled.');
        // Positive allowlist on immutable authored fixture content. Names on arbitrary
        // web pages are never treated as evidence that an action is safe.
        const permitted = input.action === 'type'
          ? input.role === 'textbox' && input.name === 'Draft note'
          : (input.role === 'checkbox' && input.name === 'Show details') ||
            (input.role === 'radio' && input.name === 'Compact view') ||
            (input.role === 'button' && input.name === 'Preview draft');
        if (!permitted) throw new Error('Action blocked by controlled fixture policy.');
        if (input.action === 'type') await locator.fill(input.text);
        else await locator.click({ noWaitAfter: true });
        s.actions++;
      }
      if (s.closed) throw new Error('Browser session expired.');
      const result = await snapshot(s);
      if (s.actions >= maxActions) { await close(s); return { ...result, closed: true }; }
      return { ...result, closed: false };
    };
    try {
      const result = await Promise.race([work(), deadline]);
      if (!s.closed) arm(s);
      return result;
    } catch (error) { await close(s); throw error; }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); s.busy = false; }
  }
  return { run, closeAll: async () => { await Promise.all([...sessions.values()].map(close)); } };
}

export const interactions = createInteractionTools();

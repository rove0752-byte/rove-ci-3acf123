import { createHash, randomUUID } from 'node:crypto';
import type { Browser, Page } from 'playwright';
import { launchBrowser } from './browser.ts';
import { fixturePreviewUrl, fixtureUrl, interactionFixture, interactionPreview } from './interaction-fixture.ts';
import {
  ACTION_LIMITS, type InteractionInput, LIVE_SIDE_EFFECT_ERROR, classifyBrowserAction, interactionInput,
} from './action-contract.ts';

export { approvalForInteraction, interactionInput } from './action-contract.ts';

type Input = InteractionInput;
type Session = { id: string; owner: string; browser?: Browser; page?: Page; expires: number;
  actions: number; busy: boolean; closed: boolean; closing?: Promise<void>; timer?: NodeJS.Timeout };

const FIXTURE_CSP = "default-src 'none'; script-src 'none'; form-action 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'";

// In-process, short-lived fixture sessions, not durable browser handles. No URL,
// selector, keypress, upload, script or policy override is exposed to the agent.
export function createInteractionTools(options: {
  launch?: () => Promise<Browser>; lifetimeMs?: number; idleMs?: number;
  operationMs?: number; maxActions?: number; maxSessions?: number;
} = {}) {
  const sessions = new Map<string, Session>();
  const lifetime = options.lifetimeMs ?? ACTION_LIMITS.lifetimeMs;
  const idle = options.idleMs ?? ACTION_LIMITS.idleMs;
  const operation = options.operationMs ?? ACTION_LIMITS.operationMs;
  const maxActions = options.maxActions ?? ACTION_LIMITS.maxActions;
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
    const image = await s.page!.screenshot({ type: 'png', timeout: 5000 });
    return { sessionId: s.id, mode: 'controlled_local_fixture' as const,
      evidenceId: randomUUID(), capturedAt: new Date().toISOString(),
      expiresAt: new Date(s.expires).toISOString(), remainingActions: maxActions - s.actions,
      title: await s.page!.title(), url: s.page!.url(),
      accessibility: (await s.page!.locator('body').ariaSnapshot()).slice(0, 18_000),
      screenshotSha256: createHash('sha256').update(image).digest('hex'), screenshotBytes: image.length,
      screenshotBase64: image.toString('base64') };
  }
  async function run(owner: string, raw: Input, signal?: AbortSignal) {
    const input = interactionInput.parse(raw);
    if (!owner) throw new Error('An owning Eve session is required.');
    signal?.throwIfAborted();
    let s: Session;
    if (input.action === 'start') {
      if (sessions.size >= (options.maxSessions ?? ACTION_LIMITS.maxSessions) || [...sessions.values()].some(item => item.owner === owner)) {
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
      const effect = classifyBrowserAction(input);
      if (input.action === 'close') { await close(s); return { sessionId: s.id, closed: true }; }
      if (input.action === 'submit' || input.action === 'purchase' || input.action === 'authenticate' || input.action === 'transfer') {
        throw new Error(LIVE_SIDE_EFFECT_ERROR);
      }
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
        const served = new Set<string>();
        await context.route('**/*', async route => {
          const request = route.request();
          const url = request.url();
          // No request ever reaches the network. Only the two authored virtual
          // documents are fulfilled, each once; frames, redirects and resources fail closed.
          if (!s.closed && !served.has(url) && (url === fixtureUrl || url === fixturePreviewUrl) &&
              request.method() === 'GET' && request.isNavigationRequest() && request.frame() === page.mainFrame()) {
            served.add(url);
            await route.fulfill({ contentType: 'text/html', body: url === fixturePreviewUrl ? interactionPreview : interactionFixture, headers: {
              'content-security-policy': FIXTURE_CSP,
            } });
          } else await route.abort();
        });
        await page.goto(fixtureUrl, { waitUntil: 'domcontentloaded' });
      } else if (input.action === 'navigate') {
        if (effect.disposition !== 'fixture') throw new Error(LIVE_SIDE_EFFECT_ERROR);
        if (s.actions >= maxActions) throw new Error('Browser action limit reached.');
        await s.page!.goto(fixturePreviewUrl, { waitUntil: 'domcontentloaded' });
        s.actions++;
      } else if (input.action === 'click' || input.action === 'type' || input.action === 'select') {
        if (s.actions >= maxActions) throw new Error('Browser action limit reached.');
        const locator = s.page!.getByRole(input.role, { name: input.name, exact: true });
        if (await locator.count() !== 1) throw new Error('Target must match exactly one accessible element.');
        if (!(await locator.isVisible()) || !(await locator.isEnabled())) throw new Error('Target is not visible and enabled.');
        if (effect.disposition === 'approval-required') throw new Error(LIVE_SIDE_EFFECT_ERROR);
        if (effect.disposition !== 'fixture') throw new Error(effect.reason);
        let selection: string | undefined;
        if (input.action === 'type') await locator.fill(input.text);
        else if (input.action === 'select') {
          await locator.selectOption({ label: input.option });
          selection = await locator.inputValue();
        } else await locator.click({ noWaitAfter: true });
        s.actions++;
        if (s.closed) throw new Error('Browser session expired.');
        const selected = await snapshot(s);
        const evidence = { ...selected, effect: effect.effect, ...(selection !== undefined ? { selection } : {}) };
        if (s.actions >= maxActions) { await close(s); return { ...evidence, closed: true }; }
        return { ...evidence, closed: false };
      }
      if (s.closed) throw new Error('Browser session expired.');
      const result = await snapshot(s);
      const evidence = { ...result, effect: effect.disposition === 'fixture' ? effect.effect : 'read' as const };
      if (s.actions >= maxActions) { await close(s); return { ...evidence, closed: true }; }
      return { ...evidence, closed: false };
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

import { chromium, type Browser, type Page } from 'playwright';
import { createHash, randomUUID } from 'node:crypto';
import { type LookupAddress } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { existsSync } from 'node:fs';
import { isIP } from 'node:net';
import bundledChromium from '@sparticuz/chromium';
import { buildCompleteness, extractNavigationHeadings, extractionBounds, type TimeoutStage } from './document-catalog.ts';
import { mandatoryChromiumArgs, startIsolatedNetwork, type IsolatedDocument, type IsolatedNetwork } from './egress-proxy.ts';
import { publicAddress } from './public-address.ts';
import { validateUrl } from './policy.ts';

export class ExtractionTimeout extends Error {
  readonly complete = false;
  readonly failed = true;
  readonly reason = 'timeout';
  readonly timedOut = true;
  readonly stage: TimeoutStage;
  constructor(stage: TimeoutStage) {
    super(`Browser operation timed out during ${stage}.`);
    this.name = 'ExtractionTimeout';
    this.stage = stage;
  }
}

export type PinnedAddress = { address: string; family: 4 | 6 };

// One checked answer set, in lookup order. Any private or empty answer rejects the whole set.
export function selectPinnedAddresses(records: readonly LookupAddress[]): PinnedAddress[] {
  if (!records.length || records.some(record => !publicAddress(record.address))) {
    throw new Error('Private and reserved network targets are blocked.');
  }
  return records.map(record => {
    const family = isIP(record.address);
    if (family !== 4 && family !== 6) throw new Error('Private and reserved network targets are blocked.');
    return { address: record.address, family };
  });
}

export async function resolvePinned(url: URL): Promise<PinnedAddress[]> {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const literal = isIP(host);
  // Address literals were already accepted by validate. Production validateUrl rejects
  // private literals before a browser starts; loopback fixtures use that test seam.
  if (literal === 4 || literal === 6) return [{ address: host, family: literal }];
  return selectPinnedAddresses(await lookup(host, { all: true }));
}

const networks = new WeakMap<Browser, IsolatedNetwork>();

export function networkIsolationFor(browser: Browser): IsolatedNetwork {
  const network = networks.get(browser);
  if (!network) throw new Error('Browser network isolation is required.');
  return network;
}

function knownFetchError(error: unknown): Error {
  if (error instanceof Error && (error.message === 'Document exceeds 1 MiB.' || error.message === 'Browser operation timed out.' ||
    error.message === 'Navigation failed.' || error.message === 'Browser network isolation is required.')) return error;
  return new Error('Navigation failed.');
}

// The browser process does not open this socket. The isolation process dials the pinned literal.
async function fetchDocument(browser: Browser, url: URL, addresses: readonly PinnedAddress[], timeoutMs: number, signal: AbortSignal): Promise<IsolatedDocument> {
  const pinned = addresses[0];
  if (!pinned || isIP(pinned.address) !== pinned.family) throw new Error('Private and reserved network targets are blocked.');
  if (signal.aborted) throw new ExtractionTimeout('deadline');
  const secure = url.protocol === 'https:';
  const port = Number(url.port || (secure ? 443 : 80));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Navigation failed.');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  try {
    return await networkIsolationFor(browser).request({
      op: 'fetch', address: pinned.address, family: pinned.family, port, https: secure,
      servername: hostname, hostHeader: url.host, path: `${url.pathname}${url.search}`, timeoutMs,
    }, signal);
  } catch (error) {
    if (signal.aborted) throw new ExtractionTimeout('deadline');
    const known = knownFetchError(error);
    if (known.message === 'Browser operation timed out.') throw new ExtractionTimeout('fetch');
    throw known;
  }
}

function bindIsolation(browser: Browser, network: IsolatedNetwork): Browser {
  networks.set(browser, network);
  let closing: Promise<void> | undefined;
  const finish = () => closing ??= network.close().then(() => undefined);
  browser.on('disconnected', () => { void finish(); });
  const close = browser.close.bind(browser);
  browser.close = async () => {
    try { return await close(); }
    finally { await finish(); }
  };
  return browser;
}

// Every product browser dials the separate deny proxy. There is no direct-network launch.
export async function launchBrowser(): Promise<Browser> {
  const network = await startIsolatedNetwork();
  try {
    const useBundled = !existsSync(chromium.executablePath()) && process.platform === 'linux';
    const browser = await chromium.launch({
      headless: true, timeout: 10_000,
      args: mandatoryChromiumArgs(network.port, useBundled ? bundledChromium.args : []),
      ...(useBundled ? { executablePath: await bundledChromium.executablePath() } : {}),
    });
    return bindIsolation(browser, network);
  } catch (error) {
    await network.close();
    throw error;
  }
}

// Dependencies are injectable by local tests only; tools never accept policy overrides.
export function createBrowserTools(dependencies: {
  launch?: () => Promise<Browser>;
  validate?: (url: string) => Promise<URL>;
  resolve?: (url: URL) => Promise<readonly PinnedAddress[]>;
  timeoutMs?: number;
  navigationTimeoutMs?: number;
} = {}) {
  const launch = dependencies.launch ?? launchBrowser;
  const validate = dependencies.validate ?? validateUrl;
  const resolve = dependencies.resolve ?? resolvePinned;
  const timeoutMs = dependencies.timeoutMs ?? 30_000;
  const navigationTimeoutMs = dependencies.navigationTimeoutMs ?? 20_000;
  // Same visit deadline the fetch already races. Accessibility calls do not get a second clock.
  type ExtractionBudget = { deadlineAt: number; signal: AbortSignal };

  function allowedTimeout(budget: ExtractionBudget, limit: number): number {
    if (budget.signal.aborted) throw new ExtractionTimeout('deadline');
    const remaining = budget.deadlineAt - Date.now();
    // Playwright treats timeout 0 as unlimited, so a spent budget must not start the call.
    if (remaining < 1) throw new ExtractionTimeout('deadline');
    return Math.min(limit, remaining);
  }

  function deadlineFailure(error: unknown, budget: ExtractionBudget): unknown {
    if (error instanceof ExtractionTimeout) return error;
    if (budget.signal.aborted || Date.now() >= budget.deadlineAt) return new ExtractionTimeout('deadline');
    if (error instanceof Error && /timeout|timed out/i.test(error.message)) return new ExtractionTimeout('deadline');
    return error;
  }

  async function withinDeadline<T>(budget: ExtractionBudget, run: () => Promise<T>): Promise<T> {
    if (budget.signal.aborted || budget.deadlineAt - Date.now() < 1) throw new ExtractionTimeout('deadline');
    try {
      return await run();
    } catch (error) {
      throw deadlineFailure(error, budget);
    }
  }

  async function visit<T>(raw: string, capture: (page: Page, status: number, budget: ExtractionBudget) => Promise<T>): Promise<T> {
    let browser: Browser | undefined;
    let expired = false;
    let closing: Promise<void> | undefined;
    const close = () => browser ? (closing ??= browser.close()) : Promise.resolve();
    const controller = new AbortController();
    const deadlineAt = Date.now() + timeoutMs;
    const budget: ExtractionBudget = { deadlineAt, signal: controller.signal };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        expired = true;
        controller.abort();
        reject(new ExtractionTimeout('deadline'));
        void close().catch(() => {});
      }, timeoutMs);
    });
    const work = async () => {
      if (raw.length > 2048) throw new Error('URL exceeds 2048 characters.');
      await validate(raw);
      if (expired) throw new ExtractionTimeout('deadline');
      browser = await launch();
      const session = browser;
      // A startup that finishes after the deadline must not leak a process.
      if (expired) { await close(); throw new ExtractionTimeout('deadline'); }
      const context = await browser.newContext({ javaScriptEnabled: false, serviceWorkers: 'block',
        acceptDownloads: false, viewport: { width: 1280, height: 900 } });
      context.setDefaultTimeout(5000);
      context.setDefaultNavigationTimeout(navigationTimeoutMs);
      let count = 0;
      const hop: { target: string; pinned: readonly PinnedAddress[]; redirect?: string; failure?: Error; served: boolean } =
        { target: '', pinned: [], served: false };
      const page = await context.newPage();
      page.on('dialog', dialog => { void dialog.dismiss().catch(() => {}); });
      page.on('download', download => { void download.cancel().catch(() => {}); });
      await context.route('**/*', async route => {
        const request = route.request();
        try {
          if (expired || ++count > 80) { await route.abort(); return; }
          // Chromium must not open a socket. Only the one main-frame document for this hop is fetched.
          const document = request.method() === 'GET' && request.resourceType() === 'document' &&
            request.isNavigationRequest() && request.frame() === page.mainFrame() && request.url() === hop.target;
          if (!document || hop.served) { await route.abort(); return; }
          hop.served = true;
          const outcome = await fetchDocument(session, new URL(hop.target), hop.pinned, navigationTimeoutMs, controller.signal);
          const status = outcome.status;
          if (status >= 300 && status < 400) {
            if (outcome.headers.location) hop.redirect = new URL(outcome.headers.location, request.url()).href;
            await route.fulfill({ status: 200, contentType: 'text/html', body: '' });
          } else if (/attachment/i.test(outcome.headers['content-disposition'] ?? '')) {
            await route.abort();
          } else {
            if (!outcome.headers['content-type']) outcome.headers['content-type'] = 'text/html; charset=utf-8';
            await route.fulfill({ status, body: outcome.body, headers: { ...outcome.headers,
              'content-security-policy': "script-src 'none'; form-action 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'",
            } });
          }
        } catch (error) {
          hop.failure ??= error instanceof Error ? error : new Error('Navigation failed.');
          await route.abort().catch(() => {});
        }
      });
      const initial = new URL(raw);
      initial.hash = '';
      let target = initial.href;
      for (let redirectHop = 0; redirectHop <= 5; redirectHop++) {
        await validate(target);
        hop.target = target;
        hop.pinned = await resolve(new URL(target));
        hop.redirect = undefined;
        hop.failure = undefined;
        hop.served = false;
        let response;
        try {
          response = await page.goto(target, { waitUntil: 'domcontentloaded', timeout: navigationTimeoutMs });
        } catch (error) {
          if (hop.failure) throw hop.failure;
          if (error instanceof Error && /timeout|timed out/i.test(error.message)) throw new ExtractionTimeout('navigation');
          throw error;
        }
        if (hop.failure) throw hop.failure;
        if (hop.redirect) {
          if (redirectHop === 5) throw new Error('Navigation exceeded five redirects.');
          const next = new URL(hop.redirect);
          next.hash = '';
          target = next.href;
          continue;
        }
        if (!response || response.status() >= 400) throw new Error(`Website returned HTTP ${response?.status() ?? 'unknown'}.`);
        await validate(page.url());
        if (expired || budget.signal.aborted || Date.now() >= budget.deadlineAt) throw new ExtractionTimeout('deadline');
        return capture(page, response.status(), budget);
      }
      throw new Error('Navigation failed.');
    };
    const job = work();
    // A deadline winner must not leave the fetch rejection unhandled.
    void job.catch(() => {});
    try { return await Promise.race([job, deadline]); }
    finally { expired = true; controller.abort(); clearTimeout(timer); await close(); }
  }

  async function inspectPage(raw: string) {
    const started = Date.now();
    return visit(raw, async (page, status, budget) => {
      const content = await page.locator('body').innerText();
      const bounds = extractionBounds();
      // Fixed catalog only. The page supplies data; caller selectors and scripts are not accepted.
      // The old inspect path kept only the first 60 anchors and dropped the rest with no omission count.
      const extracted = await page.locator('a[href]').evaluateAll((nodes, bounds) => {
        const links: { text: string; url: string }[] = [];
        let linksOmitted = 0;
        let overlongLinks = 0;
        let textCapped = false;
        for (const node of nodes) {
          const href = (node as HTMLAnchorElement).href || '';
          if (!/^https?:/i.test(href)) continue;
          if (href.length > bounds.linkUrlLimit) { overlongLinks += 1; continue; }
          const raw = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
          if (raw.length > bounds.linkTextLimit) textCapped = true;
          if (links.length >= bounds.linkLimit) { linksOmitted += 1; continue; }
          links.push({ text: raw.slice(0, bounds.linkTextLimit), url: href });
        }
        return { links, linksOmitted, overlongLinks, textCapped };
      }, bounds);
      const catalog = await page.locator('html').evaluate((_root, bounds) => {
        const clean = (value: string | null | undefined, max: number) => {
          const text = (value ?? '').replace(/\s+/g, ' ').trim();
          return { text: text.slice(0, max), capped: text.length > max };
        };
        const description = clean(document.querySelector('meta[name="description" i]')?.getAttribute('content'), bounds.metaLimit);
        const cell = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
        const tables = [...document.querySelectorAll('table')].slice(0, 5).map(table =>
          [...table.querySelectorAll('tr')].slice(0, 20).map(row =>
            [...row.querySelectorAll('th, td')].slice(0, 10).map(item => cell(item.textContent))));
        const jsonLd: unknown[] = [];
        for (const node of [...document.querySelectorAll('script[type="application/ld+json"]')].slice(0, 5)) {
          const raw = (node.textContent ?? '').trim();
          if (!raw || raw.length > 20_000) continue;
          try { jsonLd.push(JSON.parse(raw)); } catch { /* Invalid JSON-LD is data, not code, and is omitted. */ }
        }
        return { description: description.text, tables, jsonLd, textCapped: description.capped };
      }, bounds);
      const links = extracted.links;
      const headed = extractNavigationHeadings(await page.content());
      const listed = await inventory(page, status, budget);
      const textCapped = extracted.textCapped || catalog.textCapped || headed.textCapped || content.length > 18_000;
      const completeness = buildCompleteness({
        headingsKept: headed.headings.length,
        headingsOmitted: headed.headingsOmitted,
        linksKept: links.length,
        linksOmitted: extracted.linksOmitted,
        sectionsSkipped: 0,
        textCapped,
        overlongLinks: extracted.overlongLinks,
        timedOut: false,
      });
      const screenshot = await page.screenshot({ type: 'png', timeout: 5000 });
      const title = await page.title();
      return { evidenceId: randomUUID(), url: page.url(), title, httpStatus: status,
        capturedAt: new Date().toISOString(), text: content.slice(0, 18_000), truncated: content.length > 18_000,
        links, completeness, accessibilityCompleteness: listed.accessibilityCompleteness,
        structured: { title, description: catalog.description, headings: headed.headings, links, tables: catalog.tables, jsonLd: catalog.jsonLd, completeness },
        screenshotBase64: screenshot.toString('base64'),
        screenshotSha256: createHash('sha256').update(screenshot).digest('hex'), durationMs: Date.now() - started,
        mode: 'read_only_no_javascript' as const };
    });
  }

  const inventoryLimit = 60;

  function accessibilityCompleteness(kept: number, omitted: number) {
    const reasons = omitted > 0 ? ['inventory-cap' as const] : [];
    return { complete: reasons.length === 0, kept, omitted, reasons };
  }

  async function inventory(page: Page, status: number, budget: ExtractionBudget) {
    const roles = ['link', 'button', 'textbox', 'checkbox', 'radio', 'combobox', 'listbox',
      'option', 'slider', 'spinbutton', 'switch', 'tab', 'menuitem', 'searchbox'] as const;
    const elements: { role: string; accessibility: string; disabled: boolean }[] = [];
    let omitted = 0;
    for (const role of roles) {
      const matches = page.getByRole(role);
      const count = await withinDeadline(budget, () => matches.count());
      for (let index = 0; index < count; index++) {
        const element = matches.nth(index);
        if (!(await withinDeadline(budget, () => element.isVisible()))) continue;
        // The 60-element cap stays. Eligible controls after it are counted, not dropped silently.
        if (elements.length >= inventoryLimit) { omitted += 1; continue; }
        // The 1000ms snapshot cap and the 5000ms action cap stay, and neither can outlive the visit deadline.
        const accessibility = await withinDeadline(budget, () => element.ariaSnapshot({
          timeout: allowedTimeout(budget, 1000), signal: budget.signal,
        }));
        const disabled = await withinDeadline(budget, () => element.isDisabled({
          timeout: allowedTimeout(budget, 5000), signal: budget.signal,
        }));
        elements.push({ role, accessibility: accessibility.slice(0, 1000), disabled });
      }
    }
    const truncated = omitted > 0;
    return { evidenceId: randomUUID(), url: page.url(), title: await withinDeadline(budget, () => page.title()), httpStatus: status,
      capturedAt: new Date().toISOString(), elements, truncated,
      accessibilityCompleteness: accessibilityCompleteness(elements.length, omitted),
      mode: 'read_only_no_javascript' as const };
  }

  function navigate(raw: string) {
    return visit(raw, (page, status, budget) => inventory(page, status, budget));
  }

  function snapshotPage(raw: string) {
    return visit(raw, async (page, status, budget) => {
      const details = await inventory(page, status, budget);
      const screenshot = await page.screenshot({ type: 'png', timeout: 5000 });
      return { ...details, screenshotBase64: screenshot.toString('base64'),
        screenshotSha256: createHash('sha256').update(screenshot).digest('hex'), screenshotBytes: screenshot.length };
    });
  }
  return { inspectPage, navigate, snapshotPage };
}

export function omitScreenshot(output: object) {
  const { screenshotBase64: _image, ...evidence } = output as { screenshotBase64?: string };
  return evidence;
}

export const { inspectPage, navigate, snapshotPage } = createBrowserTools();

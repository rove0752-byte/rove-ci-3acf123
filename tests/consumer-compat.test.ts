import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as browser from '../agent/lib/browser.ts';

test('the default browser tools export the stop() kill switch', async () => {
  assert.equal(typeof browser.stop, 'function');
  assert.equal(await browser.stop(), 0, 'nothing running is a no-op');
});

test('the UI never renders a null screenshot and explains a screenshot timeout', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /typeof image==='string'&&image/);
  assert.match(html, /screenshotTimedOut/);
  assert.ok(!/\$\('shot'\)\.src='data:image\/png;base64,'\+image;\$\('shot'\)\.hidden=false;\}\}catch/.test(html.replace(/if\(typeof image[^}]*\}/, '')));
});

test('model output helpers tolerate a null screenshot', () => {
  const evidence = browser.omitScreenshot({ screenshotBase64: null, screenshotSha256: null, screenshotTimedOut: true, url: 'x' });
  assert.deepEqual(evidence, { screenshotSha256: null, screenshotTimedOut: true, url: 'x' });
});

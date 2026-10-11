import { defineTool } from 'eve/tools';
import { z } from 'zod';
import { omitScreenshot, snapshotPage } from '../lib/browser';
import { approvalForBrowser, reserveBrowserPage } from '../lib/browser-guard';
export default defineTool({
  description: 'Capture a fresh read-only accessibility inventory and PNG screenshot of a public URL. Requires a URL: no browser state persists between calls. JavaScript, interactions, uploads, downloads and submissions are disabled. Only the main document is fetched; images, stylesheets, fonts, scripts and other subresources are blocked before any connection. A session can fetch three documents; a different host waits for approval.',
  availableInSubagents: false,
  inputSchema: z.object({ url: z.string().url().max(2048) }).strict(),
  approval: ({ toolInput, callId, session }) => approvalForBrowser(typeof toolInput?.url === 'string' ? toolInput.url : undefined, callId, session.id),
  async execute({ url }, ctx) {
    await reserveBrowserPage(url, ctx.callId, ctx.session.id);
    return snapshotPage(url);
  },
  toModelOutput(output) { return { type: 'json', value: omitScreenshot(output) }; },
});

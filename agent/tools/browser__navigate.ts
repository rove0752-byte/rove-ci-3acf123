import { defineTool } from 'eve/tools';
import { z } from 'zod';
import { navigate } from '../lib/browser';
import { approvalForBrowser, reserveBrowserPage } from '../lib/browser-guard';
export default defineTool({
  description: 'Navigate to a public HTTP(S) URL and discover up to 60 visible interactive elements by accessibility role and name. Read-only, JavaScript disabled; no clicking, uploads, downloads or form submissions. Only the main document is fetched; images, stylesheets, fonts, scripts and other subresources are blocked before any connection. At most five redirects. A session can fetch three documents; a different host waits for approval. Browser closes after each call.',
  availableInSubagents: false,
  inputSchema: z.object({ url: z.string().url().max(2048) }).strict(),
  approval: ({ toolInput, callId, session }) => approvalForBrowser(typeof toolInput?.url === 'string' ? toolInput.url : undefined, callId, session.id),
  async execute({ url }, ctx) {
    await reserveBrowserPage(url, ctx.callId, ctx.session.id);
    return navigate(url);
  },
});

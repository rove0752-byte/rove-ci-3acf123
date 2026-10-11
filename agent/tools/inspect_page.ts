import { defineTool } from 'eve/tools';
import { z } from 'zod';
import { inspectPage } from '../lib/browser';
import { approvalForBrowser, reserveBrowserPage } from '../lib/browser-guard';
export default defineTool({
  description:'Read a public web page and return text, links, a fixed structured catalog and screenshot evidence. The catalog contains the title, meta description, headings, links, tables and JSON-LD. No caller selectors or scripts. JavaScript, submissions, downloads and non-GET requests are disabled. Only the main document is fetched; images, stylesheets, fonts, scripts and other subresources are blocked before any connection. Each call opens an isolated browser. A session can fetch three documents; a different host waits for approval. Follow links by inspecting their URLs.',
  availableInSubagents: false,
  inputSchema:z.object({url:z.string().url().max(2048)}),
  approval: ({ toolInput, callId, session }) => approvalForBrowser(typeof toolInput?.url === 'string' ? toolInput.url : undefined, callId, session.id),
  async execute({ url }, ctx) {
    await reserveBrowserPage(url, ctx.callId, ctx.session.id);
    return inspectPage(url);
  },
  toModelOutput(output) { const {screenshotBase64,...evidence}=output; return {type:'json',value:evidence}; },
});

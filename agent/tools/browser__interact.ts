import { defineTool } from 'eve/tools';
import { omitScreenshot } from '../lib/browser';
import { approvalForInteraction, interactionInput, interactions } from '../lib/interactions';

export default defineTool({
  description: 'Controlled local fixture only; cannot interact with live websites. Start a session, then type Draft note, click Show details, Compact view or Preview draft, select Sort by, or open the fixture preview page, using exact accessibility role and name. Each action returns an accessibility snapshot and a PNG SHA-256. Sessions last at most 60 seconds, expire after 20 seconds idle, and close after 10 actions. Close when finished. Navigation to other hosts, submissions, purchases, authentication, uploads and downloads require approval and stay disabled. State is temporary and process-local; start again if expired.',
  availableInSubagents: false,
  inputSchema: interactionInput,
  approval: ({ toolInput }) => approvalForInteraction(toolInput),
  execute: (input, ctx) => interactions.run(ctx.session.id, input, ctx.abortSignal),
  toModelOutput(output) { return { type: 'json', value: omitScreenshot(output) }; },
});

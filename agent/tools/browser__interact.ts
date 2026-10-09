import { defineTool } from 'eve/tools';
import { interactionInput, interactions } from '../lib/interactions';

export default defineTool({
  description: 'Controlled local fixture only; cannot interact with live websites. Start a session, then type Draft note or click Show details, Compact view or Preview draft using exact accessibility role and name. Each action returns an accessibility snapshot. Sessions last at most 60 seconds, expire after 20 seconds idle, and close after 10 actions. Close when finished. Submissions, purchases, authentication, uploads, downloads, scripts and navigation are blocked. State is temporary and process-local; start again if expired.',
  availableInSubagents: false,
  inputSchema: interactionInput,
  execute: (input, ctx) => interactions.run(ctx.session.id, input, ctx.abortSignal),
});

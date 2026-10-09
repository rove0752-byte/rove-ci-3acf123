import { defineAgent } from 'eve';
import { mockModel } from 'eve/evals';

export default defineAgent({
  defaultTools: false,
  modelContextWindowTokens: 128_000,
  build: { externalDependencies: ['playwright', 'playwright-core', '@sparticuz/chromium'] },
  model: mockModel(({ lastUserMessage, userMessageCount, toolResults }) => {
    // This fixture requests exactly one tool per user turn. Prior turns' results
    // remain in the prompt when continuing the owning Eve session.
    if (toolResults.length >= userMessageCount) return JSON.stringify(toolResults.at(-1)?.output);
    const input = JSON.parse(lastUserMessage ?? '{}');
    return { toolCalls: [{ name: input.name, input: input.input ?? { url: input.url } }] };
  }),
});

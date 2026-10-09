import { defineEval } from 'eve/evals';
import { equals } from 'eve/evals/expect';
import type config from './evals.config';
import { z } from 'zod';

export default defineEval<typeof config>({
  timeoutMs: 90_000,
  async test(t) {
    for (const name of ['browser__navigate', 'browser__snapshot', 'inspect_page']) {
      const turn = await t.send(JSON.stringify({ name, url: t.context.origin }));
      turn.succeeded();
      turn.calledTool(name, { count: 1, status: 'completed', output: (value: any) => {
        if (value?.title !== 'Eve isolated fixture' || value?.mode !== 'read_only_no_javascript') return false;
        if (name === 'inspect_page') return !!value.evidenceId && /^[a-f0-9]{64}$/.test(value.screenshotSha256);
        return value.elements?.some((element: any) => element.role === 'textbox' && element.accessibility.includes('Your name')) &&
          value.elements.some((element: any) => element.accessibility.includes('Accessible action')) &&
          value.elements.some((element: any) => element.disabled && element.accessibility.includes('Unavailable')) &&
          !value.elements.some((element: any) => element.accessibility.includes('Hidden control'));
      } });
      t.log(`${name}: ${turn.message}`);
    }
    const start = await t.send(JSON.stringify({ name: 'browser__interact', input: { action: 'start' } }));
    start.succeeded();
    // Assertion predicates are deferred: read the settled call before building inputs.
    const { sessionId } = z.object({ sessionId: z.string().uuid() }).parse(
      start.requireToolCall('browser__interact').output,
    );
    start.calledTool('browser__interact', { count: 1, status: 'completed', output: (value: any) => {
      return value?.sessionId === sessionId && value.title === 'Rove controlled fixture' && value.closed === false;
    } });
    for (const input of [
      { action: 'type', sessionId, role: 'textbox', name: 'Draft note', text: 'Eve persisted draft' },
      { action: 'click', sessionId, role: 'checkbox', name: 'Show details' },
      { action: 'snapshot', sessionId },
    ]) {
      // The browser handle belongs to this Eve session; never create a new owner.
      const turn = await start.session.send(JSON.stringify({ name: 'browser__interact', input }));
      turn.succeeded();
      turn.calledTool('browser__interact', { count: 1, status: 'completed', output: (value: any) =>
        value?.sessionId === sessionId && value.closed === false && value.accessibility?.includes('Eve persisted draft') &&
        (input.action === 'type' || value.accessibility.includes('Show details" [checked]')) });
      t.log(`${input.action}: ${turn.message}`);
    }
    const close = await start.session.send(JSON.stringify({ name: 'browser__interact', input: { action: 'close', sessionId } }));
    close.succeeded();
    close.calledTool('browser__interact', { count: 1, status: 'completed', output: (value: any) => value?.sessionId === sessionId && value.closed === true });
    t.log(`close: ${close.message}`);
    t.noFailedActions();
    t.maxToolCalls(8);
    t.check(t.context.requests.every(request => request === 'GET /'), equals(true));
    t.log(`Fixture requests: ${JSON.stringify(t.context.requests)}`);
  },
});

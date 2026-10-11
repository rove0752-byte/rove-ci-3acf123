// Proves Eve enforces Rove's compiled outputSchema with a mock model.
// The fixture is temporary and does not use the production model, browser, or paid gateway.
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { compileAgentOutputSchema, validateAgentResult } from '../agent/lib/result-schema.ts';

function parseReport(stdout) {
  const lines = stdout.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!lines[index].startsWith('{')) continue;
    try { return JSON.parse(lines.slice(index).join('\n')); } catch { /* try an earlier object */ }
  }
  return JSON.parse(stdout);
}

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const agentSource = await readFile(join(root, 'agent/agent.ts'), 'utf8');
assert.match(agentSource, /openai\/gpt-6-luna-fast/);
assert.doesNotMatch(agentSource, /mockModel/);
assert.equal(existsSync(join(root, 'agent/extensions/browser.ts')), false);
assert.equal(existsSync(join(root, 'agent/extensions/browser.ts.disabled')), true);
const tools = (await readdir(join(root, 'agent/tools'))).filter(name => name.endsWith('.ts')).sort();
assert.deepEqual(tools, ['browser__interact.ts', 'browser__navigate.ts', 'browser__snapshot.ts', 'inspect_page.ts']);

const caller = {
  type: 'object',
  additionalProperties: false,
  required: ['title'],
  properties: { title: { type: 'string', minLength: 1, maxLength: 80 } },
};
const schema = compileAgentOutputSchema(caller);
const expected = {
  status: 'completed',
  summary: 'Example Domain is a placeholder page.',
  data: { title: 'Example' },
  evidence: [{ url: 'https://example.com/', evidenceId: 'ev-example', capturedAt: '2026-10-11T00:00:00Z', excerpt: 'Example Domain' }],
  limitations: ['JavaScript was not executed.'],
};
assert.deepEqual(validateAgentResult(expected, caller), expected);
const invalid = { ...expected, notes: 'extra' };
assert.throws(() => validateAgentResult(invalid, caller), /unexpected property "notes"/);

const fixture = await mkdtemp(join(tmpdir(), 'rove-eve-output-schema-'));
console.log(`Isolated fixture: ${fixture}`);
try {
  for (const dir of ['agent/channels', 'evals']) await mkdir(join(fixture, dir), { recursive: true });
  await writeFile(join(fixture, 'package.json'), JSON.stringify({ name: 'rove-eve-output-schema-fixture', type: 'module', dependencies: { eve: '^0.75.1' } }));
  const nodeModules = join(root, 'node_modules');
  const { symlink } = await import('node:fs/promises');
  await symlink(nodeModules, join(fixture, 'node_modules'), 'dir');
  await writeFile(join(fixture, 'agent/instructions.md'), 'Answer with the structured result when one is required.');
  await writeFile(join(fixture, 'agent/channels/eve.ts'), `import { eveChannel } from 'eve/channels/eve';
import { localDev } from 'eve/channels/auth';
export default eveChannel({ auth: [localDev()] });
`);
  await writeFile(join(fixture, 'agent/agent.ts'), `import { defineAgent } from 'eve';
import { mockModel } from 'eve/evals';
let rejectedExtra = false;
export default defineAgent({
  defaultTools: false,
  modelContextWindowTokens: 128_000,
  model: mockModel(({ lastUserMessage, tools, toolResults }) => {
    let input: any = {};
    try { input = JSON.parse(lastUserMessage ?? '{}'); } catch { /* prose */ }
    const mode = input && typeof input === 'object' && 'mode' in input ? input.mode : '';
    if ((mode === 'structured' || mode === 'invalid') && !tools.some(tool => tool.name === 'final_output')) {
      throw new Error('final_output was not advertised');
    }
    if (mode === 'structured') {
      if (toolResults.some(result => result.name === 'final_output')) return 'Structured result already submitted.';
      return { toolCalls: [{ name: 'final_output', input: input.result }] };
    }
    if (mode === 'invalid') {
      if (!rejectedExtra) {
        rejectedExtra = true;
        return { toolCalls: [{ name: 'final_output', input: input.result }] };
      }
      return 'The extra field was rejected.';
    }
    return 'A prose answer that does not call final_output.';
  }),
});
`);
  await writeFile(join(fixture, 'evals/evals.config.ts'), `import { defineEvalConfig } from 'eve/evals';
export default defineEvalConfig({});
`);
  await writeFile(join(fixture, 'evals/output-schema.eval.ts'), `import { defineEval } from 'eve/evals';
import { equals } from 'eve/evals/expect';
const schema = ${JSON.stringify(schema)};
const expected = ${JSON.stringify(expected)};
const invalid = ${JSON.stringify(invalid)};
export default defineEval({
  timeoutMs: 60_000,
  async test(t) {
    const ok = await t.send(JSON.stringify({ mode: 'structured', result: expected }), { outputSchema: schema });
    ok.succeeded();
    t.check(ok.data, equals(expected));
    t.check(completedAfterMessage(ok), equals(true));
    t.check(schemaFailure(ok) === undefined, equals(true));
    t.log('structured data matched the envelope');
    const prose = await ok.session.send(JSON.stringify({ mode: 'prose' }), { outputSchema: schema });
    t.check(schemaFailure(prose)?.data?.code, equals('OUTPUT_SCHEMA_NOT_FULFILLED'));
    t.check(schemaFailure(prose)?.data?.message, equals('The agent could not produce a result matching the requested schema.'));
    t.check(completedAfterMessage(prose), equals(false));
    t.log('prose rejected');
    const rejected = await ok.session.send(JSON.stringify({ mode: 'invalid', result: invalid }), { outputSchema: schema });
    t.check(schemaFailure(rejected)?.data?.code, equals('OUTPUT_SCHEMA_NOT_FULFILLED'));
    t.check(completedAfterMessage(rejected), equals(false));
    t.log('extra field rejected');
  },
});
function eventsAfterMessage(turn) {
  const events = turn.events ?? [];
  const start = events.findIndex(event => event.type === 'message.received');
  return events.slice(start < 0 ? 0 : start);
}
function schemaFailure(turn) {
  return eventsAfterMessage(turn).find(event => event.type === 'turn.failed' && event.data?.code === 'OUTPUT_SCHEMA_NOT_FULFILLED');
}
function completedAfterMessage(turn) {
  return eventsAfterMessage(turn).some(event => event.type === 'result.completed');
}
`);
  const cli = join(root, 'node_modules/eve/bin/eve.js');
  const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'SYSTEMROOT'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
  const result = spawnSync(process.execPath, [cli, 'eval', 'output-schema', '--json', '--timeout', '60000', '--max-concurrency', '1', '--skip-report'], {
    cwd: fixture, env, encoding: 'utf8', timeout: 180_000, maxBuffer: 8 * 1024 * 1024,
  });
  console.log(result.stdout);
  console.error(result.stderr);
  if (result.error) console.error(result.error.message);
  assert.equal(result.status, 0, 'Eve outputSchema eval failed');
  const report = parseReport(result.stdout);
  const results = report.results ?? report.evals ?? [];
  assert.ok(Array.isArray(results) && results.length === 1, 'Expected one eval result');
  for (const item of results) assert.equal(item.verdict ?? item.status, 'passed');
  console.log('Eve outputSchema enforcement passed');
} finally {
  await rm(fixture, { recursive: true, force: true });
}

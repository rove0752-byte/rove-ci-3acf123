import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_RESULT_LIMITS, ResultSchemaError, agentRunTurn, compileAgentOutputSchema, validateAgentResult } from '../agent/lib/result-schema.ts';

const evidence = { url: 'https://example.com/', evidenceId: 'ev-1', capturedAt: '2026-10-11T00:00:00Z', excerpt: 'Example Domain' };

function result(data: unknown, extra: Record<string, unknown> = {}) {
  return { status: 'completed', summary: 'Example Domain is a placeholder.', data, evidence: [evidence], limitations: ['JavaScript was not executed.'], ...extra };
}

const closed = {
  type: 'object',
  additionalProperties: false,
  required: ['title'],
  properties: { title: { type: 'string', minLength: 1, maxLength: 80 } },
};

test('accepts the default envelope for object and array data', () => {
  const objectResult = validateAgentResult(result({ title: 'Example', missing: null }));
  assert.equal(objectResult.status, 'completed');
  assert.deepEqual(objectResult.data, { title: 'Example', missing: null });
  assert.deepEqual(validateAgentResult(result(['Example'])).data, ['Example']);
  const schema = compileAgentOutputSchema();
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ['status', 'summary', 'data', 'evidence', 'limitations']);
  assert.deepEqual(schema.properties.data, { type: ['object', 'array'] });
});

test('rejects results that break the envelope', () => {
  const rejects = (value: unknown, pattern: RegExp) => assert.throws(() => validateAgentResult(value), pattern);
  const { evidence: _removed, ...missingEvidence } = result({});
  rejects(missingEvidence, /missing required property "evidence"/);
  rejects(result({}, { notes: 'extra' }), /unexpected property "notes"/);
  rejects(result('text'), /result\.data: expected object or array/);
  rejects({ ...result({}), status: 'done' }, /expected one of "completed", "partial"/);
  rejects({ ...result({}), summary: '' }, /shorter than 1/);
  rejects({ ...result({}), summary: 'x'.repeat(AGENT_RESULT_LIMITS.summary + 1) }, new RegExp(`longer than ${AGENT_RESULT_LIMITS.summary}`));
  rejects({ ...result({}), evidence: Array.from({ length: AGENT_RESULT_LIMITS.evidence + 1 }, () => evidence) }, /too many items/);
  rejects({ ...result({}), evidence: [{ ...evidence, html: '<p>' }] }, /unexpected property "html"/);
  rejects({ ...result({}), limitations: [''] }, /shorter than 1/);
  rejects({ ...result({}), limitations: ['x'.repeat(AGENT_RESULT_LIMITS.limitationLength + 1)] }, new RegExp(`longer than ${AGENT_RESULT_LIMITS.limitationLength}`));
  assert.equal(validateAgentResult({ ...result({}), status: 'partial', limitations: [] }).status, 'partial');
});

test('caller schema replaces only the data slot', () => {
  const input = structuredClone(closed);
  const compiled = compileAgentOutputSchema(input);
  input.properties.title.maxLength = 1;
  const dataSchema = compiled.properties.data as { properties: { title: { maxLength: number } }; additionalProperties: boolean };
  assert.equal(dataSchema.properties.title.maxLength, 80);
  assert.equal(dataSchema.additionalProperties, false);
  const accepted = validateAgentResult(result({ title: 'Example' }), closed);
  assert.equal((accepted.data as { title: string }).title, 'Example');
  assert.throws(() => validateAgentResult(result({}), closed), /missing required property "title"/);
  assert.throws(() => validateAgentResult(result({ title: 'Example', extra: 1 }), closed), /unexpected property "extra"/);
  const open = { type: 'object', required: ['title'], properties: { title: { type: 'string' } } };
  assert.deepEqual(validateAgentResult(result({ title: 'Example', extra: 1 }), open).data, { title: 'Example', extra: 1 });
  const counted = { type: 'object', properties: { count: { type: 'integer', minimum: 0, maximum: 5, exclusiveMaximum: 5 } } };
  assert.equal((validateAgentResult(result({ count: 4 }), counted).data as { count: number }).count, 4);
  assert.throws(() => validateAgentResult(result({ count: 4.5 }), counted), /expected integer/);
  assert.throws(() => validateAgentResult(result({ count: 5 }), counted), /exclusive maximum/);
});

test('rejects unsafe or oversized caller schemas before a model call', () => {
  const rejects = (schema: unknown, pattern: RegExp) => assert.throws(() => compileAgentOutputSchema(schema), (error: unknown) => {
    assert.ok(error instanceof ResultSchemaError);
    assert.match(error.message, pattern);
    return true;
  });
  rejects({ type: 'object', properties: { a: { $ref: 'https://evil.example/schema' } } }, /unsupported keyword "\$ref"/);
  rejects({ type: 'string', pattern: '^(a+)+$' }, /unsupported keyword "pattern"/);
  rejects({ type: 'string', format: 'email' }, /unsupported keyword "format"/);
  for (const schema of [[], null, 'object', 1, true]) rejects(schema, /must be a JSON object/);
  rejects({ type: 'array', items: [{ type: 'string' }] }, /tuple item schemas/);
  let deep: Record<string, unknown> = { type: 'string' };
  for (let i = 0; i < AGENT_RESULT_LIMITS.schemaDepth; i += 1) deep = { type: 'array', items: deep };
  rejects(deep, /maximum depth/);
  const wide: Record<string, unknown> = {};
  for (let i = 0; i < 40; i += 1) wide[`p${i}`] = { type: 'object', properties: { a: { type: 'string' } } };
  rejects({ type: 'object', properties: wide }, /schema nodes/);
  const heavy: Record<string, unknown> = {};
  for (let i = 0; i < 30; i += 1) heavy[`p${i}`] = { type: 'string', description: 'x'.repeat(AGENT_RESULT_LIMITS.description) };
  rejects({ type: 'object', properties: heavy }, /exceeds 8000 bytes/);
  const cycle: Record<string, unknown> = { type: 'object' };
  cycle.properties = { self: cycle };
  rejects(cycle, /cycle/);
  rejects({ type: 'object', additionalProperties: false, required: ['title'], properties: {} }, /is not a declared property/);
  let bounded: Record<string, unknown> = { type: 'string' };
  for (let i = 0; i < AGENT_RESULT_LIMITS.schemaDepth - 1; i += 1) bounded = { type: 'array', items: bounded };
  assert.equal(compileAgentOutputSchema(bounded).type, 'object');
});

test('the agent run keeps outputFormat as a prompt hint and passes the compiled schema', () => {
  const turn = agentRunTurn({ url: 'https://example.com/start', task: 'Summarise the page', outputFormat: 'bullets', outputSchema: closed });
  assert.deepEqual(JSON.parse(turn.message), { task: 'Summarise the page', startUrl: 'https://example.com/start', outputFormat: 'bullets' });
  assert.equal(JSON.parse(turn.message).outputSchema, undefined);
  const data = turn.outputSchema.properties as unknown as { data: { required: string[] } };
  assert.equal(data.data.required[0], 'title');
  const fallback = agentRunTurn({ url: 'https://example.com/start', task: 'Summarise the page' });
  assert.equal(JSON.parse(fallback.message).outputFormat, 'JSON');
  assert.throws(() => agentRunTurn({ url: 'https://example.com', task: 'Find prices', outputSchema: { type: 'object', properties: { a: { $ref: '#/' } } } }), ResultSchemaError);
});

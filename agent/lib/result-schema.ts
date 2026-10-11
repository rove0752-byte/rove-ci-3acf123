// Caller schemas are a bounded JSON Schema subset placed only in `data`.
// $ref and pattern are rejected so a request cannot name a remote document or supply a regular expression.
// Eve validates this object at runtime with its JSON Schema validator. This module checks the same subset locally.

export const AGENT_RESULT_LIMITS = {
  schemaBytes: 8000,
  schemaDepth: 8,
  schemaNodes: 80,
  properties: 40,
  description: 300,
  enumValues: 30,
  enumLength: 200,
  stringLength: 4000,
  arrayItems: 50,
  summary: 4000,
  evidence: 12,
  excerpt: 2000,
  evidenceUrl: 2048,
  evidenceId: 80,
  capturedAt: 40,
  limitations: 20,
  limitationLength: 500,
} as const;

export class ResultSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResultSchemaError';
  }
}

export interface AgentEvidence {
  url: string;
  evidenceId: string;
  capturedAt: string;
  excerpt: string;
}

export interface AgentResult {
  status: 'completed' | 'partial';
  summary: string;
  data: unknown;
  evidence: AgentEvidence[];
  limitations: string[];
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export interface AgentOutputSchema {
  [key: string]: JsonValue;
  type: 'object';
  additionalProperties: false;
  required: ['status', 'summary', 'data', 'evidence', 'limitations'];
  properties: {
    status: { type: 'string'; enum: ['completed', 'partial'] };
    summary: { type: 'string'; minLength: 1; maxLength: number };
    data: { [key: string]: JsonValue };
    evidence: { [key: string]: JsonValue };
    limitations: { [key: string]: JsonValue };
  };
}

interface Schema {
  type?: string | string[];
  description?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: Schema;
  enum?: JsonValue[];
  const?: JsonValue;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  minProperties?: number;
  maxProperties?: number;
}

const KEYWORDS = new Set([
  'type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength',
  'minItems', 'maxItems', 'minProperties', 'maxProperties', 'description',
]);
const TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null']);
const FORBIDDEN_NAMES = new Set(['__proto__', 'constructor', 'prototype']);
const KEYWORDS_FOR: Record<string, readonly string[]> = {
  string: ['minLength', 'maxLength'],
  number: ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum'],
  integer: ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum'],
  object: ['properties', 'required', 'additionalProperties', 'minProperties', 'maxProperties'],
  array: ['items', 'minItems', 'maxItems'],
};

const DEFAULT_DATA: Schema = { type: ['object', 'array'] };

export interface AgentRunInput {
  url: string;
  task: string;
  outputFormat?: string;
  outputSchema?: unknown;
}

export function compileAgentOutputSchema(dataSchema?: unknown): AgentOutputSchema {
  const data = dataSchema === undefined ? DEFAULT_DATA : acceptCallerSchema(dataSchema);
  return structuredClone(envelope(data)) as AgentOutputSchema;
}

export function validateAgentResult(value: unknown, dataSchema?: unknown): AgentResult {
  assertValid(value, envelope(dataSchema === undefined ? DEFAULT_DATA : acceptCallerSchema(dataSchema)), 'result');
  return value as AgentResult;
}

export function agentRunTurn(input: AgentRunInput): { message: string; outputSchema: AgentOutputSchema } {
  return {
    message: JSON.stringify({ task: input.task, startUrl: input.url, outputFormat: input.outputFormat ?? 'JSON' }),
    outputSchema: compileAgentOutputSchema(input.outputSchema),
  };
}

function envelope(data: Schema): Schema {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['status', 'summary', 'data', 'evidence', 'limitations'],
    properties: {
      status: { type: 'string', enum: ['completed', 'partial'] },
      summary: { type: 'string', minLength: 1, maxLength: AGENT_RESULT_LIMITS.summary },
      data,
      evidence: {
        type: 'array',
        maxItems: AGENT_RESULT_LIMITS.evidence,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['url', 'evidenceId', 'capturedAt', 'excerpt'],
          properties: {
            url: { type: 'string', minLength: 1, maxLength: AGENT_RESULT_LIMITS.evidenceUrl },
            evidenceId: { type: 'string', minLength: 1, maxLength: AGENT_RESULT_LIMITS.evidenceId },
            capturedAt: { type: 'string', minLength: 1, maxLength: AGENT_RESULT_LIMITS.capturedAt },
            excerpt: { type: 'string', maxLength: AGENT_RESULT_LIMITS.excerpt },
          },
        },
      },
      limitations: {
        type: 'array',
        maxItems: AGENT_RESULT_LIMITS.limitations,
        items: { type: 'string', minLength: 1, maxLength: AGENT_RESULT_LIMITS.limitationLength },
      },
    },
  };
}

function acceptCallerSchema(input: unknown): Schema {
  const counter = { nodes: 0 };
  const schema = walk(input, 'outputSchema', 1, [], counter);
  const bytes = Buffer.byteLength(JSON.stringify(schema), 'utf8');
  if (bytes > AGENT_RESULT_LIMITS.schemaBytes) {
    throw new ResultSchemaError(`outputSchema exceeds ${AGENT_RESULT_LIMITS.schemaBytes} bytes.`);
  }
  return schema;
}

function walk(value: unknown, path: string, depth: number, stack: object[], counter: { nodes: number }): Schema {
  if (!isRecord(value)) throw new ResultSchemaError(`${path} must be a JSON object.`);
  if (stack.includes(value)) throw new ResultSchemaError(`${path} contains a cycle.`);
  if (depth > AGENT_RESULT_LIMITS.schemaDepth) {
    throw new ResultSchemaError(`outputSchema exceeds the maximum depth of ${AGENT_RESULT_LIMITS.schemaDepth}.`);
  }
  counter.nodes += 1;
  if (counter.nodes > AGENT_RESULT_LIMITS.schemaNodes) {
    throw new ResultSchemaError(`outputSchema exceeds ${AGENT_RESULT_LIMITS.schemaNodes} schema nodes.`);
  }
  stack.push(value);
  try {
    for (const key of Object.keys(value)) {
      if (!KEYWORDS.has(key)) throw new ResultSchemaError(`${path}: unsupported keyword "${key}".`);
    }
    if (!Object.hasOwn(value, 'type')) throw new ResultSchemaError(`${path} must declare a type.`);
    const declared = readTypes(value.type, path);
    const out: Schema = { type: declared.length === 1 ? declared[0] : declared };
    if (Object.hasOwn(value, 'description')) out.description = readDescription(value.description, `${path}.description`);
    if (Object.hasOwn(value, 'enum')) out.enum = readEnum(value.enum, `${path}.enum`);
    if (Object.hasOwn(value, 'const')) out.const = readPrimitive(value.const, `${path}.const`);
    readNumericKeywords(value, out, path);
    readStringKeywords(value, out, path);
    readArrayKeywords(value, out, path, depth, stack, counter);
    readObjectKeywords(value, out, path, depth, stack, counter);
    const applicable = new Set(['type', 'description', 'enum', 'const']);
    for (const type of declared) for (const key of KEYWORDS_FOR[type] ?? []) applicable.add(key);
    for (const key of Object.keys(out)) {
      if (!applicable.has(key)) throw new ResultSchemaError(`${path}: keyword "${key}" does not apply to the declared type.`);
    }
    checkContradictions(out, path);
    return out;
  } finally {
    stack.pop();
  }
}

function readTypes(value: unknown, path: string): string[] {
  const types = Array.isArray(value) ? value : [value];
  if (types.length < 1 || types.length > TYPES.size) throw new ResultSchemaError(`${path}.type is not a supported type.`);
  const seen = new Set<string>();
  for (const type of types) {
    if (typeof type !== 'string' || !TYPES.has(type) || seen.has(type)) {
      throw new ResultSchemaError(`${path}.type is not a supported type.`);
    }
    seen.add(type);
  }
  return types as string[];
}

function readDescription(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length > AGENT_RESULT_LIMITS.description) {
    throw new ResultSchemaError(`${path} must be a string of at most ${AGENT_RESULT_LIMITS.description} characters.`);
  }
  return value;
}

function readEnum(value: unknown, path: string): JsonValue[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > AGENT_RESULT_LIMITS.enumValues) {
    throw new ResultSchemaError(`${path} must contain 1 to ${AGENT_RESULT_LIMITS.enumValues} values.`);
  }
  return value.map((item, index) => readPrimitive(item, `${path}[${index}]`));
}

function readPrimitive(value: unknown, path: string): JsonValue {
  if (typeof value === 'string') {
    if (value.length > AGENT_RESULT_LIMITS.enumLength) throw new ResultSchemaError(`${path} exceeds ${AGENT_RESULT_LIMITS.enumLength} characters.`);
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'boolean' || value === null) return value;
  throw new ResultSchemaError(`${path} must be a string, number, boolean or null.`);
}

function readNumericKeywords(source: Record<string, unknown>, out: Schema, path: string): void {
  for (const key of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum'] as const) {
    if (!Object.hasOwn(source, key)) continue;
    const value = source[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new ResultSchemaError(`${path}.${key} must be a finite number.`);
    out[key] = value;
  }
}

function readStringKeywords(source: Record<string, unknown>, out: Schema, path: string): void {
  for (const key of ['minLength', 'maxLength'] as const) {
    if (!Object.hasOwn(source, key)) continue;
    out[key] = readCount(source[key], `${path}.${key}`, AGENT_RESULT_LIMITS.stringLength);
  }
}

function readArrayKeywords(source: Record<string, unknown>, out: Schema, path: string, depth: number, stack: object[], counter: { nodes: number }): void {
  for (const key of ['minItems', 'maxItems'] as const) {
    if (!Object.hasOwn(source, key)) continue;
    out[key] = readCount(source[key], `${path}.${key}`, AGENT_RESULT_LIMITS.arrayItems);
  }
  if (!Object.hasOwn(source, 'items')) return;
  if (Array.isArray(source.items)) throw new ResultSchemaError(`${path}.items: tuple item schemas are not supported.`);
  out.items = walk(source.items, `${path}.items`, depth + 1, stack, counter);
}

function readObjectKeywords(source: Record<string, unknown>, out: Schema, path: string, depth: number, stack: object[], counter: { nodes: number }): void {
  for (const key of ['minProperties', 'maxProperties'] as const) {
    if (!Object.hasOwn(source, key)) continue;
    out[key] = readCount(source[key], `${path}.${key}`, AGENT_RESULT_LIMITS.properties);
  }
  if (Object.hasOwn(source, 'additionalProperties')) {
    if (typeof source.additionalProperties !== 'boolean') {
      throw new ResultSchemaError(`${path}.additionalProperties must be a boolean.`);
    }
    out.additionalProperties = source.additionalProperties;
  }
  if (Object.hasOwn(source, 'properties')) {
    if (!isRecord(source.properties)) throw new ResultSchemaError(`${path}.properties must be a JSON object.`);
    const names = Object.keys(source.properties);
    if (names.length > AGENT_RESULT_LIMITS.properties) {
      throw new ResultSchemaError(`${path}: exceeds ${AGENT_RESULT_LIMITS.properties} properties.`);
    }
    out.properties = {};
    for (const name of names) {
      checkName(name, path);
      out.properties[name] = walk(source.properties[name], `${path}.properties.${name}`, depth + 1, stack, counter);
    }
  }
  if (Object.hasOwn(source, 'required')) {
    if (!Array.isArray(source.required)) throw new ResultSchemaError(`${path}.required must be an array of strings.`);
    if (source.required.length > AGENT_RESULT_LIMITS.properties) {
      throw new ResultSchemaError(`${path}.required exceeds ${AGENT_RESULT_LIMITS.properties} names.`);
    }
    const required: string[] = [];
    const seen = new Set<string>();
    for (const name of source.required) {
      if (typeof name !== 'string') throw new ResultSchemaError(`${path}.required must be an array of strings.`);
      checkName(name, path);
      if (seen.has(name)) throw new ResultSchemaError(`${path}.required contains a duplicate.`);
      seen.add(name);
      required.push(name);
    }
    out.required = required;
  }
}

function checkContradictions(schema: Schema, path: string): void {
  if (schema.minLength !== undefined && schema.maxLength !== undefined && schema.minLength > schema.maxLength) {
    throw new ResultSchemaError(`${path}: minLength exceeds maxLength.`);
  }
  if (schema.minItems !== undefined && schema.maxItems !== undefined && schema.minItems > schema.maxItems) {
    throw new ResultSchemaError(`${path}: minItems exceeds maxItems.`);
  }
  if (schema.minProperties !== undefined && schema.maxProperties !== undefined && schema.minProperties > schema.maxProperties) {
    throw new ResultSchemaError(`${path}: minProperties exceeds maxProperties.`);
  }
  if (schema.minimum !== undefined && schema.maximum !== undefined && schema.minimum > schema.maximum) {
    throw new ResultSchemaError(`${path}: minimum exceeds maximum.`);
  }
  if (schema.exclusiveMinimum !== undefined && schema.exclusiveMaximum !== undefined && schema.exclusiveMinimum >= schema.exclusiveMaximum) {
    throw new ResultSchemaError(`${path}: exclusiveMinimum exceeds exclusiveMaximum.`);
  }
  if (schema.additionalProperties !== false) return;
  const declared = new Set(Object.keys(schema.properties ?? {}));
  for (const name of schema.required ?? []) {
    if (!declared.has(name)) throw new ResultSchemaError(`${path}.required: "${name}" is not a declared property.`);
  }
  if ((schema.minProperties ?? 0) > declared.size) {
    throw new ResultSchemaError(`${path}: minProperties exceeds the declared properties.`);
  }
}

function readCount(value: unknown, path: string, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > max) {
    throw new ResultSchemaError(`${path} must be an integer from 0 to ${max}.`);
  }
  return value;
}

function checkName(name: string, path: string): void {
  if (FORBIDDEN_NAMES.has(name) || name.length < 1 || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new ResultSchemaError(`${path}: unsupported property name.`);
  }
}

function assertValid(value: unknown, schema: Schema, path: string): void {
  const types = schema.type === undefined ? undefined : Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types && !types.some(type => matchesType(value, type))) {
    throw new ResultSchemaError(`${path}: expected ${types.join(' or ')}.`);
  }
  if (Object.hasOwn(schema, 'const') && !same(value, schema.const)) {
    throw new ResultSchemaError(`${path}: expected the required constant.`);
  }
  if (schema.enum && !schema.enum.some(item => same(value, item))) {
    throw new ResultSchemaError(`${path}: expected one of ${schema.enum.map(item => JSON.stringify(item)).join(', ')}.`);
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      throw new ResultSchemaError(`${path}: shorter than ${schema.minLength} characters.`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      throw new ResultSchemaError(`${path}: longer than ${schema.maxLength} characters.`);
    }
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (schema.minimum !== undefined && value < schema.minimum) throw new ResultSchemaError(`${path}: below the minimum.`);
    if (schema.maximum !== undefined && value > schema.maximum) throw new ResultSchemaError(`${path}: above the maximum.`);
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) {
      throw new ResultSchemaError(`${path}: below the exclusive minimum.`);
    }
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) {
      throw new ResultSchemaError(`${path}: above the exclusive maximum.`);
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) throw new ResultSchemaError(`${path}: has too few items.`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) throw new ResultSchemaError(`${path}: has too many items.`);
    if (schema.items) value.forEach((item, index) => assertValid(item, schema.items as Schema, `${path}[${index}]`));
  }
  if (!isRecord(value)) return;
  const keys = Object.keys(value);
  if (schema.minProperties !== undefined && keys.length < schema.minProperties) {
    throw new ResultSchemaError(`${path}: has too few properties.`);
  }
  if (schema.maxProperties !== undefined && keys.length > schema.maxProperties) {
    throw new ResultSchemaError(`${path}: has too many properties.`);
  }
  const properties = schema.properties ?? {};
  for (const name of schema.required ?? []) {
    if (!Object.hasOwn(value, name)) throw new ResultSchemaError(`${path}: missing required property "${name}".`);
  }
  for (const key of keys) {
    if (Object.hasOwn(properties, key)) assertValid(value[key], properties[key] as Schema, `${path}.${key}`);
    else if (schema.additionalProperties === false) throw new ResultSchemaError(`${path}: unexpected property "${key}".`);
  }
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    case 'array': return Array.isArray(value);
    case 'object': return isRecord(value);
    default: return false;
  }
}

function same(left: unknown, right: unknown): boolean {
  return typeof left === 'number' && typeof right === 'number' ? left === right : left === right;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

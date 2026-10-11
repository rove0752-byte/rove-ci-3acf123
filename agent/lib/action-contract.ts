import { z } from 'zod';
import { fixturePreviewUrl } from './interaction-fixture.ts';

export const ACTION_LIMITS = {
  lifetimeMs: 60_000,
  idleMs: 20_000,
  operationMs: 10_000,
  maxActions: 10,
  maxSessions: 4,
  nameLength: 100,
  textLength: 1000,
  urlLength: 2048,
  optionLength: 100,
} as const;

export const FIXTURE_POLICY_ERROR = 'Action blocked by controlled fixture policy.';
export const LIVE_SIDE_EFFECT_ERROR = 'Live side effects are disabled.';

const target = {
  role: z.enum(['button', 'textbox', 'checkbox', 'radio', 'link']),
  name: z.string().min(1).max(ACTION_LIMITS.nameLength),
};
const session = { sessionId: z.string().uuid() };

export const interactionInput = z.discriminatedUnion('action', [
  z.object({ action: z.literal('start') }).strict(),
  z.object({ action: z.literal('click'), ...session, ...target }).strict(),
  z.object({ action: z.literal('type'), ...session, ...target, text: z.string().max(ACTION_LIMITS.textLength) }).strict(),
  z.object({
    action: z.literal('select'), ...session, role: z.literal('combobox'),
    name: z.string().min(1).max(ACTION_LIMITS.nameLength),
    option: z.string().min(1).max(ACTION_LIMITS.optionLength),
  }).strict(),
  z.object({ action: z.literal('navigate'), ...session, url: z.string().min(1).max(ACTION_LIMITS.urlLength) }).strict(),
  z.object({ action: z.literal('snapshot'), ...session }).strict(),
  z.object({ action: z.literal('close'), ...session }).strict(),
  z.object({ action: z.literal('submit'), ...session }).strict(),
  z.object({ action: z.literal('purchase'), ...session }).strict(),
  z.object({ action: z.literal('authenticate'), ...session }).strict(),
  z.object({ action: z.literal('transfer'), ...session, kind: z.enum(['upload', 'download']) }).strict(),
]);

export type InteractionInput = z.infer<typeof interactionInput>;
export type SideEffect = 'external-navigation' | 'submission' | 'purchase' | 'authentication' | 'transfer' | 'other-side-effect';
export type BrowserActionClass =
  | { disposition: 'fixture'; effect: 'read' | 'local-input' | 'local-navigation' }
  | { disposition: 'deny'; reason: string }
  | { disposition: 'approval-required'; effect: SideEffect };

const SIDE_EFFECT_TARGETS: Record<string, SideEffect> = {
  'button\u0000Buy now': 'purchase',
  'button\u0000Sign in': 'authentication',
  'button\u0000Submit GET': 'submission',
  'button\u0000Submit POST': 'submission',
  'link\u0000Download': 'transfer',
  'link\u0000External page': 'external-navigation',
  'textbox\u0000Account password': 'authentication',
  'textbox\u0000Upload file': 'transfer',
};

function targetKey(role: string, name: string): string {
  return `${role}\u0000${name}`;
}

function sideEffect(effect: SideEffect): BrowserActionClass {
  return { disposition: 'approval-required', effect };
}

function classifiedTarget(role: string, name: string): BrowserActionClass {
  const effect = SIDE_EFFECT_TARGETS[targetKey(role, name)];
  return effect ? sideEffect(effect) : { disposition: 'deny', reason: FIXTURE_POLICY_ERROR };
}

export function authoredFixtureUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    if (url.username || url.password || url.search || url.hash) return undefined;
    return url.href === fixturePreviewUrl ? fixturePreviewUrl : undefined;
  } catch {
    return undefined;
  }
}

function classifyNavigation(raw: string): BrowserActionClass {
  if (authoredFixtureUrl(raw)) return { disposition: 'fixture', effect: 'local-navigation' };
  try {
    const url = new URL(raw);
    if ((url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password &&
        url.hostname.replace(/^\[|\]$/g, '').toLowerCase() !== 'rove-fixture.invalid') {
      return sideEffect('external-navigation');
    }
  } catch { /* A URL that does not parse is still a refused side effect. */ }
  return sideEffect('other-side-effect');
}

export function classifyBrowserAction(input: InteractionInput): BrowserActionClass {
  switch (input.action) {
    case 'start':
    case 'snapshot':
    case 'close':
      return { disposition: 'fixture', effect: 'read' };
    case 'submit':
      return sideEffect('submission');
    case 'purchase':
      return sideEffect('purchase');
    case 'authenticate':
      return sideEffect('authentication');
    case 'transfer':
      return sideEffect('transfer');
    case 'navigate':
      return classifyNavigation(input.url);
    case 'type':
      if (input.role === 'textbox' && input.name === 'Draft note') return { disposition: 'fixture', effect: 'local-input' };
      return classifiedTarget(input.role, input.name);
    case 'click':
      if ((input.role === 'checkbox' && input.name === 'Show details') ||
          (input.role === 'radio' && input.name === 'Compact view') ||
          (input.role === 'button' && input.name === 'Preview draft')) {
        return { disposition: 'fixture', effect: 'local-input' };
      }
      return classifiedTarget(input.role, input.name);
    case 'select':
      if (input.name === 'Sort by' && (input.option === 'Name' || input.option === 'Date')) {
        return { disposition: 'fixture', effect: 'local-input' };
      }
      return { disposition: 'deny', reason: FIXTURE_POLICY_ERROR };
    default: {
      const unreachable: never = input;
      return unreachable;
    }
  }
}

export function approvalForInteraction(raw: unknown) {
  const parsed = interactionInput.safeParse(raw);
  if (!parsed.success) return { type: 'denied' as const, reason: 'Browser action is not in the controlled contract.' };
  const decision = classifyBrowserAction(parsed.data);
  if (decision.disposition === 'fixture') return 'not-applicable' as const;
  if (decision.disposition === 'deny') return { type: 'denied' as const, reason: decision.reason };
  return 'user-approval' as const;
}

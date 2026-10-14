// robots.ts unit tests (review t26 N3, N4, N6). No Docker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { robotsFromBytes, parseRobots, disallowed, wildcardMatch, normalisePath, LIMITS } from '../robots.ts';
const UA = 'RoveStageA/0.1';
const dis = (txt: string, path: string) => disallowed(parseRobots(txt, UA).rules, path);

test('N3: catastrophic pattern from the review completes in linear-ish time', () => {
  const t0 = performance.now();
  assert.equal(wildcardMatch('/' + 'a*'.repeat(30) + 'b', '/' + 'a'.repeat(40)), false);
  assert.ok(performance.now() - t0 < 50);
  const t1 = performance.now();
  const rules = parseRobots('User-agent: *\n' + Array.from({ length: 1000 }, () => 'Disallow: /' + 'a*'.repeat(200) + 'b').join('\n'), UA);
  const r = disallowed(rules.rules, '/' + 'a'.repeat(2000));
  assert.ok(r === false || r === 'budget');
  assert.ok(performance.now() - t1 < 3000, `worst case bounded (${performance.now() - t1} ms)`);
});
test('N3: caps fail closed (deny-all with a reason)', () => {
  assert.equal(parseRobots('User-agent: *\n' + 'Disallow: /x\n'.repeat(LIMITS.rules + 1), UA).error, 'too-many-rules');
  assert.equal(parseRobots('User-agent: *\nDisallow: /' + 'x'.repeat(LIMITS.patternChars), UA).error, 'pattern-too-long');
  assert.equal(parseRobots('#'.repeat(LIMITS.bodyBytes + 1), UA).error, 'body-too-large');
  for (const e of ['too-many-rules']) assert.equal(disallowed(parseRobots('User-agent: *\n' + 'Disallow: /x\n'.repeat(LIMITS.rules + 1), UA).rules, '/anything'), true, e);
  assert.equal(disallowed([{ allow: false, pattern: '/x' }], '/' + 'a'.repeat(LIMITS.pathChars + 1)), 'budget');
  assert.equal(wildcardMatch('*a*a*a*a*b', 'a'.repeat(5000), 1000), null, 'step budget');
});
test('N4: CR, LF and CRLF line endings', () => {
  for (const eol of ['\r', '\n', '\r\n']) assert.equal(dis(`User-agent: *${eol}Disallow: /private${eol}`, '/private/x'), true, JSON.stringify(eol));
});
test('N4: user-agent matching is exact product token, case-insensitive', () => {
  const base = 'User-agent: *\nDisallow: /\n\n';
  assert.equal(dis(base + 'User-agent: a\nAllow: /\n', '/x'), true, "'a' must not match RoveStageA");
  assert.equal(dis(base + 'User-agent: stage\nAllow: /\n', '/x'), true);
  assert.equal(dis(base + 'User-agent: rove\nAllow: /\n', '/x'), true);
  assert.equal(dis(base + 'User-agent: ROVESTAGEA\nAllow: /\n', '/x'), false);
});
test('N4: percent-encoded patterns are decoded; undecodable pattern fails closed', () => {
  assert.equal(dis('User-agent: *\nDisallow: /%70rivate\n', '/private/x'), true);
  const bad = parseRobots('User-agent: *\nDisallow: /%zz\n', UA);
  assert.equal(bad.error, 'pattern-decode-failure');
  assert.equal(disallowed(bad.rules, '/anything'), true);
});
test('robots: Allow longest match, $ anchor, * wildcard', () => {
  const t = 'User-agent: *\nDisallow: /p\nAllow: /p/ok\nDisallow: /*.pdf$\n';
  assert.equal(dis(t, '/p/x'), true); assert.equal(dis(t, '/p/ok/1'), false);
  assert.equal(dis(t, '/a/b.pdf'), true); assert.equal(dis(t, '/a/b.pdf?x'), false);
});
test('N6: normalisePath flags %2F separately; %2F + dot segment is a bypass', () => {
  assert.deepEqual(normalisePath('/files/a%2Fb'), { path: '/files/a%2Fb', encodedSlash: true });
  assert.deepEqual(normalisePath('/a%2F..%2Fprivate'), { bypass: 'dot-segment' });
  assert.deepEqual(normalisePath('/%2570'), { bypass: 'double-encoding' });
});

test('t27u: ambiguous/unsupported robots input fails closed', () => {
  const deny = (b: Buffer, why: string) => { const r = robotsFromBytes(b, UA); assert.equal(r.error, why); assert.equal(disallowed(r.rules, '/x'), true); };
  deny(Buffer.from([0x55, 0x73, 0xff, 0xfe, 0x0a]), 'invalid-utf8');
  deny(Buffer.from('User-agent: *\nAllow: /\u0000\n'), 'nul-byte');
  deny(Buffer.from('<!doctype html><html>oops</html>'), 'html-not-robots');
  deny(Buffer.alloc(LIMITS.bodyBytes + 1, 0x23), 'body-too-large');
  assert.equal(disallowed(robotsFromBytes(Buffer.from('\uFEFFUser-agent: *\nDisallow: /p\n'), UA).rules, '/p'), true, 'BOM stripped');
  assert.equal(disallowed(robotsFromBytes(Buffer.from(''), UA).rules, '/x'), false, 'empty robots = allow (RFC 9309)');
});

test('R3-4: query strings are part of the match (RFC 9309)', () => {
  const t = 'User-agent: *\nDisallow: /search?q=\nDisallow: /*?sid=\n';
  assert.equal(dis(t, '/search?q=x'), true); assert.equal(dis(t, '/search?p=1'), false); assert.equal(dis(t, '/search'), false);
  assert.equal(dis(t, '/a?sid=1'), true); assert.equal(dis('User-agent: *\nDisallow: /x$\n', '/x?y'), false);
});

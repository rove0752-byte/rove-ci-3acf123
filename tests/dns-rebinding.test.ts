import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectPinnedAddresses } from '../agent/lib/browser.ts';
import { peerFailure } from '../agent/lib/egress-proxy.ts';
import { publicAddress } from '../agent/lib/public-address.ts';

// Local rebinding stub: the first answer is public, every later answer is private.
function rebindingResolver(privateAnswer: string) {
  let calls = 0;
  return () => (calls++ === 0 ? [{ address: '93.184.215.14', family: 4 }] : [{ address: privateAnswer, family: privateAnswer.includes(':') ? 6 : 4 }]);
}

test('a rebinding answer at pin time is rejected: the pinned set is checked independently of validation', () => {
  for (const target of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '::1', '::ffff:7f00:1', '64:ff9b::7f00:1', '2002:7f00:1::', 'fe80::1', 'fd00::1']) {
    const stub = rebindingResolver(target);
    assert.deepEqual(selectPinnedAddresses(stub() as never), [{ address: '93.184.215.14', family: 4 }], 'validation-time answer is public');
    assert.throws(() => selectPinnedAddresses(stub() as never), /Private and reserved/, target);
  }
});

test('a mixed answer set with any private address is rejected as a whole', () => {
  assert.throws(() => selectPinnedAddresses([{ address: '93.184.215.14', family: 4 }, { address: '10.0.0.1', family: 4 }]), /blocked/);
  assert.throws(() => selectPinnedAddresses([]), /blocked/);
});

test('blocked ranges include loopback, link-local, private, CGNAT, 6to4, NAT64, mapped, Teredo and the 6to4 relay', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '198.18.0.1',
    '192.88.99.1', '224.0.0.1', '255.255.255.255',
    '::1', '::', 'fe80::1', 'fc00::1', 'fd00:ec2::254', '::ffff:7f00:1', '64:ff9b::a00:1', '2002:a00:1::', '2001:0:4136:e378::1', '2001:db8::1']) {
    assert.equal(publicAddress(address), false, address);
  }
  for (const address of ['93.184.215.14', '8.8.8.8', '2606:4700::1111']) assert.equal(publicAddress(address), true, address);
});

test('post-connect verification rejects a peer that differs from the pinned literal', () => {
  assert.equal(peerFailure('93.184.215.14', '93.184.215.14'), null);
  assert.equal(peerFailure('::ffff:93.184.215.14', '93.184.215.14'), null);
  assert.equal(peerFailure('[2606:4700::1111]', '2606:4700::1111'), null);
  assert.match(peerFailure('127.0.0.1', '93.184.215.14') ?? '', /does not match/);
  assert.match(peerFailure(undefined, '93.184.215.14') ?? '', /unavailable/);
});

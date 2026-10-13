import {test} from 'node:test';
import assert from 'node:assert/strict';
import {publicAddress,validateUrl} from '../agent/lib/policy.ts';
test('blocks private, loopback, metadata, mapped IPv6 and reserved targets',()=>{
 for(const ip of ['127.0.0.1','10.0.0.1','172.16.0.1','192.168.1.1','169.254.169.254','100.64.0.1','0.0.0.0','::1','::ffff:127.0.0.1','fc00::1','2001:db8::1','2001:0db8::10','2001:0000::1','2001:0002::1']) assert.equal(publicAddress(ip),false,ip);
 for(const ip of ['8.8.8.8','1.1.1.1','2606:4700::1111','2606:4700:4700:0000:0000:0000:0000:1111']) assert.equal(publicAddress(ip),true,ip);
});
test('rejects unsafe protocols, credentials, ports and non-allowlisted hosts',async()=>{
 for(const url of ['file:///etc/passwd','http://127.0.0.1','https://user:pass@example.com','https://example.com:8443'])await assert.rejects(validateUrl(url));
 await assert.rejects(validateUrl('https://example.com','other.example'));
});
test('blocks 6to4 (2002::/16) addresses, including ones embedding private IPv4 targets',async()=>{
 // 2002:AABB:CCDD:: embeds IPv4 AA.BB.CC.DD.
 const embedded={'127.0.0.1':'2002:7f00:1::','10.0.0.1':'2002:a00:1::','192.168.1.1':'2002:c0a8:101::','172.16.0.1':'2002:ac10:1::','169.254.169.254':'2002:a9fe:a9fe::'};
 for(const [ipv4,ip] of Object.entries(embedded)){
  assert.equal(publicAddress(ip),false,`${ip} embeds ${ipv4}`);
  assert.equal(publicAddress(ip.toUpperCase()),false,`${ip} uppercase`);
  await assert.rejects(validateUrl(`http://[${ip}]/`),/Private and reserved/,ip);
 }
 // A 6to4 address embedding a public IPv4 is also refused; the whole prefix is blocked.
 assert.equal(publicAddress('2002:808:808::1'),false);
 assert.equal(publicAddress('2002::'),false);
 // Neighbouring global unicast ranges are unaffected.
 for(const ip of ['2001:4860:4860::8888','2003::1','2606:4700::1111']) assert.equal(publicAddress(ip),true,ip);
});

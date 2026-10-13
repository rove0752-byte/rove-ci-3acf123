import {test} from 'node:test';
import assert from 'node:assert/strict';
import {authorize,isLoopbackAddress,principalFor,SessionOwners} from '../agent/lib/auth.ts';
const req=(h:Record<string,string>={})=>new Request('http://localhost/v1/health',{headers:h});
test('spoofed Host: localhost with no key and no opt-in is 401',()=>{
 const r=authorize(new Request('http://localhost/v1/health',{headers:{host:'localhost'}}),'203.0.113.9',{});
 assert.deepEqual(r,{ok:false,status:401});
 assert.equal(authorize(req({host:'localhost'}),'127.0.0.1',{}).ok,false,'loopback alone is not enough without opt-in');
});
test('dev opt-in requires loopback socket address, not Host header',()=>{
 const env={ROVE_DEV_NO_AUTH:'1'};
 assert.equal(authorize(req({host:'localhost'}),'203.0.113.9',env).ok,false);
 assert.equal(authorize(req(),null,env).ok,false);
 assert.equal(authorize(req({'x-forwarded-for':'127.0.0.1'}),'198.51.100.1',env).ok,false);
 for(const ip of ['127.0.0.1','::1','[::1]','::ffff:127.0.0.1']) assert.equal(authorize(req(),ip,env).ok,true,ip);
});
test('production always requires the key, even with opt-in on loopback',()=>{
 assert.equal(authorize(req(),'127.0.0.1',{NODE_ENV:'production',ROVE_DEV_NO_AUTH:'1'}).ok,false);
 const env={NODE_ENV:'production',ROVE_API_KEY:'k-123'};
 assert.equal(authorize(req(),'127.0.0.1',env).ok,false);
 assert.equal(authorize(req({authorization:'Bearer wrong'}),'127.0.0.1',env).ok,false);
 const ok=authorize(req({authorization:'Bearer k-123'}),'203.0.113.9',env);
 assert.deepEqual(ok,{ok:true,principal:principalFor('k-123')});
});
test('key set: dev opt-in does not bypass the key',()=>{
 assert.equal(authorize(req(),'127.0.0.1',{ROVE_API_KEY:'k',ROVE_DEV_NO_AUTH:'1'}).ok,false);
});
test('cross-session stream attach is forbidden; unknown sessions fail closed',()=>{
 const o=new SessionOwners();const a=principalFor('a'),b=principalFor('b');
 o.bind('s1',a);
 assert.equal(o.check('s1',a),'ok');
 assert.equal(o.check('s1',b),'forbidden');
 assert.equal(o.check('nope',a),'forbidden');
});
test('principal ids do not reveal the key',()=>{assert.ok(!principalFor('secret-key').includes('secret-key'));assert.equal(isLoopbackAddress('10.0.0.1'),false);});
import {readFileSync} from 'node:fs';
test('every API route authorizes via the socket address and never trusts Host',()=>{
 const src=readFileSync(new URL('../agent/channels/api.ts',import.meta.url),'utf8');
 const routes=(src.match(/\b(GET|POST)\('/g)??[]).length;
 assert.equal((src.match(/authorize\(req,requestIp\)/g)??[]).length,routes);
 assert.ok(!/hostname|headers\.get\('host'\)|x-forwarded/i.test(src));
 assert.match(src,/owners\.check\(params\.id,auth\.principal\)/);
});

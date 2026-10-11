import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
const image=process.env.ROVE_TEST_IMAGE??'rove-cloud:trial';
const node=process.env.ROVE_TEST_NODE??'node';
const script=`
const assert=require('node:assert/strict'),fs=require('node:fs');
const lock=JSON.parse(fs.readFileSync('/app/package-lock.json','utf8'));
assert.deepEqual(fs.readdirSync('/app/node_modules').filter(n=>n!=='.package-lock.json').sort(),['postgres','zod']);
for(const name of ['postgres','zod'])assert.equal(JSON.parse(fs.readFileSync('/app/node_modules/'+name+'/package.json','utf8')).version,lock.packages['node_modules/'+name].version);
for(const path of ['agent','scripts','docs','.git','.env'])assert(!fs.existsSync('/app/'+path));
assert.equal(process.getuid(),1000);
assert.equal(process.versions.node.split('.')[0],'24');
assert(fs.readFileSync('/etc/ssl/certs/ca-certificates.crt','utf8').includes('BEGIN CERTIFICATE'));
if(process.execPath==='/nodejs/bin/node'){
 for(const path of ['/bin/sh','/usr/bin/apt','/usr/bin/perl','/usr/local/lib/node_modules/npm','/opt/yarn','/app/node_modules/playwright','/app/node_modules/eve'])assert(!fs.existsSync(path),path);
}

console.log(JSON.stringify({node:process.version,uid:process.getuid(),dependencies:JSON.parse(fs.readFileSync('/app/package.json')).dependencies}));
`;
const run=spawnSync('docker',['run','--rm','--network','none','--entrypoint',node,image,'-e',script],{encoding:'utf8'});
assert.equal(run.status,0,run.stderr||run.stdout);process.stdout.write(run.stdout);
console.log('Cloud image inventory passed');

// Executes probes against the candidate libraries, never the compiler image libraries.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
const arch=process.env.ROVE_TEST_ARCH??'arm64';assert(['arm64','amd64'].includes(arch));
const image=process.env.ROVE_TEST_IMAGE??(arch==='arm64'?'rove-cloud:phase4a-distroless':'rove-cloud:phase4a-amd64');
const builder=`rove-security-probes:${arch}`,dir=resolve(`reports/phase4a/review/native-${arch}`);
mkdirSync(dir,{recursive:true});
function raw(args){return spawnSync('docker',args,{encoding:'utf8',maxBuffer:8*1024*1024,timeout:120000});}
function docker(args){const r=raw(args);assert.equal(r.status,0,r.stderr||r.stdout);return r.stdout.trim();}
const library=`/lib/${arch==='arm64'?'aarch64':'x86_64'}-linux-gnu/libstdc++.so.6`;
const containers=[];
try{
 for(const [tag,files] of [[builder,['/out/aligned-new','/out/resolver']],[image,[library]]]){
  const id=docker(['create','--platform',`linux/${arch}`,tag]);containers.push(id);
  for(const file of files)docker(['cp','-L',id+':'+file,dir+'/'+file.split('/').pop()]);
 }
 const base=['run','--rm','--platform',`linux/${arch}`,'--network','none','--memory','256m','--cpus','1','--ulimit','core=0','-v',dir+':/probe:ro'];
 const allocation=docker([...base,'--entrypoint','/probe/aligned-new',image]);
 assert(allocation.includes('20 overflow cases rejected'));writeFileSync(dir+'/allocation.log',allocation+'\n');
 const assembly=docker(['run','--rm','--platform',`linux/${arch}`,'--network','none','-v',dir+':/probe:ro',builder,'objdump','-d','--disassemble=_ZnwmSt11align_val_t','/probe/libstdc++.so.6']);
 assert.match(assembly,/posix_memalign/);assert(!assembly.includes('<aligned_alloc@plt>'));
 writeFileSync(dir+'/aligned-new-disassembly.txt',assembly+'\n');
 // The unmitigated controls deliberately exercise the reported libc assertion, in isolated containers.
 const controls=[];
 for(const length of [200,255,256,300,1000]){
  const r=raw([...base,'-e','LOCALDOMAIN='+'a'.repeat(length),'--entrypoint','/probe/resolver',image]);
  controls.push({length,exit:r.status,stdout:r.stdout,stderr:r.stderr});
 }
 writeFileSync(dir+'/resolver-controls.json',JSON.stringify(controls,null,2)+'\n');
 assert(controls.some(x=>[133,134].includes(x.exit)&&/assert|Assertion/.test(x.stderr)),'Known-bad resolver positive control must abort');
 writeFileSync(dir+'/resolv.conf','nameserver 127.0.0.1\nsearch '+'a'.repeat(300)+'\noptions timeout:1 attempts:1\n');
 const mitigated=docker([...base,'-v',dir+'/resolv.conf:/etc/resolv.conf:ro','-e','LOCALDOMAIN=.','--entrypoint','/probe/resolver',image]);
 assert(mitigated.includes('search=.'));writeFileSync(dir+'/resolver-mitigated.log',mitigated+'\n');
 const sha256=createHash('sha256').update(readFileSync(dir+'/libstdc++.so.6')).digest('hex');
 writeFileSync(dir+'/identity.json',JSON.stringify({image,arch,library,sha256,inspect:JSON.parse(docker(['image','inspect',image]))[0].Id},null,2)+'\n');
 console.log(allocation);console.log(mitigated);console.log(`Native security verification passed (${arch}); exact library sha256=${sha256}`);
}finally{for(const id of containers)raw(['rm',id]);}

// Local-only disposable Docker fixtures. Optional dashboard port binds loopback only. No real secrets, cloud accounts or volumes.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
const image=process.env.ROVE_TEST_IMAGE??'rove-cloud:trial';
const node=process.env.ROVE_TEST_NODE??'node';
const suffix=process.pid,dbName=`rove-test-db-${suffix}`,appName=`rove-test-app-${suffix}`;
function docker(args,input){const r=spawnSync('docker',args,{encoding:'utf8',input,maxBuffer:4*1024*1024});assert.equal(r.status,0,r.stderr||r.stdout);return r.stdout.trim();}
const env=['-e','NODE_ENV=development','-e','ROVE_DB_LOCAL=1','-e','ROVE_DATABASE_URL=postgres://rove_fixture:local-fixture-only@127.0.0.1:5432/postgres','-e','ROVE_CLOUD_OWNER=fixture','-e','ROVE_CLOUD_TOKEN=local-fixture-token-not-real-123456789'];
const smoke=mode=>docker(['run','--rm','--network',`container:${dbName}`,...env,'-v',`${resolve('scripts/cloud-smoke.ts')}:/app/scripts/cloud-smoke.ts:ro`,'--entrypoint',node,image,'--experimental-strip-types','scripts/cloud-smoke.ts',mode]);
try{
 docker(['run','-d','--name',dbName,...(process.env.ROVE_VERIFY_DASHBOARD==='1'?['-p','127.0.0.1::4320']:[]),'--tmpfs','/var/lib/postgresql/data','-e','POSTGRES_PASSWORD=local-fixture-only','postgres:17-alpine']);
 let ready=false;
 for(let i=0;i<30;i++){if(spawnSync('docker',['exec',dbName,'pg_isready','-h','127.0.0.1','-U','postgres']).status===0){ready=true;break;}await delay(1000);}
 assert(ready,'Postgres not ready');
 const dashboardOrigin=process.env.ROVE_VERIFY_DASHBOARD==='1'?'http://'+docker(['port',dbName,'4320/tcp']):undefined;
 if(dashboardOrigin)env.push('-e','ROVE_CLOUD_ORIGIN='+dashboardOrigin);

 docker(['exec','-i',dbName,'psql','-v','ON_ERROR_STOP=1','-U','postgres'],readFileSync('db/cloud.sql','utf8'));
 docker(['exec',dbName,'psql','-v','ON_ERROR_STOP=1','-U','postgres','-c',"CREATE ROLE rove_fixture LOGIN INHERIT PASSWORD 'local-fixture-only' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; GRANT rove_service TO rove_fixture;"]);
 console.log(smoke('seed'));await delay(1200);
 docker(['run','-d','--name',appName,'--network',`container:${dbName}`,'--memory','512m','--cpus','1',...env,image]);
 let healthy=false;
 for(let i=0;i<30;i++){
  const r=spawnSync('docker',['exec',appName,node,'-e',"fetch('http://127.0.0.1:4320/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]);
  if(r.status===0){healthy=true;break;}await delay(1000);
 }
 assert(healthy,'App failed health check');await delay(2000);console.log(smoke('verify'));
 docker(['exec',appName,node,'--input-type=module','-e',`
  import assert from 'node:assert/strict';
  assert.equal((await fetch('http://127.0.0.1:4320/v1/cloud')).status,401);
  assert.equal((await fetch('http://127.0.0.1:4320/v1/cloud/controls',{method:'POST',headers:{Authorization:'Bearer local-fixture-token-not-real-123456789'},body:JSON.stringify({stopped:false,concurrency:2,daily_budget:0,job_budget:0})})).status,422);
 `]);
 docker(['restart',appName]);await delay(2000);console.log(smoke('verify'));
 // Round-trip the same export/restore code through the real PostgreSQL driver.
 docker(['exec',dbName,'psql','-v','ON_ERROR_STOP=1','-U','postgres','-c','CREATE DATABASE restore_fixture']);
 docker(['exec','-i',dbName,'psql','-v','ON_ERROR_STOP=1','-U','postgres','-d','restore_fixture'],readFileSync('db/cloud.sql','utf8').replace('CREATE ROLE rove_service NOLOGIN;','-- Role already exists in this disposable cluster.'));
 docker(['exec',dbName,'psql','-v','ON_ERROR_STOP=1','-U','postgres','-d','restore_fixture','-c',"CREATE ROLE rove_restore_fixture LOGIN INHERIT PASSWORD 'local-fixture-only'; GRANT rove_service TO rove_restore_fixture; GRANT INSERT,DELETE ON rove.controls TO rove_restore_fixture; GRANT UPDATE ON ALL SEQUENCES IN SCHEMA rove TO rove_restore_fixture;"]);
 docker(['exec',appName,node,'--experimental-strip-types','--input-type=module','-e',`
  import assert from 'node:assert/strict';
  import {connectDatabase} from './cloud/database.ts';
  import {exportData,restoreData,tables} from './cloud/backup.ts';
  const source=connectDatabase(process.env.ROVE_DATABASE_URL);
  const target=connectDatabase('postgres://rove_restore_fixture:local-fixture-only@127.0.0.1:5432/restore_fixture');
  try{
   const saved=JSON.parse(JSON.stringify(await exportData(source)));await restoreData(target,saved);
   const restored=await exportData(target);
   for(const table of tables.filter(t=>t!=='controls'))assert.deepEqual(restored.data[table],saved.data[table]);
   assert.equal(restored.data.controls[0].stopped,true);await assert.rejects(restoreData(target,saved));
  }finally{await source.close();await target.close();}
 `]);
 console.log('Network PostgreSQL backup/restore passed');
 if(dashboardOrigin){
  const result=spawnSync(process.execPath,['--experimental-strip-types','scripts/verify-cloud-dashboard-container.ts'],{encoding:'utf8',env:{...process.env,ROVE_DASHBOARD_ORIGIN:dashboardOrigin},timeout:90000});
  assert.equal(result.status,0,result.stderr||result.stdout);process.stdout.write(result.stdout);
 }

 console.log('Resource sample: '+docker(['stats','--no-stream','--format','{{.MemUsage}} | {{.CPUPerc}}',appName]));
 console.log('Image bytes: '+docker(['image','inspect',image,'--format','{{.Size}}']));
 console.log('Cloud container verification passed (local PostgreSQL, TLS off only for loopback fixture)');
}finally{
 for(const name of [appName,dbName])spawnSync('docker',['rm','-f',name],{encoding:'utf8'});
}

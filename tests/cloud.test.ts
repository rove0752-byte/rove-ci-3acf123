import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { testDatabase } from './helpers/database.ts';
import { Jobs,type Job } from '../cloud/jobs.ts';
import { Worker } from '../cloud/worker.ts';
import { cloudHandler } from '../cloud/http.ts';
import { browserProvider } from '../cloud/browser.ts';
const input=(key:string,kind='checksum')=>({key,kind,input:{text:'hello',failUntil:0}});

test('PostgreSQL job lifecycle persists across worker processes and fences the old lease',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'rove-cloud-'));
 try{
  let {db}=await testDatabase(directory);let jobs=new Jobs(db);
  const created=await jobs.enqueue('owner',input('restart'));await db.close();
  const child=spawnSync(process.execPath,['--experimental-strip-types','tests/helpers/restart-worker.ts',directory,'claim'],{encoding:'utf8'});
  assert.equal(child.status,17,child.stderr);const stale=JSON.parse(child.stdout) as Job;
  await delay(1100);
  const restarted=spawnSync(process.execPath,['--experimental-strip-types','tests/helpers/restart-worker.ts',directory,'run'],{encoding:'utf8'});
  assert.equal(restarted.status,0,restarted.stderr);
  ({db}=await testDatabase(directory,false));jobs=new Jobs(db);
  assert.equal(await jobs.finish(stale,{wrong:true}),false);
  const snapshot=await jobs.snapshot('owner');assert.equal(snapshot.jobs[0]!.state,'completed');assert.equal(snapshot.jobs[0]!.attempts,2);
  assert.deepEqual(snapshot.attempts.map(a=>a.outcome).sort(),['completed','lease_expired']);
  assert.equal((await jobs.enqueue('owner',input('restart'))).id,created.id);
  await assert.rejects(jobs.enqueue('owner',{...input('restart'),input:{text:'different'}}));
  assert(snapshot.history.some(e=>e.event==='lease_expired'));await db.close();
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('leases, concurrent claims, heartbeat, retries, cancellation and emergency stop',async()=>{
 const {db}=await testDatabase();const jobs=new Jobs(db);
 try{
  await jobs.enqueue('o',input('a'));await jobs.enqueue('o',input('b'));
  const claims=await Promise.all([jobs.claim('one'),jobs.claim('two')]);assert.equal(claims.filter(Boolean).length,1);
  const first=claims.find(Boolean)!;assert.equal(await jobs.heartbeat(first),true);
  await jobs.cancel('o',first.id);assert.equal(await jobs.finish(first,{}),false);assert.equal(await jobs.heartbeat(first),false);
  const second=(await jobs.claim('two'))!;
  await jobs.controls('o',{stopped:true,concurrency:1,daily_budget:0,job_budget:0});
  assert.equal(await jobs.finish(second,{}),false);assert.equal(await jobs.claim('three'),undefined);
  await jobs.controls('o',{stopped:false,concurrency:1,daily_budget:0,job_budget:0});
  const retry=await jobs.enqueue('o',{...input('retry','retry_demo'),input:{text:'retry',failUntil:5},maxAttempts:2});
  const worker=new Worker(jobs);await worker.once();
  await db.query('UPDATE rove.jobs SET due_at=clock_timestamp() WHERE id=$1',[retry.id]);await worker.once();
  const failed=(await jobs.snapshot('o')).jobs.find(j=>j.id===retry.id)!;assert.equal(failed.state,'failed');assert.equal(failed.attempts,2);
  const exhausted=await jobs.enqueue('o',{...input('expire'),maxAttempts:1});await jobs.claim('dead');
  await db.query(`UPDATE rove.jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1`,[exhausted.id]);
  assert.equal(await jobs.claim('recover'),undefined);assert.equal((await jobs.snapshot('o')).jobs.find(j=>j.id===exhausted.id)!.state,'failed');
 }finally{await db.close();}
});

test('approval ownership, decisions, schedules and conservative AI budget reservations',async()=>{
 const {db}=await testDatabase();const jobs=new Jobs(db,false);const worker=new Worker(jobs);
 try{
  const a=await jobs.enqueue('o',input('approval','approval_demo'));await worker.once();
  assert.equal((await jobs.snapshot('o')).jobs[0]!.state,'awaiting_approval');
  await assert.rejects(jobs.decide('other',a.id,true));await jobs.decide('o',a.id,true);await worker.once();
  assert.equal((await jobs.snapshot('o')).jobs[0]!.state,'completed');await assert.rejects(jobs.decide('o',a.id,false));
  const rejected=await jobs.enqueue('o',input('reject','approval_demo'));await worker.once();await jobs.decide('o',rejected.id,false);
  assert.equal((await jobs.snapshot('o')).jobs.find(j=>j.id===rejected.id)!.state,'cancelled');
  await jobs.schedule('o',{job:input('once'),nextAt:'2020-01-01T00:00:00.000Z',intervalSeconds:null});
  const recurring=await jobs.schedule('o',{job:input('repeat'),nextAt:'2020-01-01T00:00:00.000Z',intervalSeconds:60});
  await Promise.all([jobs.tick(),jobs.tick()]);let snapshot=await jobs.snapshot('o');
  assert.equal(snapshot.jobs.length,4);assert.equal(snapshot.schedules.filter(s=>s.enabled).length,1);
  await jobs.disableSchedule('o',String(recurring!.id));
  const budgetJob=(await jobs.claim('budget'))!;await assert.rejects(jobs.reserveAI(budgetJob,1));
  await jobs.controls('o',{stopped:false,concurrency:2,daily_budget:7,job_budget:5});
  await jobs.reserveAI(budgetJob,5);await assert.rejects(jobs.reserveAI(budgetJob,1));await jobs.finish(budgetJob,{});
  const other=(await jobs.claim('budget2'))!;await jobs.reserveAI(other,2);await assert.rejects(jobs.reserveAI(other,1));
  await jobs.controls('o',{stopped:true,concurrency:2,daily_budget:7,job_budget:5});await assert.rejects(jobs.reserveAI(other,1));
  await jobs.schedule('o',{job:input('paused'),nextAt:'2020-01-01T00:00:00.000Z',intervalSeconds:null});
  await jobs.tick();snapshot=await jobs.snapshot('o');assert.equal(snapshot.jobs.length,4);assert.equal((await jobs.snapshot('stranger')).jobs.length,0);
 }finally{await db.close();}
});

test('SQL access controls deny clients and prevent service audit rewriting',async()=>{
 const {db,pg}=await testDatabase();
 try{
  await pg.exec('CREATE ROLE anon; CREATE ROLE authenticated;');
  for(const role of ['anon','authenticated']){
   await pg.exec(`SET ROLE ${role}`);await assert.rejects(db.query('SELECT * FROM rove.jobs'));await assert.rejects(db.query(`INSERT INTO rove.controls(id) VALUES(1)`));await pg.exec('RESET ROLE');
  }
  const rows=await db.query<{relrowsecurity:boolean}>(`SELECT relrowsecurity FROM pg_class WHERE relnamespace='rove'::regnamespace AND relkind='r'`);
  assert.equal(rows.length,6);assert(rows.every(r=>r.relrowsecurity));
  const {verifyDatabaseAccess}=await import('../cloud/database.ts');await assert.rejects(verifyDatabaseAccess(db));
  await pg.exec('SET ROLE rove_service');await verifyDatabaseAccess(db);const jobs=new Jobs(db);await jobs.enqueue('o',input('allowed'));
  await new Worker(jobs).once();assert.equal((await jobs.snapshot('o')).jobs[0]!.state,'completed');
  await assert.rejects(db.query(`UPDATE rove.audit_events SET event='tampered'`));await assert.rejects(db.query('DELETE FROM rove.audit_events'));
  await assert.rejects(db.query('DELETE FROM rove.jobs'));
 }finally{await db.close();}
});

test('HTTP requires explicit authentication, rejects cross-origin and unsafe input; browser stays offline',async()=>{
 const {db}=await testDatabase();const jobs=new Jobs(db);const token='test-only-not-a-real-secret-123456';const handler=cloudHandler(jobs,{token,owner:'o'});
 const request=(path:string,data?:unknown,headers:Record<string,string>={Authorization:`Bearer ${token}`})=>handler(new Request('http://localhost'+path,{method:data?'POST':'GET',headers,body:data?JSON.stringify(data):undefined}));
 try{
  assert.equal((await request('/v1/cloud',undefined,{})).status,401);
  assert.equal((await request('/v1/cloud',undefined,{Authorization:`Bearer ${token}`,Origin:'https://evil.test'})).status,403);
  assert.equal((await request('/v1/cloud/jobs',{...input('unsafe'),kind:'external_browser'})).status,422);
  assert.equal((await request('/v1/cloud/jobs',{...input('url'),url:'https://example.com'})).status,422);
  assert.equal((await request('/v1/cloud/jobs',{...input('huge'),input:{text:'x'.repeat(17000)}})).status,422);
  assert.equal((await request('/v1/cloud/jobs',input('ok'))).status,201);
  assert.equal((await request('/v1/cloud')).status,200);
  assert.throws(()=>browserProvider('cloud'));const abort=new AbortController();abort.abort();await assert.rejects(browserProvider().snapshot({title:'x',text:'y'},abort.signal));
  assert.deepEqual(await browserProvider().snapshot({title:'x',text:'y'},new AbortController().signal),{title:'x',text:'y',provider:'local-offline'});
 }finally{await db.close();}
});

test('future jobs wait, offline jobs complete, and reservations roll over by UTC reservation date',async()=>{
 const {db}=await testDatabase();const jobs=new Jobs(db,false);
 try{
  await jobs.enqueue('o',{...input('future'),dueAt:'2099-01-01T00:00:00.000Z'});assert.equal(await jobs.claim('w'),undefined);
  const offline=await jobs.enqueue('o',input('offline','offline_browser'));await new Worker(jobs).once();
  assert.equal((await jobs.snapshot('o')).jobs.find(j=>j.id===offline.id)!.state,'completed');
  const a=await jobs.enqueue('o',input('budget'));await assert.rejects(jobs.cancel('other',a.id));const active=(await jobs.claim('w'))!;
  await jobs.controls('o',{stopped:false,concurrency:1,daily_budget:3,job_budget:6});await jobs.reserveAI(active,3);await assert.rejects(jobs.reserveAI(active,1));
  await db.query(`UPDATE rove.controls SET budget_day=budget_day-1`);await jobs.reserveAI(active,3);await assert.rejects(jobs.reserveAI(active,1));
  const [attempt]=await db.query<{reserved_cents:number}>('SELECT reserved_cents FROM rove.attempts WHERE id=$1',[active.lease_token]);assert.equal(attempt!.reserved_cents,6);
  await db.query(`UPDATE rove.jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1`,[a.id]);
  assert.equal(await jobs.heartbeat(active),false);await assert.rejects(jobs.reserveAI(active,1));assert.equal(await jobs.finish(active,{}),false);
 }finally{await db.close();}
});

test('trial limits cannot be raised; unsafe persisted controls fail closed',async()=>{
 const {db}=await testDatabase();const jobs=new Jobs(db);
 try{
  for(const settings of [{concurrency:2,daily_budget:0,job_budget:0},{concurrency:1,daily_budget:1,job_budget:0},{concurrency:1,daily_budget:0,job_budget:1}])await assert.rejects(jobs.controls('o',{stopped:false,...settings}));
  await db.query('UPDATE rove.controls SET concurrency=2');
  await assert.rejects(jobs.claim('w'));await assert.rejects(jobs.tick());await assert.rejects(jobs.enqueue('o',input('unsafe')));
 }finally{await db.close();}
});

test('backup export and atomic empty-target restore preserve data and stop execution',async()=>{
 const {exportData,restoreData,tables}=await import('../cloud/backup.ts');
 const source=await testDatabase(),target=await testDatabase();
 try{
  const jobs=new Jobs(source.db);await jobs.enqueue('o',input('backup'));await new Worker(jobs).once();
  await jobs.enqueue('o',input('approval-backup','approval_demo'));await new Worker(jobs).once();
  await jobs.schedule('o',{job:input('scheduled-backup'),nextAt:'2099-01-01T00:00:00.000Z',intervalSeconds:3600});
  const backup=JSON.parse(JSON.stringify(await exportData(source.db)));
  const corrupt=structuredClone(backup);corrupt.data.schedules=[{id:'not-a-uuid'}];
  await assert.rejects(restoreData(target.db,corrupt));
  assert.equal((await target.db.query('SELECT * FROM rove.jobs')).length,0);
  await restoreData(target.db,backup);
  const restored=await exportData(target.db);
  for(const table of tables.filter(t=>t!=='controls'))assert.deepEqual(JSON.parse(JSON.stringify(restored.data[table])),backup.data[table]);
  const restoredJobs=new Jobs(target.db);assert.equal(await restoredJobs.claim('w'),undefined);
  await assert.rejects(restoreData(target.db,backup));
  await restoredJobs.controls('o',{stopped:false,concurrency:1,daily_budget:0,job_budget:0});
  assert.equal((await restoredJobs.enqueue('o',input('backup'))).id,backup.data.jobs[0].id);
  const rows=await target.db.query<{n:number}>('SELECT count(*)::integer n FROM rove.audit_events');assert(rows[0]!.n>backup.data.audit_events.length);
 }finally{await source.db.close();await target.db.close();}
});


test('database configuration rejects privileged users and remote TLS bypass without connecting',async()=>{
 const {connectDatabase}=await import('../cloud/database.ts');
 assert.throws(()=>connectDatabase('postgres://postgres.project:fake@db.example.test/postgres'));
 assert.throws(()=>connectDatabase('postgres://rove:fake@db.example.test/postgres?sslmode=disable'));
 const prior=process.env.ROVE_DB_LOCAL;process.env.ROVE_DB_LOCAL='1';
 try{assert.throws(()=>connectDatabase('postgres://rove:fake@db.example.test/postgres'));}
 finally{if(prior===undefined)delete process.env.ROVE_DB_LOCAL;else process.env.ROVE_DB_LOCAL=prior;}
});

test('trial HTTP controls, approval mutations, deadlines and schedule limits are enforced',async()=>{
 const {db}=await testDatabase();const jobs=new Jobs(db);const token='test-only-not-a-real-secret-123456';const handler=cloudHandler(jobs,{token,owner:'o'});
 try{
  for(const path of ['jobs','controls','approval','cancel','schedules','schedules/disable'])assert.equal((await handler(new Request('http://localhost/v1/cloud/'+path,{method:'POST',body:'{}'}))).status,401);
  assert.equal((await handler(new Request('http://localhost/v1/cloud/controls',{method:'POST',headers:{Authorization:`Bearer ${token}`},body:JSON.stringify({stopped:false,concurrency:2,daily_budget:0,job_budget:0})}))).status,422);
  for(let i=0;i<5;i++)await jobs.schedule('o',{job:input('limit'+i),nextAt:'2099-01-01T00:00:00.000Z',intervalSeconds:3600});
  await assert.rejects(jobs.schedule('o',{job:input('excess'),nextAt:'2099-01-01T00:00:00.000Z',intervalSeconds:3600}));
  await jobs.enqueue('o',input('deadline'));const previous=process.env.ROVE_TRIAL_END;process.env.ROVE_TRIAL_END='2000-01-01T00:00:00Z';
  try{assert.equal(await jobs.claim('expired'),undefined);}finally{if(previous===undefined)delete process.env.ROVE_TRIAL_END;else process.env.ROVE_TRIAL_END=previous;}
 }finally{await db.close();}
});

test('trial daily capacity rolls back excess jobs and preserves duplicate requests',async()=>{
 const {db}=await testDatabase();const jobs=new Jobs(db);
 try{
  for(let i=0;i<100;i++)await jobs.enqueue('o',input('capacity-'+i));
  await assert.rejects(jobs.enqueue('o',input('capacity-overflow')));
  assert.equal((await jobs.enqueue('o',input('capacity-0'))).state,'queued');
  const [jobsCount]=await db.query<{n:number}>('SELECT count(*)::integer n FROM rove.jobs');
  const [auditCount]=await db.query<{n:number}>('SELECT count(*)::integer n FROM rove.audit_events');
  assert.equal(jobsCount!.n,100);assert.equal(auditCount!.n,100);
  await jobs.schedule('o',{job:input('capacity-schedule'),nextAt:'2020-01-01T00:00:00.000Z',intervalSeconds:3600});
  await new Worker(jobs).once();
  const [completed]=await db.query<{n:number}>("SELECT count(*)::integer n FROM rove.jobs WHERE state='completed'");assert.equal(completed!.n,1);
 }finally{await db.close();}
});


test('HTTP origin cannot be replaced by absolute or authority-form request targets',async()=>{
 const {cloudRequestURL}=await import('../cloud/http.ts');
 assert.equal(cloudRequestURL('/v1/cloud?x=1','https://rove.example').origin,'https://rove.example');
 for(const target of ['https://evil.example/v1/cloud','//evil.example/v1/cloud','/\\evil.example/v1/cloud'])assert.throws(()=>cloudRequestURL(target,'https://rove.example'));
 assert.throws(()=>cloudRequestURL('/cloud','https://user:pass@rove.example'));
});


test('production cloud entrypoints refuse an open trial before connecting',async()=>{
 const {assertProductionTrial}=await import('../cloud/http.ts');
 const {handleCloud,openCloudDatabase}=await import('../cloud/runtime.ts');
 const previous={node:process.env.NODE_ENV,end:process.env.ROVE_TRIAL_END,origin:process.env.ROVE_CLOUD_ORIGIN,url:process.env.ROVE_DATABASE_URL,token:process.env.ROVE_CLOUD_TOKEN,owner:process.env.ROVE_CLOUD_OWNER};
 process.env.NODE_ENV='production';
 process.env.ROVE_DATABASE_URL='postgres://rove_fixture:fake@127.0.0.1:1/postgres';
 process.env.ROVE_CLOUD_TOKEN='test-only-not-a-real-secret-123456';
 process.env.ROVE_CLOUD_OWNER='fixture';
 delete process.env.ROVE_TRIAL_END;delete process.env.ROVE_CLOUD_ORIGIN;
 try{
  assert.throws(()=>assertProductionTrial(),/Set trial end within seven days/);
  await assert.rejects(handleCloud(new Request('http://127.0.0.1/healthz')),/Set trial end within seven days/);
  await assert.rejects(openCloudDatabase(process.env.ROVE_DATABASE_URL),/Set trial end within seven days/);
  process.env.ROVE_TRIAL_END=new Date(Date.now()+86_400_000).toISOString();
  assert.throws(()=>assertProductionTrial(),/HTTPS origin required/);
  await assert.rejects(handleCloud(new Request('http://127.0.0.1/healthz')),/HTTPS origin required/);
  process.env.ROVE_CLOUD_ORIGIN='http://localhost:4320';
  assert.throws(()=>assertProductionTrial(),/HTTPS origin required/);
  process.env.ROVE_CLOUD_ORIGIN='https://rove.example';
  assert.doesNotThrow(()=>assertProductionTrial());
 }finally{
  for(const [key,value] of Object.entries({NODE_ENV:previous.node,ROVE_TRIAL_END:previous.end,ROVE_CLOUD_ORIGIN:previous.origin,ROVE_DATABASE_URL:previous.url,ROVE_CLOUD_TOKEN:previous.token,ROVE_CLOUD_OWNER:previous.owner})){
   if(value===undefined)delete process.env[key];else process.env[key]=value;
  }
 }
});


test('production DNS rejects search-domain overrides before connecting',async()=>{
 const {connectDatabase}=await import('../cloud/database.ts');
 const previous={node:process.env.NODE_ENV,domain:process.env.LOCALDOMAIN,local:process.env.ROVE_DB_LOCAL};
 process.env.NODE_ENV='production';delete process.env.ROVE_DB_LOCAL;
 try{
  for(const value of [undefined,'','example.test','a'.repeat(300)]){
   if(value===undefined)delete process.env.LOCALDOMAIN;else process.env.LOCALDOMAIN=value;
   assert.throws(()=>connectDatabase('postgres://rove_fixture:fake@db.example.test/postgres'),/Production DNS requires LOCALDOMAIN/);
  }
  process.env.LOCALDOMAIN='.';
  const db=connectDatabase('postgres://rove_fixture:fake@db.example.test/postgres');await db.close();
 }finally{
  for(const [key,value] of Object.entries({NODE_ENV:previous.node,LOCALDOMAIN:previous.domain,ROVE_DB_LOCAL:previous.local})){
   if(value===undefined)delete process.env[key];else process.env[key]=value;
  }
 }
});

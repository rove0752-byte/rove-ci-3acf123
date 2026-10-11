import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { connectDatabase } from '../cloud/database.ts';
import { Jobs } from '../cloud/jobs.ts';
const mode=process.argv[2];
if(!['seed','verify'].includes(mode!))throw new Error('Use seed with worker stopped, then verify after worker restart');
const owner=process.env.ROVE_CLOUD_OWNER;if(!owner)throw new Error('Owner required');
const db=connectDatabase(process.env.ROVE_DATABASE_URL!),jobs=new Jobs(db);
const input={key:'phase4a-cloud-smoke-v1',kind:'checksum',input:{text:'harmless cloud smoke'}};
try{
 if(mode==='seed'){
  const snapshot=await jobs.snapshot(owner);assert.equal(snapshot.jobs.length,0,'Use an empty trial queue');
  const job=await jobs.enqueue(owner,input);assert.equal((await jobs.enqueue(owner,input)).id,job.id);
  const claimed=await jobs.claim('smoke-interrupted-worker',1);assert.equal(claimed?.id,job.id);
  console.log('Smoke claim persisted. Restart the service after lease expiry, then run verify.');
 }else{
  const job=await jobs.enqueue(owner,input),snapshot=await jobs.snapshot(owner);
  const matches=snapshot.jobs.filter(j=>j.id===job.id);assert.equal(matches.length,1);
  assert.equal(matches[0]!.state,'completed');assert.equal(matches[0]!.attempts,2);
  assert.deepEqual(matches[0]!.result,{sha256:createHash('sha256').update(input.input.text).digest('hex')});
  assert(snapshot.history.some(e=>e.job_id===job.id&&e.event==='lease_expired'));
  console.log('Cloud smoke passed: persisted checksum, duplicate prevented, expired worker recovered');
 }
}finally{await db.close();}

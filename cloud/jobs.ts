import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Database } from './database.ts';
export const jobInput = z.object({kind:z.enum(['checksum','approval_demo','retry_demo','offline_browser']),
 input:z.object({text:z.string().max(4000).default('Rove'),failUntil:z.number().int().min(0).max(5).default(0)}).strict().default({text:'Rove',failUntil:0}),
 key:z.string().min(1).max(128), dueAt:z.iso.datetime().optional(), maxAttempts:z.number().int().min(1).max(5).default(3)}).strict();
export type JobInput = z.infer<typeof jobInput>;
export interface Job { id:string; owner_id:string; kind:JobInput['kind']; input:JobInput['input']; state:string; attempts:number; max_attempts:number; lease_token:string; }
export interface Controls { stopped:boolean; concurrency:number; daily_budget:number; job_budget:number; daily_reserved:number; }
export class Jobs {
 readonly db:Database;
 readonly trial:boolean;
 constructor(db:Database, trial=true) {this.db=db;this.trial=trial;}
 trialExpired(){return Boolean(process.env.ROVE_TRIAL_END && Date.now()>=Date.parse(process.env.ROVE_TRIAL_END));}
 async mutate<T>(fn:(db:Database,c:Controls)=>Promise<T>):Promise<T> {
  return this.db.transaction(async db=>{const [c]=await db.query<Controls>('SELECT * FROM rove.controls WHERE id=1 FOR UPDATE');if(this.trial&&(c!.concurrency!==1||c!.daily_budget!==0||c!.job_budget!==0))throw new Error('Unsafe trial controls');return fn(db,c!);});
 }
 async audit(db:Database,actor:string,event:string,id:string|null=null,detail:unknown={}) {
  await db.query('INSERT INTO rove.audit_events(actor,event,job_id,detail) VALUES($1,$2,$3,$4)',[actor,event,id,detail]);
 }
 async insert(db:Database,owner:string,input:JobInput) {
  const [job]=await db.query<Job>(`INSERT INTO rove.jobs(id,owner_id,idempotency_key,kind,input,state,due_at,max_attempts)
   VALUES($1,$2,$3,$4,$5,'queued',COALESCE($6::timestamptz,clock_timestamp()),$7) ON CONFLICT(owner_id,idempotency_key) DO NOTHING RETURNING *`,
   [randomUUID(),owner,input.key,input.kind,input.input,input.dueAt??null,input.maxAttempts]);
  if(job){
   if(this.trial){const [count]=await db.query<{n:number}>("SELECT count(*)::integer n FROM rove.jobs WHERE created_at >= date_trunc('day',clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'");if(count!.n>100)throw new Error('Trial daily job limit');}
   await this.audit(db,owner,'queued',job.id);return job;}
  const [existing]=await db.query<Job>('SELECT * FROM rove.jobs WHERE owner_id=$1 AND idempotency_key=$2',[owner,input.key]);
  if(existing!.kind!==input.kind || existing!.input.text!==input.input.text || existing!.input.failUntil!==input.input.failUntil || existing!.max_attempts!==input.maxAttempts)throw new Error('Idempotency key already used for different input');
  return existing!;
 }
 enqueue(owner:string,raw:unknown) {const input=jobInput.parse(raw);return this.mutate(db=>this.insert(db,owner,input));}
 async claim(worker:string,leaseSeconds=30):Promise<Job|undefined> {
  if(!Number.isInteger(leaseSeconds)||leaseSeconds<1||leaseSeconds>300)throw new Error('Invalid lease');
  return this.mutate(async(db,c)=>{
   const expired=await db.query<Job>(`SELECT * FROM rove.jobs WHERE state='running' AND lease_until<=clock_timestamp()`);
   for(const job of expired){
    await db.query(`UPDATE rove.attempts SET outcome='lease_expired',ended_at=clock_timestamp() WHERE id=$1`,[job.lease_token]);
    await db.query(`UPDATE rove.jobs SET state=CASE WHEN attempts>=max_attempts THEN 'failed' ELSE 'queued' END,
     lease_token=NULL,lease_until=NULL,error='Worker lease expired' WHERE id=$1`,[job.id]);
    await this.audit(db,worker,'lease_expired',job.id);
   }
   if(c.stopped||this.trialExpired())return;
   const [count]=await db.query<{n:number}>(`SELECT count(*)::integer n FROM rove.jobs WHERE state='running'`);
   if(count!.n>=c.concurrency)return;
   const [job]=await db.query<Job>(`SELECT * FROM rove.jobs WHERE state='queued' AND due_at<=clock_timestamp() ORDER BY due_at,id LIMIT 1 FOR UPDATE`);
   if(!job)return;
   if(job.kind==='approval_demo'){
    const [approval]=await db.query<{decision:string}>('SELECT decision FROM rove.approvals WHERE job_id=$1',[job.id]);
    if(approval?.decision!=='approved'){
     await db.query(`INSERT INTO rove.approvals(job_id) VALUES($1) ON CONFLICT DO NOTHING`,[job.id]);
     await db.query(`UPDATE rove.jobs SET state='awaiting_approval' WHERE id=$1`,[job.id]);
     await this.audit(db,worker,'approval_requested',job.id);return;
    }
   }
   const token=randomUUID();
   const [leased]=await db.query<Job>(`UPDATE rove.jobs SET state='running',attempts=attempts+1,lease_token=$2,
    lease_until=clock_timestamp()+$3*interval '1 second',heartbeat_at=clock_timestamp(),error=NULL WHERE id=$1 RETURNING *`,[job.id,token,leaseSeconds]);
   await db.query('INSERT INTO rove.attempts(id,job_id,number,worker_id) VALUES($1,$2,$3,$4)',[token,job.id,leased!.attempts,worker]);
   await this.audit(db,worker,'running',job.id);return leased;
  });
 }
 async heartbeat(job:Job,seconds=30) {
  return this.mutate(async(db,c)=>{
   if(c.stopped)return false;
   const rows=await db.query(`UPDATE rove.jobs SET lease_until=clock_timestamp()+$3*interval '1 second',heartbeat_at=clock_timestamp()
    WHERE id=$1 AND lease_token=$2 AND state='running' AND lease_until>clock_timestamp() RETURNING id`,[job.id,job.lease_token,seconds]);
   return rows.length===1;
  });
 }
 async reserveAI(job:Job,cents:number) {
  if(this.trial)throw new Error('AI disabled for trial');
  if(!Number.isSafeInteger(cents)||cents<=0)throw new Error('Invalid reservation');
  return this.mutate(async(db,c)=>{
   const [active]=await db.query(`SELECT id FROM rove.jobs WHERE id=$1 AND lease_token=$2 AND state='running' AND lease_until>clock_timestamp()`,[job.id,job.lease_token]);
   const [daily]=await db.query<{daily_reserved:number}>(`UPDATE rove.controls SET
    daily_reserved=CASE WHEN budget_day=(clock_timestamp() AT TIME ZONE 'UTC')::date THEN daily_reserved ELSE 0 END,
    budget_day=(clock_timestamp() AT TIME ZONE 'UTC')::date WHERE id=1 RETURNING daily_reserved`);
   const [spent]=await db.query<{job:number}>(`SELECT COALESCE(sum(reserved_cents),0)::integer job FROM rove.attempts WHERE job_id=$1`,[job.id]);
   if(!active||c.stopped||daily!.daily_reserved+cents>c.daily_budget||spent!.job+cents>c.job_budget)throw new Error('AI budget or lease denied');
   await db.query('UPDATE rove.controls SET daily_reserved=daily_reserved+$1 WHERE id=1',[cents]);
   await db.query('UPDATE rove.attempts SET reserved_cents=reserved_cents+$2 WHERE id=$1',[job.lease_token,cents]);
   await this.audit(db,'worker','ai_reserved',job.id,{cents});
  });
 }
 async finish(job:Job,result:unknown,error?:string) {
  return this.mutate(async(db,c)=>{
   const [active]=await db.query<Job>(`SELECT * FROM rove.jobs WHERE id=$1 AND lease_token=$2 AND state='running' AND lease_until>clock_timestamp()`,[job.id,job.lease_token]);
   if(!active||c.stopped)return false;
   const state=error?(active.attempts>=active.max_attempts?'failed':'queued'):'completed';
   await db.query(`UPDATE rove.jobs SET state=$3,result=$4,error=$5,lease_token=NULL,lease_until=NULL,
    due_at=clock_timestamp()+$6*interval '1 second' WHERE id=$1 AND lease_token=$2`,
    [job.id,job.lease_token,state,error?null:result,error??null,error?Math.min(60,2**active.attempts):0]);
   await db.query(`UPDATE rove.attempts SET outcome=$2,ended_at=clock_timestamp() WHERE id=$1`,[job.lease_token,error?'failed':'completed']);
   await this.audit(db,'worker',state,job.id);return true;
  });
 }
 async decide(owner:string,id:string,approve:boolean) {
  return this.mutate(async db=>{
   const [job]=await db.query<Job>(`SELECT * FROM rove.jobs WHERE id=$1 AND owner_id=$2 AND state='awaiting_approval'`,[id,owner]);
   if(!job)throw new Error('Pending approval not found');
   await db.query(`UPDATE rove.approvals SET decision=$2,decided_by=$3,decided_at=clock_timestamp() WHERE job_id=$1`,[id,approve?'approved':'rejected',owner]);
   await db.query('UPDATE rove.jobs SET state=$2 WHERE id=$1',[id,approve?'queued':'cancelled']);
   await this.audit(db,owner,approve?'approved':'rejected',id);
  });
 }
 async cancel(owner:string,id:string) {
  return this.mutate(async db=>{
   const [job]=await db.query<Job>(`UPDATE rove.jobs SET state='cancelled',lease_token=NULL,lease_until=NULL
    WHERE id=$1 AND owner_id=$2 AND state IN ('queued','running','awaiting_approval') RETURNING *`,[id,owner]);
   if(!job)throw new Error('Active job not found');
   await db.query(`UPDATE rove.attempts SET outcome='cancelled',ended_at=clock_timestamp() WHERE job_id=$1 AND outcome='running'`,[id]);
   await this.audit(db,owner,'cancelled',id);
  });
 }
 async controls(owner:string,raw:unknown) {
  const settings=z.object({stopped:z.boolean(),concurrency:z.number().int().min(1).max(8),daily_budget:z.number().int().min(0).max(100000),job_budget:z.number().int().min(0).max(10000)}).strict().parse(raw);
  if(this.trial&&(settings.concurrency!==1||settings.daily_budget!==0||settings.job_budget!==0))throw new Error('Trial limits are locked');
  return this.mutate(async db=>{
   await db.query('UPDATE rove.controls SET stopped=$1,concurrency=$2,daily_budget=$3,job_budget=$4 WHERE id=1',[settings.stopped,settings.concurrency,settings.daily_budget,settings.job_budget]);
   if(settings.stopped){
    await db.query(`UPDATE rove.attempts SET outcome='cancelled',ended_at=clock_timestamp() WHERE outcome='running'`);
    const stopped=await db.query<Job>(`UPDATE rove.jobs SET state='cancelled',lease_token=NULL,lease_until=NULL WHERE state='running' RETURNING *`);
    for(const job of stopped)await this.audit(db,owner,'emergency_cancelled',job.id);
   }
   await this.audit(db,owner,'controls_updated',null,settings);
  });
 }
 async schedule(owner:string,raw:unknown) {
  const v=z.object({job:jobInput,nextAt:z.iso.datetime(),intervalSeconds:z.number().int().min(60).max(31536000).nullable()}).strict().parse(raw);
  return this.mutate(async db=>{
   if(this.trial){const [count]=await db.query<{n:number}>('SELECT count(*)::integer n FROM rove.schedules WHERE enabled');if(count!.n>=5)throw new Error('Trial schedule limit');}
   const [s]=await db.query(`INSERT INTO rove.schedules(id,owner_id,kind,input,next_at,interval_seconds) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[randomUUID(),owner,v.job.kind,v.job,v.nextAt,v.intervalSeconds]);
   await this.audit(db,owner,'schedule_created',null,s);return s;
  });
 }
 async disableSchedule(owner:string,id:string){return this.mutate(async db=>{
  const rows=await db.query('UPDATE rove.schedules SET enabled=false WHERE id=$1 AND owner_id=$2 RETURNING id',[id,owner]);
  if(!rows.length)throw new Error('Schedule not found');await this.audit(db,owner,'schedule_disabled',null,{id});
 });}
 async tick(){return this.mutate(async(db,c)=>{
  await db.query('UPDATE rove.controls SET worker_seen=clock_timestamp() WHERE id=1');
  if(c.stopped||this.trialExpired())return;
  const schedules=await db.query<{id:string;owner_id:string;input:JobInput;next_at:Date|string;interval_seconds:number|null}>(`SELECT * FROM rove.schedules WHERE enabled AND next_at<=clock_timestamp() ORDER BY next_at LIMIT 100`);
  for(const s of schedules){
   if(this.trial){
    const [count]=await db.query<{n:number}>("SELECT count(*)::integer n FROM rove.jobs WHERE created_at >= date_trunc('day',clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'");
    if(count!.n>=100)break; // Leave the occurrence due; still allow existing queued jobs to run.
   }
   const due=new Date(s.next_at).toISOString();
   await this.insert(db,s.owner_id,{...s.input,key:`schedule:${s.id}:${due}`,dueAt:due});
   // Coalesce missed occurrences to one; keep the cadence anchored in UTC.
   await db.query(`UPDATE rove.schedules SET enabled=interval_seconds IS NOT NULL,
    next_at=CASE WHEN interval_seconds IS NULL THEN next_at ELSE next_at+(floor(extract(epoch FROM(clock_timestamp()-next_at))/interval_seconds)+1)*interval_seconds*interval '1 second' END WHERE id=$1`,[s.id]);
  }
 });}
 async snapshot(owner:string){
  return this.db.transaction(async db=>({
   controls:(await db.query('SELECT * FROM rove.controls'))[0],
   jobs:await db.query('SELECT * FROM rove.jobs WHERE owner_id=$1 ORDER BY created_at DESC LIMIT 100',[owner]),
   attempts:await db.query('SELECT a.* FROM rove.attempts a JOIN rove.jobs j ON j.id=a.job_id WHERE j.owner_id=$1 ORDER BY a.started_at DESC LIMIT 200',[owner]),
   approvals:await db.query('SELECT a.* FROM rove.approvals a JOIN rove.jobs j ON j.id=a.job_id WHERE j.owner_id=$1 ORDER BY a.requested_at DESC LIMIT 100',[owner]),
   history:await db.query('SELECT a.* FROM rove.audit_events a LEFT JOIN rove.jobs j ON j.id=a.job_id WHERE j.owner_id=$1 OR (a.job_id IS NULL AND a.actor=$1) ORDER BY a.id DESC LIMIT 200',[owner]),
   schedules:await db.query('SELECT * FROM rove.schedules WHERE owner_id=$1 ORDER BY created_at DESC LIMIT 100',[owner]),
  }));
 }
}

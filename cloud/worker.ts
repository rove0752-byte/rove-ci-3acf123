import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Jobs, type Job } from './jobs.ts';
import { browserProvider } from './browser.ts';
export async function execute(job:Job,signal:AbortSignal):Promise<unknown> {
 signal.throwIfAborted();
 switch(job.kind){
  case 'checksum': return {sha256:createHash('sha256').update(job.input.text).digest('hex')};
  case 'approval_demo':return {approved:true,text:job.input.text};
  case 'retry_demo':if(job.attempts<=job.input.failUntil)throw new Error('Deterministic retry');return {attempt:job.attempts};
  case 'offline_browser':return browserProvider().snapshot({title:'Offline fixture',text:job.input.text},signal);
  default:throw new Error('Handler not allowed');
 }
}
export class Worker {
 readonly id=randomUUID();
 readonly jobs:Jobs; readonly leaseSeconds:number;
 constructor(jobs:Jobs,leaseSeconds=30){this.jobs=jobs;this.leaseSeconds=leaseSeconds;}
 async once(signal:AbortSignal=new AbortController().signal){
  signal.throwIfAborted();await this.jobs.tick();
  const job=await this.jobs.claim(this.id,this.leaseSeconds);if(!job)return false;
  const controller=new AbortController();
  const abort=()=>controller.abort();signal.addEventListener('abort',abort,{once:true});
  const timer=setInterval(()=>{void this.jobs.heartbeat(job,this.leaseSeconds).then(ok=>{if(!ok)controller.abort();}).catch(()=>controller.abort());},this.leaseSeconds*1000/3);
  try {
   const result=await execute(job,controller.signal);
   controller.signal.throwIfAborted();await this.jobs.finish(job,result);
  } catch(error){
   if(!controller.signal.aborted)await this.jobs.finish(job,null,error instanceof Error?error.message:'Job failed');
  } finally {clearInterval(timer);signal.removeEventListener('abort',abort);}
  return true;
 }
 async run(signal:AbortSignal){
  while(!signal.aborted){
   try {await this.once(signal);}catch {if(!signal.aborted)console.error('Worker cycle failed; will retry');}
   try {await delay(1000,undefined,{signal});}catch {break;}
  }
 }
}

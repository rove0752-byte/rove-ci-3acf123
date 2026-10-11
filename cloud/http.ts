import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Jobs } from './jobs.ts';
import { z } from 'zod';
export interface Access {token:string;owner:string;}
export function accessFromEnvironment():Access {
 const token=process.env.ROVE_CLOUD_TOKEN,owner=process.env.ROVE_CLOUD_OWNER;
 if(!token||token.length<32||!owner)throw new Error('Configure ROVE_CLOUD_TOKEN (32+ characters) and ROVE_CLOUD_OWNER');
 return {token,owner};
}
export function assertProductionTrial():void {
 if(process.env.NODE_ENV!=='production')return;
 const end=Date.parse(process.env.ROVE_TRIAL_END??'');
 if(!Number.isFinite(end)||end<=Date.now()||end>Date.now()+7*86400000)throw new Error('Set trial end within seven days');
 if(!process.env.ROVE_CLOUD_ORIGIN?.startsWith('https://'))throw new Error('HTTPS origin required');
}
export function cloudRequestURL(target:string,origin:string){
 const base=new URL(origin);
 if(base.username||base.password||base.pathname!=='/'||base.search||base.hash)throw new Error('Configure a plain cloud origin');
 const url=new URL(target,base);
 if(!target.startsWith('/')||url.origin!==base.origin)throw new Error('Foreign request target denied');
 return url;
}
const headers={'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer'};
async function boundedBody(req:Request){
 const reader=req.body?.getReader();if(!reader)throw new Error('Missing body');
 let size=0;const parts:Uint8Array[]=[];
 try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>16000)throw new Error('Body too large');parts.push(value);}}
 finally{await reader.cancel();}
 return JSON.parse(Buffer.concat(parts).toString('utf8'));
}
export function cloudHandler(jobs:Jobs,access:Access){
 return async(req:Request):Promise<Response>=>{
  const path=new URL(req.url).pathname;
  if(req.method==='GET'&&path==='/healthz'){
   try{await jobs.db.query('SELECT id FROM rove.controls WHERE id=1');return Response.json({ok:true},{headers});}
   catch{return Response.json({ok:false},{status:503,headers});}
  }
  if(req.method==='GET'&&path==='/cloud')return new Response(readFileSync('public/cloud.html','utf8'),{headers:{...headers,'content-type':'text/html; charset=utf-8','content-security-policy':"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"}});
  if(req.method==='GET'&&(path==='/cloud.js'||path==='/cloud.css'))return new Response(readFileSync(`public${path}`),{headers:{...headers,'content-type':path.endsWith('.js')?'text/javascript':'text/css'}});
  const actual=Buffer.from(req.headers.get('authorization')??''),expected=Buffer.from(`Bearer ${access.token}`);
  if(actual.length!==expected.length||!timingSafeEqual(actual,expected))return Response.json({error:'Authentication required'},{status:401,headers});
  if(req.headers.get('origin')&&req.headers.get('origin')!==new URL(req.url).origin)return Response.json({error:'Origin denied'},{status:403,headers});
  try {
   if(req.method==='GET'&&path==='/v1/cloud')return Response.json(await jobs.snapshot(access.owner),{headers});
   if(req.method!=='POST')return Response.json({error:'Not found'},{status:404,headers});
   const data=await boundedBody(req);
   if(path==='/v1/cloud/jobs')return Response.json(await jobs.enqueue(access.owner,data),{status:201,headers});
   if(path==='/v1/cloud/schedules')return Response.json(await jobs.schedule(access.owner,data),{status:201,headers});
   if(path==='/v1/cloud/controls')await jobs.controls(access.owner,data);
   else if(path==='/v1/cloud/approval'){
    const v=z.object({id:z.uuid(),approve:z.boolean()}).strict().parse(data);await jobs.decide(access.owner,v.id,v.approve);
   }else if(path==='/v1/cloud/cancel'){
    const v=z.object({id:z.uuid()}).strict().parse(data);await jobs.cancel(access.owner,v.id);
   }else if(path==='/v1/cloud/schedules/disable'){
    const v=z.object({id:z.uuid()}).strict().parse(data);await jobs.disableSchedule(access.owner,v.id);
   }else return Response.json({error:'Not found'},{status:404,headers});
   return Response.json({ok:true},{headers});
  }catch{return Response.json({error:'Request rejected; verify input and current job state'},{status:422,headers});}
 };
}

import { defineChannel, GET, POST } from 'eve/channels';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { z } from 'zod';
import { inspectPage } from '../lib/browser';
import { validateUrl } from '../lib/policy';
import { agentRunTurn } from '../lib/result-schema';
import { authorize, SessionOwners } from '../lib/auth';
const runSchema=z.object({url:z.string().url().max(2048),task:z.string().min(3).max(3000),outputFormat:z.string().max(2000).optional(),outputSchema:z.unknown().optional()}).strict();
const owners=new SessionOwners();
async function body(req:Request){const raw=await req.text(); if(Buffer.byteLength(raw)>10000)throw new Error('Request too large');return JSON.parse(raw);}
const denied=()=>Response.json({error:'API key required'},{status:401});
const forbidden=()=>Response.json({error:'This session belongs to another caller'},{status:403});
let extracting=false;
export default defineChannel({
  routes:[
    GET('/v1/health',async(req,{requestIp})=>{if(!authorize(req,requestIp).ok)return denied();return Response.json({service:'rove',version:'0.1.0',browserInstalled:(existsSync(chromium.executablePath())||process.platform==='linux'),aiConfigured:!!(process.env.AI_GATEWAY_API_KEY||process.env.VERCEL_OIDC_TOKEN),mode:'read_only_no_javascript'});}),
    POST('/v1/extract',async(req,{requestIp})=>{
      if(!authorize(req,requestIp).ok)return denied(); if(extracting)return Response.json({error:'An extraction is running. Try again shortly.'},{status:429});
      try {const input=z.object({url:z.string().url().max(2048)}).strict().parse(await body(req)); extracting=true;return Response.json(await inspectPage(input.url));}
      catch(e){return Response.json({error:e instanceof Error?e.message:'Extraction failed'},{status:422});} finally {extracting=false;}
    }),
    POST('/v1/agent/run',async(req,{from,requestIp})=>{
      const auth=authorize(req,requestIp); if(!auth.ok)return denied();
      try {
        const input=runSchema.parse(await body(req));
        const turn=agentRunTurn(input);
        await validateUrl(input.url);
        if(!process.env.AI_GATEWAY_API_KEY&&!process.env.VERCEL_OIDC_TOKEN)return Response.json({error:'Configure AI_GATEWAY_API_KEY to enable AI tasks.'},{status:503});
        if(!(existsSync(chromium.executablePath())||process.platform==='linux'))return Response.json({error:'Install the browser with npx playwright install chromium.'},{status:503});
        const runId=randomUUID();
        const session=await from(runId).send(turn.message,{auth:null,outputSchema:turn.outputSchema});
        owners.bind(session.id,auth.principal);
        return Response.json({runId,sessionId:session.id,status:'accepted',streamUrl:`/v1/agent/runs/${session.id}/stream`},{status:202});
      } catch(e){return Response.json({error:e instanceof Error?e.message:'Invalid task'},{status:422});}
    }),
    GET('/v1/agent/runs/:id/stream',async(req,{attachSession,params,requestIp})=>{
      const auth=authorize(req,requestIp); if(!auth.ok)return denied();
      if(owners.check(params.id,auth.principal)!=='ok')return forbidden();
      return new Response(await attachSession(params.id).getEventStream(),{headers:{'content-type':'application/x-ndjson; charset=utf-8'}});
    }),
  ],
});

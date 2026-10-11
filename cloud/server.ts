import { createServer } from 'node:http';
import { Jobs } from './jobs.ts';
import { accessFromEnvironment, cloudHandler, cloudRequestURL } from './http.ts';
import { openCloudDatabase } from './runtime.ts';
import { Worker } from './worker.ts';
const url=process.env.ROVE_DATABASE_URL;if(!url)throw new Error('ROVE_DATABASE_URL required');
const access=accessFromEnvironment();
const db=await openCloudDatabase(url),jobs=new Jobs(db),handler=cloudHandler(jobs,access);
const stop=new AbortController();
const worker=new Worker(jobs);const running=worker.run(stop.signal);
const server=createServer(async(req,res)=>{
 try {
  const chunks:Buffer[]=[];let size=0;
  for await(const part of req){size+=part.length;if(size>16000){res.writeHead(413);res.end();return;}chunks.push(part);}
  // Fixed configured origin prevents Host-header manipulation of origin checks.
  const origin=process.env.ROVE_CLOUD_ORIGIN??'http://localhost:4320';
  let requestURL:URL;try{requestURL=cloudRequestURL(req.url??'/',origin);}catch{res.writeHead(400);res.end('Invalid request target');return;}
  const response=await handler(new Request(requestURL,{method:req.method,headers:req.headers as Record<string,string>,body:req.method==='POST'?Buffer.concat(chunks):undefined}));
  res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
 }catch{res.writeHead(500);res.end('Request failed');}
});
server.requestTimeout=10000;server.headersTimeout=10000;server.maxConnections=32;server.keepAliveTimeout=5000;
server.listen(Number(process.env.PORT??4320),process.env.ROVE_BIND??'127.0.0.1',()=>console.log('Rove cloud foundation listening'));
async function shutdown(){stop.abort();server.close();await running;await db.close();}
process.once('SIGTERM',()=>void shutdown());process.once('SIGINT',()=>void shutdown());

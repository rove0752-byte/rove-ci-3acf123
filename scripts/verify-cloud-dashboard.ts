import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { testDatabase } from '../tests/helpers/database.ts';
import { Jobs } from '../cloud/jobs.ts';
import { cloudHandler } from '../cloud/http.ts';
import { Worker } from '../cloud/worker.ts';
const {db}=await testDatabase();const jobs=new Jobs(db),worker=new Worker(jobs);
const token='dashboard-test-only-token-123456789';const handler=cloudHandler(jobs,{token,owner:'test-owner'});
const server=createServer(async(req,res)=>{
 const chunks:Buffer[]=[];for await(const c of req)chunks.push(c);
 const response=await handler(new Request(`http://127.0.0.1:${(server.address() as {port:number}).port}${req.url}`,{method:req.method,headers:req.headers as Record<string,string>,body:req.method==='POST'?Buffer.concat(chunks):undefined}));
 res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
});
await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({headless:true});
try{
 const page=await browser.newPage();const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 await page.goto(origin+'/cloud');await page.getByLabel('Operator token').fill(token);await page.getByRole('button',{name:'Connect',exact:true}).click();
 await page.getByRole('heading',{name:'Create a harmless job'}).waitFor();
 await page.getByLabel('Task', {exact:true}).selectOption('approval_demo');await page.getByRole('button',{name:'Queue job'}).click();await page.locator('.card').first().waitFor();
 await worker.once();await page.getByRole('button',{name:'Refresh',exact:true}).click();await page.getByRole('button',{name:'Approve',exact:true}).click();
 await page.waitForFunction(()=>!document.querySelector('#jobs')?.textContent?.includes('awaiting_approval'));
 await worker.once();await page.getByRole('button',{name:'Refresh',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#jobs')?.textContent?.includes('completed'));
 await page.getByRole('button',{name:'Emergency stop',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#status')?.textContent==='Emergency stop active');
 assert.equal((await jobs.snapshot('test-owner')).controls!.stopped,true);
 await page.getByRole('button',{name:'Resume queue',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#status')?.textContent==='Queue enabled');
 await jobs.enqueue('test-owner',{kind:'checksum',key:'xss',input:{text:'<img src=x onerror=alert(1)>'}});await page.getByRole('button',{name:'Refresh',exact:true}).click();
 await page.getByText('<img src=x onerror=alert(1)>',{exact:true}).waitFor();assert.equal(await page.locator('#jobs img').count(),0);
 for(const width of [390,1280]){await page.setViewportSize({width,height:900});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:`/tmp/rove-cloud-${width}.png`,fullPage:true});}
 assert.deepEqual(errors,[]);
 // A response already in flight must not reopen data after disconnect.
 let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});
 let reached!:()=>void;const intercepted=new Promise<void>(resolve=>{reached=resolve;});
 await page.route('**/v1/cloud',async route=>{reached();await held;await route.continue();});
 await page.getByRole('button',{name:'Refresh',exact:true}).click();await intercepted;
 await page.getByRole('button',{name:'Disconnect',exact:true}).click();
 const response=page.waitForResponse(r=>r.url().endsWith('/v1/cloud'));release();await response;
 await page.waitForTimeout(100);assert.equal(await page.locator('#workspace').isVisible(),false);
 assert.equal(await page.locator('#jobs').textContent(),'');
 console.log('Dashboard verification passed');
}finally{await browser.close();await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));await db.close();}

// Host browser exercises the actual candidate HTTP server and PostgreSQL worker.
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
const origin=process.env.ROVE_DASHBOARD_ORIGIN!;
assert.match(origin,/^http:\/\/127\.0\.0\.1:\d+$/);
const browser=await chromium.launch({headless:true});
try{
 const page=await browser.newPage();const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(origin+'/cloud');await page.getByLabel('Operator token').fill('local-fixture-token-not-real-123456789');
 await page.getByRole('button',{name:'Connect',exact:true}).click();await page.getByRole('heading',{name:'Create a harmless job'}).waitFor();
 await page.getByLabel('Task',{exact:true}).selectOption('approval_demo');await page.getByRole('button',{name:'Queue job'}).click();
 await page.getByRole('button',{name:'Approve',exact:true}).click();
 await page.waitForFunction(()=>!document.querySelector('#jobs')?.textContent?.includes('awaiting_approval'));
 await page.waitForFunction(()=>Array.from(document.querySelectorAll('#jobs .card')).some(e=>e.textContent?.includes('approval demo')&&e.textContent?.includes('completed')));
 await page.getByRole('button',{name:'Emergency stop',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#status')?.textContent==='Emergency stop active');
 const snapshot=await page.request.get(origin+'/v1/cloud',{headers:{Authorization:'Bearer local-fixture-token-not-real-123456789'}});
 assert.equal((await snapshot.json()).controls.stopped,true);
 await page.getByRole('button',{name:'Resume queue',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#status')?.textContent==='Queue enabled');
 await page.getByLabel('Task',{exact:true}).selectOption('checksum');await page.getByLabel('Text',{exact:true}).fill('<img src=x onerror=alert(1)>');await page.getByRole('button',{name:'Queue job'}).click();
 await page.getByText('<img src=x onerror=alert(1)>',{exact:true}).waitFor();assert.equal(await page.locator('#jobs img').count(),0);
 for(const width of [390,1280]){await page.setViewportSize({width,height:900});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:`reports/phase4a/dashboard-${width}.png`,fullPage:true});}
 assert.deepEqual(errors,[]);
 let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});
 let reached!:()=>void;const intercepted=new Promise<void>(resolve=>{reached=resolve;});
 await page.route('**/v1/cloud',async route=>{reached();await held;await route.continue();});
 await page.getByRole('button',{name:'Refresh',exact:true}).click();await intercepted;
 await page.getByRole('button',{name:'Disconnect',exact:true}).click();
 const response=page.waitForResponse(r=>r.url().endsWith('/v1/cloud'));release();await response;
 await page.waitForTimeout(100);assert.equal(await page.locator('#workspace').isVisible(),false);assert.equal(await page.locator('#jobs').textContent(),'');
 console.log('Candidate dashboard verification passed');
}finally{await browser.close();}

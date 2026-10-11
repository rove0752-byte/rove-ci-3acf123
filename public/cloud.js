'use strict';
const el=id=>document.getElementById(id);let token='',state=null;
async function api(path='',data){const response=await fetch('/v1/cloud'+path,{method:data?'POST':'GET',headers:{Authorization:'Bearer '+token,...(data?{'Content-Type':'application/json'}:{})},body:data?JSON.stringify(data):undefined});if(!response.ok)throw new Error((await response.json()).error||'Request failed');return response.json();}
async function act(fn){try{el('message').textContent='';await fn();}catch(e){el('message').textContent=e.message;}}
function text(parent,tag,value){const n=document.createElement(tag);n.textContent=value;parent.append(n);return n;}
function button(parent,label,fn){const b=text(parent,'button',label);b.onclick=()=>act(fn);}
async function refresh(){const requestToken=token;const next=await api();if(!requestToken||token!==requestToken)return;state=next;el('workspace').hidden=false;el('login').hidden=true;el('status').textContent=state.controls.stopped?'Emergency stop active':'Queue enabled';el('control-summary').textContent=state.controls.stopped?'Running jobs cancelled. Queue and schedules paused.':'Worker last seen: '+(state.controls.worker_seen?new Date(state.controls.worker_seen).toLocaleString():'not yet observed')+'. Reserved today: '+state.controls.daily_reserved+'¢.';el('concurrency').value=state.controls.concurrency;el('daily').value=state.controls.daily_budget;el('budget').value=state.controls.job_budget;render();}
function render(){
 el('count').textContent='('+state.jobs.length+' recent)';el('jobs').replaceChildren();
 for(const j of state.jobs.filter(j=>!el('filter').value||j.state===el('filter').value)){
  const card=text(el('jobs'),'article','');card.className='card';text(card,'h3',j.kind.replaceAll('_',' '));text(card,'span',j.state).className='badge';text(card,'p',j.input.text);text(card,'small',j.id+' · attempts '+j.attempts+'/'+j.max_attempts);text(card,'p','Due '+new Date(j.due_at).toLocaleString());
  if(j.result)text(card,'pre',JSON.stringify(j.result,null,2));if(j.error)text(card,'p',j.error);
  if(j.state==='awaiting_approval'){text(card,'p','Approve this deterministic demonstration? It returns the text above; no external action.');button(card,'Approve',async()=>{await api('/approval',{id:j.id,approve:true});await refresh();});button(card,'Reject',async()=>{await api('/approval',{id:j.id,approve:false});await refresh();});}
  if(['queued','running','awaiting_approval'].includes(j.state))button(card,'Cancel',async()=>{await api('/cancel',{id:j.id});await refresh();});
 }
 if(!el('jobs').children.length)text(el('jobs'),'p','No jobs in this view.');
 el('schedules').replaceChildren();for(const s of state.schedules){const c=text(el('schedules'),'article','');c.className='card';text(c,'h3',s.kind);text(c,'p',(s.enabled?'Active':'Disabled')+' · '+(s.interval_seconds?'Every '+s.interval_seconds+' seconds':'One-off'));text(c,'p','Next '+new Date(s.next_at).toLocaleString());if(s.enabled)button(c,'Disable schedule',async()=>{await api('/schedules/disable',{id:s.id});await refresh();});}
 el('attempts').replaceChildren();for(const a of state.attempts)text(el('attempts'),'p',new Date(a.started_at).toLocaleString()+' · '+a.job_id+' · attempt '+a.number+' · '+a.outcome+' · reserved '+a.reserved_cents+'¢');
 el('history').replaceChildren();for(const a of state.history)text(el('history'),'p',new Date(a.at).toLocaleString()+' · '+a.event+' · '+(a.job_id||'workspace'));
}
el('connect').onsubmit=e=>{e.preventDefault();token=el('token').value;el('token').value='';act(refresh);};
el('disconnect').onclick=()=>{token='';state=null;el('workspace').hidden=true;el('login').hidden=false;el('status').textContent='Disconnected';for(const id of ['jobs','history','attempts','schedules'])el(id).replaceChildren();};
el('refresh').onclick=()=>act(refresh);el('filter').onchange=()=>state&&render();
el('create').onsubmit=e=>{e.preventDefault();act(async()=>{const job={kind:el('kind').value,key:crypto.randomUUID(),input:{text:el('text').value,failUntil:el('kind').value==='retry_demo'?1:0}};const due=el('due').value?new Date(el('due').value).toISOString():undefined;if(el('interval').value){await api('/schedules',{job,nextAt:due||new Date().toISOString(),intervalSeconds:Number(el('interval').value)});}else await api('/jobs',{...job,...(due?{dueAt:due}:{})});await refresh();});};
async function controls(stopped){await api('/controls',{stopped,concurrency:Number(el('concurrency').value),daily_budget:Number(el('daily').value),job_budget:Number(el('budget').value)});await refresh();}
el('limits').onsubmit=e=>{e.preventDefault();act(()=>controls(state.controls.stopped));};
el('stop').onclick=()=>act(async()=>{await api('/controls',{stopped:true,concurrency:state.controls.concurrency,daily_budget:state.controls.daily_budget,job_budget:state.controls.job_budget});await refresh();});
el('resume').onclick=()=>act(()=>controls(false));
setInterval(()=>{if(token&&state)act(refresh);},5000);

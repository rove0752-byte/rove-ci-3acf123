// Disposable production-mode PostgreSQL TLS fixture; no external service or credentials.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
const image=process.env.ROVE_TEST_IMAGE??'rove-cloud:phase4a-distroless';
const node=process.env.ROVE_TEST_NODE??'/nodejs/bin/node';
const name=`rove-tls-${process.pid}`,app=`rove-tls-app-${process.pid}`,dir=mkdtempSync(join(tmpdir(),'rove-tls-'));
function run(cmd,args,input){const r=spawnSync(cmd,args,{encoding:'utf8',input,maxBuffer:4*1024*1024});assert.equal(r.status,0,r.stderr||r.stdout);return r.stdout.trim();}
const docker=(args,input)=>run('docker',args,input);
try{
 run('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(dir,'key.pem'),'-out',join(dir,'cert.pem'),'-days','1','-subj','/CN=rove-local-fixture','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1']);
 docker(['run','-d','--name',name,'--tmpfs','/var/lib/postgresql/data','-e','POSTGRES_PASSWORD=fixture-only','postgres:17-alpine']);
 let ready=false;for(let i=0;i<30;i++){if(spawnSync('docker',['exec',name,'pg_isready','-h','127.0.0.1','-U','postgres']).status===0){ready=true;break;}await delay(1000);}assert(ready);
 docker(['exec','-i','-u','postgres',name,'sh','-c','umask 077; cat > /var/lib/postgresql/data/server.key'],readFileSync(join(dir,'key.pem'),'utf8'));
 docker(['exec','-i','-u','postgres',name,'sh','-c','cat > /var/lib/postgresql/data/server.crt'],readFileSync(join(dir,'cert.pem'),'utf8'));
 docker(['exec',name,'chown','postgres:postgres','/var/lib/postgresql/data/server.key','/var/lib/postgresql/data/server.crt']);
 docker(['exec',name,'chmod','600','/var/lib/postgresql/data/server.key']);
 docker(['exec',name,'psql','-U','postgres','-c',"ALTER SYSTEM SET ssl = 'on'"]);
 docker(['exec',name,'psql','-U','postgres','-c','SELECT pg_reload_conf()']);
 docker(['exec','-i',name,'psql','-v','ON_ERROR_STOP=1','-U','postgres'],readFileSync('db/cloud.sql','utf8'));
 docker(['exec',name,'psql','-v','ON_ERROR_STOP=1','-U','postgres','-c',"CREATE ROLE rove_fixture LOGIN INHERIT PASSWORD 'fixture-only' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; GRANT rove_service TO rove_fixture;"]);
 writeFileSync(join(dir,'hosts'),'127.0.0.1 localhost wrong.fixture\n');
 const base=['-v',`${join(dir,'hosts')}:/etc/hosts:ro`,'--rm','--network',`container:${name}`,'-e','NODE_ENV=production','--entrypoint',node];
 const trust=['-v',`${join(dir,'cert.pem')}:/fixture/ca.pem:ro`,'-e','NODE_EXTRA_CA_CERTS=/fixture/ca.pem'];
 const query=`import assert from 'node:assert/strict';import {connectDatabase} from './cloud/database.ts';const db=connectDatabase('postgres://rove_fixture:fixture-only@127.0.0.1:5432/postgres');try{const [row]=await db.query('SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()');assert.equal(row.ssl,true);console.log('Verified PostgreSQL TLS passed');}finally{await db.close();}`;
 console.log(docker(['run',...base,...trust,image,'--input-type=module','-e',query]));
 for(const [label,extra,url] of [['untrusted',[],'127.0.0.1'],['hostname',trust,'wrong.fixture']]){
  const script=`import assert from 'node:assert/strict';import {connectDatabase} from './cloud/database.ts';const db=connectDatabase('postgres://rove_fixture:fixture-only@${url}:5432/postgres');try{await assert.rejects(db.query('SELECT 1'),e=>/certificate|self.signed|altname|Hostname/i.test(e.message));console.log('${label} certificate rejected');}finally{await db.close();}`;
  console.log(docker(['run',...base,...extra,image,'--input-type=module','-e',script]));
 }
 docker(['run','-d','--name',app,'--network',`container:${name}`,...trust,'-e','NODE_ENV=production','-e','PORT=54321','-e','ROVE_DATABASE_URL=postgres://rove_fixture:fixture-only@127.0.0.1:5432/postgres','-e','ROVE_CLOUD_OWNER=fixture','-e','ROVE_CLOUD_TOKEN=local-fixture-token-not-real-123456789','-e','ROVE_CLOUD_ORIGIN=https://fixture.invalid','-e','ROVE_TRIAL_END='+new Date(Date.now()+86400000).toISOString(),image]);
 let healthy=false;for(let i=0;i<45;i++){if(docker(['inspect',app,'--format','{{.State.Health.Status}}'])==='healthy'){healthy=true;break;}await delay(1000);}assert(healthy,'Production healthcheck failed');
 docker(['stop','--time','15',app]);assert.equal(docker(['inspect',app,'--format','{{.State.ExitCode}}']),'0');
 console.log('Production TLS, custom PORT healthcheck and SIGTERM shutdown passed');
}finally{for(const container of [app,name])spawnSync('docker',['rm','-f',container],{encoding:'utf8'});rmSync(dir,{recursive:true,force:true});}

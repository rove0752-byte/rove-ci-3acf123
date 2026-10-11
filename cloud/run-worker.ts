import { Jobs } from './jobs.ts';
import { openCloudDatabase } from './runtime.ts';
import { Worker } from './worker.ts';
const url=process.env.ROVE_DATABASE_URL;if(!url)throw new Error('ROVE_DATABASE_URL required');
const db=await openCloudDatabase(url),stop=new AbortController();
process.once('SIGTERM',()=>stop.abort());process.once('SIGINT',()=>stop.abort());
try{await new Worker(new Jobs(db)).run(stop.signal);}finally{await db.close();}

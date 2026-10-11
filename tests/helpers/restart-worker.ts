import { testDatabase } from './database.ts';
import { Jobs } from '../../cloud/jobs.ts';
import { Worker } from '../../cloud/worker.ts';
const {db}=await testDatabase(process.argv[2],false);const jobs=new Jobs(db);
if(process.argv[3]==='claim'){
 const job=await jobs.claim('doomed-process',1);console.log(JSON.stringify(job));
 // Durable lease exists, but the process exits before handler execution or completion.
 await db.close();process.exit(17);
}else{await new Worker(jobs).once();await db.close();}

import { connectDatabase, verifyDatabaseAccess, type Database } from './database.ts';
import { Jobs } from './jobs.ts';
import { accessFromEnvironment, assertProductionTrial, cloudHandler } from './http.ts';
let instance:ReturnType<typeof cloudHandler>|undefined;
export async function openCloudDatabase(url:string):Promise<Database>{
 assertProductionTrial();
 const db=connectDatabase(url);
 try{await verifyDatabaseAccess(db);return db;}
 catch(error){await db.close();throw error;}
}
export async function handleCloud(req:Request){
 if(!instance){
  const url=process.env.ROVE_DATABASE_URL;
  if(!url)return Response.json({error:'Cloud foundation not configured'},{status:503});
  const access=accessFromEnvironment();
  const db=await openCloudDatabase(url);
  instance=cloudHandler(new Jobs(db),access);
 }
 return instance(req);
}

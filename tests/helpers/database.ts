import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import type { Database } from '../../cloud/database.ts';
export async function testDatabase(path?:string,initialize=true){
 const pg=new PGlite(path);await pg.waitReady;
 if(initialize)await pg.exec(readFileSync('db/cloud.sql','utf8'));
 function wrap(client:Pick<PGlite,'query'>):Database{
  return {query:async<T>(sql:string,params:unknown[]=[]) => (await client.query<T>(sql,params)).rows,
   transaction:fn=>pg.transaction(tx=>fn(wrap(tx))),close:()=>pg.close()};
 }
 return {pg,db:wrap(pg)};
}

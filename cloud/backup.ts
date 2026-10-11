import type { Database } from './database.ts';
// Fixed identifiers only. The export is application data, not provider auth/storage or role passwords.
export const tables=['controls','jobs','attempts','audit_events','approvals','schedules'] as const;
export async function exportData(db:Database){
 return db.transaction(async tx=>{
  await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const data:Record<string,unknown[]>={};
  for(const table of tables)data[table]=(await tx.query<{row:unknown}>(`SELECT to_jsonb(t) AS row FROM rove.${table} t`)).map(r=>r.row);
  return {version:1,exportedAt:new Date().toISOString(),data};
 });
}
export async function restoreData(db:Database,backup:Awaited<ReturnType<typeof exportData>>){
 if(backup.version!==1||Object.keys(backup.data).sort().join()!==[...tables].sort().join())throw new Error('Invalid backup');
 if(backup.data.controls?.length!==1)throw new Error('Invalid controls');
 await db.transaction(async tx=>{
  // Restore only a freshly bootstrapped database, with an administrator, while all workers are off.
  for(const table of tables.filter(t=>t!=='controls')){
   const [row]=await tx.query<{n:number}>(`SELECT count(*)::integer n FROM rove.${table}`);
   if(row!.n!==0)throw new Error('Restore target must be empty');
  }
  await tx.query('DELETE FROM rove.controls');
  for(const table of tables){
   const rows=backup.data[table];if(!Array.isArray(rows))throw new Error('Invalid table data');
   await tx.query(`INSERT INTO rove.${table} OVERRIDING SYSTEM VALUE SELECT * FROM jsonb_populate_recordset(NULL::rove.${table},$1::jsonb)`,[rows]);
  }
  await tx.query("SELECT setval(pg_get_serial_sequence('rove.audit_events','id'),COALESCE((SELECT max(id) FROM rove.audit_events),1),(SELECT count(*)>0 FROM rove.audit_events))");
  // Always restore paused; invalidate uncertain work before any explicit operator resume.
  await tx.query('UPDATE rove.controls SET stopped=true,concurrency=1,daily_budget=0,job_budget=0 WHERE id=1');
  await tx.query("UPDATE rove.jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE state='running'");
 });
}

import postgres from 'postgres';
export interface Database {
 query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
 transaction<T>(fn: (db: Database) => Promise<T>): Promise<T>;
 close(): Promise<void>;
}
export function connectDatabase(url: string): Database {
 let parsed:URL;try{parsed=new URL(url);}catch{throw new Error('Invalid database URL');}
 if(!['postgres:','postgresql:'].includes(parsed.protocol))throw new Error('PostgreSQL URL required');
 if(process.env.ROVE_DB_LOCAL==='1' && (process.env.NODE_ENV==='production'||!['localhost','127.0.0.1','[::1]'].includes(parsed.hostname)))throw new Error('Local TLS bypass denied');
 if(['postgres','supabase_admin','service_role'].includes(decodeURIComponent(parsed.username).split('.')[0]!))throw new Error('Privileged database login denied');
 if([...parsed.searchParams.keys()].some(k=>k.startsWith('ssl')))throw new Error('Set TLS through verified client configuration only');
 // glibc uses LOCALDOMAIN ahead of resolv.conf; fail before any database DNS lookup.
 // The restricted cloud runtime uses fully qualified database hostnames, not search suffixes.
 if(process.env.NODE_ENV==='production'&&process.env.LOCALDOMAIN!=='.')throw new Error('Production DNS requires LOCALDOMAIN=.');
 const client = postgres(url, { max: 2, prepare: false, connect_timeout: 10, idle_timeout: 20, connection: {statement_timeout: 10000, lock_timeout: 5000, idle_in_transaction_session_timeout: 15000},
  ssl: process.env.ROVE_DB_LOCAL === '1' ? false : {rejectUnauthorized:true} });
 function wrap(sql: typeof client): Database {
  return {
   query: async <T>(text: string, params: unknown[] = []) => [...await sql.unsafe(text, params as never[])] as T[],
   transaction: fn => sql.begin(async tx => fn(wrap(tx as unknown as typeof client))) as Promise<Awaited<ReturnType<typeof fn>>>,
   close: () => client.end(),
  };
 }
 return wrap(client);
}

export async function verifyDatabaseAccess(db:Database){
 const [role]=await db.query<{safe:boolean}>(`SELECT NOT (rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole)
  AND pg_has_role(current_user,'rove_service','member')
  AND NOT has_table_privilege(current_user,'rove.audit_events','UPDATE,DELETE,TRUNCATE')
  AND NOT has_schema_privilege(current_user,'rove','CREATE') AS safe
  FROM pg_roles WHERE rolname=current_user`);
 if(!role?.safe)throw new Error('Database identity is not least privilege');
 const [limits]=await db.query<{safe:boolean}>('SELECT concurrency=1 AND daily_budget=0 AND job_budget=0 AS safe FROM rove.controls WHERE id=1');
 if(!limits?.safe)throw new Error('Unsafe trial database settings');
}

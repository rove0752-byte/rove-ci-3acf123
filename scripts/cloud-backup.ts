import { readFile,writeFile } from 'node:fs/promises';
import { connectDatabase } from '../cloud/database.ts';
import { exportData,restoreData } from '../cloud/backup.ts';
const [mode,path]=process.argv.slice(2);
if(!path||!['export','restore'].includes(mode!))throw new Error('Usage: cloud-backup.ts export|restore FILE');
if(mode==='restore'&&process.env.ROVE_RESTORE_EMPTY_TARGET!=='yes')throw new Error('Explicit empty-target restore acknowledgement required');
const db=connectDatabase(process.env.ROVE_DATABASE_URL!);
try{
 if(mode==='export')await writeFile(path,JSON.stringify(await exportData(db)),{mode:0o600,flag:'wx'});
 else await restoreData(db,JSON.parse(await readFile(path,'utf8')));
 console.log(mode==='export'?'Cloud export complete':'Cloud restore complete; queue stopped');
}finally{await db.close();}

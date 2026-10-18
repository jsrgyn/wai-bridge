import Database from 'better-sqlite3';
import { chmod, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import process from 'node:process';

const source=resolve(process.argv[2]??'');
const destination=resolve(process.argv[3]??'');
if(source===destination||!process.argv[2]||!process.argv[3])throw new Error('Usage: backup-database.mjs <database> <destination>');
await mkdir(dirname(destination),{recursive:true,mode:0o700});
const db=new Database(source,{readonly:true,fileMustExist:true});
try{
  const check=db.pragma('integrity_check',{simple:true});
  if(check!=='ok')throw new Error('SOURCE_INTEGRITY_CHECK_FAILED');
  await db.backup(destination);
}finally{db.close();}
await chmod(destination,0o600);
const verify=new Database(destination,{readonly:true,fileMustExist:true});
try{if(verify.pragma('integrity_check',{simple:true})!=='ok')throw new Error('BACKUP_INTEGRITY_CHECK_FAILED');}
finally{verify.close();}

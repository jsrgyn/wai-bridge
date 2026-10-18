import Database from 'better-sqlite3';
import { access, chmod, copyFile, mkdir, rename, rm } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import process from 'node:process';

const source=resolve(process.argv[2]??'');
const target=resolve(process.argv[3]??'');
const backupDir=resolve(process.argv[4]??'');
if(!process.argv[2]||!process.argv[3]||!process.argv[4]||source===target)throw new Error('Usage: restore-database.mjs <source> <target> <backup-directory>');
function validate(path){const db=new Database(path,{readonly:true,fileMustExist:true});try{if(db.pragma('integrity_check',{simple:true})!=='ok')throw new Error('DATABASE_INTEGRITY_CHECK_FAILED');const version=db.prepare('SELECT MAX(version) AS version FROM wa_schema_migrations').get()?.version;if(typeof version!=='number'||version<1||version>10)throw new Error('DATABASE_SCHEMA_UNSUPPORTED');}finally{db.close();}}
validate(source);
await mkdir(backupDir,{recursive:true,mode:0o700});
await mkdir(dirname(target),{recursive:true,mode:0o700});
let targetExists=true;
try{await access(target);}catch{targetExists=false;}
if(targetExists){
  const current=new Database(target,{readonly:true,fileMustExist:true});
  try{const stamp=new Date().toISOString().replaceAll(':','').replaceAll('.','');await current.backup(resolve(backupDir,`pre-restore-${stamp}-${basename(target)}`));}
  finally{current.close();}
}
const temporary=`${target}.restore-${process.pid}`;
try{await copyFile(source,temporary);await chmod(temporary,0o600);validate(temporary);await rm(`${target}-wal`,{force:true});await rm(`${target}-shm`,{force:true});await rename(temporary,target);}
catch(error){await rm(temporary,{force:true});throw error;}

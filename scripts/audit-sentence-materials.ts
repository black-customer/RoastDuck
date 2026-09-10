import fs from 'node:fs';
import path from 'node:path';
import {createClient} from '@libsql/client';
import {auditSentenceMaterials} from '../src/lib/sentence-study/audit';
const url=process.env.ROASTDUCK_DB??'file:./data/app.db';if(!url.startsWith('file:')||!fs.existsSync(path.resolve(url.slice(5))))throw new Error('需要已经存在的本机数据库');
const relative=path.relative(path.resolve('test-results'),path.resolve(url.slice(5))),isolated=!relative.startsWith('..')&&!path.isAbsolute(relative),db=createClient({url});
try{await db.execute('PRAGMA query_only=ON');const result=await auditSentenceMaterials({all:async command=>(await db.execute(command)).rows as never},isolated&&process.env.AI_PROVIDER==='mock');const folder=process.env.ROASTDUCK_REPORTS_DIR??'test-results/sentence-audit';fs.mkdirSync(folder,{recursive:true});fs.writeFileSync(path.join(folder,'sentence-audit.json'),JSON.stringify({...result,isolated,networkCalls:0},null,2));console.log(JSON.stringify({...result,networkCalls:0}));if(!result.ok)process.exitCode=1;}finally{db.close();}

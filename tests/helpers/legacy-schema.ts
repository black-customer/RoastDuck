import type {Client} from '@libsql/client';
import fs from 'node:fs';
import path from 'node:path';
import {V26_DDL} from '../../db/migrations/v26-device-runtime';
import {V27_DDL} from '../../db/migrations/v27-memory-recovery';
import {V28_DDL} from '../../db/migrations/v28-device-sync';
import {V29_DDL} from '../../db/migrations/v29-web-usability';
import {V30_DDL} from '../../db/migrations/v30-web-speech-lock';
import {V31_DDL} from '../../db/migrations/v31-web-material-controls';
import {V32_DDL} from '../../db/migrations/v32-expression-study';
import {V33_DDL} from '../../db/migrations/v33-sentence-study';
import {V34_DDL} from '../../db/migrations/v34-personal-focus';
import {V35_DDL} from '../../db/migrations/v35-guided-reveal';
import {assertInsideTestResults,TEST_RESULTS_DIRECTORY} from './temp-db';

export async function migrationHistory(client:Client,maxVersion=35){
  const {rows}=await client.execute({sql:'SELECT version,checksum FROM _schema_migrations WHERE version<=? ORDER BY version',args:[maxVersion]});
  return rows.map(row=>({version:Number(row.version),checksum:String(row.checksum)}));
}

/** Test fixture reconstruction only. Never exposes a production rollback entry point. */
export async function removePostV25Schema(client:Client,url:string):Promise<void>{
  if(!process.env.VITEST||!url.startsWith('file:')||/[?#]/.test(url))throw new Error('旧结构夹具仅允许 Vitest 的显式本地测试数据库');
  const expected=path.resolve(url.slice(5));assertInsideTestResults(expected);
  const realExpected=fs.realpathSync(expected),testDirectory=fs.realpathSync(TEST_RESULTS_DIRECTORY);
  if(path.dirname(realExpected)!==testDirectory)throw new Error('旧结构夹具拒绝 test-results 外的真实路径');
  const databases=await client.execute('PRAGMA database_list');
  const main=databases.rows.find(row=>row.name==='main'),actual=main?.file?fs.realpathSync(String(main.file)):null;
  if(actual!==realExpected)throw new Error('旧结构夹具连接与指定测试文件不一致');
  const before=await migrationHistory(client);
  if(before.map(row=>row.version).join(',')!==Array.from({length:35},(_,index)=>index+1).join(','))throw new Error('旧结构夹具要求完整且连续的 v35 起始库');
  const reverseStatements=[V35_DDL,V34_DDL,V33_DDL,V32_DDL,V31_DDL,V30_DDL,V29_DDL,V28_DDL,V27_DDL,V26_DDL].flatMap(statements=>[...statements].reverse().map(statement=>{
    const addColumn=/^ALTER TABLE ([a-z_][a-z0-9_]*) ADD COLUMN ([a-z_][a-z0-9_]*)\b/i.exec(statement.trim());
    if(addColumn)return `ALTER TABLE "${addColumn[1]}" DROP COLUMN "${addColumn[2]}"`;
    const createIndex=/^CREATE (?:UNIQUE )?INDEX ([a-z_][a-z0-9_]*)\b/i.exec(statement.trim());
    if(createIndex)return `DROP INDEX "${createIndex[1]}"`;
    const createTable=/^CREATE TABLE ([a-z_][a-z0-9_]*)\b/i.exec(statement.trim());
    if(createTable)return `DROP TABLE "${createTable[1]}"`;
    throw new Error('旧结构夹具遇到未支持的新增DDL，必须显式更新测试转换');
  }));
  const tx=await client.transaction('write');
  try{
    for(const statement of reverseStatements)await tx.execute(statement);
    await tx.execute('DELETE FROM _schema_migrations WHERE version>=26');
    await tx.commit();
  }catch(error){await tx.rollback();throw error;}
  if(JSON.stringify(await migrationHistory(client))!==JSON.stringify(before.filter(row=>row.version<=25)))throw new Error('旧结构夹具意外修改历史迁移checksum');
}

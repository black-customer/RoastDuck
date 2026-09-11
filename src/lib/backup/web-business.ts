import {z} from 'zod';
import type {DatabasePort,SqlReader,SqlValue} from '@/lib/platform/database';
import {encryptBackup,decryptBackup} from '@/lib/device-sync/backup';
import {SYNC_ENTITIES} from '@/lib/device-sync/contracts';
import {credentialValue} from '@/lib/app-services/shared';
// Reuse encryption only. This module does not initialize a device, sync server, or sync log.
export const WEB_BACKUP_TABLES=[...SYNC_ENTITIES.filter(t=>!t.startsWith('device_sync_')),'user_settings','lexemes','text_annotations','learning_inbox_items','light_study_successions','light_study_succession_batches','expression_preferences','material_feedback','runtime_requests','companion_memory_jobs','material_validation_cache','sentence_learning_units','sentence_study_progress','sentence_study_sessions','sentence_study_events','sentence_material_editions','sentence_highlights','sentence_teaching_editions'] as const;
const rowSchema=z.record(z.string(),z.union([z.string(),z.number(),z.null()]));
const archiveSchema=z.object({format:z.literal('roastduck-web-business-v1'),version:z.number().int().positive(),createdAt:z.string().datetime(),tables:z.record(z.string(),z.array(rowSchema).max(300000))}).strict();
type Archive=z.infer<typeof archiveSchema>;
async function columns(tx:SqlReader,table:string){return tx.all<{name:string;pk:number}>({sql:`PRAGMA table_info("${table}")`});}
async function snapshot(database:DatabasePort):Promise<Archive>{return database.read(async tx=>{
  const [schema]=await tx.all<{version:number}>({sql:'SELECT MAX(version) version FROM _schema_migrations'}),tables:Archive['tables']={};
  for(const table of WEB_BACKUP_TABLES){if(!(await columns(tx,table)).length)continue;tables[table]=(await tx.all<Record<string,string|number|null>>({sql:`SELECT * FROM "${table}"`})).map(row=>rowSchema.parse(row));}
  const result={format:'roastduck-web-business-v1' as const,version:schema.version,createdAt:new Date().toISOString(),tables};
  if(credentialValue(JSON.stringify(tables)))throw new Error('业务资料疑似含有凭证，已停止导出，请先检查；不会把密钥放入备份');
  return result;
});}
export async function exportWebBackup(database:DatabasePort,password:string){return encryptBackup(new TextEncoder().encode(JSON.stringify(await snapshot(database))),password);}
async function decode(bytes:Uint8Array,password:string){
  const archive=archiveSchema.parse(JSON.parse(new TextDecoder().decode(await decryptBackup(bytes,password))));
  if(Object.keys(archive.tables).some(t=>!(WEB_BACKUP_TABLES as readonly string[]).includes(t)))throw new Error('备份包含非业务资料，拒绝恢复');
  if(credentialValue(JSON.stringify(archive.tables)))throw new Error('备份疑似包含凭证，拒绝导入');return archive;
}
/** Restore missing rows only. Existing newer data and deletion/hide markers always win. No automatic AI work. */
export async function restoreWebBackup(database:DatabasePort,bytes:Uint8Array,password:string,apply=false){
  const archive=await decode(bytes,password);
  const inspect=async(tx:SqlReader)=>{
    const [schema]=await tx.all<{version:number}>({sql:'SELECT MAX(version) version FROM _schema_migrations'});if(archive.version>schema.version)throw new Error('备份来自较新版本，请先升级软件');
    const pending:Array<{table:string;row:Record<string,string|number|null>}>=[];let conflicts=0,unchanged=0;
    for(const [table,rows] of Object.entries(archive.tables)){
      const shape=await columns(tx,table),names=new Set(shape.map(c=>c.name)),pk=shape.filter(c=>c.pk).sort((a,b)=>a.pk-b.pk).map(c=>c.name);
      if(!pk.length&&rows.length)throw new Error(`备份表 ${table} 缺少稳定主键`);
      for(const original of rows){
        if(Object.keys(original).some(k=>!names.has(k))||pk.some(k=>original[k]===undefined))throw new Error('备份字段不兼容，现有数据未改动');
        const [current]=await tx.all<Record<string,string|number|null>>({sql:`SELECT * FROM "${table}" WHERE ${pk.map(k=>`"${k}" IS ?`).join(' AND ')}`,args:pk.map(k=>original[k])});
        if(current){if(Object.entries(original).every(([k,v])=>current[k]===v))unchanged++;else conflicts++;continue;}
        const row={...original};
        if(table==='light_study_sessions'||table==='four_step_sessions'){if(row.status==='active')row.status='paused';}
        if(table==='sentence_study_sessions'&&row.status==='active'){row.status='paused';const view=JSON.parse(String(row.view_json));view.status='paused';row.view_json=JSON.stringify(view);}
        if(table==='practice_materials'){row.lease_token=null;row.lease_until=null;if(['generating','reviewing'].includes(String(row.status)))row.status='queued';}
        if(table==='runtime_requests'&&row.state==='pending'){row.state='unknown';row.error_code='result_unknown';}
        pending.push({table,row});
      }
    }return {pending,conflicts,unchanged};
  };
  if(!apply){const result=await database.read(inspect);return {added:result.pending.length,conflicts:result.conflicts,unchanged:result.unchanged,applied:false,createdAt:archive.createdAt};}
  return database.write(async tx=>{
    const result=await inspect(tx);await tx.run({sql:'PRAGMA defer_foreign_keys=ON'});
    for(const {table,row} of result.pending){const keys=Object.keys(row);await tx.run({sql:`INSERT INTO "${table}" (${keys.map(k=>`"${k}"`).join(',')}) VALUES (${keys.map(()=>'?').join(',')})`,args:keys.map(k=>row[k]) as SqlValue[]});}
    return {added:result.pending.length,conflicts:result.conflicts,unchanged:result.unchanged,applied:true,createdAt:archive.createdAt};
  });
}

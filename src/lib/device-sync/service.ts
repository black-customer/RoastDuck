import type {DatabasePort,SqlWriter,SqlReader,SqlValue} from '@/lib/platform/database';
import {query as sql} from '@/lib/platform/sql';
import {credentialValue,parseJson} from '@/lib/app-services/shared';
import {TrainingError} from '@/lib/four-step/shared';
import {SYNC_ENTITIES,syncChangeSchema,changeHash,contentHash,canonical,ownedEntities,type SyncEntity,type SyncRow,type SyncChange} from './contracts';
import {mergeConcurrent} from './merge';
import {projectChatMessage,projectCompanionMessage} from './chat-branches';
type Meta={columns:string[];primary:string[]};
type Head={entity:SyncEntity;record_key:string;heads_json:string;projection_hash:string};
type Stored={change_id:string;device_id:string;entity:SyncEntity;record_key:string;parents_json:string;payload_json:string;changed_at:string;sequence:number};
const decoded=(row:Stored):SyncChange=>({id:row.change_id,deviceId:row.device_id,entity:row.entity,key:row.record_key,parents:JSON.parse(row.parents_json),row:JSON.parse(row.payload_json),at:row.changed_at});
const quoted=(name:string)=>`"${name}"`; // Only trusted schema column names, never supplied identifiers.
const keyOf=(row:SyncRow,meta:Meta)=>canonical(meta.primary.map(column=>row[column]));
export function createDeviceSync(database:DatabasePort,identity:{device_id:string;dataset_id:string},clock:{now:()=>Date}){
  const metadata=new Map<SyncEntity,Meta>();
  async function meta(tx:SqlReader,entity:SyncEntity){
    if(metadata.has(entity))return metadata.get(entity)!;
    const rows=await tx.all<{name:string;pk:number}>({sql:`PRAGMA table_info(${quoted(entity)})`});
    const primary=rows.filter(row=>row.pk).sort((a,b)=>a.pk-b.pk).map(row=>row.name);
    if(!rows.length||!primary.length)throw new Error(`同步实体结构不可确认：${entity}`);
    const value={columns:rows.map(row=>row.name),primary};metadata.set(entity,value);return value;
  }
  async function getRow(tx:SqlReader,entity:SyncEntity,key:string){
    const shape=await meta(tx,entity),values=JSON.parse(key) as SqlValue[];
    if(!Array.isArray(values)||values.length!==shape.primary.length||values.some(v=>typeof v!=='string'&&typeof v!=='number'))throw new Error('记录主键无效');
    return (await tx.all<SyncRow>({sql:`SELECT * FROM ${quoted(entity)} WHERE ${shape.primary.map(c=>`${quoted(c)}=?`).join(' AND ')}`,args:values}))[0]??null;
  }
  async function store(tx:SqlWriter,change:SyncChange){
    await tx.run(sql`INSERT INTO device_sync_changes(change_id,device_id,entity,record_key,parents_json,payload_json,changed_at)
      VALUES(${change.id},${change.deviceId},${change.entity},${change.key},${JSON.stringify(change.parents)},${JSON.stringify(change.row)},${change.at}) ON CONFLICT(change_id) DO NOTHING`);
  }
  async function writeHeads(tx:SqlWriter,entity:SyncEntity,key:string,heads:string[],row:SyncRow|null){
    await tx.run(sql`INSERT INTO device_sync_heads(entity,record_key,heads_json,projection_hash) VALUES(${entity},${key},${JSON.stringify(heads.sort())},${contentHash(row)})
      ON CONFLICT(entity,record_key) DO UPDATE SET heads_json=excluded.heads_json,projection_hash=excluded.projection_hash`);
  }
  async function captureIn(tx:SqlWriter){
    let changed=0;const excluded:Array<{entity:SyncEntity;key:string;reason:string}>=[];
    for(const entity of SYNC_ENTITIES){
      const shape=await meta(tx,entity),rows=await tx.all<SyncRow>({sql:`SELECT * FROM ${quoted(entity)}`});
      const heads=new Map((await tx.all<Head>(sql`SELECT * FROM device_sync_heads WHERE entity=${entity}`)).map(row=>[row.record_key,row]));
      const seen=new Set<string>();
      for(const row of rows){
        const key=keyOf(row,shape);seen.add(key);
        if(heads.get(key)?.projection_hash===contentHash(row))continue;
        if(credentialValue(JSON.stringify(row))){excluded.push({entity,key,reason:'sensitive_credential'});continue;}
        const raw={deviceId:identity.device_id,entity,key,parents:parseJson<string[]>(heads.get(key)?.heads_json??'[]',[]),row,at:clock.now().toISOString()};
        const change={...raw,id:changeHash(raw)};await store(tx,change);await writeHeads(tx,entity,key,[change.id],row);changed++;
        if(ownedEntities.has(entity))await tx.run(sql`INSERT INTO device_sync_owners(entity,record_key,owner_device_id,paused) VALUES(${entity},${key},${identity.device_id},${Number(row.status==='paused'||['ready','failed','completed'].includes(String(row.status)))})
          ON CONFLICT(entity,record_key) DO UPDATE SET paused=excluded.paused WHERE owner_device_id=${identity.device_id}`);
      }
      for(const [key,head] of heads){
        if(seen.has(key)||head.projection_hash===contentHash(null))continue;
        const raw={deviceId:identity.device_id,entity,key,parents:JSON.parse(head.heads_json) as string[],row:null,at:clock.now().toISOString()},change={...raw,id:changeHash(raw)};
        await store(tx,change);await writeHeads(tx,entity,key,[change.id],null);changed++;
      }
    }return {changed,excluded};
  }
  const capture=()=>database.write(captureIn);
  async function manifest(){return database.read(async tx=>{
    const counts:Record<string,number>={};for(const entity of SYNC_ENTITIES)counts[entity]=Number((await tx.all<{n:number}>({sql:`SELECT count(*) n FROM ${quoted(entity)}`}))[0].n);
    const [end]=await tx.all<{seq:number}>(sql`SELECT COALESCE(MAX(sequence),0) seq FROM device_sync_changes`);
    return {protocol:1 as const,schemaVersion:28,deviceId:identity.device_id,datasetId:identity.dataset_id,sequence:end.seq,counts};
  });}
  async function changes(after=0,maxBytes=1_500_000){
    if(!Number.isSafeInteger(after)||after<0)throw new Error('同步位置无效');
    return database.read(async tx=>{
      const rows=await tx.all<Stored>(sql`SELECT * FROM device_sync_changes WHERE sequence>${after} ORDER BY sequence LIMIT 200`);
      const result:SyncChange[]=[];let bytes=0,cursor=after;
      for(const row of rows){const change=decoded(row),size=new TextEncoder().encode(JSON.stringify(change)).length;if(result.length&&bytes+size>maxBytes)break;if(size>4_000_000)throw new Error('单条同步记录过大，需要缩小材料快照');result.push(change);bytes+=size;cursor=row.sequence;}
      return {from:after,changes:result,cursor,hasMore:!!(await tx.all(sql`SELECT 1 FROM device_sync_changes WHERE sequence>${cursor} LIMIT 1`)).length};
    });
  }
  async function putRow(tx:SqlWriter,entity:SyncEntity,key:string,row:SyncRow|null){
    const shape=await meta(tx,entity);
    if(row===null){
      // Original answers/audit history are never physically erased by an old peer's tombstone.
      if(['question_favorites','difficult_notes'].includes(entity))await tx.run({sql:`DELETE FROM ${quoted(entity)} WHERE ${shape.primary.map(c=>`${quoted(c)}=?`).join(' AND ')}`,args:JSON.parse(key)});
      return;
    }
    if(entity==='free_talk_messages')row=await projectChatMessage(tx,row);
    if(entity==='companion_messages')row=await projectCompanionMessage(tx,row);
    const columns=Object.keys(row);
    if(columns.some(column=>!shape.columns.includes(column))||shape.columns.some(column=>!columns.includes(column))||keyOf(row,shape)!==key)throw new Error('同步字段或稳定 ID 不匹配');
    if(entity==='audio_assets'&&!/^data\/audio\/(?:cache|generated)\/[a-zA-Z0-9_/-]+\.(?:wav|opus|mp3|ogg)$/.test(String(row.relative_path)))throw new Error('音频路径不在允许的缓存目录');
    const updates=columns.filter(c=>!shape.primary.includes(c));
    await tx.run({sql:`INSERT INTO ${quoted(entity)}(${columns.map(quoted).join(',')}) VALUES(${columns.map(()=>'?').join(',')}) ON CONFLICT(${shape.primary.map(quoted).join(',')}) DO UPDATE SET ${updates.map(c=>`${quoted(c)}=excluded.${quoted(c)}`).join(',')||`${quoted(shape.primary[0])}=excluded.${quoted(shape.primary[0])}`}`,args:columns.map(c=>row[c])});
  }
  async function receive(peerId:string,from:number,through:number,raw:unknown){
    if(peerId===identity.device_id||!Number.isSafeInteger(from)||from<0||!Number.isSafeInteger(through)||through<from)throw new Error('同步设备或回执无效');
    const incoming=syncChangeSchema.array().max(200).parse(raw);
    for(const change of incoming){const {id,...body}=change;if(changeHash(body)!==id||credentialValue(JSON.stringify(change.row)))throw new Error('同步校验失败或包含敏感凭证');}
    return database.write(async tx=>{
      const current=(await tx.all<{received_sequence:number}>(sql`SELECT received_sequence FROM device_sync_receipts WHERE peer_id=${peerId}`))[0]?.received_sequence??0;
      if(from!==current){
        if(through<=current){for(const change of incoming)if(!(await tx.all(sql`SELECT 1 FROM device_sync_changes WHERE change_id=${change.id}`)).length)throw new Error('旧页未完整确认，请恢复同步检查点');return {added:0,conflicts:0};}
        throw new Error('同步页面不连续，请先恢复已确认的检查点');
      }
      await captureIn(tx); // Local offline changes are secured before any remote projection.
      const affected=new Map<string,{entity:SyncEntity;key:string}>();let added=0;
      for(const change of incoming){
        if((await tx.all(sql`SELECT 1 FROM device_sync_changes WHERE change_id=${change.id}`)).length)continue;
        for(const parent of change.parents){const [previous]=await tx.all<Stored>(sql`SELECT * FROM device_sync_changes WHERE change_id=${parent}`);if(!previous||previous.entity!==change.entity||previous.record_key!==change.key)throw new Error('缺少前序同步记录，请从已确认检查点续传');}
        await store(tx,change);affected.set(change.entity+'|'+change.key,{entity:change.entity,key:change.key});added++;
      }
      let conflicts=0;
      for(const {entity,key} of affected.values()){
        const history=await tx.all<Stored>(sql`SELECT * FROM device_sync_changes WHERE entity=${entity} AND record_key=${key}`),all=history.map(decoded),ancestors=new Set(all.flatMap(c=>c.parents));
        const heads=all.filter(change=>!ancestors.has(change.id)),merge=heads.length===1?{row:heads[0].row,reason:null}:mergeConcurrent(heads);
        let row=merge.row;
        if(ownedEntities.has(entity)&&row){
          const owner=heads.find(c=>c.row&&canonical(c.row)===canonical(row))??[...heads].sort((a,b)=>a.id.localeCompare(b.id))[0];
          const paused=['paused','ready','failed','completed'].includes(String(row.status));
          await tx.run(sql`INSERT INTO device_sync_owners(entity,record_key,owner_device_id,paused) VALUES(${entity},${key},${owner.deviceId},${Number(paused)}) ON CONFLICT(entity,record_key) DO UPDATE SET owner_device_id=excluded.owner_device_id,paused=excluded.paused`);
          if(owner.deviceId!==identity.device_id&&entity!=='practice_materials'&&row.status==='active')row={...row,status:'paused'};
        }
        if(merge.reason){
          const id=contentHash([entity,key,heads.map(c=>c.id).sort()]);conflicts++;
          await tx.run(sql`INSERT INTO device_sync_conflicts(id,entity,record_key,heads_json,reason,created_at) VALUES(${id},${entity},${key},${JSON.stringify(heads.map(c=>c.id).sort())},${merge.reason},${clock.now().toISOString()}) ON CONFLICT DO NOTHING`);
        }
        await putRow(tx,entity,key,row);
        await writeHeads(tx,entity,key,heads.map(c=>c.id),await getRow(tx,entity,key));
      }
      // A real edit creates a new ID. Revocation propagates down the version lineage after all projections.
      const descendants=await tx.all<SyncRow>(sql`WITH RECURSIVE revoked(id) AS (
        SELECT id FROM companion_memories WHERE status IN ('deleted','dismissed')
        UNION SELECT m.id FROM companion_memories m JOIN revoked r ON m.source_type='user_edit' AND m.source_id=r.id
      ) SELECT * FROM companion_memories WHERE status='active' AND id IN(SELECT id FROM revoked)`);
      for(const row of descendants){
        await tx.run(sql`UPDATE companion_memories SET status='dismissed' WHERE id=${row.id}`);
        await tx.run(sql`UPDATE device_sync_heads SET projection_hash=${contentHash({...row,status:'dismissed'})} WHERE entity='companion_memories' AND record_key=${canonical([row.id])}`);
        const id=contentHash(['memory_ancestor_revoked',row.id]);await tx.run(sql`INSERT INTO device_sync_conflicts(id,entity,record_key,heads_json,reason,created_at) VALUES(${id},'companion_memories',${canonical([row.id])},'[]','memory_ancestor_revoked',${clock.now().toISOString()}) ON CONFLICT DO NOTHING`);conflicts++;
      }
      const [memoryControl]=await tx.all<{cutoffs_json:string}>(sql`SELECT cutoffs_json FROM companion_memory_control WHERE singleton=1`);
      const cutoffs=parseJson<Record<string,number>>(memoryControl?.cutoffs_json??'{}',{});
      const extracted=await tx.all<SyncRow>(sql`SELECT * FROM companion_memories WHERE status='active' AND source_type='chat_message'`);
      for(const row of extracted){
        if(parseJson<{userRestored?:boolean}>(String(row.detail_json),{}).userRestored)continue;
        const ids=parseJson<string[]>(String(row.evidence_json),[]);if(!ids.length)continue;
        const sources=await tx.all<{id:string;thread_id:string;sequence_no:number;metadata_json:string}>({sql:`SELECT id,thread_id,sequence_no,metadata_json FROM companion_messages WHERE id IN(${ids.map(()=>'?').join(',')})`,args:ids});
        if(!ids.every(id=>cutoffs['@'+id]||sources.some(m=>m.id===id&&((cutoffs[m.thread_id]??-1)>=m.sequence_no||!!parseJson<{branchPrefixSourceId?:string}>(m.metadata_json,{}).branchPrefixSourceId))))continue;
        await tx.run(sql`UPDATE companion_memories SET status='dismissed' WHERE id=${row.id}`);
        await tx.run(sql`UPDATE device_sync_heads SET projection_hash=${contentHash({...row,status:'dismissed'})} WHERE entity='companion_memories' AND record_key=${canonical([row.id])}`);
        const id=contentHash(['memory_source_cleared',row.id]);await tx.run(sql`INSERT INTO device_sync_conflicts(id,entity,record_key,heads_json,reason,created_at) VALUES(${id},'companion_memories',${canonical([row.id])},'[]','memory_source_cleared',${clock.now().toISOString()}) ON CONFLICT DO NOTHING`);conflicts++;
      }
      await tx.run(sql`INSERT INTO device_sync_receipts(peer_id,received_sequence,updated_at) VALUES(${peerId},${through},${clock.now().toISOString()}) ON CONFLICT(peer_id) DO UPDATE SET received_sequence=MAX(received_sequence,excluded.received_sequence),updated_at=excluded.updated_at`);
      return {added,conflicts};
    });
  }
  const cursor=(peerId:string)=>database.read(async tx=>(await tx.all<{received_sequence:number}>(sql`SELECT received_sequence FROM device_sync_receipts WHERE peer_id=${peerId}`))[0]?.received_sequence??0);
  const conflicts=()=>database.read(tx=>tx.all<{id:string;entity:string;record_key:string;reason:string;status:string}>(sql`SELECT * FROM device_sync_conflicts WHERE status='unresolved' ORDER BY created_at DESC`));
  async function assertOwner(entity:SyncEntity,id:string){return database.read(async tx=>{
    const [owner]=await tx.all<{owner_device_id:string;paused:number}>(sql`SELECT * FROM device_sync_owners WHERE entity=${entity} AND record_key=${canonical([id])}`);
    if(owner&&owner.owner_device_id!==identity.device_id)throw new TrainingError(owner.paused?'先显式接续这份已暂停任务':'任务仍由另一台设备处理，请先在原设备暂停并同步',409,'remote_owned');
  });}
  const remoteTasks=()=>database.read(tx=>tx.all<{entity:SyncEntity;record_key:string;owner_device_id:string;paused:number}>(sql`SELECT * FROM device_sync_owners o WHERE owner_device_id!=${identity.device_id} AND (
    entity='light_study_sessions' AND EXISTS(SELECT 1 FROM light_study_sessions s WHERE json_array(s.id)=o.record_key AND s.status IN('active','paused'))
    OR entity='four_step_sessions' AND EXISTS(SELECT 1 FROM four_step_sessions s WHERE json_array(s.id)=o.record_key AND s.status IN('active','paused')))`));
  const mediaKeys=()=>database.read(async tx=>(await tx.all<{content_hash:string}>(sql`SELECT DISTINCT content_hash FROM audio_assets WHERE provider='mimo' AND format='wav' AND status='ready'`)).map(row=>row.content_hash));
  async function claim(entity:SyncEntity,key:string){
    if(!['light_study_sessions','four_step_sessions'].includes(entity))throw new TrainingError('生成任务请先在原设备完成当前阶段',409,'task_not_transferable');
    await database.write(async tx=>{
      const [owner]=await tx.all<{owner_device_id:string;paused:number}>(sql`SELECT * FROM device_sync_owners WHERE entity=${entity} AND record_key=${key}`);
      if(!owner||owner.owner_device_id===identity.device_id)return;
      const row=await getRow(tx,entity,key);
      if(!owner.paused||!row||row.status!=='paused')throw new TrainingError('请先在原设备暂停，并同步最新状态',409,'task_not_paused');
      await putRow(tx,entity,key,{...row,updated_at:clock.now().toISOString()});
      await tx.run(sql`UPDATE device_sync_owners SET owner_device_id=${identity.device_id} WHERE entity=${entity} AND record_key=${key}`);
      await captureIn(tx);
    });
  }
  return {capture,manifest,changes,receive,cursor,conflicts,assertOwner,remoteTasks,claim,mediaKeys};
}
export type DeviceSync=ReturnType<typeof createDeviceSync>;

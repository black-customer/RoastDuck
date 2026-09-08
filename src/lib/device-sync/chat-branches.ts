import type {SqlWriter} from '@/lib/platform/database';
import {query as sql} from '@/lib/platform/sql';
import {stableId,parseJson} from '@/lib/app-services/shared';
import {canonical,contentHash,type SyncRow} from './contracts';
type Branch={conversation_id:string;parent_id:string;origin_device_id:string;fork_sequence:number;fork_message_id:string};
async function creator(tx:SqlWriter,entity:string,id:string){return (await tx.all<{device_id:string}>(sql`SELECT device_id FROM device_sync_changes WHERE entity=${entity} AND record_key=${canonical([id])} ORDER BY sequence LIMIT 1`))[0]?.device_id??'legacy';}
async function refreshProjection(tx:SqlWriter,entity:string,row:SyncRow){await tx.run(sql`UPDATE device_sync_heads SET projection_hash=${contentHash(row)} WHERE entity=${entity} AND record_key=${canonical([row.id])}`);}
async function ensureBranch(tx:SqlWriter,parentId:string,origin:string,fork:number,forkMessageId:string){
  let [branch]=await tx.all<Branch>(sql`SELECT * FROM device_sync_chat_branches WHERE parent_id=${parentId} AND origin_device_id=${origin} AND fork_message_id=${forkMessageId}`);if(branch)return branch;
  const [parent]=await tx.all<SyncRow>(sql`SELECT * FROM free_talk_conversations WHERE id=${parentId}`);if(!parent)throw new Error('缺少聊天分支的原会话');
  const id=stableId('ft_branch',parentId,origin,forkMessageId),threadId=stableId('companion','free_talk:'+id);
  await tx.run(sql`INSERT INTO free_talk_conversations(id,title,mode,status,created_at,updated_at) VALUES(${id},${String(parent.title)+' · 另一设备的续聊'},${parent.mode},'active',${parent.created_at},${parent.updated_at}) ON CONFLICT DO NOTHING`);
  await tx.run(sql`INSERT INTO device_sync_chat_branches(conversation_id,parent_id,origin_device_id,fork_sequence,fork_message_id) VALUES(${id},${parentId},${origin},${fork},${forkMessageId}) ON CONFLICT DO NOTHING`);
  await tx.run(sql`INSERT INTO companion_threads(id,scope_key,scope_type,title,created_at,updated_at) VALUES(${threadId},${'free_talk:'+id},'general',${String(parent.title)+' · 另一设备的续聊'},${parent.created_at},${parent.updated_at}) ON CONFLICT DO NOTHING`);
  const prefix=await tx.all<SyncRow>(sql`SELECT * FROM free_talk_messages WHERE conversation_id=${parentId} AND sequence_no<${fork} ORDER BY sequence_no`);
  for(const row of prefix){
    const prefixId=stableId('ft_prefix',id,String(row.id)),metadata={...parseJson<Record<string,unknown>>(String(row.metadata_json),{}),branchPrefixSourceId:row.id};
    await tx.run(sql`INSERT INTO free_talk_messages(id,conversation_id,sequence_no,role,text,teaching_state,target_repetition,gap_count,metadata_json,created_at) VALUES(${prefixId},${id},${row.sequence_no},${row.role},${row.text},${row.teaching_state},${row.target_repetition},${row.gap_count},${JSON.stringify(metadata)},${row.created_at}) ON CONFLICT(id) DO NOTHING`);
  }
  [branch]=await tx.all<Branch>(sql`SELECT * FROM device_sync_chat_branches WHERE conversation_id=${id}`);return branch;
}
async function relocate(tx:SqlWriter,row:SyncRow,branch:Branch){
  await tx.run(sql`UPDATE free_talk_messages SET conversation_id=${branch.conversation_id} WHERE id=${row.id}`);
  await refreshProjection(tx,'free_talk_messages',{...row,conversation_id:branch.conversation_id});
  const threadId=stableId('companion','free_talk:'+branch.conversation_id),mirrors=await tx.all<SyncRow>(sql`SELECT * FROM companion_messages WHERE source_type='free_talk' AND source_id=${row.id}`);
  for(const mirror of mirrors){await tx.run(sql`UPDATE companion_messages SET thread_id=${threadId} WHERE id=${mirror.id}`);await refreshProjection(tx,'companion_messages',{...mirror,thread_id:threadId});}
}
/** Keep original message IDs/text; only the conversation grouping forks. Original snapshots remain auditable. */
export async function projectChatMessage(tx:SqlWriter,row:SyncRow):Promise<SyncRow>{
  const parentId=String(row.conversation_id),origin=await creator(tx,'free_talk_messages',String(row.id));
  const [known]=await tx.all<Branch>(sql`SELECT * FROM device_sync_chat_branches WHERE parent_id=${parentId} AND origin_device_id=${origin} AND fork_sequence<=${row.sequence_no} ORDER BY fork_sequence DESC LIMIT 1`);
  const metadata=parseJson<{previousMessageId?:string}>(String(row.metadata_json),{});
  let predecessor=metadata.previousMessageId;
  if(!predecessor&&known&&Number(row.sequence_no)>known.fork_sequence){
    const [previous]=await tx.all<{payload_json:string}>(sql`SELECT payload_json FROM device_sync_changes WHERE entity='free_talk_messages' AND device_id=${origin} AND json_extract(payload_json,'$.conversation_id')=${parentId} AND json_extract(payload_json,'$.sequence_no')=${Number(row.sequence_no)-1} ORDER BY sequence DESC LIMIT 1`);
    predecessor=previous?parseJson<{id:string}>(previous.payload_json,{id:''}).id:undefined;
  }
  if(predecessor){
    const [previous]=await tx.all<{conversation_id:string}>(sql`SELECT conversation_id FROM free_talk_messages WHERE id=${predecessor}`);
    if(previous&&previous.conversation_id!==parentId&&(await tx.all(sql`SELECT 1 FROM device_sync_chat_branches WHERE conversation_id=${previous.conversation_id} AND parent_id=${parentId}`)).length)return {...row,conversation_id:previous.conversation_id};
  }
  const [collision]=await tx.all<SyncRow>(sql`SELECT * FROM free_talk_messages WHERE conversation_id=${parentId} AND sequence_no=${row.sequence_no} AND id!=${row.id}`);
  if(!collision)return row;
  const otherOrigin=await creator(tx,'free_talk_messages',String(collision.id));
  const incomingWins=(origin+'|'+row.id).localeCompare(otherOrigin+'|'+collision.id)<0;
  const losingOrigin=incomingWins?otherOrigin:origin,losingId=String(incomingWins?collision.id:row.id),branch=await ensureBranch(tx,parentId,losingOrigin,Number(row.sequence_no),losingId);
  if(!incomingWins)return {...row,conversation_id:branch.conversation_id};
  const tail=await tx.all<SyncRow>(sql`SELECT * FROM free_talk_messages WHERE conversation_id=${parentId} AND sequence_no>=${row.sequence_no} ORDER BY sequence_no`);
  const moved=new Set([losingId]);
  for(const old of tail){const previous=parseJson<{previousMessageId?:string}>(String(old.metadata_json),{}).previousMessageId;
    if(old.id===losingId||previous&&moved.has(previous)||!previous&&await creator(tx,'free_talk_messages',String(old.id))===losingOrigin){await relocate(tx,old,branch);moved.add(String(old.id));}
  }
  return row;
}
export async function projectCompanionMessage(tx:SqlWriter,row:SyncRow){
  if(row.source_type!=='free_talk')return row;
  const [source]=await tx.all<{conversation_id:string}>(sql`SELECT conversation_id FROM free_talk_messages WHERE id=${row.source_id}`);
  if(!source)return row;
  const [thread]=await tx.all<{id:string}>(sql`SELECT id FROM companion_threads WHERE scope_key=${'free_talk:'+source.conversation_id}`);
  return thread?{...row,thread_id:thread.id}:row;
}

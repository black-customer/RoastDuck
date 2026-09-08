import { query as sql } from "@/lib/platform/sql";
import type { DatabasePort,SqlReader } from "@/lib/platform/database";
import { grade, newCard, type Card } from "@/lib/learning/fsrs";
import { hash } from "@/lib/four-step/shared";
import { type MaterialRow } from "@/lib/four-step/material-types";
import { createLightSchema, lightEventSchema, LIGHT_RATINGS, LightStudyError,
  type LightCard,type LightScope,type LightMode,type LightView,type LightOverview } from "./contracts";
import { materialFingerprint, createLightCatalogue, type ProgressRow } from "./core-catalogue";
import { createLightRound, lightRoundSchema } from "./round";
import { createV2LightService } from "./v2-service";
import {assertLocalOwnership,localOwnerFilter} from '@/lib/device-sync/ownership';
import {continueLegacy,findSuccession,notSuperseded,type LegacySession} from './succession';

interface SessionRow {
  id:string;scope_key:string;scope_json:string;mode:LightMode;status:LightView["status"];
  version:number;cursor:number;revealed:number;queue_json:string;created_at:string;updated_at:string;
  experience_version:"light_study_v1"|"light_study_v2";
  round_json:string|null;
}
const scopeKey=(scope:LightScope)=>JSON.stringify(scope);
const queue=(row:SessionRow)=>JSON.parse(row.queue_json) as LightCard[];
function remainingCards(row:SessionRow){
  const cards=queue(row);
  if(row.experience_version!=="light_study_v2")return cards.slice(row.cursor);
  const round=lightRoundSchema.parse(JSON.parse(row.round_json!));
  return round.queue.slice(round.cursor).map(item=>cards[item.sourceIndex]);
}
function availableSnapshotKeys(cards:LightCard[]){return new Set(cards.flatMap(card=>(card.sources?.length?card.sources:[{materialId:card.materialId}]).map(source=>card.itemId+':'+source.materialId)));}
async function session(db:SqlReader,id:string) {
  const [row]=await db.all<SessionRow>(sql`SELECT * FROM light_study_sessions WHERE id=${id}`);
  if(!row)throw new LightStudyError("轻学习记录不存在",404,"session_not_found");
  return row;
}
function basicView(row:SessionRow,unavailable:string|null=null,notice:string|null=null):LightView {
  const cards=queue(row);
  return {id:row.id,scope:JSON.parse(row.scope_json),mode:row.mode,status:row.status,version:row.version,
    index:row.cursor,total:cards.length,revealed:row.mode==="learn"||Boolean(row.revealed),
    card:unavailable?null:cards[row.cursor]??null,nextCard:null,unavailable,notice,experienceVersion:"light_study_v1"};
}
export interface LightServiceOptions { now:()=>Date; newId:()=>string; enabled:()=>boolean; allowMock?:boolean }
/** Shared desktop/native service. All SQL scopes are explicit; no network in transactions. */
export function createLightService(database:DatabasePort,options:LightServiceOptions) {
const {applyV2LightEvent,getV2LightView}=createV2LightService(database,options.allowMock);
async function getLightView(id:string,notice:string|null=null):Promise<LightView> {
  const row=await database.read(db=>session(db,id));
  if(row.experience_version==="light_study_v2"){
    const [predecessor]=await database.read(db=>db.all<{legacy_session_id:string}>(sql`SELECT legacy_session_id FROM light_study_succession_batches WHERE session_id=${id}`));
    return {...await getV2LightView(id,notice),...(predecessor?{legacySessionId:predecessor.legacy_session_id}:{})};
  }
  const successor=await database.read(db=>findSuccession(db,id));
  if(successor?.current_session_id)return {...await getV2LightView(successor.current_session_id,notice),legacySessionId:id};
  // Reading an old URL never reveals the retired teaching screen or writes a replacement session.
  return {...basicView(row,null,notice??(successor?'未学项已更新或暂不可用，原记录保留；没有记为学会。':null)),
    status:row.status==='completed'||successor?'completed':'paused',card:null,nextCard:null,revealed:false,
    needsUpgrade:row.status!=='completed'&&!successor,historyOnly:row.status==='completed'||!!successor,legacySessionId:id};
}
async function lightOverview(scope:LightScope,now=options.now()):Promise<LightOverview> {
  return database.read(async db=>{
  const {cards,progress,unavailableCount}=await createLightCatalogue(db,options.allowMock).readLightCatalogue(scope);
  const newCount=cards.filter(c=>!progress.has(c.itemId)).length;
  const dueCount=cards.filter(c=>(progress.get(c.itemId)?.due_at??"9999")<=now.toISOString()).length;
  const rows=await db.all<SessionRow>(sql`SELECT * FROM light_study_sessions WHERE scope_key=${scopeKey(scope)} AND status IN ('active','paused') AND ${notSuperseded} AND ${localOwnerFilter('light_study_sessions','light_study_sessions.id')} ORDER BY julianday(updated_at) DESC,id`);
  const resumable:LightOverview["resumable"]={};
  const eligibleIds=availableSnapshotKeys(cards);
  for(const row of rows){
    const cards=queue(row),round=row.experience_version==="light_study_v2"?lightRoundSchema.parse(JSON.parse(row.round_json!)):null;
    if(!resumable[row.mode]&&remainingCards(row).some(card=>eligibleIds.has(card.itemId+':'+card.materialId)))resumable[row.mode]={id:row.id,index:row.cursor,total:round?.queue.length??cards.length};
  }
  return {enabled:options.enabled(),scope,newCount,dueCount,totalCount:cards.length,unavailableCount,
    defaultMode:dueCount>0?"review":"learn",resumable};
  });
}

async function createLightSession(raw:unknown,now=options.now()):Promise<LightView> {
  const input=createLightSchema.parse(raw),key=scopeKey(input.scope),payloadHash=hash(JSON.stringify(input));
  const id=await database.write(async tx=>{
    const [duplicate]=await tx.all<{session_id:string;payload_hash:string}>(sql`SELECT * FROM light_study_events WHERE kind='create' AND client_event_id=${input.clientRequestId}`);
    if(duplicate){
      if(duplicate.payload_hash!==payloadHash)throw new LightStudyError("请求编号已用于不同范围",409,"request_conflict");
      const previous=await session(tx,duplicate.session_id);
      if(previous.experience_version==='light_study_v1'&&previous.status!=='completed'){
        const [first]=await tx.all<{session_id:string}>(sql`SELECT session_id FROM light_study_succession_batches WHERE legacy_session_id=${previous.id} ORDER BY batch_no LIMIT 1`);
        if(first)return first.session_id;
        if(await findSuccession(tx,previous.id))return previous.id;
        return continueLegacy(tx,previous,now,options.allowMock);
      }return duplicate.session_id;
    }
    const catalogue=await createLightCatalogue(tx,options.allowMock).readLightCatalogue(input.scope);
    const candidates=await tx.all<SessionRow>(sql`SELECT * FROM light_study_sessions WHERE scope_key=${key} AND mode=${input.mode} AND status IN ('active','paused') AND ${notSuperseded} AND ${localOwnerFilter('light_study_sessions','light_study_sessions.id')} ORDER BY (status='active') DESC,julianday(updated_at) DESC,id`);
    const eligibleIds=availableSnapshotKeys(catalogue.cards);
    const active=candidates.find(row=>row.experience_version==='light_study_v1'||remainingCards(row).some(card=>eligibleIds.has(card.itemId+':'+card.materialId)));
    // A stopped snapshot remains recoverable, but cannot monopolize this scope's active slot.
    for(const row of candidates)if(row.status==='active'&&row.id!==active?.id)await tx.run(sql`UPDATE light_study_sessions SET status='paused',version=version+1,updated_at=${now.toISOString()} WHERE id=${row.id}`);
    let id=active?.id;
    if(input.resumeSessionId){
      const requested=await session(tx,input.resumeSessionId);
      if(requested.scope_key!==key||requested.mode!==input.mode)throw new LightStudyError('恢复范围与原记录不一致',409,'scope_conflict');
      await assertLocalOwnership(tx,'light_study_sessions',requested.id);
      if(active&&active.id!==requested.id&&active.experience_version==='light_study_v2'&&active.status==='active'){
        const link=await findSuccession(tx,requested.id);
        if(link?.current_session_id!==active.id)throw new LightStudyError('这个范围已有正在进行的学习，请从首页继续当前一组',409,'session_in_use');
      }
      if(requested.experience_version==='light_study_v1'&&requested.status!=='completed')id=await continueLegacy(tx,requested,now,options.allowMock);
      else id=requested.id;
      const resumed=await session(tx,id);
      if(resumed.experience_version==='light_study_v2'&&resumed.status==='paused')await tx.run(sql`UPDATE light_study_sessions SET status='active',version=version+1,updated_at=${now.toISOString()} WHERE id=${id}`);
    }else if(active?.experience_version==='light_study_v1')id=await continueLegacy(tx,active,now,options.allowMock);
    else if(active){
      if(active.status==="paused")await tx.run(sql`UPDATE light_study_sessions SET status='active',version=version+1,updated_at=${now.toISOString()} WHERE id=${active.id}`);
    }else{
      const [backlog]=await tx.all<LegacySession>(sql`SELECT l.* FROM light_study_sessions l JOIN light_study_successions s ON s.legacy_session_id=l.id WHERE l.scope_key=${key} AND l.mode=${input.mode} AND s.remaining_json!='[]' ORDER BY s.updated_at DESC LIMIT 1`);
      if(backlog)id=await continueLegacy(tx,backlog,now,options.allowMock);
      if(!id){
      if(!options.enabled())throw new LightStudyError("轻松学暂未开放新批次，已有记录仍可恢复",503,"light_study_disabled");
      const progress=new Map((await tx.all<ProgressRow>(sql`SELECT * FROM light_study_progress`)).map(p=>[p.learning_item_id,p]));
      const candidates=catalogue.cards.filter(c=>input.mode==="learn"?!progress.has(c.itemId):(progress.get(c.itemId)?.due_at??"9999")<=now.toISOString());
      if(input.mode==="review")candidates.sort((a,b)=>progress.get(a.itemId)!.due_at.localeCompare(progress.get(b.itemId)!.due_at)||a.itemId.localeCompare(b.itemId));
      const cards=candidates.slice(0,5).map(c=>({...c,progressVersion:progress.get(c.itemId)?.version??0}));
      if(!cards.length)throw new LightStudyError(input.mode==="review"?"这个范围暂时没有到期表达":"这个范围暂时没有新的可学表达",409,"nothing_available");
      id=`light_${options.newId()}`;
      await tx.run(sql`INSERT INTO light_study_sessions(id,scope_key,scope_json,mode,queue_json,experience_version,round_json,created_at,updated_at)
        VALUES(${id},${key},${key},${input.mode},${JSON.stringify(cards)},'light_study_v2',${JSON.stringify(createLightRound(cards.length))},${now.toISOString()},${now.toISOString()})`);
      }
    }
    await tx.run(sql`INSERT INTO light_study_events(session_id,client_event_id,kind,payload_hash,outcome,created_at)
      VALUES(${id!},${input.clientRequestId},'create',${payloadHash},'created_or_resumed',${now.toISOString()})`);
    return id!;
  });
  return getLightView(id);
}

async function applyLightEvent(id:string,raw:unknown,now=options.now()):Promise<LightView> {
  const event=lightEventSchema.parse(raw),payloadHash=hash(JSON.stringify(event));
  const before=await database.read(db=>session(db,id));
  if(before.experience_version==="light_study_v2"){const result=await applyV2LightEvent(id,event,now);return getLightView(id,result.notice);}
  const notice=await database.write(async db=>{
    await assertLocalOwnership(db,'light_study_sessions',id);
    const row=await session(db,id),card=queue(row)[row.cursor];
    const unavailable=card?await createLightCatalogue(db,options.allowMock).snapshotAvailability(card):null;
    const [receipt]=await db.all<{payload_hash:string;outcome:string}>(sql`SELECT * FROM light_study_events WHERE session_id=${id} AND client_event_id=${event.clientEventId}`);
    if(receipt){
      if(receipt.payload_hash!==payloadHash)throw new LightStudyError("事件编号已用于不同操作",409,"event_conflict");
      return receipt.outcome==="skipped"?"已跳过发生变化的表达，没有重复评分。":null;
    }
    const successor=await findSuccession(db,id);
    if((row.status!=="active"&&!successor)||row.version!==event.version||successor&&event.version>successor.cutover_version)throw new LightStudyError("学习位置已更新，已恢复最新位置",409,"version_conflict");
    const item=queue(row)[row.cursor];
    let outcome="recorded",rating:string|null=null,notice:string|null=null;
    if(event.type==="pause")row.status="paused";
    else{
      if(!item)throw new LightStudyError("本批已经结束");
      const [progress]=await db.all<ProgressRow>(sql`SELECT * FROM light_study_progress WHERE learning_item_id=${item.itemId}`);
      const [material]=await db.all<MaterialRow>(sql`SELECT * FROM practice_materials WHERE id=${item.materialId}`);
      const validItem=(await db.all(sql`SELECT 1 FROM learning_items WHERE id=${item.itemId} AND status='active'`)).length>0;
      const changed=unavailable || !validItem || !material || material.status!=="ready" || materialFingerprint(material)!==item.materialHash || (progress?.version??0)!==item.progressVersion;
      if(changed){outcome="skipped";notice=typeof changed==="string"?changed:"这项材料或进度已变化，已跳过，没有记为学会。";row.cursor++;row.revealed=0;}
      else if(event.type==="reveal"){
        if(row.mode!=="review")throw new LightStudyError("新学已经展示表达");
        row.revealed=1;
      }else if(event.type==="advance"){
        if(row.mode!=="learn")throw new LightStudyError("请先揭晓，再选择本次回想情况",409,"rating_required");
        await db.run(sql`INSERT INTO light_study_progress(learning_item_id,first_seen_at,last_seen_at,due_at)
          VALUES(${item.itemId},${now.toISOString()},${now.toISOString()},${new Date(now.getTime()+86400000).toISOString()})`);
        outcome="exposure";row.cursor++;
      }else{
        if(row.mode!=="review"||!row.revealed||!progress)throw new LightStudyError("先揭晓表达，再记录自评",409,"reveal_required");
        const prior:Card=progress.fsrs_json?JSON.parse(progress.fsrs_json):newCard(now);
        prior.due=new Date(prior.due);if(prior.last_review)prior.last_review=new Date(prior.last_review);
        const next=grade(prior,LIGHT_RATINGS[event.rating],now).card;
        await db.run(sql`UPDATE light_study_progress SET fsrs_json=${JSON.stringify(next)},due_at=${next.due.toISOString()},
          last_seen_at=${now.toISOString()},review_count=review_count+1,version=version+1,last_rating=${event.rating} WHERE learning_item_id=${item.itemId}`);
        rating=event.rating;outcome="self_report";row.cursor++;row.revealed=0;
      }
      if(row.cursor>=queue(row).length)row.status="completed";
    }
    await db.run(sql`UPDATE light_study_sessions SET cursor=${row.cursor},revealed=${row.revealed},status=${successor?'paused':row.status},version=version+1,updated_at=${now.toISOString()} WHERE id=${id}`);
    await db.run(sql`INSERT INTO light_study_events(session_id,client_event_id,kind,payload_hash,learning_item_id,rating,outcome,created_at)
      VALUES(${id},${event.clientEventId},${event.type},${payloadHash},${card?.itemId??null},${rating},${outcome},${now.toISOString()})`);
    return notice;
  });
  return getLightView(id,notice);
}

return {getLightView,lightOverview,createLightSession,applyLightEvent};
}
export type LightStudyService=ReturnType<typeof createLightService>;

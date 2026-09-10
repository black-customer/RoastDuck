import { query as sql } from "@/lib/platform/sql";
import type { DatabasePort,SqlReader } from "@/lib/platform/database";
import { hash } from "@/lib/four-step/shared";
import type { MaterialRow } from "@/lib/four-step/material-types";
import { LightStudyError, type LightCard, type LightEvent, type LightScope, type LightView } from "./contracts";
import {gradeLightCard,LIGHT_SCHEDULER_VERSION} from "./scheduler";
import { materialFingerprint, createLightCatalogue, type ProgressRow } from "./core-catalogue";
import { advanceLightRound, consolidationIsEligible, initialWasAssessed, lightRoundSchema, revealLightRound, type LightRound } from "./round";
import {assertLocalOwnership} from '@/lib/device-sync/ownership';

interface V2Row {
  id:string; scope_json:string; mode:"learn"|"review"; status:LightView["status"]; version:number;
  cursor:number; revealed:number; queue_json:string; round_json:string;
}
async function readRow(db:SqlReader,id:string) {
  const [row] = await db.all<V2Row>(sql`SELECT * FROM light_study_sessions WHERE id=${id} AND experience_version='light_study_v2'`);
  if (!row) throw new LightStudyError("轻学习记录不存在",404,"session_not_found");
  return row;
}
function decode(row:V2Row) {
  try {
    const round = lightRoundSchema.parse(JSON.parse(row.round_json));
    const cards:LightCard[] = JSON.parse(row.queue_json);
    if (cards.length !== round.initialCount || round.cursor !== row.cursor || round.revealed !== Boolean(row.revealed)) throw new Error("inconsistent snapshot");
    return { round,cards };
  } catch { throw new LightStudyError("学习位置暂时无法读取，原记录已保留",409,"invalid_snapshot"); }
}
function current(round:LightRound,cards:LightCard[],position=round.cursor) {
  const sourceIndex=round.queue[position]?.sourceIndex,card=cards[sourceIndex];
  return card?{...card,progressVersion:card.progressVersion+(initialWasAssessed(round,sourceIndex)?1:0)}:undefined;
}
function project(row:V2Row,round:LightRound,cards:LightCard[],unavailable:string|null,notice:string|null):LightView {
  const occurrence=round.queue[round.cursor];
  const summary=round.assessments.filter(value=>value.phase==="initial").map(value=>{
    const latest=round.assessments.filter(other=>other.sourceIndex===value.sourceIndex).at(-1)!;
    return {itemId:cards[value.sourceIndex].itemId,chinese:cards[value.sourceIndex].chinese,initialRating:value.rating,latestRating:latest.rating};
  });
  return {id:row.id,scope:JSON.parse(row.scope_json) as LightScope,mode:row.mode,status:row.status,version:row.version,
    index:round.cursor,total:round.queue.length,revealed:round.revealed,card:unavailable?null:current(round,cards)??null,nextCard:null,
    unavailable,notice,experienceVersion:"light_study_v2",phase:occurrence?.phase??null,initialTotal:round.initialCount,
    initialIndex:occurrence?.sourceIndex??round.initialCount,questionId:cards.length&&cards.every(card=>card.questionId===cards[0].questionId)?cards[0].questionId:null,summary};
}
export function createV2LightService(database:DatabasePort,allowMock=false) {
async function getV2LightView(id:string,notice:string|null=null):Promise<LightView> {
  return database.read(async db=>{
  const {snapshotAvailability}=createLightCatalogue(db,allowMock);
  const row=await readRow(db,id),{round,cards}=decode(row),card=current(round,cards);
  const unavailable=card ? !consolidationIsEligible(round)?"间隔还不够，留到下次复习。":await snapshotAvailability(card) : null;
  const view=project(row,round,cards,unavailable,notice);
  if(row.status==='completed'){
    const catalogue=await createLightCatalogue(db,allowMock).readLightCatalogue(view.scope);
    const eligible=new Map(catalogue.cards.map(card=>[card.itemId,card]));
    view.summary=await Promise.all((view.summary??[]).map(async item=>{
      const snapshot=cards.find(card=>card.itemId===item.itemId)!;
      try{
        const source=await createLightCatalogue(db,allowMock).readLightCatalogue({type:'material',id:snapshot.materialId});
        const live=source.cards.find(card=>card.itemId===item.itemId&&card.rowIndex===snapshot.rowIndex&&card.materialHash===snapshot.materialHash);
        return {...item,english:live?snapshot.english:undefined};
      }catch(error){if(error instanceof LightStudyError&&error.status===404)return {...item,english:undefined};throw error;}
    }));
    const due=view.summary?.flatMap(item=>eligible.has(item.itemId)&&catalogue.progress.has(item.itemId)?[catalogue.progress.get(item.itemId)!.due_at]:[]).sort();
    view.nextDueAt=due?.[0]??null;
  }
  const next=current(round,cards,round.cursor+1);
  if(row.status!=="completed"&&next&&!await snapshotAvailability(next))view.nextCard=next;
  return view;
  });
}

async function applyV2LightEvent(id:string,event:LightEvent,now:Date):Promise<LightView> {
  const payloadHash=hash(JSON.stringify(event));
  const notice=await database.write(async db=>{
    await assertLocalOwnership(db,'light_study_sessions',id);
    const row=await readRow(db,id),{cards}=decode(row);
    let {round}=decode(row);
    const beforeCard=current(round,cards);
    const {snapshotAvailability}=createLightCatalogue(db,allowMock);
    const unavailable=beforeCard?await snapshotAvailability(beforeCard):null;
    const [receipt]=await db.all<{payload_hash:string;outcome:string}>(sql`SELECT * FROM light_study_events WHERE session_id=${id} AND client_event_id=${event.clientEventId}`);
    if(receipt){
      if(receipt.payload_hash!==payloadHash)throw new LightStudyError("事件编号已用于不同操作",409,"event_conflict");
      return receipt.outcome==="skipped"?"已跳过发生变化的表达，没有重复记录。":null;
    }
    if(row.status!=="active"||row.version!==event.version)throw new LightStudyError("学习位置已更新，请恢复最新位置",409,"version_conflict",project(row,round,cards,null,null));
    const occurrence=round.queue[round.cursor],item=current(round,cards);
    let outcome="recorded",rating:string|null=null,message:string|null=null;
    if(event.type==="pause")row.status="paused";
    else {
      if(!occurrence||!item)throw new LightStudyError("本组已经结束");
      const [progress]=await db.all<ProgressRow>(sql`SELECT * FROM light_study_progress WHERE learning_item_id=${item.itemId}`);
      const [material]=await db.all<MaterialRow>(sql`SELECT * FROM practice_materials WHERE id=${item.materialId}`);
      const active=(await db.all(sql`SELECT 1 FROM learning_items WHERE id=${item.itemId} AND status='active'`)).length>0;
      const expected=item.progressVersion;
      const changed=unavailable||!active||!material||material.status!=="ready"||materialFingerprint(material)!==item.materialHash||(progress?.version??0)!==expected;
      if(changed||!consolidationIsEligible(round)){
        round=advanceLightRound(round,null);outcome="skipped";
        message=typeof changed==="string"?changed:changed?"另一批次已更新这项，已跳过，没有重复评分。":"间隔不足，已留到下次复习。";
      }else if(event.type==="reveal")round=revealLightRound(round);
      else if(event.type==="advance")throw new LightStudyError("请揭晓后选择刚才的回想情况",409,"rating_required");
      else {
        if(!round.revealed)throw new LightStudyError("先揭晓表达，再选择回想情况",409,"reveal_required");
        rating=event.rating;
        if(occurrence.phase==="consolidation")outcome="consolidation";
        else if(row.mode==="learn"){
          const next=gradeLightCard(null,event.rating,now);
          await db.run(sql`INSERT INTO light_study_progress(learning_item_id,first_seen_at,last_seen_at,due_at,fsrs_json,last_rating,scheduler_version)
            VALUES(${item.itemId},${now.toISOString()},${now.toISOString()},${next.due.toISOString()},${JSON.stringify(next)},${event.rating},${LIGHT_SCHEDULER_VERSION})`);
          outcome="diagnostic_exposure";
        }else {
          if(!progress)throw new LightStudyError("复习记录不存在",409,"invalid_progress");
          const next=gradeLightCard(progress.fsrs_json,event.rating,now);
          await db.run(sql`UPDATE light_study_progress SET fsrs_json=${JSON.stringify(next)},due_at=${next.due.toISOString()},
            last_seen_at=${now.toISOString()},review_count=review_count+1,version=version+1,last_rating=${event.rating},scheduler_version=${LIGHT_SCHEDULER_VERSION} WHERE learning_item_id=${item.itemId}`);
          outcome="self_report";
        }
        round=advanceLightRound(round,event.rating);
      }
      if(round.cursor===round.queue.length)row.status="completed";
    }
    await db.run(sql`UPDATE light_study_sessions SET round_json=${JSON.stringify(round)},cursor=${round.cursor},revealed=${Number(round.revealed)},
      status=${row.status},version=version+1,updated_at=${now.toISOString()} WHERE id=${id}`);
    await db.run(sql`INSERT INTO light_study_events(session_id,client_event_id,kind,payload_hash,learning_item_id,rating,outcome,phase,created_at)
      VALUES(${id},${event.clientEventId},${event.type},${payloadHash},${item?.itemId??null},${rating},${outcome},${occurrence?.phase??null},${now.toISOString()})`);
    return message;
  });
  return getV2LightView(id,notice);
}

return {getV2LightView,applyV2LightEvent};
}

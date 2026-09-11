import type {DatabasePort,SqlReader,SqlWriter} from '@/lib/platform/database';
import {query as sql} from '@/lib/platform/sql';
import {hash} from '@/lib/four-step/shared';
import {gradeLightCard} from '@/lib/light-study/scheduler';
import {readSentenceCatalogue,sentenceGroup,type SentenceProgress} from './catalogue';
import {SentenceStudyError,sentenceScopeSchema,sentenceCreateSchema,sentenceEventSchema,projectSentenceEvent,emptySentencePractice,type SentenceSession,type SentenceOverview,type SentenceScope,type SentenceRating} from './contracts';
interface SessionRow {id:string;version:number;view_json:string;request_hash:string;status:string}
interface EventRow {client_event_id:string;payload_hash:string;kind:string;sentence_id:string|null;rating:SentenceRating|null;before_progress_json:string|null;after_progress_version:number|null;created_at:string}
const keyOf=(scope:SentenceScope)=>JSON.stringify(scope);
async function readSession(db:SqlReader,id:string){const [r]=await db.all<SessionRow>(sql`SELECT * FROM sentence_study_sessions WHERE id=${id}`);if(!r)throw new SentenceStudyError('学习记录不存在',404,'session_missing');return JSON.parse(r.view_json) as SentenceSession;}
async function putProgress(tx:SqlWriter,id:string,before:SentenceProgress|undefined,rating:SentenceRating,at:string,version:number){
  const card=gradeLightCard(before?.fsrs_json??null,rating,new Date(at)),due=card.due.toISOString();
  await tx.run(sql`INSERT INTO sentence_study_progress(sentence_id,first_seen_at,last_seen_at,due_at,fsrs_json,review_count,version,last_rating) VALUES(${id},${before?.first_seen_at??at},${at},${due},${JSON.stringify(card)},${before?(before.review_count+1):0},${version},${rating}) ON CONFLICT(sentence_id) DO UPDATE SET last_seen_at=excluded.last_seen_at,due_at=excluded.due_at,fsrs_json=excluded.fsrs_json,review_count=excluded.review_count,version=excluded.version,last_rating=excluded.last_rating`);
  return due;
}
export function createSentenceService(database:DatabasePort,platform:{now:()=>Date;newId:()=>string;random?:()=>number}){
  async function availableView(db:SqlReader,stored:SentenceSession,heal=false){
    const view=structuredClone(stored),catalogue=await readSentenceCatalogue(db,view.scope,platform.now()),live=new Map(catalogue.cards.map(c=>[c.id,c]));
    let changed=false;
    const past=view.cards.slice(0,view.index).map(c=>{const current=live.get(c.id);if(current&&current.version===c.version)return {...c,teaching:current.teaching,teachingRevision:current.teachingRevision,userHighlights:current.userHighlights};return {...c,english:'',teaching:undefined,userHighlights:[],chinese:'这句材料已更新，原学习记录保留。',contextZh:'',usages:[],notes:[],unavailable:'材料已更新或撤销'};});
    const rest=view.cards.slice(view.index).flatMap(c=>{
      const current=live.get(c.id);const valid=current&&current.version===c.version&&current.progressVersion===c.progressVersion;
      if(valid)return [{...c,teaching:current.teaching,teachingRevision:current.teachingRevision,userHighlights:current.userHighlights}];changed=true;
      if(heal)return current&&current.progressVersion===c.progressVersion?[current]:[];
      return [{...c,english:'',teaching:undefined,userHighlights:[],chinese:'材料或学习记录已更新，请恢复当前位置。',contextZh:'',usages:[],notes:[],unavailable:'需要恢复'}];
    });
    view.cards=[...past,...rest];
    if(changed){view.notice=heal?'已恢复最新材料；其他会话已经学习的句子已跳过，没有重复评分。':'材料或进度已变化，点击继续学习恢复当前位置。';view.status=heal?(view.index>=view.cards.length?'completed':'active'):'paused';
      if(heal&&(view.cards[view.index]?.id!==stored.cards[stored.index]?.id||view.cards[view.index]?.version!==stored.cards[stored.index]?.version)){view.revealed=false;view.stage='recall';view.practice=emptySentencePractice();}
    }
    const dues=view.assessments.flatMap(a=>catalogue.progress.has(a.sentenceId)?[catalogue.progress.get(a.sentenceId)!.due_at]:[]).sort();view.nextDueAt=dues[0]??null;return view;
  }
  async function overview(raw:SentenceScope={type:'all'}):Promise<SentenceOverview>{const scope=sentenceScopeSchema.parse(raw);return database.read(async db=>{
    const now=platform.now(),catalogue=await readSentenceCatalogue(db,scope,now,false),{cards,progress}=catalogue;
    const sessions=await db.all<{view_json:string}>(sql`SELECT view_json FROM sentence_study_sessions WHERE status IN ('active','paused') ORDER BY julianday(updated_at) DESC,id`);
    const resumable:SentenceOverview['resumable']={};
    for(const row of sessions){const v=JSON.parse(row.view_json) as SentenceSession;if(scope.type!=='all'&&keyOf(scope)!==keyOf(v.scope))continue;if(!resumable[v.mode]&&v.cards.slice(v.index).some(c=>cards.some(l=>l.id===c.id&&l.version===c.version&&l.progressVersion===c.progressVersion)))resumable[v.mode]={id:v.id,index:v.index,total:v.cards.length,title:v.cards[0]?.source.title??'句子学习'};}
    const sourceOptions=[...catalogue.sources];
    if(scope.type==='all'||scope.type==='collection'&&scope.id==='ielts'){
      const questions=await db.all<{id:string;text:string;text_zh:string;part:number;topic_id:string|null;topic:string}>(sql`SELECT q.id,q.text,q.text_zh,q.part,q.topic_id,COALESCE(t.name_zh,t.name_en,'未标注') topic FROM questions q LEFT JOIN topics t ON t.id=q.topic_id ORDER BY q.part,q.id`);
      for(const q of questions){
        const seasons=catalogue.seasonLinks.filter(s=>s.question_id===q.id).map(s=>({id:s.id,name:s.name}));
        if(scope.type==='collection'&&(scope.questionId&&scope.questionId!==q.id||scope.topicId&&scope.topicId!==q.topic_id||scope.seasonId&&!seasons.some(s=>s.id===scope.seasonId)))continue;
        if(!sourceOptions.some(s=>s.type==='question'&&s.id===q.id))sourceOptions.push({id:q.id,type:'question',title:q.text_zh||q.text,textEn:q.text,part:q.part,topicId:q.topic_id,topic:q.topic,seasons,materialId:null,totalCount:0,newCount:0,dueCount:0,materialStatus:catalogue.materialStates.find(m=>m.questionId===q.id)?.status??null,href:`/questions/${q.id}/practice`});
      }
    }
    const [{count}]=await db.all<{count:number}>(sql`SELECT COUNT(*) count FROM sentence_study_progress`);
    return {scope,totalCount:cards.length,newCount:cards.filter(c=>!progress.has(c.id)).length,dueCount:cards.filter(c=>Date.parse(progress.get(c.id)?.due_at??'')<=now.getTime()).length,studiedCount:Number(count),unavailableCount:catalogue.unavailableCount,resumable,sources:sourceOptions};
  });}
  async function get(id:string){return database.read(async db=>availableView(db,await readSession(db,id)));}
  async function create(raw:unknown){const input=sentenceCreateSchema.parse(raw),requestHash=hash(JSON.stringify(input)),now=platform.now();
    const id=await database.write(async tx=>{
      const [existing]=await tx.all<SessionRow>(sql`SELECT * FROM sentence_study_sessions WHERE request_id=${input.clientRequestId}`);
      if(existing){if(existing.request_hash!==requestHash)throw new SentenceStudyError('请求编号已用于另一范围',409,'request_conflict');return existing.id;}
      if(input.resumeSessionId){const prior=await readSession(tx,input.resumeSessionId);if(prior.mode!==input.mode)throw new SentenceStudyError('恢复模式不一致');if(input.scope.type!=='all'&&keyOf(input.scope)!==keyOf(prior.scope))throw new SentenceStudyError('恢复范围不一致');return prior.id;}
      const catalogue=await readSentenceCatalogue(tx,input.scope,now);
      let cards=catalogue.cards.filter(c=>input.mode==='learn'?!catalogue.progress.has(c.id):Date.parse(catalogue.progress.get(c.id)?.due_at??'')<=now.getTime());
      if(input.scope.type==='all'||input.scope.type==='collection'){
        const groups=[...new Set(cards.filter(c=>input.mode==='review'||input.scope.type==='collection'&&input.scope.id==='free_talk'||!!c.source.questionId).map(sentenceGroup))];
        if(input.mode==='review')groups.sort((a,b)=>Math.min(...cards.filter(c=>sentenceGroup(c)===a).map(c=>Date.parse(catalogue.progress.get(c.id)!.due_at)))-Math.min(...cards.filter(c=>sentenceGroup(c)===b).map(c=>Date.parse(catalogue.progress.get(c.id)!.due_at))));
        const chosen=groups[input.mode==='learn'?Math.min(groups.length-1,Math.floor((platform.random?.()??Math.random())*groups.length)):0];cards=cards.filter(c=>sentenceGroup(c)===chosen);
      }
      if(!cards.length)throw new SentenceStudyError(input.mode==='review'?'这个范围暂时没有到期句子':'这个范围暂时没有新句子，请选择题目准备材料',409,'no_sentences');
      cards.sort((a,b)=>a.ordinal-b.ordinal);
      const first=cards[0],scope:SentenceScope=first.source.questionId?{type:'question',id:first.source.questionId}:{type:'conversation',id:first.source.id};
      const actualScope=input.scope.type==='material'?input.scope:scope;
      const v:SentenceSession={id:`ss_${platform.newId()}`,scope:actualScope,mode:input.mode,status:'active',version:0,cards,index:0,revealed:false,assessments:[],lastRatingEventId:null,nextDueAt:null,notice:null,...(input.experienceVersion?{experienceVersion:input.experienceVersion,stage:'recall' as const,practice:emptySentencePractice()}:{})};
      await tx.run(sql`INSERT INTO sentence_study_sessions(id,scope_json,scope_key,mode,status,view_json,request_id,request_hash,created_at,updated_at) VALUES(${v.id},${JSON.stringify(v.scope)},${keyOf(v.scope)},${v.mode},'active',${JSON.stringify(v)},${input.clientRequestId},${requestHash},${now.toISOString()},${now.toISOString()})`);
      return v.id;
    });return get(id);
  }
  async function event(id:string,raw:unknown){const input=sentenceEventSchema.parse(raw),payloadHash=hash(JSON.stringify(input));return database.write(async tx=>{
    let v=await readSession(tx,id);const stamp=platform.now().toISOString();
    const [receipt]=await tx.all<EventRow>(sql`SELECT * FROM sentence_study_events WHERE session_id=${id} AND client_event_id=${input.clientEventId}`);
    if(receipt){if(receipt.payload_hash!==payloadHash)throw new SentenceStudyError('同一操作编号对应了不同内容',409,'event_conflict');return availableView(tx,v);}
    if(v.version!==input.version)throw new SentenceStudyError('另一窗口已更新，请恢复最新位置',409,'version_conflict');
    if(v.experienceVersion&&(input.type==='rate'||input.type==='reveal')&&input.experienceVersion!==v.experienceVersion)throw new SentenceStudyError('学习界面已更新，请刷新页面后继续；原记录仍保留。',409,'client_update_required');
    if(input.type==='resume')v=await availableView(tx,v,true);
    // Validate the transition before touching scheduling state.
    const next=projectSentenceEvent(v,input,stamp);
    let before:SentenceProgress|undefined,afterVersion:number|null=null,sentenceId:string|null=null,due:string|null=v.nextDueAt;
    if('sentenceId'in input){
      const card=v.cards[v.index],current=await readSentenceCatalogue(tx,v.scope,platform.now()),unit=current.cards.find(c=>c.id===input.sentenceId);
      if(!card||!unit||card.version!==unit.version||card.id!==input.sentenceId)throw new SentenceStudyError('句子已更新，原进度保留',409,'material_changed');
      sentenceId=card.id;
      if(input.type==='rate'){
        [before]=await tx.all<SentenceProgress>(sql`SELECT * FROM sentence_study_progress WHERE sentence_id=${card.id}`);
        if((before?.version??0)!==card.progressVersion)throw new SentenceStudyError('这句话已在另一个会话更新，请恢复位置',409,'progress_conflict');
        afterVersion=(before?.version??0)+1;due=await putProgress(tx,card.id,before,input.rating,stamp,afterVersion);
      }
    }else if(input.type==='revise_rating'){
      const [original]=await tx.all<EventRow>(sql`SELECT * FROM sentence_study_events WHERE session_id=${id} AND client_event_id=${input.targetEventId} AND kind='rate'`);
      if(!original?.sentence_id||v.lastRatingEventId!==input.targetEventId)throw new SentenceStudyError('只能修改最近一次评分',409,'rating_changed');
      sentenceId=original.sentence_id;[before]=await tx.all<SentenceProgress>(sql`SELECT * FROM sentence_study_progress WHERE sentence_id=${sentenceId}`);
      if(!before||before.version!==original.after_progress_version)throw new SentenceStudyError('这句话已经有更新的学习记录，不能覆盖',409,'progress_conflict');
      const originalBefore=original.before_progress_json?JSON.parse(original.before_progress_json) as SentenceProgress:undefined;
      afterVersion=before.version+1;due=await putProgress(tx,sentenceId,originalBefore,input.rating,original.created_at,afterVersion);
      await tx.run(sql`UPDATE sentence_study_events SET after_progress_version=${afterVersion} WHERE session_id=${id} AND client_event_id=${original.client_event_id}`);
    }
    next.nextDueAt=due;
    if(input.type==='rate')next.cards[next.experienceVersion?next.index:next.index-1].progressVersion=afterVersion!;
    if(input.type==='revise_rating'&&sentenceId){const card=next.cards.find(c=>c.id===sentenceId);if(card)card.progressVersion=afterVersion!;}
    const nextDues=await tx.all<{due_at:string}>(sql`SELECT p.due_at FROM sentence_study_progress p WHERE p.sentence_id IN (${{sql:next.assessments.map(()=>'?').join(',')||'NULL',args:next.assessments.map(a=>a.sentenceId)}}) ORDER BY p.due_at`);
    next.nextDueAt=nextDues[0]?.due_at??null;
    await tx.run(sql`INSERT INTO sentence_study_events(session_id,client_event_id,payload_hash,kind,sentence_id,rating,target_event_id,before_progress_json,after_progress_version,created_at) VALUES(${id},${input.clientEventId},${payloadHash},${input.type},${sentenceId},${'rating'in input?input.rating:null},${input.type==='revise_rating'?input.targetEventId:null},${before?JSON.stringify(before):null},${afterVersion},${stamp})`);
    await tx.run(sql`UPDATE sentence_study_sessions SET version=${next.version},status=${next.status},view_json=${JSON.stringify(next)},updated_at=${stamp} WHERE id=${id}`);return availableView(tx,next);
  });}
  return {overview,get,create,event};
}
export type SentenceService=ReturnType<typeof createSentenceService>;

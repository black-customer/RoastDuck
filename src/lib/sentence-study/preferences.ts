import {z} from 'zod';
import type {DatabasePort} from '@/lib/platform/database';
import {query as sql} from '@/lib/platform/sql';
import {hash} from '@/lib/four-step/shared';
import {readSentenceCatalogue} from './catalogue';
import {SentenceStudyError,sentenceScopeSchema,type SentencePreference,type SentenceScope} from './contracts';

const id=z.string().min(1).max(160);
export const sentencePreferenceSchema=z.object({clientRequestId:id,sentenceId:id,unitVersion:id,version:z.number().int().nonnegative(),hidden:z.boolean().optional(),favorite:z.boolean().optional(),selfKnown:z.boolean().optional(),note:z.string().max(4000).optional()}).refine(v=>[v.hidden,v.favorite,v.selfKnown,v.note].some(value=>value!==undefined),'请指定偏好');
export const sentenceFeedbackSchema=z.discriminatedUnion('action',[
  z.object({action:z.literal('report'),clientRequestId:id,sentenceId:id,unitVersion:id,kind:z.enum(['incorrect','unclear','other']),reason:z.string().trim().min(1).max(4000)}),
  z.object({action:z.literal('withdraw'),clientRequestId:id,feedbackId:id}),
]);
export interface SentenceFeedback {id:string;sentenceId:string;unitVersion:string;kind:'incorrect'|'unclear'|'other';reason:string;status:'open'|'withdrawn';createdAt:string}
interface FeedbackRow {id:string;sentence_id:string;unit_version:string;kind:SentenceFeedback['kind'];reason:string;status:SentenceFeedback['status'];created_at:string}
const projectFeedback=(row:FeedbackRow):SentenceFeedback=>({id:row.id,sentenceId:row.sentence_id,unitVersion:row.unit_version,kind:row.kind,reason:row.reason,status:row.status,createdAt:row.created_at});
const emptyPreference=():SentencePreference=>({hidden:false,favorite:false,selfKnown:false,note:'',version:0});
/** Preferences never infer ratings. Material feedback quarantines only the cited current edition. */
export function createSentencePreferences(database:DatabasePort,platform:{now:()=>Date;newId:()=>string}){
  async function list(rawScope:SentenceScope={type:'all'}){
    const scope=sentenceScopeSchema.parse(rawScope);
    return database.read(async db=>{
      const catalogue=await readSentenceCatalogue(db,scope,platform.now());
      const ids={sql:catalogue.cards.map(()=>'?').join(',')||'NULL',args:catalogue.cards.map(c=>c.id)};
      const feedback=await db.all<FeedbackRow>(sql`SELECT * FROM sentence_feedback WHERE sentence_id IN (${ids}) ORDER BY created_at DESC,id`);
      return {scope,cards:catalogue.cards,feedback:feedback.map(projectFeedback)};
    });
  }
  async function set(raw:unknown){
    const input=sentencePreferenceSchema.parse(raw),payloadHash=hash(JSON.stringify(input));
    return database.write(async tx=>{
      const [receipt]=await tx.all<{payload_hash:string;after_json:string}>(sql`SELECT payload_hash,after_json FROM sentence_preference_events WHERE client_request_id=${input.clientRequestId}`);
      if(receipt){if(receipt.payload_hash!==payloadHash)throw new SentenceStudyError('请求编号对应了不同偏好',409,'request_conflict');return {preference:JSON.parse(receipt.after_json) as SentencePreference};}
      const catalogue=await readSentenceCatalogue(tx,{type:'all'},platform.now()),card=catalogue.cards.find(c=>c.id===input.sentenceId&&c.version===input.unitVersion);
      if(!card)throw new SentenceStudyError('句子版本已变化，请重新读取',409,'material_changed');
      const before=card.preference??emptyPreference();
      if(before.version!==input.version)throw new SentenceStudyError('另一窗口已更新偏好，请重新读取',409,'version_conflict');
      const after:SentencePreference={hidden:input.hidden??before.hidden,favorite:input.favorite??before.favorite,selfKnown:input.selfKnown??before.selfKnown,note:input.note??before.note,version:before.version+1};
      const stamp=platform.now().toISOString();
      await tx.run(sql`INSERT INTO sentence_preferences(sentence_id,hidden,favorite,self_known,note,version,updated_at) VALUES(${card.id},${after.hidden?1:0},${after.favorite?1:0},${after.selfKnown?1:0},${after.note},${after.version},${stamp}) ON CONFLICT(sentence_id) DO UPDATE SET hidden=excluded.hidden,favorite=excluded.favorite,self_known=excluded.self_known,note=excluded.note,version=excluded.version,updated_at=excluded.updated_at`);
      await tx.run(sql`INSERT INTO sentence_preference_events(client_request_id,payload_hash,sentence_id,unit_version,before_json,after_json,created_at) VALUES(${input.clientRequestId},${payloadHash},${card.id},${card.version},${JSON.stringify(before)},${JSON.stringify(after)},${stamp})`);
      return {preference:after};
    });
  }
  async function feedback(raw:unknown){
    const input=sentenceFeedbackSchema.parse(raw),payloadHash=hash(JSON.stringify(input));
    return database.write(async tx=>{
      const [receipt]=await tx.all<{payload_hash:string;feedback_id:string}>(sql`SELECT payload_hash,feedback_id FROM sentence_feedback_events WHERE client_request_id=${input.clientRequestId}`);
      if(receipt){
        if(receipt.payload_hash!==payloadHash)throw new SentenceStudyError('请求编号对应了不同反馈',409,'request_conflict');
        const [row]=await tx.all<FeedbackRow>(sql`SELECT * FROM sentence_feedback WHERE id=${receipt.feedback_id}`);return {feedback:projectFeedback(row)};
      }
      const stamp=platform.now().toISOString();let feedbackId:string;
      if(input.action==='report'){
        const catalogue=await readSentenceCatalogue(tx,{type:'all'},platform.now()),card=catalogue.cards.find(c=>c.id===input.sentenceId&&c.version===input.unitVersion);
        if(!card)throw new SentenceStudyError('句子版本已变化，请重新读取',409,'material_changed');
        feedbackId=`sf_${platform.newId()}`;
        await tx.run(sql`INSERT INTO sentence_feedback(id,client_request_id,payload_hash,sentence_id,unit_version,material_id,kind,reason,status,created_at) VALUES(${feedbackId},${input.clientRequestId},${payloadHash},${card.id},${card.version},${card.materialId},${input.kind},${input.reason},'open',${stamp})`);
      }else{
        const [row]=await tx.all<FeedbackRow>(sql`SELECT * FROM sentence_feedback WHERE id=${input.feedbackId}`);
        if(!row)throw new SentenceStudyError('反馈记录不存在',404,'feedback_missing');feedbackId=row.id;
        await tx.run(sql`UPDATE sentence_feedback SET status='withdrawn' WHERE id=${feedbackId}`);
      }
      await tx.run(sql`INSERT INTO sentence_feedback_events(client_request_id,payload_hash,feedback_id,action,created_at) VALUES(${input.clientRequestId},${payloadHash},${feedbackId},${input.action},${stamp})`);
      const [row]=await tx.all<FeedbackRow>(sql`SELECT * FROM sentence_feedback WHERE id=${feedbackId}`);return {feedback:projectFeedback(row)};
    });
  }
  return {list,set,feedback};
}

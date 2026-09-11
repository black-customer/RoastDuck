import {SPOKEN_REGISTER_VERSION} from '@/lib/ai/spoken-register';
import {z} from "zod";
import type {DatabasePort,SqlReader} from "@/lib/platform/database";
import {query as sql} from "@/lib/platform/sql";
import type {MaterialService} from "@/lib/four-step/core-materials";
import type {MaterialRow} from "@/lib/four-step/material-types";
import {hash,TrainingError} from "@/lib/four-step/shared";
import {speakingAttemptAnalysisSchema} from "@/lib/speaking-practice/schemas";
import {auditPracticeMaterials} from "@/lib/four-step/audit";
import {credentialValue,parseJson} from "./shared";
import {SPOKEN_STYLE_VERSION,SELECTION_POLICY_VERSION,SENTENCE_STUDY_VERSION} from '@/lib/four-step/stage-contracts';

export interface AnswerDraft {id:string;question_id:string;english_text:string;chinese_text:string;english_unknown:number;raw_input?:string;input_format?:string;version:number;submitted_attempt_id:string|null;source_attempt_id:string|null;kind:'practice'|'independent'|'edit';english_committed_at:string|null;created_at:string;updated_at:string}
export interface AppAttempt {id:string;question_id:string;mode:string;answer_text:string;intended_meaning_zh:string;natural_version:string;gap_count:number;status:string;analysis_json:string;created_at:string;updated_at:string}
const patchSchema=z.union([
  z.object({version:z.number().int().nonnegative(),inputText:z.string().max(16000)}).strict(),
  z.object({version:z.number().int().nonnegative(),english:z.string().max(16000),chinese:z.string().max(16000),englishUnknown:z.boolean()}).strict(),
]);
const idSchema=z.string().min(1).max(160);
export function createAnswerService(database:DatabasePort,materials:Pick<MaterialService,'prepareIn'>,platform:{now:()=>Date;newId:()=>string;allowMock?:boolean}){
  async function draftFrom(tx:SqlReader,id:string){const [row]=await tx.all<AnswerDraft>(sql`SELECT * FROM answer_drafts WHERE id=${id}`);if(!row)throw new TrainingError("草稿不存在",404,"draft_missing");return row;}
  async function start(questionId:string,clientId:string,sourceAttemptId:string|null=null,kind:AnswerDraft['kind']='practice'){
    idSchema.parse(questionId);idSchema.parse(clientId);
    z.enum(['practice','independent','edit']).parse(kind);
    if(kind!=='practice'&&!sourceAttemptId)throw new TrainingError('新版本需要关联原回答',400,'source_missing');
    const id=`draft_${hash(questionId,clientId).slice(0,24)}`;
    return database.write(async tx=>{
      if(!(await tx.all(sql`SELECT id FROM questions WHERE id=${questionId}`)).length)throw new TrainingError("题目不存在",404,"question_missing");
      if(sourceAttemptId&&!(await tx.all(sql`SELECT id FROM speaking_question_attempts WHERE id=${sourceAttemptId} AND question_id=${questionId}`)).length)throw new TrainingError("原回答不属于这道题",409,"source_mismatch");
      const timestamp=platform.now().toISOString();
      const source=kind==='edit'?(await tx.all<AppAttempt>(sql`SELECT * FROM speaking_question_attempts WHERE id=${sourceAttemptId}`))[0]:null;
      await tx.run(sql`INSERT INTO answer_drafts(id,question_id,source_attempt_id,kind,english_text,chinese_text,created_at,updated_at) VALUES(${id},${questionId},${sourceAttemptId},${kind},${source?.answer_text??''},${source?.intended_meaning_zh??''},${timestamp},${timestamp}) ON CONFLICT DO NOTHING`);
      const result=await draftFrom(tx,id);
      if(result.source_attempt_id!==sourceAttemptId||result.kind!==kind)throw new TrainingError("开始请求已用于另一份回答",409,"draft_conflict");
      return result;
    });
  }
  const getDraft=(id:string)=>database.read(tx=>draftFrom(tx,id));
  async function saveDraft(id:string,raw:unknown){
    const input=patchSchema.parse(raw);
    if(credentialValue('inputText' in input?input.inputText:input.english+"\n"+input.chinese))throw new TrainingError("内容看起来包含密钥或凭证，不会保存，请先去除",400,"sensitive_answer");
    return database.write(async tx=>{
      const current=await draftFrom(tx,id);
      if(current.submitted_attempt_id)throw new TrainingError("这份回答已保存，请创建新版本修改",409,"draft_submitted");
      if('inputText' in input){
        if(current.kind==='independent')throw new TrainingError('无提示重答先封存英文',409,'english_first');
        if(current.input_format==='mixed-v1'&&current.raw_input===input.inputText)return current;
        if(current.version!==input.version)throw new TrainingError('草稿已更新，请恢复最新内容后再保存',409,'draft_version_conflict');
        await tx.run(sql`UPDATE answer_drafts SET raw_input=${input.inputText},input_format='mixed-v1',version=version+1,updated_at=${platform.now().toISOString()} WHERE id=${id}`);
        return draftFrom(tx,id);
      }
      if(current.kind==='independent'){
        if(!current.english_committed_at&&input.chinese.trim())throw new TrainingError('请先保存无提示的英文回答，再补充中文原意',409,'english_first');
        if(current.english_committed_at&&(current.english_text!==input.english||Boolean(current.english_unknown)!==input.englishUnknown))throw new TrainingError('独立回答已封存，修改请新建版本',409,'english_committed');
      }
      // A response-lost retry of the same values is idempotent, even after its version advanced.
      if(current.english_text===input.english&&current.chinese_text===input.chinese&&Boolean(current.english_unknown)===input.englishUnknown)return current;
      if(current.version!==input.version)throw new TrainingError("草稿已更新，请恢复最新内容后再保存",409,"draft_version_conflict");
      await tx.run(sql`UPDATE answer_drafts SET english_text=${input.english},chinese_text=${input.chinese},english_unknown=${Number(input.englishUnknown)},version=version+1,updated_at=${platform.now().toISOString()} WHERE id=${id}`);
      return draftFrom(tx,id);
    });
  }
  async function commitEnglish(id:string,version:number){return database.write(async tx=>{
    const current=await draftFrom(tx,id);
    if(current.kind!=='independent'||current.submitted_attempt_id)throw new TrainingError('不是可提交的独立回答',409,'draft_changed');
    if(current.english_committed_at)return current;
    if(current.version!==version)throw new TrainingError('先保存最新输入',409,'draft_version_conflict');
    if(!current.english_text.trim()&&!current.english_unknown)throw new TrainingError('请尝试回答，或明确标记暂时不会',422,'answer_incomplete');
    await tx.run(sql`UPDATE answer_drafts SET english_committed_at=${platform.now().toISOString()},version=version+1,updated_at=${platform.now().toISOString()} WHERE id=${id}`);
    return draftFrom(tx,id);
  });}
  async function submit(id:string,version:number){
    return database.write(async tx=>{
      const draft=await draftFrom(tx,id);
      if(draft.submitted_attempt_id)return {attemptId:draft.submitted_attempt_id};
      if(draft.version!==version)throw new TrainingError("请先完成草稿保存，再提交分析",409,"draft_version_conflict");
      if(draft.kind==='independent'&&!draft.english_committed_at)throw new TrainingError('先封存无提示回答',409,'english_first');
      const mixed=draft.input_format==='mixed-v1';
      if(mixed?!draft.raw_input?.trim():((draft.kind!=='independent'&&!draft.chinese_text.trim())||(!draft.english_unknown&&!draft.english_text.trim())))throw new TrainingError('请写下你想表达的意思',422,'answer_incomplete');
      if(!mixed&&!draft.chinese_text.trim()&&!draft.english_text.trim())throw new TrainingError('没有可分析的回答，请至少补充中文原意',422,'answer_incomplete');
      const [question]=await tx.all<{id:string;text:string;text_zh:string;part:number}>(sql`SELECT id,text,text_zh,part FROM questions WHERE id=${draft.question_id}`);
      if(!question)throw new TrainingError("题目已移除，草稿保留",409,"question_missing");
      const attemptId=`sqa_${hash("draft",id).slice(0,24)}`,timestamp=platform.now().toISOString();
      // Explicit 'unknown' means an empty attempt, never a made-up English placeholder.
      const english=mixed?draft.raw_input!:(draft.english_unknown?"":draft.english_text),meaning=mixed?'':draft.chinese_text;
      const [parentMaterial]=draft.kind==='edit'&&draft.source_attempt_id?await tx.all<{input_json:string}>(sql`SELECT input_json FROM practice_materials WHERE source_type='ielts_practice' AND source_id=${draft.source_attempt_id} AND status='ready' ORDER BY created_at DESC,id DESC LIMIT 1`):[];
      const parent=parentMaterial?parseJson<{sentenceSourceId?:string;sourceId:string}>(parentMaterial.input_json,{sourceId:draft.source_attempt_id!}):null;
      const sentenceSourceId=parent?.sentenceSourceId??parent?.sourceId;
      await tx.run(sql`INSERT INTO speaking_question_attempts(id,question_id,mode,answer_text,intended_meaning_zh,status,created_at,updated_at)
        VALUES(${attemptId},${question.id},'practice',${english},${meaning},'processing',${timestamp},${timestamp})`);
      await tx.run(sql`INSERT INTO practice_submissions(request_id,input_hash,attempt_id) VALUES(${id},${hash(question.id,"practice",english,meaning)},${attemptId})`);
      await materials.prepareIn(tx,{sourceType:"ielts_practice",sourceId:attemptId,question:{id:question.id,textEn:question.text,textZh:question.text_zh,part:question.part},mode:"practice",actualAnswer:english,intendedMeaningZh:meaning,spokenStyleVersion:SPOKEN_STYLE_VERSION,selectionPolicyVersion:SELECTION_POLICY_VERSION,sentenceStudyVersion:SENTENCE_STUDY_VERSION,registerProfileVersion:SPOKEN_REGISTER_VERSION,teachingVersion:'sentence-teaching-v1',...(sentenceSourceId?{sentenceSourceId}:{}),...(mixed?{inputFormat:'mixed-v1' as const,rawInput:english}:{})});
      await tx.run(sql`UPDATE answer_drafts SET submitted_attempt_id=${attemptId},version=version+1,updated_at=${timestamp} WHERE id=${id}`);
      return {attemptId};
    });
  }
  async function detail(id:string){return database.read(async tx=>{
    const [attempt]=await tx.all<AppAttempt>(sql`SELECT * FROM speaking_question_attempts WHERE id=${id}`);
    if(!attempt)throw new TrainingError("回答不存在",404,"attempt_missing");
    const [material]=await tx.all<MaterialRow>(sql`SELECT * FROM practice_materials WHERE source_type='ielts_practice' AND source_id=${id} ORDER BY (contract_version='evidence_v2') DESC,created_at DESC,id DESC LIMIT 1`);
    const analysis=material?speakingAttemptAnalysisSchema.safeParse(parseJson(material.analysis_json,null)):null;
    const audit=material?.status==="ready"?await auditPracticeMaterials({execute:async statement=>({rows:await tx.all<Record<string,unknown>>(typeof statement==="string"?{sql:statement}:statement)})},platform.allowMock,[material.id]):null;
    const stages=material?await tx.all<{stage:string;status:string}>(sql`SELECT stage,status FROM practice_material_stages WHERE material_id=${material.id} ORDER BY created_at`):[];
    const [origin]=await tx.all<AnswerDraft>(sql`SELECT * FROM answer_drafts WHERE submitted_attempt_id=${id} LIMIT 1`);
    const [previous]=origin?.source_attempt_id?await tx.all<AppAttempt>(sql`SELECT * FROM speaking_question_attempts WHERE id=${origin.source_attempt_id}`):[];
    return {attempt,material:material??null,analysis:analysis?.success?analysis.data:null,learnable:Boolean(audit?.ok&&analysis?.success&&analysis.data.learningMaterials.length),audit,stages,origin:origin??null,previous:previous??null};
  });}
  const history=(questionId:string)=>database.read(tx=>tx.all<AppAttempt>(sql`SELECT * FROM speaking_question_attempts WHERE question_id=${questionId}
    AND NOT EXISTS(SELECT 1 FROM practice_answer_sources s JOIN personal_answers p ON p.id=s.answer_id WHERE s.attempt_id=speaking_question_attempts.id AND p.superseded_by_revision_id IS NOT NULL)
    ORDER BY julianday(created_at) DESC,id DESC`));
  const drafts=(questionId?:string)=>database.read(tx=>tx.all<AnswerDraft>(sql`SELECT * FROM answer_drafts WHERE submitted_attempt_id IS NULL AND ${questionId?sql`question_id=${questionId}`:sql`1=1`} ORDER BY julianday(updated_at) DESC,id DESC`));
  return {start,getDraft,saveDraft,commitEnglish,submit,detail,history,drafts};
}
export type AnswerService=ReturnType<typeof createAnswerService>;

import type {SqlReader,SqlWriter} from '@/lib/platform/database';
import {query as sql} from '@/lib/platform/sql';
import {TrainingError} from '@/lib/four-step/shared';
import type {SentenceSession} from '@/lib/sentence-study/contracts';
import type {CoachingContext,CoachingPracticeEvidence} from './contracts';
interface Link {practice_id:string;root_practice_id:string;material_id:string;sentence_id:string|null;source_session_id:string|null;related_task_id:string|null;created_at:string}
export async function readCoachingPracticeEvidence(db:SqlReader,c:CoachingContext,at:Date){
  const [existing]=await db.all<Link>(sql`SELECT * FROM coaching_practice_links WHERE practice_id=${c.practiceId}`);
  const rootPracticeId=c.rootPracticeId??existing?.root_practice_id??c.practiceId;
  if(existing&&(existing.material_id!==c.materialId||existing.root_practice_id!==rootPracticeId||existing.sentence_id!==(c.sentenceId??null)||existing.source_session_id!==(c.sourceSessionId??null)||existing.related_task_id!==(c.relatedTaskId??null)))throw new TrainingError('练习编号已关联其他来源，请恢复原练习',409,'coaching_practice_conflict');
  if(c.rootPracticeId&&c.rootPracticeId!==c.practiceId){
    const [root]=await db.all<Link>(sql`SELECT * FROM coaching_practice_links WHERE practice_id=${rootPracticeId}`);
    if(root&&root.material_id!==c.materialId)throw new TrainingError('原练习与当前材料不一致',409,'coaching_root_mismatch');
  }
  let sourceSession:SentenceSession|null=null;
  if(c.sourceSessionId){
    const [session]=await db.all<{view_json:string}>(sql`SELECT view_json FROM sentence_study_sessions WHERE id=${c.sourceSessionId}`);
    if(!session)throw new TrainingError('来源学习会话不存在',404,'coaching_session_missing');sourceSession=JSON.parse(session.view_json) as SentenceSession;
    if(!sourceSession.cards.some(card=>card.materialId===c.materialId&&(!c.sentenceId||card.id===c.sentenceId)))throw new TrainingError('来源学习会话与本次句子不一致',409,'coaching_session_mismatch');
  }
  const relatedLinks=await db.all<Link>(sql`SELECT * FROM coaching_practice_links WHERE material_id=${c.materialId} AND (root_practice_id=${rootPracticeId} OR practice_id=${rootPracticeId})`);
  const practiceIds=[...new Set([c.practiceId,rootPracticeId,...relatedLinks.map(link=>link.practice_id)])];
  const outputs=await db.all<{id:string;role:string;created_at:string;metadata_json:string}>(sql`SELECT id,role,created_at,metadata_json FROM companion_messages WHERE source_type='coaching_output' AND source_id=${c.materialId} AND json_extract(metadata_json,'$.context.practiceId') IN (${{sql:practiceIds.map(()=>'?').join(','),args:practiceIds}}) ORDER BY created_at,id`);
  const sessionIds=[...new Set([c.sourceSessionId,...relatedLinks.map(link=>link.source_session_id)].filter((id):id is string=>!!id))];
  const sessionFilter={sql:sessionIds.map(()=>'?').join(',')||'NULL',args:sessionIds};
  const exposures=await db.all<{client_event_id:string;created_at:string}>(sql`SELECT e.client_event_id,e.created_at FROM sentence_exposure_events e JOIN sentence_learning_units u ON u.id=e.sentence_id AND u.version=e.unit_version WHERE u.active=1 AND u.material_id=${c.materialId} AND (${c.sentenceId?sql`e.sentence_id=${c.sentenceId}`:sql`1=1`}) ORDER BY e.created_at,e.client_event_id`);
  const practice=await db.all<{client_event_id:string}>(sql`SELECT e.client_event_id FROM sentence_practice_evidence e JOIN sentence_learning_units u ON u.id=e.sentence_id AND u.version=e.unit_version WHERE u.active=1 AND e.session_id IN (${sessionFilter}) AND u.material_id=${c.materialId} AND (${c.sentenceId?sql`e.sentence_id=${c.sentenceId}`:sql`1=1`}) ORDER BY e.created_at,e.client_event_id`);
  const helpTimes=[...exposures.map(e=>e.created_at),...outputs.filter(o=>o.role==='teacher').map(o=>o.created_at)].sort();
  const lastHelpAt=helpTimes.at(-1)??null;
  const evidence:CoachingPracticeEvidence={version:'context-coaching-evidence-v1',currentCueCondition:c.mode==='sentence_guided'?'sentence_chinese':c.mode==='answer_guided'?'answer_chinese':'question_only',lastHelpAt,elapsedMsSinceHelp:lastHelpAt?Math.max(0,at.getTime()-Date.parse(lastHelpAt)):null,sourceSessionId:c.sourceSessionId??null,rootPracticeId,relatedTaskId:c.relatedTaskId??null,exposureEventIds:exposures.map(e=>e.client_event_id),practiceEventIds:practice.map(e=>e.client_event_id),firstOutputMessageId:outputs.find(o=>o.role==='user')?.id??null};
  return {evidence,sourceSession,existing};
}
export async function linkCoachingPractice(tx:SqlWriter,c:CoachingContext,evidence:CoachingPracticeEvidence,at:string){
  await tx.run(sql`INSERT INTO coaching_practice_links(practice_id,root_practice_id,material_id,sentence_id,source_session_id,related_task_id,created_at) VALUES(${c.practiceId},${evidence.rootPracticeId},${c.materialId},${c.sentenceId??null},${c.sourceSessionId??null},${c.relatedTaskId??null},${at}) ON CONFLICT DO NOTHING`);
}

import { randomUUID } from 'node:crypto';
import type { DatabasePort, SqlReader, SqlWriter } from '@/lib/platform/database';
import { query as sql } from '@/lib/platform/sql';
import { LocalWriteError } from '@/lib/http/local-write';
import { credentialValue } from '@/lib/app-services/shared';
import { fullAnswerInputSchema, type FullAnswer, type FullAnswerInput, type AudioAsset } from '@/lib/answer-audio/contracts';
import {projectHistoricalAnswers,answerIsRevision} from './history';

export interface AnswerRow { id: string; question_id: string; source_key: string; stage: FullAnswer['stage']; prompt_condition: string; material_id: string | null; text: string; refs_json: string; created_at: string; updated_at: string }
export interface AssetRow { id: string; full_answer_id: string; upload_id: string; sha256: string; byte_length: number; mime_type: string; extension: string; duration_seconds: number | null; source: 'recording' | 'upload'; original_name: string; note: string; created_at: string; recorded_at?:string|null;recorded_at_source?:AudioAsset['recordedAtSource'];removed_at: string | null; purged_at: string | null }
export const assetView = (r: AssetRow): AudioAsset => ({ id: r.id, fullAnswerId: r.full_answer_id, sha256: r.sha256, byteLength: r.byte_length, mimeType: r.mime_type, extension: r.extension, durationSeconds: r.duration_seconds, source: r.source, originalName: r.original_name, note: r.note, createdAt: r.created_at,recordedAt:r.recorded_at??null,recordedAtSource:r.recorded_at_source??'unknown', removedAt: r.removed_at, purgedAt: r.purged_at });
export async function validateAnswerRefs(tx: SqlReader, input: FullAnswerInput) {
  if (credentialValue(input.text)) throw new LocalWriteError('附加文字包含凭证，请去除后再保存', 400);
  if (!(await tx.all(sql`SELECT id FROM questions WHERE id=${input.questionId}`)).length) throw new LocalWriteError('题目不存在', 404);
  if (input.materialId && !(await tx.all(sql`SELECT id FROM practice_materials WHERE id=${input.materialId} AND (${input.refs.taskId ? sql`1=1` : sql`question_id=${input.questionId}`})`)).length) throw new LocalWriteError('材料与题目不一致', 409);
  const refs = input.refs;
  if (refs.taskId && input.stage !== 'transfer') throw new LocalWriteError('相关任务需要保留为相关新题回答', 409);
  if (refs.draftId && !(await tx.all(sql`SELECT id FROM answer_drafts WHERE id=${refs.draftId} AND question_id=${input.questionId}`)).length) throw new LocalWriteError('草稿与题目不一致', 409);
  if (refs.attemptId && !(await tx.all(sql`SELECT id FROM speaking_question_attempts WHERE id=${refs.attemptId} AND question_id=${input.questionId}`)).length) throw new LocalWriteError('原回答与题目不一致', 409);
  if (refs.coachingMessageId) {
    const [row] = await tx.all<{ scope_id: string | null; role: string; source_id: string | null; metadata_json: string }>(sql`SELECT t.scope_id,m.role,m.source_id,m.metadata_json FROM companion_messages m JOIN companion_threads t ON m.thread_id=t.id WHERE m.id=${refs.coachingMessageId}`);
    let taskMatches = false; try { taskMatches = !!refs.taskId && JSON.parse(row?.metadata_json ?? '{}').context?.relatedTaskId === refs.taskId && row?.source_id === input.materialId; } catch { /* Invalid metadata cannot establish ownership. */ }
    if (!row || row.role !== 'user' || (refs.taskId ? !taskMatches : row.scope_id !== input.questionId)) throw new LocalWriteError('教学输出与题目不一致', 409);
    if(await answerIsRevision(tx,{coachingMessageId:refs.coachingMessageId}))throw new LocalWriteError('局部修正保留在原教学记录，不另计完整回答',409);
  }
  if (refs.taskId && !(await tx.all(sql`SELECT id FROM context_practice_tasks WHERE id=${refs.taskId} AND COALESCE(question_id,source_question_id)=${input.questionId} AND material_id=${input.materialId ?? null}`)).length) throw new LocalWriteError('相关任务与题目或材料不一致', 409);
}
/** Called inside the same short transaction that publishes an audio asset. */
export async function ensureFullAnswer(tx: SqlWriter, raw: FullAnswerInput): Promise<string> {
  const input = fullAnswerInputSchema.parse(raw); await validateAnswerRefs(tx, input);
  const [prior] = await tx.all<AnswerRow>(sql`SELECT * FROM full_answer_attempts WHERE source_key=${input.sourceKey}`);
  if (prior) {
    if (prior.question_id !== input.questionId || prior.stage !== input.stage || prior.prompt_condition !== input.promptCondition || (prior.material_id ?? null) !== (input.materialId ?? null)) throw new LocalWriteError('回答编号已用于其他题目或提示条件', 409);
    const refs = JSON.parse(prior.refs_json) as FullAnswerInput['refs'];
    for (const key of Object.keys(input.refs) as Array<keyof typeof refs>) if (refs[key] && refs[key] !== input.refs[key]) throw new LocalWriteError('原回答引用已存在，不能覆盖旧版本', 409);
    // Later text links may fill the empty audio-only record. A correction cannot overwrite it.
    if (prior.text && input.text && prior.text !== input.text) throw new LocalWriteError('此回答已保存文字；修正请保留为新版本', 409);
    await tx.run(sql`UPDATE full_answer_attempts SET text=${prior.text || input.text},refs_json=${JSON.stringify({ ...refs, ...input.refs })},updated_at=${new Date().toISOString()} WHERE id=${prior.id}`);
    return prior.id;
  }
  const id = randomUUID(), at = new Date().toISOString();
  await tx.run(sql`INSERT INTO full_answer_attempts(id,question_id,source_key,stage,prompt_condition,material_id,text,refs_json,created_at,updated_at) VALUES(${id},${input.questionId},${input.sourceKey},${input.stage},${input.promptCondition},${input.materialId ?? null},${input.text},${JSON.stringify(input.refs)},${at},${at})`);
  return id;
}
export function createFullAnswerService(database: DatabasePort) {
  return {
    async sourceLink(raw: FullAnswerInput) {
      const input = fullAnswerInputSchema.parse(raw);
      if (!input.text.trim() && !Object.values(input.refs).some(Boolean)) throw new LocalWriteError('完整回答需要已保存的文字或原回答引用', 400);
      return { fullAnswerId: await database.write(tx => ensureFullAnswer(tx, input)) };
    },
    async history(questionId: string) {
      return database.read(async tx => {
        const [question] = await tx.all<{ text: string; text_zh: string }>(sql`SELECT text,text_zh FROM questions WHERE id=${questionId}`);
        if (!question) throw new LocalWriteError('题目不存在', 404);
        const rows = await tx.all<AnswerRow>(sql`SELECT * FROM full_answer_attempts WHERE question_id=${questionId} ORDER BY created_at,id`);
        const assets = await tx.all<AssetRow>(sql`SELECT a.* FROM answer_audio_assets a JOIN full_answer_attempts f ON f.id=a.full_answer_id WHERE f.question_id=${questionId} ORDER BY a.created_at,a.id`);
        const attempts: FullAnswer[] = [];
        for (const r of rows) {
          const refs = JSON.parse(r.refs_json) as FullAnswer['refs'];
          const [task] = refs.taskId ? await tx.all<{ prompt_en: string }>(sql`SELECT prompt_en FROM context_practice_tasks WHERE id=${refs.taskId}`) : [];
          attempts.push({ id: r.id, questionId: r.question_id, sourceKey: r.source_key, stage: r.stage, promptCondition: r.prompt_condition, materialId: r.material_id, text: r.text, refs, taskPrompt: task?.prompt_en ?? null, createdAt: r.created_at, updatedAt: r.updated_at, audio: assets.filter(a => a.full_answer_id === r.id).map(assetView),countsAsAttempt:!await answerIsRevision(tx,refs) });
        }
        const previous=await projectHistoricalAnswers(tx,questionId,attempts);
        return { question: { textEn: question.text, textZh: question.text_zh }, attempts:[...attempts,...previous].sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id)) };
      });
    },
  };
}

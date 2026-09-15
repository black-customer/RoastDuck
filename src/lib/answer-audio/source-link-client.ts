import { fullAnswerInputSchema, type FullAnswerInput } from './contracts';

const key = (sourceKey: string) => `roastduck-full-answer-link-v1:${sourceKey}`;
/** This durable intent only links already saved text; it never resubmits text to AI. */
export async function linkFullAnswer(input: FullAnswerInput) {
  const payload = fullAnswerInputSchema.parse(input);
  try { localStorage.setItem(key(payload.sourceKey), JSON.stringify(payload)); } catch { /* The server can still acknowledge; a failed request remains visible in the caller. */ }
  const response = await fetch('/api/full-answer-attempts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operation: 'sourceLink', ...payload }) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error ?? '回答历史关联未完成');
  try { localStorage.removeItem(key(payload.sourceKey)); } catch { /* Replaying the same source remains idempotent. */ }
  return result as { fullAnswerId: string };
}
export async function retryFullAnswerLink(sourceKey: string) {
  const pending = localStorage.getItem(key(sourceKey)); if (!pending) return null;
  const input = fullAnswerInputSchema.parse(JSON.parse(pending)); if (input.sourceKey !== sourceKey) throw new Error('历史关联记录不匹配，请保留原回答后重试');
  return linkFullAnswer(input);
}
export function pendingFullAnswerLinks(questionId:string){
  const pending:FullAnswerInput[]=[];
  for(let index=0;index<localStorage.length;index++){
    const name=localStorage.key(index);if(!name?.startsWith('roastduck-full-answer-link-v1:'))continue;
    try{const parsed=fullAnswerInputSchema.safeParse(JSON.parse(localStorage.getItem(name)??'null'));if(parsed.success&&parsed.data.questionId===questionId)pending.push(parsed.data);}catch{/* Preserve malformed records for recovery rather than inventing references. */}
  }
  return pending;
}

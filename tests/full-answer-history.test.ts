import {afterEach,expect,it} from 'vitest';
import {portableTestDatabase} from './helpers/portable-db';
import {query as sql} from '@/lib/platform/sql';
import {createFullAnswerService,assetView,type AssetRow} from '@/lib/full-answer-attempts/service';
import {comparisonDefaults,uploadInputSchema,type FullAnswer,type AudioAsset} from '@/lib/answer-audio/contracts';
const opened:ReturnType<typeof portableTestDatabase>[]=[];
afterEach(()=>{for(const fixture of opened)fixture.close();opened.length=0;});
async function setup(){
  const fixture=portableTestDatabase();opened.push(fixture);
  await fixture.database.write(tx=>tx.run(sql`INSERT INTO questions(id,book_id,part,text,text_zh,norm_text) VALUES('history-q','retired',1,'What is your routine?','你的日常是什么？','history-q')`));
  return {...fixture,service:createFullAnswerService(fixture.database)};
}
it('projects existing saved answers without creating records, retaining original IDs, dates and deduplicating linked versions',async()=>{
  const f=await setup();await f.database.write(async tx=>{
    await tx.run(sql`INSERT INTO speaking_question_attempts(id,question_id,mode,answer_text,intended_meaning_zh,status,created_at,updated_at) VALUES('original-a','history-q','practice','I start with a walk.','我先散步。','completed','2025-01-01T08:00:00Z','2025-01-01T08:00:00Z'),('edited-a','history-q','practice','I start with a long walk.','','completed','2025-02-01T08:00:00Z','2025-02-01T08:00:00Z'),('independent-a','history-q','practice','I read before breakfast.','','completed','2025-03-01T08:00:00Z','2025-03-01T08:00:00Z')`);
    await tx.run(sql`INSERT INTO answer_drafts(id,question_id,kind,submitted_attempt_id,source_attempt_id,english_committed_at,created_at,updated_at) VALUES('edit-draft','history-q','edit','edited-a','original-a',NULL,'2025-02-01','2025-02-01'),('independent-draft','history-q','independent','independent-a',NULL,'2025-03-01T07:55:00Z','2025-03-01','2025-03-01')`);
  });
  const before=f.connection.prepare('SELECT total_changes() count').get(),history=await f.service.history('history-q');expect(f.connection.prepare('SELECT total_changes() count').get()).toEqual(before);
  expect(history.attempts.map(a=>a.id)).toEqual(['original-a','independent-a']);expect(history.attempts[0]).toMatchObject({legacy:true,audio:[],createdAt:'2025-01-01T08:00:00Z',refs:{attemptId:'original-a'},countsAsAttempt:true});expect(history.attempts[1].stage).toBe('independent');
  expect(f.connection.prepare('SELECT * FROM full_answer_attempts').all()).toHaveLength(0);
  await f.service.sourceLink({questionId:'history-q',sourceKey:'existing-link',stage:'initial',promptCondition:'历史回答',text:'I start with a walk.',refs:{attemptId:'original-a'}});
  const linked=await f.service.history('history-q');expect(linked.attempts).toHaveLength(2);expect(linked.attempts.filter(a=>a.refs.attemptId==='original-a')).toHaveLength(1);
});
it('keeps revisions visible without counting them and refuses to create a full answer from a known local correction',async()=>{
  const f=await setup();await f.database.write(async tx=>{
    await tx.run(sql`INSERT INTO answer_drafts(id,question_id,kind,created_at,updated_at) VALUES('edit-only','history-q','edit','2026-01-01','2026-01-01')`);
    await tx.run(sql`INSERT INTO companion_threads(id,scope_key,scope_type,scope_id,title,created_at,updated_at) VALUES('thread','question:history-q','question','history-q','History','2026-01-01','2026-01-01')`);
    await tx.run(sql`INSERT INTO companion_messages(id,thread_id,sequence_no,role,text,status,client_message_id,source_type,source_id,metadata_json,created_at) VALUES('local-message','thread',1,'user','I meant, a short walk.','sent','local-message','coaching_output','material','{"correctionHint":true}','2026-01-01')`);
  });
  await f.service.sourceLink({questionId:'history-q',sourceKey:'edited-source',stage:'initial',promptCondition:'编辑原回答',text:'An edited sentence.',refs:{draftId:'edit-only'}});
  expect((await f.service.history('history-q')).attempts[0].countsAsAttempt).toBe(false);
  await expect(f.service.sourceLink({questionId:'history-q',sourceKey:'local-source',stage:'guided',promptCondition:'中文辅助',text:'I meant, a short walk.',refs:{coachingMessageId:'local-message'}})).rejects.toThrow('局部修正');
});
it('defaults to two different complete answers and uses observed recording time without inventing one for uploads',()=>{
  const audio=(id:string,answer:string,createdAt:string,recordedAt?:string):AudioAsset=>({id,fullAnswerId:answer,sha256:'',byteLength:10,mimeType:'audio/wav',extension:'wav',durationSeconds:null,source:'upload',originalName:'clip.wav',note:'',createdAt,recordedAt:recordedAt??null,recordedAtSource:recordedAt?'user_provided':'unknown',removedAt:null,purgedAt:null});
  const answer=(id:string,files:AudioAsset[],condition='same'):FullAnswer=>({id,sourceKey:id,questionId:'history-q',stage:'initial',promptCondition:condition,materialId:null,text:'',refs:{},createdAt:'2026-09-01',updatedAt:'2026-09-01',audio:files});
  const first=answer('one',[audio('one-old','one','2026-09-15T01:00:00Z','2026-01-01T01:00:00Z'),audio('one-extra','one','2026-09-15T02:00:00Z','2026-01-01T02:00:00Z')]),second=answer('two',[audio('two-audio','two','2026-09-15T00:00:00Z','2026-05-01T01:00:00Z')]);
  expect(comparisonDefaults([first,second])).toEqual(['one-old','two-audio']);expect(comparisonDefaults([first])).toEqual(['one-extra','']);
  expect(comparisonDefaults([first,answer('other',[audio('other-audio','other','2026-09-15T03:00:00Z')],'different')])).toEqual(['one-old','other-audio']);
  const legacy=assetView({id:'asset',full_answer_id:'answer',created_at:'2026-09-15'} as AssetRow);expect(legacy.recordedAt).toBeNull();expect(legacy.recordedAtSource).toBe('unknown');
});
it('accepts explicit recording metadata while preserving old upload payloads without inferred dates',()=>{
  const base={questionId:'history-q',sourceKey:'upload-source',stage:'initial',promptCondition:'首次表达',uploadId:'123e4567-e89b-42d3-a456-426614174000',byteLength:44,source:'upload',originalName:'old-file.wav',declaredMime:'audio/wav',recordingComplete:true};
  expect(uploadInputSchema.parse(base).recordedAt).toBeUndefined();expect(uploadInputSchema.parse({...base,recordedAt:'2025-08-15T10:00:00+08:00',recordedAtSource:'user_provided'}).recordedAtSource).toBe('user_provided');
  expect(()=>uploadInputSchema.parse({...base,recordedAt:'not a date'})).toThrow();
});

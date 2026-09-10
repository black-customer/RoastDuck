import {afterEach,expect,it} from 'vitest';
import {portableTestDatabase} from './helpers/portable-db';
import {query as sql} from '@/lib/platform/sql';
import {publishSentenceMaterials} from '@/lib/sentence-study/materials';
import {createSentenceHighlights} from '@/lib/sentence-study/highlights-service';
import {highlightAnchor,highlightSegments,reanchorHighlight,validHighlightRange} from '@/lib/sentence-study/highlights';
import {recallFixture} from './helpers/recall-material';
import {hash} from '@/lib/four-step/shared';
import type {MaterialInput,MaterialRow} from '@/lib/four-step/material-types';
import type {SentenceCard} from '@/lib/sentence-study/contracts';
const open:ReturnType<typeof portableTestDatabase>[]=[];afterEach(()=>open.splice(0).forEach(value=>value.close()));
async function fixture(){
  const f=portableTestDatabase();open.push(f);let next=0;const clock={now:()=>new Date('2026-09-10T06:00:00Z'),newId:()=>`mark-${++next}`};
  const input:MaterialInput={sourceType:'ielts_practice',sourceId:'a',mode:'practice',actualAnswer:'I am used to live alone.',intendedMeaningZh:'我已经习惯一个人住了。',question:{id:'q',textEn:'Where do you live?',textZh:'你住哪里？',part:1},spokenStyleVersion:'personal-spoken-v2'};
  const analysis=recallFixture({key:'a',kind:'attempt',createdAt:clock.now().toISOString(),questionId:'q',questionEn:'Where do you live?',questionZh:'你住哪里？',part:1,english:input.actualAnswer,chinese:input.intendedMeaningZh,mode:'practice',index:0,hash:'source',spokenStyleVersion:'personal-spoken-v2',en:[{index:0,start:0,end:input.actualAnswer.length,text:input.actualAnswer}],zh:[{index:0,start:0,end:input.intendedMeaningZh.length,text:input.intendedMeaningZh}]}).analysis;
  await f.database.write(async tx=>{
    await tx.run(sql`INSERT INTO questions(id,book_id,part,text,text_zh,norm_text) VALUES('q','retired',1,'Where do you live?','你住哪里？','q')`);
    await tx.run(sql`INSERT INTO speaking_question_attempts(id,question_id,mode,answer_text,intended_meaning_zh,status) VALUES('a','q','practice',${input.actualAnswer},${input.intendedMeaningZh},'completed')`);
    await tx.run(sql`INSERT INTO practice_materials(id,source_type,source_id,question_id,input_json,input_hash,analysis_json,status,contract_version,created_at,updated_at) VALUES('m','ielts_practice','a','q',${JSON.stringify(input)},${hash(JSON.stringify(input))},${JSON.stringify(analysis)},'ready','evidence_v2',${clock.now().toISOString()},${clock.now().toISOString()})`);
    const [row]=await tx.all<MaterialRow>(sql`SELECT * FROM practice_materials WHERE id='m'`);await publishSentenceMaterials(tx,row,input,analysis,clock.now());
  });
  const [row]=await f.database.read(tx=>tx.all<{body_json:string}>(sql`SELECT body_json FROM sentence_learning_units`));const card=JSON.parse(row.body_json) as SentenceCard;
  return {...f,card,service:createSentenceHighlights(f.database,clock),context:{sentenceId:card.id,textVersion:card.version,language:'en' as const}};
}
it('stores exact Chinese and English marks once, GET is read-only, remove cannot be resurrected by an old add receipt',async()=>{
  const f=await fixture(),start=f.card.english.indexOf('used'),input={...f.context,start,end:start+7,quote:'used to',clientRequestId:'create'};
  const first=await f.service.add(input);expect(first.highlights).toHaveLength(1);expect((await f.service.add(input)).highlights).toEqual(first.highlights);
  await f.service.add({...f.context,language:'zh',start:3,end:5,quote:'习惯',clientRequestId:'chinese'});
  const before=await f.database.read(tx=>tx.all(sql`SELECT * FROM sentence_highlights`));
  expect((await f.service.list(f.context)).highlights).toHaveLength(2);expect(await f.database.read(tx=>tx.all(sql`SELECT * FROM sentence_highlights`))).toEqual(before);
  await f.service.remove(first.highlights[0].id,f.context);expect((await f.service.add(input)).highlights).toHaveLength(1);
  expect((await f.service.remove(first.highlights[0].id,f.context)).highlights).toHaveLength(1);
  expect(await f.database.read(tx=>tx.all(sql`SELECT * FROM sentence_study_progress`))).toHaveLength(0);
  expect(await f.database.read(tx=>tx.all(sql`SELECT * FROM companion_memories`))).toHaveLength(0);
});
it('rejects wrong quotes, reused request identifiers, changed versions and revoked source materials',async()=>{
  const f=await fixture(),input={...f.context,start:0,end:1,quote:'I',clientRequestId:'request'};await f.service.add(input);
  await expect(f.service.add({...input,quote:'X'})).rejects.toMatchObject({code:'request_conflict'});
  await expect(f.service.add({...input,quote:'X',clientRequestId:'other'})).rejects.toMatchObject({code:'invalid_selection'});
  await expect(f.service.add({...input,textVersion:'stale'})).rejects.toMatchObject({code:'material_changed'});
  await f.database.write(tx=>tx.run(sql`UPDATE practice_materials SET status='hidden' WHERE id='m'`));
  await expect(f.service.list(f.context)).rejects.toMatchObject({code:'material_changed'});
  await expect(f.service.add(input)).rejects.toMatchObject({code:'material_changed'});
});
it('display-only sentence versions safely retain original mark provenance without rewriting stored ranges',async()=>{
  const f=await fixture();await f.service.add({...f.context,start:0,end:1,quote:'I',clientRequestId:'request'});
  const changed={...f.card,version:'display-v2'};await f.database.write(tx=>tx.run(sql`UPDATE sentence_learning_units SET version='display-v2',body_json=${JSON.stringify(changed)} WHERE id=${f.card.id}`));
  const result=await f.service.list({...f.context,textVersion:'display-v2'});expect(result.highlights[0]).toMatchObject({textVersion:'display-v2',sourceVersion:f.card.version,start:0,end:1});
  const [stored]=await f.database.read(tx=>tx.all<{text_version:string}>(sql`SELECT text_version FROM sentence_highlights`));expect(stored.text_version).toBe(f.card.version);
});
it('reanchors only an exact unambiguous quotation with its context and never splits emoji surrogate pairs',()=>{
  const original='A useful phrase in a sentence.',anchor=highlightAnchor(original,2,15);
  expect(reanchorHighlight(original,anchor)).toEqual({start:2,end:15});
  expect(reanchorHighlight('Intro. '+original,anchor)).toEqual({start:9,end:22});
  expect(reanchorHighlight(`${original} ${original}`,anchor)).toBeNull();
  expect(reanchorHighlight('A different phrase in a sentence.',anchor)).toBeNull();
  expect(validHighlightRange('A😀B',1,3,'😀')).toBe(true);expect(validHighlightRange('A😀B',1,2,'\uD83D')).toBe(false);
});
it('manual yellow ranges and AI blue ranges overlap without duplicate text or bold styling',()=>{
  const segments=highlightSegments('look put together',[{id:'a',start:0,end:8},{id:'b',start:5,end:17}],[{start:5,end:17}]);
  expect(segments.map(value=>value.text).join('')).toBe('look put together');
  expect(segments.find(value=>value.start===5)).toMatchObject({manualIds:['a','b'],ai:true});
});

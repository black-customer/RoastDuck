import {afterEach,expect,it} from 'vitest';
import {portableTestDatabase} from './helpers/portable-db';
import {createDeviceSync} from '@/lib/device-sync/service';
import {changeHash,type SyncChange} from '@/lib/device-sync/contracts';
import fs from 'node:fs';
import {createAppServices} from '@/lib/app-services';
import {MockAiProvider} from '@/lib/ai/mock-provider';
import {selectionMockResolver} from '@/lib/four-step/selection-mock';
const fixtures:Array<ReturnType<typeof portableTestDatabase>>=[];
afterEach(()=>fixtures.splice(0).forEach(f=>f.close()));
function setup(device:string){const fixture=portableTestDatabase();fixtures.push(fixture);fixture.connection.prepare("INSERT INTO app_device VALUES(1,?,'dataset-test','2026-09-08')").run(device);const identity={device_id:device,dataset_id:'dataset-test'};return {...fixture,sync:createDeviceSync(fixture.database,identity,{now:()=>new Date('2026-09-08T00:00:00Z')})};}
async function appFor(fixture:ReturnType<typeof setup>,device:string,delayReply?:()=>Promise<void>){let n=0;return createAppServices({database:fixture.database,now:()=>new Date('2026-09-08T00:00:00Z'),newId:()=>device+(++n),bootId:device,allowMock:true,loadPrompt:name=>fs.readFileSync(`pipeline/prompts/${name}`,'utf8'),provider:new MockAiProvider(async request=>{
  if(request.schemaName==='companion_dialogue_v2'&&delayReply)await delayReply();
  if(request.schemaName==='companion_dialogue_v2')return {messages:[{text:'What do you enjoy about that?',translationZh:'你喜欢其中的哪些方面？',purpose:'follow_up'}],usedLearningItemIds:[],glossary:[]};
  if(request.schemaName==='companion_memory_extractor_v1')return {memories:[]};return selectionMockResolver(request);
})});}
async function send(from:ReturnType<typeof setup>,to:ReturnType<typeof setup>,device:string){
  await from.sync.capture();let cursor=await to.sync.cursor(device);
  for(;;){const page=await from.sync.changes(cursor);await to.sync.receive(device,page.from,page.cursor,page.changes);cursor=page.cursor;if(!page.hasMore)break;}
}
it('sync uses append-only business envelopes, resumes by receipt, and replay does not add duplicate records',async()=>{
  const a=setup('a'),b=setup('b');a.connection.exec("INSERT INTO questions(id,book_id,part,text,text_zh,norm_text) VALUES('q','removed',1,'Do you read?','你阅读吗？','read')");
  a.connection.exec("INSERT INTO question_favorites(question_id) VALUES('q')");
  await send(a,b,'a');expect(b.connection.prepare('SELECT * FROM questions').all()).toHaveLength(1);
  const count=(await b.sync.manifest()).sequence;await send(a,b,'a');expect((await b.sync.manifest()).sequence).toBe(count);
  b.connection.exec("DELETE FROM question_favorites WHERE question_id='q'");
  await send(b,a,'b');expect(a.connection.prepare('SELECT * FROM question_favorites').all()).toHaveLength(0);
  await send(a,b,'a');expect(b.connection.prepare('SELECT * FROM question_favorites').all()).toHaveLength(0);
  expect((await a.sync.manifest()).counts).not.toHaveProperty('books');
});
it('concurrent self ratings keep both events and one conservative schedule, not two successful reviews',async()=>{
  const a=setup('a'),b=setup('b');
  a.connection.exec("INSERT INTO light_study_progress(learning_item_id,first_seen_at,last_seen_at,due_at,review_count,version) VALUES('item','2026-09-01','2026-09-01','2026-09-02',1,1)");
  await send(a,b,'a');
  a.connection.exec("UPDATE light_study_progress SET due_at='2026-09-20',review_count=2,version=2,last_rating='remembered'");
  b.connection.exec("UPDATE light_study_progress SET due_at='2026-09-09',review_count=2,version=2,last_rating='forgot'");
  await a.sync.capture();await b.sync.capture();await send(a,b,'a');await send(b,a,'b');
  const row=a.connection.prepare('SELECT * FROM light_study_progress').get();
  expect(row).toMatchObject({due_at:'2026-09-09',review_count:2,version:3,last_rating:'forgot'});
  expect(b.connection.prepare('SELECT * FROM light_study_progress').get()).toEqual(row);
  const history=a.connection.prepare("SELECT * FROM device_sync_changes WHERE entity='light_study_progress'").all();expect(history).toHaveLength(3);
  await send(a,b,'a');await send(b,a,'b');expect(a.connection.prepare('SELECT * FROM light_study_progress').get()).toEqual(row);
});
it('invalid hashes, forbidden entities and missing ancestry are rejected without updating receipt',async()=>{
  const b=setup('b');const raw={deviceId:'a',entity:'question_favorites' as const,key:'["q"]',parents:[],row:{question_id:'q',created_at:'2026-09-08'},at:'2026-09-08T00:00:00.000Z'};
  const valid={...raw,id:changeHash(raw)};
  await expect(b.sync.receive('a',0,1,[{...valid,id:'0'.repeat(64)}])).rejects.toThrow();
  await expect(b.sync.receive('a',0,1,[{...valid,entity:'runtime_requests'}])).rejects.toThrow();
  const orphan={...raw,parents:['1'.repeat(64)]};await expect(b.sync.receive('a',0,1,[{...orphan,id:changeHash(orphan)}])).rejects.toThrow('前序');
  expect(await b.sync.cursor('a')).toBe(0);expect(b.connection.prepare('SELECT * FROM device_sync_changes').all()).toHaveLength(0);
});
it('an old device cannot revive a concurrently deleted memory',async()=>{
  const a=setup('a'),b=setup('b');
  a.connection.exec("INSERT INTO companion_memories(id,category,summary,source_type,source_id) VALUES('m','goal','Learn English','chat_message','message')");await send(a,b,'a');
  a.connection.exec("UPDATE companion_memories SET status='deleted',deleted_at='2026-09-08'");
  b.connection.exec("UPDATE companion_memories SET summary='Learn English for work'");
  await send(b,a,'b');await send(a,b,'a');expect(a.connection.prepare("SELECT status FROM companion_memories WHERE id='m'").get()).toEqual({status:'deleted'});
  expect(b.connection.prepare("SELECT status FROM companion_memories WHERE id='m'").get()).toEqual({status:'deleted'});
});
it('active imported sessions keep remote ownership and cannot be silently resumed locally',async()=>{
  const a=setup('a'),b=setup('b');a.connection.exec(`INSERT INTO light_study_sessions(id,scope_key,scope_json,mode,queue_json,created_at,updated_at) VALUES('l','all','{"type":"all"}','learn','[]','2026-09-08','2026-09-08')`);
  await send(a,b,'a');expect(b.connection.prepare('SELECT status FROM light_study_sessions').get()).toEqual({status:'paused'});
  await expect(b.sync.assertOwner('light_study_sessions','l')).rejects.toMatchObject({code:'remote_owned'});
});
it('sync is independent of transport chunk boundaries and records no API key',async()=>{
  const a=setup('a'),b=setup('b');for(let i=0;i<8;i++)a.connection.prepare("INSERT INTO question_favorites(question_id) VALUES(?)").run(`q${i}`);
  await a.sync.capture();let cursor=0;const pages:SyncChange[][]=[];
  for(;;){const page=await a.sync.changes(cursor,250);pages.push(page.changes);await b.sync.receive('a',page.from,page.cursor,page.changes);cursor=page.cursor;if(!page.hasMore)break;}
  expect(pages.length).toBeGreaterThan(1);expect(b.connection.prepare('SELECT * FROM question_favorites').all()).toHaveLength(8);
});
it('an out-of-order page never acknowledges unseen earlier records',async()=>{
  const a=setup('a'),b=setup('b');a.connection.exec("INSERT INTO question_favorites(question_id) VALUES('first'),('second')");await a.sync.capture();
  const first=await a.sync.changes(0,1),second=await a.sync.changes(first.cursor,1);
  await expect(b.sync.receive('a',second.from,second.cursor,second.changes)).rejects.toThrow('不连续');expect(await b.sync.cursor('a')).toBe(0);
  await send(a,b,'a');expect(b.connection.prepare('SELECT * FROM question_favorites').all()).toHaveLength(2);
});
it('real memory edit descendants cannot revive a revoked parent after two-device sync',async()=>{
  const a=setup('a'),b=setup('b'),aa=await appFor(a,'a'),bb=await appFor(b,'b');
  a.connection.exec("INSERT INTO companion_memories(id,category,summary,source_type,source_id) VALUES('m','goal','Learn English','chat_message','message')");await send(a,b,'a');
  await aa.memory.state('m','deleted');const edit=await bb.memory.edit('m',{clientEventId:'edit-on-b',summary:'Learn English for work',category:'goal'});
  await send(b,a,'b');await send(a,b,'a');expect(await aa.memory.list()).toEqual([]);expect(await bb.memory.list()).toEqual([]);
  expect(a.connection.prepare('SELECT status FROM companion_memories WHERE id=?').get(edit.id)).toEqual({status:'dismissed'});
});
it('two real offline replies become separate chats without losing messages or their reviewed recap',async()=>{
  const a=setup('a'),b=setup('b'),aa=await appFor(a,'a'),bb=await appFor(b,'b');
  const conversation=await aa.chat.create({clientRequestId:'shared-conversation'});await send(a,b,'a');
  const ma=await aa.chat.prepare(conversation.id,{clientMessageId:'offline-message-a',text:'What a lovely day!'}),mb=await bb.chat.prepare(conversation.id,{clientMessageId:'offline-message-b',text:"I'm used to live alone."});
  await aa.chat.process(conversation.id,ma.id);await bb.chat.process(conversation.id,mb.id);
  const material=await bb.chat.recap(conversation.id,mb.id,mb.id);await bb.materials.process(material.id);expect((await bb.materials.inspect(material.id)).verified).toBe(true);
  await send(a,b,'a');await send(b,a,'b');await send(a,b,'a');
  for(const [fixture,app] of [[a,aa],[b,bb]] as const){
    const left=fixture.connection.prepare('SELECT conversation_id FROM free_talk_messages WHERE id=?').get(ma.id),right=fixture.connection.prepare('SELECT conversation_id FROM free_talk_messages WHERE id=?').get(mb.id);
    expect(left).not.toEqual(right);expect((await app.materials.inspect(material.id)).verified).toBe(true);
    const branches=await app.chat.list();expect(branches).toHaveLength(2);
    const branch=branches.find(row=>row.id!==conversation.id)!;expect((await app.chat.messages(branch.id)).map(row=>row.text)).toContain(mb.text);
  }
  // Choosing the reconciled main thread is a new causal branch, not a permanent device route.
  const next=await bb.chat.prepare(conversation.id,{clientMessageId:'explicit-main-after-merge',text:'Back to the main conversation.'});await bb.chat.process(conversation.id,next.id);
  await send(b,a,'b');await send(a,b,'a');
  expect(a.connection.prepare('SELECT conversation_id FROM free_talk_messages WHERE id=?').get(next.id)).toEqual({conversation_id:conversation.id});
  expect(b.connection.prepare('SELECT conversation_id FROM free_talk_messages WHERE id=?').get(next.id)).toEqual({conversation_id:conversation.id});
});
it('a pending native reply follows its relocated user message and is never silently discarded',async()=>{
  let release!:()=>void,entered!:()=>void;const started=new Promise<void>(r=>entered=r),delayed=new Promise<void>(r=>release=r);
  const a=setup('a'),b=setup('b'),aa=await appFor(a,'a'),bb=await appFor(b,'b',()=>{entered();return delayed;});
  const conversation=await aa.chat.create({clientRequestId:'in-flight-shared-chat'});await send(a,b,'a');
  const userA=await aa.chat.prepare(conversation.id,{clientMessageId:'fast-response-a',text:'A different reply.'});await aa.chat.process(conversation.id,userA.id);
  const userB=await bb.chat.prepare(conversation.id,{clientMessageId:'slow-response-b',text:'My original reply.'}),task=bb.chat.process(conversation.id,userB.id);await started;
  await send(a,b,'a');release();const rows=await task;
  const user=rows.find(row=>row.id===userB.id)!;expect(user.conversation_id).not.toBe(conversation.id);
  expect(JSON.parse(user.metadata_json).deliveryStatus).toBe('completed');expect(rows.filter(row=>JSON.parse(row.metadata_json).replyTo===userB.id)).toHaveLength(1);
});
it('a clear cutoff rejects a newly extracted ID whose evidence predates the clear',async()=>{
  const a=setup('a'),b=setup('b'),aa=await appFor(a,'a');
  a.connection.exec("INSERT INTO companion_threads(id,scope_key,scope_type,title,created_at,updated_at) VALUES('t','general:t','general','Test','2026-09-08','2026-09-08')");
  for(let i=1;i<=4;i++)a.connection.prepare("INSERT INTO companion_messages(id,thread_id,sequence_no,role,text,status,client_message_id,created_at) VALUES(?,'t',?,'user','My goal is daily practice.','sent',?,'2026-09-08')").run(`u${i}`,i,`u${i}`);
  await send(a,b,'a');await aa.memory.clear();
  const bb=await createAppServices({database:b.database,now:()=>new Date('2026-09-08T00:00:00Z'),newId:()=>crypto.randomUUID(),bootId:'b',loadPrompt:name=>fs.readFileSync(`pipeline/prompts/${name}`,'utf8'),provider:new MockAiProvider(()=>({memories:[{memoryKey:'daily_practice',category:'goal',summary:'每天练习英语',confidence:.95,evidenceMessageIds:['u1']}]}))});
  expect(await bb.memory.extract('t')).toHaveLength(1);await send(b,a,'b');await send(a,b,'a');
  expect(await aa.memory.list()).toEqual([]);expect(await bb.memory.list()).toEqual([]);
});

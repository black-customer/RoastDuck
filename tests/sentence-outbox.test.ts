import {expect,it,vi} from 'vitest';
import {SentenceController,type SentenceClient} from '@/lib/sentence-study/client';
import {projectSentenceEvent,SentenceStudyError,type SentenceSession} from '@/lib/sentence-study/contracts';
function store(){const data=new Map<string,string>();return {data,get length(){return data.size;},key:(i:number)=>[...data.keys()][i]??null,getItem:(k:string)=>data.get(k)??null,setItem:(k:string,v:string)=>{data.set(k,v);},removeItem:(k:string)=>{data.delete(k);}};}
function base():SentenceSession{return {id:'one',scope:{type:'question',id:'q'},mode:'learn',status:'active',version:0,index:0,revealed:false,assessments:[],lastRatingEventId:null,nextDueAt:null,notice:null,cards:[{id:'sentence',version:'v1',materialId:'m',sentenceId:'s0',ordinal:0,chinese:'我喜欢画画。',english:'I like drawing.',contextZh:'',meaningOrigin:'derived_from_english',usages:[],notes:[],progressVersion:0,source:{id:'a',questionId:'q',type:'ielts_practice',title:'兴趣',href:'/questions/q'}}]};}
function client(v:SentenceSession):SentenceClient {return {get:vi.fn(async()=>structuredClone(v)),create:vi.fn(async()=>structuredClone(v)),overview:vi.fn(),event:vi.fn(async(_id,e)=>projectSentenceEvent(v,e))};}
it('reveal responds locally while the network is delayed and persists an exact retry event',async()=>{
  const storage=store(),v=base(),c=client(v);let finish!:(v:SentenceSession)=>void;c.event=vi.fn(()=>new Promise<SentenceSession>(resolve=>{finish=resolve;}));const controller=new SentenceController(c,storage);await controller.load(v.id);
  await controller.apply({type:'reveal'});expect(controller.getSnapshot().view?.revealed).toBe(true);expect(controller.getSnapshot().pending).toBe(1);
  expect([...storage.data.keys()].filter(k=>k.startsWith('sentence_event:'))).toHaveLength(1);finish({...v,revealed:true,version:1});await vi.waitFor(()=>expect(controller.getSnapshot().pending).toBe(0));
});
it('another tab cannot overwrite a pending rating with its pause snapshot',async()=>{
  const storage=store(),v={...base(),revealed:true},c=client(v);c.event=vi.fn(async()=>{throw new Error('offline');});const a=new SentenceController(c,storage),b=new SentenceController(c,storage);await a.load(v.id);await b.load(v.id);
  await a.apply({type:'rate',rating:'remembered'});await b.apply({type:'pause'});
  const pending=[...storage.data.entries()].filter(([k])=>k.startsWith('sentence_event:')).map(([,v])=>JSON.parse(v));expect(pending.map(e=>e.type)).toEqual(['rate']);expect(b.getSnapshot().conflict).toBe(true);
  const restored=new SentenceController(c,storage);await restored.load(v.id);expect(restored.getSnapshot().pending).toBe(1);expect(restored.getSnapshot().view?.assessments[0].rating).toBe('remembered');
});
it('recovery submits another tab\'s valid original rating before any resume or archive',async()=>{
  const storage=store();let server={...base(),revealed:true},offline=true;const c=client(server);
  c.get=vi.fn(async()=>structuredClone(server));c.event=vi.fn(async(_id,event)=>{if(offline)throw new Error('offline');if(event.version!==server.version)throw new SentenceStudyError('version',409,'version_conflict');server=projectSentenceEvent(server,event);return structuredClone(server);});
  const a=new SentenceController(c,storage),b=new SentenceController(c,storage);await a.load('one');await b.load('one');await a.apply({type:'rate',rating:'forgot'});await b.apply({type:'pause'});expect(b.getSnapshot().conflict).toBe(true);
  offline=false;await b.retry();expect(server.assessments).toHaveLength(1);expect(server.assessments[0].rating).toBe('forgot');expect(server.version).toBe(1);
  expect([...storage.data.keys()].filter(k=>k.startsWith('sentence_event:')||k.startsWith('sentence_conflict:'))).toHaveLength(0);
});
it('storage failure stops the visible transition instead of claiming a completed rating',async()=>{
  const storage=store(),v={...base(),revealed:true},c=client(v),controller=new SentenceController(c,storage);await controller.load(v.id);storage.setItem=()=>{throw new Error('storage full');};
  await controller.apply({type:'rate',rating:'forgot'});expect(controller.getSnapshot().view?.status).toBe('active');expect(controller.getSnapshot().error).toContain('存储空间不足');expect(c.event).not.toHaveBeenCalled();
});
it('a late response from an old session cannot overwrite a newly opened session',async()=>{
  const storage=store(),v=base(),c=client(v);let finish!:(v:SentenceSession)=>void;c.event=vi.fn(()=>new Promise<SentenceSession>(resolve=>{finish=resolve;}));const controller=new SentenceController(c,storage);await controller.load('one');await controller.apply({type:'reveal'});
  c.get=vi.fn(async()=>({...base(),id:'two'}));await controller.load('two');finish({...v,version:1,revealed:true});await Promise.resolve();await Promise.resolve();expect(controller.getSnapshot().view?.id).toBe('two');
});

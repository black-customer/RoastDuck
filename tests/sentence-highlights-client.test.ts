import {expect,it,vi} from 'vitest';
import {HighlightController,HIGHLIGHT_OUTBOX_PREFIX,type HighlightApi,type HighlightClientState} from '@/lib/sentence-study/highlights-client';
import type {HighlightContext,HighlightList} from '@/lib/sentence-study/highlights';
function storage(){const data=new Map<string,string>();return {data,get length(){return data.size;},key:(i:number)=>[...data.keys()][i]??null,getItem:(key:string)=>data.get(key)??null,setItem:(key:string,value:string)=>{data.set(key,value);},removeItem:(key:string)=>{data.delete(key);}};}
function api(){let value:HighlightList={highlights:[],unmappedCount:0};return {list:vi.fn(async()=>value),add:vi.fn(async input=>{if(!value.highlights.some(mark=>mark.id===input.clientRequestId))value={...value,highlights:[...value.highlights,{...input,id:input.clientRequestId,sourceVersion:input.textVersion}]};return value;}),remove:vi.fn(async id=>{value={...value,highlights:value.highlights.filter(mark=>mark.id!==id)};return value;})} satisfies HighlightApi;}
const context=(sentenceId:string,language:'en'|'zh'='en'):HighlightContext=>({sentenceId,language,textVersion:'v1'});
it('coalesces Chinese/English reads and uses preloaded marks without an extra request',async()=>{
  const server=api(),store=storage(),a=new HighlightController(context('coalesced'),store,()=>{},server),b=new HighlightController(context('coalesced','zh'),store,()=>{},server);
  await Promise.all([a.load(),b.load()]);expect(server.list).toHaveBeenCalledOnce();a.dispose();b.dispose();
  const bundled=new HighlightController(context('bundled'),store,()=>{},server,[]);await bundled.load(true);expect(server.list).toHaveBeenCalledOnce();bundled.dispose();
});
it('keeps failed selections durably, retries original request IDs after reopening and does not write learning events',async()=>{
  const server=api(),store=storage(),states:HighlightClientState[]=[];server.add.mockRejectedValueOnce(new Error('offline'));
  const a=new HighlightController(context('recover'),store,state=>states.push(state),server,[]);await a.load(true);
  a.add({start:0,end:4,quote:'look'},'same-request');expect(states.at(-1)?.highlights[0]).toMatchObject({quote:'look',pending:true});
  await vi.waitFor(()=>expect(states.at(-1)?.error).toBe('offline'));expect(store.data.size).toBe(1);a.dispose();
  const b=new HighlightController(context('recover'),store,state=>states.push(state),server);await b.load();expect(server.add).toHaveBeenCalledTimes(2);
  expect(server.add.mock.calls.map(call=>call[0].clientRequestId)).toEqual(['same-request','same-request']);expect(store.data.size).toBe(0);expect(states.at(-1)?.highlights[0]).toMatchObject({id:'same-request'});b.dispose();
});
it('does not pretend a selection is saved when local persistence fails; cleanup failures are not server failures',async()=>{
  const server=api(),store=storage(),states:HighlightClientState[]=[];const a=new HighlightController(context('storage-fail'),store,state=>states.push(state),server,[]);await a.load(true);
  const setter=vi.spyOn(store,'setItem').mockImplementation(()=>{throw new Error('quota');});expect(a.add({start:0,end:1,quote:'A'},'blocked')).toBe(false);expect(server.add).not.toHaveBeenCalled();expect(states.at(-1)?.highlights).toHaveLength(0);setter.mockRestore();a.dispose();
  const clean=storage(),b=new HighlightController(context('cleanup-fail'),clean,state=>states.push(state),server,[]);await b.load(true);vi.spyOn(clean,'removeItem').mockImplementation(()=>{throw new Error('locked');});b.add({start:0,end:1,quote:'A'},'saved');
  await vi.waitFor(()=>expect(states.at(-1)?.notice).toContain('高亮已保存'));expect(states.at(-1)?.error).toBe('');expect(states.at(-1)?.pendingCount).toBe(0);b.dispose();
});
it('does not apply an old-version pending selection to a new sentence version',async()=>{
  const server=api(),store=storage(),states:HighlightClientState[]=[];
  store.setItem(HIGHLIGHT_OUTBOX_PREFIX+'old',JSON.stringify({id:'old',createdAt:1,context:context('changed'),kind:'add',input:{...context('changed'),start:0,end:1,quote:'A',clientRequestId:'old'}}));
  const current=new HighlightController({...context('changed'),textVersion:'v2'},store,state=>states.push(state),server,[]);await current.load(true);
  expect(server.add).not.toHaveBeenCalled();expect(states.at(-1)?.notice).toContain('旧版本');expect(store.data.size).toBe(1);current.dispose();
});
it('a refresh during an in-flight write waits for its result rather than overwriting saved marks with a stale read',async()=>{
  const server=api(),store=storage(),states:HighlightClientState[]=[];let finish!:(value:HighlightList)=>void;
  server.add.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  const a=new HighlightController(context('refresh-race'),store,state=>states.push(state),server,[]);await a.load(true);a.add({start:0,end:1,quote:'A'},'race');
  await vi.waitFor(()=>expect(server.add).toHaveBeenCalledOnce());const refresh=a.retry();await Promise.resolve();expect(server.list).not.toHaveBeenCalled();
  const saved:HighlightList={highlights:[{...context('refresh-race'),id:'race',sourceVersion:'v1',start:0,end:1,quote:'A'}],unmappedCount:0};server.list.mockResolvedValue(saved);finish(saved);
  await refresh;expect(states.at(-1)?.highlights).toEqual(saved.highlights);expect(store.data.size).toBe(0);a.dispose();
});
it('returning to a sentence trusts its fresh bundle after another window added or removed a mark',async()=>{
  const server=api(),store=storage(),states:HighlightClientState[]=[],scope=context('fresh-return');
  const old={...scope,id:'old',sourceVersion:'v1',start:0,end:1,quote:'A'};
  const first=new HighlightController(scope,store,state=>states.push(state),server,[old]);await first.load(true);expect(states.at(-1)?.highlights).toEqual([old]);first.dispose();
  const added={...scope,id:'added-elsewhere',sourceVersion:'v1',start:2,end:3,quote:'B'};
  const returned=new HighlightController(scope,store,state=>states.push(state),server,[added]);await returned.load(true);expect(states.at(-1)?.highlights).toEqual([added]);returned.dispose();
  const deleted=new HighlightController(scope,store,state=>states.push(state),server,[]);await deleted.load(true);expect(states.at(-1)?.highlights).toEqual([]);expect(server.list).not.toHaveBeenCalled();deleted.dispose();
});
it('keeps a shared cache while a write is in flight and preserves its durable pending overlay across remounts',async()=>{
  const server=api(),store=storage(),states:HighlightClientState[]=[],scope=context('inflight-remount');let finish!:(value:HighlightList)=>void;
  server.add.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  const first=new HighlightController(scope,store,state=>states.push(state),server,[]);await first.load(true);first.add({start:0,end:1,quote:'A'},'pending-remount');await vi.waitFor(()=>expect(server.add).toHaveBeenCalledOnce());first.dispose();
  const next=new HighlightController(scope,store,state=>states.push(state),server,[]),loading=next.load(true);expect(states.at(-1)?.highlights[0]).toMatchObject({quote:'A',pending:true});
  const saved:HighlightList={highlights:[{...scope,id:'pending-remount',sourceVersion:'v1',start:0,end:1,quote:'A'}],unmappedCount:0};server.add.mockResolvedValue(saved);finish(saved);
  await loading;expect(states.at(-1)?.highlights).toEqual(saved.highlights);expect(store.data.size).toBe(0);expect(server.list).not.toHaveBeenCalled();next.dispose();
});

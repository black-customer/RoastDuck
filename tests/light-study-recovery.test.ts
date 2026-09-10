import {expect,it,vi} from 'vitest';
import {reconcileLightPending,PendingSaveError} from '@/lib/light-study/recovery';
import {savePending,listPending} from '@/lib/light-study/pending';
import {LightStudyError,type LightView} from '@/lib/light-study/contracts';
function store(){const data=new Map<string,string>();return {getItem:(key:string)=>data.get(key)??null,setItem:(key:string,value:string)=>{data.set(key,value);},removeItem:(key:string)=>{data.delete(key);},key:(i:number)=>[...data.keys()][i]??null,get length(){return data.size;}};}
const view={id:'recovery-session',version:2,scope:{type:'all'},mode:'learn',status:'active',index:1,total:5,revealed:false,card:null,nextCard:null,unavailable:null,notice:null} as LightView;
it('replays original IDs in order and clears only confirmed operations',async()=>{
  const storage=store();
  const reveal={type:'reveal',version:0,clientEventId:'reveal-a'} as const;
  const grade={type:'rate',rating:'forgot',version:1,clientEventId:'rate-a'} as const;
  savePending({id:view.id,event:grade},storage);savePending({id:view.id,event:reveal},storage);
  const client={get:vi.fn(),event:vi.fn().mockResolvedValue(view)};
  expect(await reconcileLightPending(view,client,storage)).toEqual(view);
  expect(client.event.mock.calls).toEqual([[view.id,reveal],[view.id,grade]]);
  expect(listPending(view.id,storage)).toHaveLength(0);
});
it('network failure retains the original choice; does not turn it into success',async()=>{
  const storage=store(),event={type:'rate',rating:'forgot',version:1,clientEventId:'offline'} as const;
  savePending({id:view.id,event},storage);
  await expect(reconcileLightPending(view,{get:vi.fn(),event:vi.fn().mockRejectedValue(new Error('offline'))},storage)).rejects.toBeInstanceOf(PendingSaveError);
  expect(listPending(view.id,storage)[0].event).toEqual(event);
});
it('version conflict reads the current state without reusing an old answer on the next card',async()=>{
  const storage=store(),event={type:'rate',rating:'forgot',version:1,clientEventId:'conflict'} as const;
  savePending({id:view.id,event},storage);
  const client={get:vi.fn().mockResolvedValue(view),event:vi.fn().mockRejectedValue(new LightStudyError('conflict',409,'version_conflict'))};
  const actual=await reconcileLightPending(view,client,storage);
  expect(actual.index).toBe(1);expect(client.event).toHaveBeenCalledOnce();expect(listPending(view.id,storage)).toHaveLength(0);
});
it('an event ID used with different data is not silently discarded',async()=>{
  const storage=store();savePending({id:view.id,event:{type:'pause',version:2,clientEventId:'collision'}},storage);
  await expect(reconcileLightPending(view,{get:vi.fn(),event:vi.fn().mockRejectedValue(new LightStudyError('collision',409,'event_conflict'))},storage)).rejects.toBeInstanceOf(PendingSaveError);
  expect(listPending(view.id,storage)).toHaveLength(1);
});

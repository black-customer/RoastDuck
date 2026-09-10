import {SentenceStudyError,projectSentenceEvent,type SentenceScope,type SentenceOverview,type SentenceSession,type SentenceCreate,type SentenceEvent,type SentenceRating} from './contracts';
export function sentenceScopeQuery(scope:SentenceScope){const p=new URLSearchParams({scope:scope.type});if('id'in scope)p.set('id',scope.id);if(scope.type==='collection')for(const k of ['questionId','topicId','seasonId'] as const)if(scope[k])p.set(k,scope[k]);return p.toString();}
export interface SentenceClient {overview(scope:SentenceScope):Promise<SentenceOverview>;create(input:SentenceCreate):Promise<SentenceSession>;get(id:string):Promise<SentenceSession>;event(id:string,event:SentenceEvent):Promise<SentenceSession>}
async function request(url:string,body?:unknown){const response=await fetch(url,body===undefined?{cache:'no-store'}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const data=await response.json();if(!response.ok)throw new SentenceStudyError(data.error??'暂时无法保存',response.status,data.code);return data;}
export const sentenceClient:SentenceClient={overview:async scope=>(await request(`/api/sentence-study/overview?${sentenceScopeQuery(scope)}`)).overview,create:async input=>(await request('/api/sentence-study/sessions',input)).session,get:async id=>(await request(`/api/sentence-study/sessions/${encodeURIComponent(id)}`)).session,event:async(id,event)=>(await request(`/api/sentence-study/sessions/${encodeURIComponent(id)}/events`,event)).session};
export interface SentenceClientState {view:SentenceSession|null;pending:number;saving:boolean;error:string|null;loading:boolean;conflict:boolean}
interface Saved {view:SentenceSession;queue:SentenceEvent[]}
type LocalStore=Pick<Storage,'getItem'|'setItem'|'removeItem'>&Partial<Pick<Storage,'key'|'length'>>;
export type SentenceAction={type:'reveal'|'pause'|'resume'}|{type:'rate';rating:SentenceRating}|{type:'revise_rating';rating:SentenceRating;targetEventId:string};

/** Durable ordered outbox. A local transition is shown only after its recovery record is persisted. */
export class SentenceController {
  private state:SentenceClientState={view:null,pending:0,saving:false,error:null,loading:false,conflict:false};
  private queue:SentenceEvent[]=[];private listeners=new Set<()=>void>();private running=false;private disposed=false;private generation=0;
  constructor(private client:SentenceClient=sentenceClient,private storage:LocalStore|null=typeof window==='undefined'?null:window.localStorage){}
  getSnapshot=()=>this.state;
  subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
  private update(patch:Partial<SentenceClientState>){this.state={...this.state,...patch};if(!this.disposed)for(const listener of this.listeners)listener();}
  private persist(view:SentenceSession,queue:SentenceEvent[]){if(!this.storage)throw new Error('浏览器无法保留操作，请先允许本机存储');this.storage.setItem(`sentence_session:${view.id}`,JSON.stringify({view,queue}));}
  private eventKey(id:string,event:SentenceEvent){return `sentence_event:${id}:${event.clientEventId}`;}
  private storedEvents(id:string,fallback:SentenceEvent[]=[]){const events=new Map(fallback.map(e=>[e.clientEventId,e]));
    if(this.storage?.key&&this.storage.length!==undefined)for(let i=0;i<this.storage.length;i++){const key=this.storage.key(i);if(key?.startsWith(`sentence_event:${id}:`)){const raw=this.storage.getItem(key);if(raw){const e=JSON.parse(raw) as SentenceEvent;events.set(e.clientEventId,e);}}}
    return [...events.values()].sort((a,b)=>a.version-b.version||a.clientEventId.localeCompare(b.clientEventId));
  }
  async load(id:string){const generation=++this.generation;this.running=false;this.update({loading:true,error:null,conflict:false});try{
    const raw=this.storage?.getItem(`sentence_session:${id}`);const saved=raw?JSON.parse(raw) as Saved:null;
    const events=this.storedEvents(id,saved?.view.id===id?saved.queue:[]);
    if(saved?.view.id===id&&events.length){this.queue=events;const conflict=new Set(events.map(e=>e.version)).size!==events.length;this.update({view:saved.view,pending:this.queue.length,conflict,error:conflict?'多个窗口留下了不同操作，请恢复服务端位置；各操作仍保存在本机。':null});if(!conflict)await this.drain();}
    else {const view=await this.client.get(id);if(generation!==this.generation)return;this.queue=events;this.persist(view,events);this.update({view,pending:events.length});if(events.length)await this.drain();}
  }catch(e){this.update({error:e instanceof Error?e.message:'读取失败'});}finally{this.update({loading:false});}}
  async start(input:SentenceCreate){const generation=++this.generation;this.running=false;this.update({loading:true,error:null,conflict:false});try{const key=`sentence_start:${sentenceScopeQuery(input.scope)}:${input.mode}:${input.selection??'scope'}:${input.resumeSessionId??''}`;const raw=this.storage?.getItem(key);let actual=input;
    if(raw){const saved=JSON.parse(raw) as SentenceCreate;if(saved.scope&&saved.clientRequestId)actual=saved;}
    this.storage?.setItem(key,JSON.stringify(actual));const view=await this.client.create(actual);if(generation!==this.generation)return;
    try{this.storage?.removeItem(key);}catch{/* confirmed on server */}
    this.queue=[];this.persist(view,[]);this.update({view,pending:0,conflict:false});
    if(view.status==='paused')await this.apply({type:'resume'});
  }catch(e){this.update({error:e instanceof Error?e.message:'暂时无法开始'});}finally{this.update({loading:false});}}
  async apply(action:SentenceAction){if(!this.state.view||this.state.conflict)return;const view=this.state.view,card=view.cards[view.index];
    const event={...action,version:view.version,clientEventId:crypto.randomUUID(),...(action.type==='reveal'||action.type==='rate'?{sentenceId:card?.id,unitVersion:card?.version}:{})} as SentenceEvent;
    try{
      const other=this.storedEvents(view.id).filter(e=>!this.queue.some(q=>q.clientEventId===e.clientEventId));
      if(other.length){this.update({conflict:true,error:'另一个窗口还有待保存操作，请先恢复最新位置。'});return;}
      const projected=projectSentenceEvent(view,event),queue=[...this.queue,event];
      if(!this.storage)throw new Error('浏览器无法保留操作');
      // Unique immutable keys stop another tab's cache write from destroying this event.
      this.storage.setItem(this.eventKey(view.id,event),JSON.stringify(event));
      this.persist(projected,queue);this.queue=queue;this.update({view:projected,pending:queue.length,error:null});void this.drain();}
    catch(e){this.update({error:e instanceof Error?e.message:'操作尚未保存'});}
  }
  async retry(){if(this.state.conflict&&this.state.view){this.update({loading:true});try{
    let live=await this.client.get(this.state.view.id);const events=this.storedEvents(live.id,this.queue);
    const rejected:SentenceEvent[]=[];
    // First reconcile every exact receipt. Another tab's pending operation is not itself a conflict.
    for(const event of events){
      try{live=await this.client.event(live.id,event);this.storage?.removeItem(this.eventKey(live.id,event));this.queue=this.queue.filter(e=>e.clientEventId!==event.clientEventId);}
      catch(error){
        if(!(error instanceof SentenceStudyError)||!['version_conflict','progress_conflict','material_changed','event_conflict'].includes(error.code))throw error;
        rejected.push(event);
      }
    }
    if(rejected.length){
      this.storage?.setItem(`sentence_conflict:${live.id}:${Date.now()}`,JSON.stringify({view:this.state.view,queue:rejected}));
      live=await this.client.get(live.id);
      live=await this.client.event(live.id,{type:'resume',version:live.version,clientEventId:crypto.randomUUID()});
      for(const event of rejected)this.storage?.removeItem(this.eventKey(live.id,event));
    }
    this.persist(live,[]);this.queue=[];this.update({view:{...live,notice:rejected.length?'已恢复服务端位置；被拒绝的冲突操作保留在本机，没有套用到其他句子。':'待保存的操作已确认，已恢复真实学习位置。'},pending:0,conflict:false,error:null});
  }catch(e){this.update({error:e instanceof Error?e.message:'恢复失败'});}finally{this.update({loading:false});}return;}
    if(this.state.view)this.queue=this.storedEvents(this.state.view.id,this.queue);
    this.update({error:null,pending:this.queue.length});await this.drain();}
  private async drain(){if(this.running||this.state.conflict||!this.state.view)return;const generation=this.generation;this.running=true;this.update({saving:true});
    try{while(this.queue.length){const event=this.queue[0],id=this.state.view!.id;let response:SentenceSession;
      try{response=await this.client.event(id,event);if(generation!==this.generation)return;}catch(e){if(generation!==this.generation)return;this.update({error:e instanceof Error?e.message:'正在等待连接，操作已保存在本机',conflict:e instanceof SentenceStudyError&&['version_conflict','progress_conflict','material_changed','event_conflict'].includes(e.code)});break;}
      const remaining=this.queue.slice(1),view=remaining.length?this.state.view!:response;
      // If local cleanup fails, retain the acknowledged event and retry its exact id.
      try{this.persist(view,remaining);this.storage?.removeItem(this.eventKey(id,event));}catch{this.update({error:'服务端已保存，但本机回执未更新；可以重试确认。'});break;}
      this.queue=remaining;this.update({view,pending:remaining.length,error:null});
    }}finally{if(generation===this.generation){this.running=false;this.update({saving:false});}}}
  dispose(){this.disposed=true;this.listeners.clear();}
}

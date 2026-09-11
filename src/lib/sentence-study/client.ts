import {SentenceStudyError,projectSentenceEvent,emptySentencePractice,sentenceWordCount,type SentencePractice,type SentenceScope,type SentenceOverview,type SentenceSession,type SentenceCreate,type SentenceEvent,type SentenceRating} from './contracts';
export function sentenceScopeQuery(scope:SentenceScope){const p=new URLSearchParams({scope:scope.type});if('id'in scope)p.set('id',scope.id);if(scope.type==='collection')for(const k of ['questionId','topicId','seasonId'] as const)if(scope[k])p.set(k,scope[k]);return p.toString();}
export interface SentenceClient {overview(scope:SentenceScope):Promise<SentenceOverview>;create(input:SentenceCreate):Promise<SentenceSession>;get(id:string):Promise<SentenceSession>;event(id:string,event:SentenceEvent):Promise<SentenceSession>}
type ErrorContext='read'|'request'|'local'|'queued';
/** Never expose browser/transport diagnostics as the learning instruction. */
export function sentenceErrorMessage(error:unknown,context:ErrorContext='request'){
  const name=error instanceof Error?error.name:'',message=error instanceof Error?error.message:'',code=error instanceof SentenceStudyError?error.code:'';
  const saved=context==='queued'?'操作已保存在本机，请恢复连接后重试。':context==='local'?'本次输入尚未保存，请先复制保留，再重试。':context==='read'?'尚未读取最新位置，请重试；已有记录不会被清空。':'尚未确认保存结果，请重试确认，不必重复新建。';
  if(/QuotaExceeded|NS_ERROR_DOM_QUOTA_REACHED/i.test(name)||/quota|storage.?full|exceeded.*storage/i.test(message))return '浏览器存储空间不足。本次操作尚未保存，请先复制保留输入，再腾出空间后重试。';
  if(/AbortError|TimeoutError/i.test(name)||['request_aborted','request_timeout'].includes(code))return `连接请求已中断。${saved}`;
  if(/Failed to fetch|NetworkError|Network request failed|Load failed|offline|fetch failed/i.test(message)||name==='NetworkError'||code==='network_error')return `暂时连接不上学习服务。${saved}`;
  if(code==='invalid_response'||error instanceof SyntaxError)return `学习服务返回了无法读取的结果。${saved}`;
  if(error instanceof SentenceStudyError){
    if(/[\u3400-\u9fff]/u.test(message))return message;
    if(['version_conflict','progress_conflict','event_conflict','stage_changed','rating_changed'].includes(code))return '学习位置已变化，请恢复最新位置；未确认操作仍保留在本机。';
    if(error.status===401||error.status===403)return `学习服务暂未允许此操作，请检查服务设置。${saved}`;
    if(error.status===429)return `请求暂时过多，请稍后重试。${saved}`;
  }
  if(context==='local'&&/[\u3400-\u9fff]/u.test(message))return message;
  return `暂时无法完成这一步。${saved}`;
}
async function request<T>(url:string,body?:unknown):Promise<T>{
  let response:Response;
  try{response=await fetch(url,body===undefined?{cache:'no-store'}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});}
  catch(error){const code=error instanceof Error&&error.name==='AbortError'?'request_aborted':error instanceof Error&&error.name==='TimeoutError'?'request_timeout':'network_error';throw new SentenceStudyError(sentenceErrorMessage(error,body===undefined?'read':'request'),0,code);}
  let data:Record<string,unknown>;
  try{data=await response.json();}catch{throw new SentenceStudyError('学习服务返回了无法读取的结果，请重试确认；已有记录不会清空。',response.status||502,'invalid_response');}
  if(!data||typeof data!=='object'||Array.isArray(data))throw new SentenceStudyError('学习服务返回了无法读取的结果，请重试确认；已有记录不会清空。',response.status||502,'invalid_response');
  if(!response.ok){const error=new SentenceStudyError(typeof data.error==='string'?data.error:'',response.status,typeof data.code==='string'?data.code:'request_failed');throw new SentenceStudyError(sentenceErrorMessage(error,body===undefined?'read':'request'),error.status,error.code);}
  return data as T;
}
export const sentenceClient:SentenceClient={overview:async scope=>(await request<{overview:SentenceOverview}>(`/api/sentence-study/overview?${sentenceScopeQuery(scope)}`)).overview,create:async input=>(await request<{session:SentenceSession}>('/api/sentence-study/sessions',input)).session,get:async id=>(await request<{session:SentenceSession}>(`/api/sentence-study/sessions/${encodeURIComponent(id)}`)).session,event:async(id,event)=>(await request<{session:SentenceSession}>(`/api/sentence-study/sessions/${encodeURIComponent(id)}/events`,event)).session};
export interface SentenceClientState {view:SentenceSession|null;pending:number;saving:boolean;error:string|null;loading:boolean;conflict:boolean}
interface Saved {view:SentenceSession;queue:SentenceEvent[]}
type LocalStore=Pick<Storage,'getItem'|'setItem'|'removeItem'>&Partial<Pick<Storage,'key'|'length'>>;
export type PracticePatch=Partial<Pick<SentencePractice,'revealCount'|'draft'|'retryDraft'>>;
export type SentenceAction={type:'reveal'|'pause'|'resume'|'upgrade_experience'|'enter_teaching'|'start_retry'|'reveal_retry'|'advance'}|{type:'rate';rating:SentenceRating}|{type:'revise_rating';rating:SentenceRating;targetEventId:string}|{type:'checkpoint';revealCount:number;maxRevealCount:number;draft:string;retryDraft:string};
interface PracticeDraft {sessionId:string;sentenceId:string;unitVersion:string;version:number;stage:string;practice:SentencePractice;clientEventId:string;owner:string}
export interface SentenceBrowserContext {sessionStorage:Pick<Storage,'getItem'|'setItem'>;locks?:Pick<LockManager,'request'>}
const writerKey='roastduck_sentence_tab';
function browserContext():SentenceBrowserContext|null{if(typeof window==='undefined')return null;try{return {sessionStorage:window.sessionStorage,locks:window.navigator.locks};}catch{return {sessionStorage:{getItem:()=>null,setItem:()=>{throw new Error('浏览器无法保留窗口身份，请允许本机存储后重试。');}}};}}
function localStorageOrNull():LocalStore|null{try{return typeof window==='undefined'?null:window.localStorage;}catch{return null;}}
function reserveWriter(locks:Pick<LockManager,'request'>,id:string):Promise<(()=>void)|null>{return new Promise((resolve,reject)=>{
  void locks.request(`roastduck:sentence-writer:${id}`,{mode:'exclusive',ifAvailable:true},lock=>{
    if(!lock){resolve(null);return;}
    return new Promise<void>(release=>resolve(release));
  }).catch(reject);
});}

/** Durable ordered outbox. A local transition is shown only after its recovery record is persisted. */
export class SentenceController {
  private state:SentenceClientState={view:null,pending:0,saving:false,error:null,loading:false,conflict:false};
  private queue:SentenceEvent[]=[];private listeners=new Set<()=>void>();private running=false;private disposed=false;private generation=0;
  private draft:PracticeDraft|null=null;private draftTimer:ReturnType<typeof setTimeout>|null=null;private guided:boolean;private writerId:string;
  private practiceFlush:Promise<void>|null=null;private writerReady:Promise<void>|null=null;private releaseWriter:(()=>void)|null=null;private browser:SentenceBrowserContext|null;
  constructor(private client:SentenceClient=sentenceClient,private storage:LocalStore|null=localStorageOrNull(),options:{guided?:boolean;writerId?:string;browser?:SentenceBrowserContext}={}){this.guided=options.guided??client===sentenceClient;this.writerId=options.writerId??crypto.randomUUID();this.browser=options.writerId?null:options.browser??browserContext();}
  private async ensureWriter(){if(!this.browser)return;if(this.writerReady)return this.writerReady;const browser=this.browser;
    this.writerReady=(async()=>{
      if(!browser.locks?.request)throw new SentenceStudyError('此浏览器暂不支持多窗口草稿保护。请用新版 Chrome 或 Edge 打开；原草稿保留，不会覆盖。',503,'writer_lock_unavailable');
      let id=browser.sessionStorage.getItem(writerKey)??this.writerId,release=await reserveWriter(browser.locks,id);
      // A refreshed document normally reclaims its released lease; opener/duplicate tabs cannot.
      if(!release){await new Promise(resolve=>setTimeout(resolve,30));release=await reserveWriter(browser.locks,id);}
      if(!release){id=crypto.randomUUID();release=await reserveWriter(browser.locks,id);}
      if(!release)throw new SentenceStudyError('暂时无法取得本窗口的草稿保存权限，请重试。',409,'writer_lock_unavailable');
      if(this.disposed){release();return;}
      try{browser.sessionStorage.setItem(writerKey,id);}catch(error){release();throw error;}
      this.writerId=id;this.releaseWriter=release;
    })().catch(error=>{this.writerReady=null;throw error;});return this.writerReady;
  }
  getSnapshot=()=>this.state;
  subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
  private update(patch:Partial<SentenceClientState>){this.state={...this.state,...patch};if(!this.disposed)for(const listener of this.listeners)listener();}
  private persist(view:SentenceSession,queue:SentenceEvent[]){if(!this.storage)throw new Error('浏览器无法保留操作，请先允许本机存储');this.storage.setItem(`sentence_session:${view.id}`,JSON.stringify({view,queue}));}
  private eventKey(id:string,event:SentenceEvent){return `sentence_event:${id}:${event.clientEventId}`;}
  private draftKey(draft:PracticeDraft){return `sentence_practice:${draft.sessionId}:${draft.owner}`;}
  private storedDrafts(id:string){const result:PracticeDraft[]=[];
    if(this.storage?.key&&this.storage.length!==undefined)for(let i=0;i<this.storage.length;i++){const key=this.storage.key(i);if(key?.startsWith(`sentence_practice:${id}:`)){const raw=this.storage.getItem(key);if(raw)result.push(JSON.parse(raw) as PracticeDraft);}}
    return result;
  }
  private restoreDraft(){const view=this.state.view;if(!view)return;const drafts=this.storedDrafts(view.id);
    if(!drafts.length)return;
    if(drafts.length!==1||drafts[0].owner!==this.writerId){this.update({conflict:true,error:'另一个窗口有尚未同步的表达草稿。请先恢复位置；草稿仍保留在本机。'});return;}
    const draft=drafts[0],card=view.cards[view.index];
    if(this.queue.some(e=>e.clientEventId===draft.clientEventId)){try{this.storage?.removeItem(this.draftKey(draft));}catch{}return;}
    if(card?.id!==draft.sentenceId||card.version!==draft.unitVersion||view.version!==draft.version||view.stage!==draft.stage){
      if(card?.id===draft.sentenceId&&JSON.stringify(view.practice)===JSON.stringify(draft.practice)){try{this.storage?.removeItem(this.draftKey(draft));}catch{}return;}
      this.update({conflict:true,error:'草稿对应的位置已经变化，请恢复；原草稿不会套到下一句。'});return;
    }
    this.draft=draft;this.update({view:{...view,practice:draft.practice}});
  }
  updatePractice(patch:PracticePatch){const view=this.state.view,card=view?.cards[view.index];if(this.disposed||!view||!card||view.status!=='active'||!view.experienceVersion||this.state.conflict||this.state.error||!['recall','retry'].includes(view.stage??''))return;
    let attempted:PracticeDraft|null=null;
    try{
      const practice={...(view.practice??emptySentencePractice())};
      if(view.stage==='recall'){
        if(patch.revealCount!==undefined){practice.revealCount=Math.max(0,Math.min(sentenceWordCount(card.english),Math.floor(patch.revealCount)));practice.maxRevealCount=Math.max(practice.maxRevealCount,practice.revealCount);}
        if(patch.draft!==undefined)practice.draft=patch.draft;
      }else if(patch.retryDraft!==undefined)practice.retryDraft=patch.retryDraft;
      if(practice.draft.length>12000||practice.retryDraft.length>12000)throw new Error('草稿太长，请先保留输入并缩短本句尝试。');
      const draft:PracticeDraft={sessionId:view.id,sentenceId:card.id,unitVersion:card.version,version:view.version,stage:view.stage!,practice,clientEventId:this.draft?.clientEventId??crypto.randomUUID(),owner:this.writerId};attempted=draft;
      if(this.storedDrafts(view.id).some(d=>d.owner!==this.writerId))throw new SentenceStudyError('另一个窗口有待保存草稿，请先恢复。',409,'version_conflict');
      if(!this.storage)throw new Error('浏览器无法保存草稿');this.storage.setItem(this.draftKey(draft),JSON.stringify(draft));this.draft=draft;this.update({view:{...view,practice}});
      if(this.draftTimer)clearTimeout(this.draftTimer);this.draftTimer=setTimeout(()=>{void this.flushPractice();},500);
    }catch(e){const conflict=e instanceof SentenceStudyError&&e.status===409;let error=sentenceErrorMessage(e,'local');
      if(attempted){
        if(conflict){try{if(!this.storage)throw new Error('浏览器无法保留本次输入，请先复制。');this.storage.setItem(`sentence_conflict_draft:${view.id}:${attempted.clientEventId}`,JSON.stringify(attempted));error='另一个窗口有待保存草稿。本次输入已单独保留，请先恢复位置。';}catch(storageError){error=sentenceErrorMessage(storageError,'local');}}
        else this.draft=attempted;
        this.update({view:{...view,practice:attempted.practice}});
      }
      this.update({error,conflict});
    }
  }
  flushPractice():Promise<void>{if(this.practiceFlush)return this.practiceFlush;this.practiceFlush=this.commitPractice().finally(()=>{this.practiceFlush=null;});return this.practiceFlush;}
  private async commitPractice(){if(this.draftTimer)clearTimeout(this.draftTimer);this.draftTimer=null;
    const draft=this.draft,view=this.state.view;if(!draft||!view||this.state.conflict)return;
    if(view.id!==draft.sessionId||view.cards[view.index]?.id!==draft.sentenceId||view.version!==draft.version){this.update({conflict:true,error:'草稿位置已经变化，请先恢复。'});return;}
    const action:SentenceAction={type:'checkpoint',revealCount:draft.practice.revealCount,maxRevealCount:draft.practice.maxRevealCount,draft:draft.practice.draft,retryDraft:draft.practice.retryDraft};
    const accepted=await this.apply(action,draft.clientEventId);
    if(accepted){this.draft=null;try{this.storage?.removeItem(this.draftKey(draft));}catch{this.update({error:'草稿已提交到本机队列，但旧回执未清理；请重试确认。'});}}
  }
  private async upgradeIfNeeded(){if(this.guided&&this.state.view&&!this.state.view.experienceVersion&&!this.state.pending&&!this.state.error&&!this.state.conflict)await this.apply({type:'upgrade_experience'});}
  private storedEvents(id:string,fallback:SentenceEvent[]=[]){const events=new Map(fallback.map(e=>[e.clientEventId,e]));
    if(this.storage?.key&&this.storage.length!==undefined)for(let i=0;i<this.storage.length;i++){const key=this.storage.key(i);if(key?.startsWith(`sentence_event:${id}:`)){const raw=this.storage.getItem(key);if(raw){const e=JSON.parse(raw) as SentenceEvent;events.set(e.clientEventId,e);}}}
    return [...events.values()].sort((a,b)=>a.version-b.version||a.clientEventId.localeCompare(b.clientEventId));
  }
  async load(id:string){const generation=++this.generation;this.running=false;this.draft=null;if(this.draftTimer)clearTimeout(this.draftTimer);this.update({loading:true,error:null,conflict:false});try{
    await this.ensureWriter();if(this.disposed||generation!==this.generation)return;
    const raw=this.storage?.getItem(`sentence_session:${id}`);const saved=raw?JSON.parse(raw) as Saved:null;
    const events=this.storedEvents(id,saved?.view.id===id?saved.queue:[]);
    if(saved?.view.id===id&&events.length){this.queue=events;const conflict=new Set(events.map(e=>e.version)).size!==events.length;this.update({view:saved.view,pending:this.queue.length,conflict,error:conflict?'多个窗口留下了不同操作，请恢复服务端位置；各操作仍保存在本机。':null});if(!conflict)await this.drain();}
    else {const view=await this.client.get(id);if(generation!==this.generation)return;this.queue=events;this.persist(view,events);this.update({view,pending:events.length});if(events.length)await this.drain();}
    if(!this.state.error&&!this.state.conflict){await this.upgradeIfNeeded();this.restoreDraft();}
  }catch(e){this.update({error:sentenceErrorMessage(e,'read')});}finally{this.update({loading:false});}}
  async start(input:SentenceCreate){const generation=++this.generation;this.running=false;this.update({loading:true,error:null,conflict:false});try{await this.ensureWriter();if(this.disposed||generation!==this.generation)return;const key=`sentence_start:${sentenceScopeQuery(input.scope)}:${input.mode}:${input.selection??'scope'}:${input.resumeSessionId??''}`;const raw=this.storage?.getItem(key);let actual=input;
    if(raw){const saved=JSON.parse(raw) as SentenceCreate;if(saved.scope&&saved.clientRequestId)actual=saved;}
    if(this.guided&&!raw)actual={...actual,experienceVersion:'guided-reveal-v1'};
    this.storage?.setItem(key,JSON.stringify(actual));const view=await this.client.create(actual);if(generation!==this.generation)return;
    try{this.storage?.removeItem(key);}catch{/* confirmed on server */}
    if(this.storage?.getItem(`sentence_session:${view.id}`)||this.storedEvents(view.id).length||this.storedDrafts(view.id).length){
      await this.load(view.id);
      const recovered=this.state.view;
      if(recovered?.status==='paused'&&!this.state.error&&!this.state.conflict&&!this.state.pending)await this.apply({type:'resume'});
      return;
    }
    this.queue=[];this.persist(view,[]);this.update({view,pending:0,conflict:false});
    if(view.status==='paused')await this.apply({type:'resume'});
    await this.upgradeIfNeeded();
  }catch(e){this.update({error:sentenceErrorMessage(e,'request')});}finally{this.update({loading:false});}}
  async apply(action:SentenceAction,receiptId?:string):Promise<boolean>{if(this.disposed||!this.state.view||this.state.conflict)return false;
    if(action.type!=='checkpoint'&&this.draft){await this.flushPractice();if(this.draft||this.state.conflict||this.state.error)return false;}
    const view=this.state.view,card=view.cards[view.index];
    const unitAction=!['pause','resume','revise_rating','upgrade_experience'].includes(action.type);
    const event={...action,version:view.version,clientEventId:receiptId??crypto.randomUUID(),...(view.experienceVersion?{experienceVersion:view.experienceVersion}:{}),...(unitAction?{sentenceId:card?.id,unitVersion:card?.version}:{})} as SentenceEvent;
    try{
      const other=this.storedEvents(view.id).filter(e=>!this.queue.some(q=>q.clientEventId===e.clientEventId));
      if(other.length){this.update({conflict:true,error:'另一个窗口还有待保存操作，请先恢复最新位置。'});return false;}
      const projected=projectSentenceEvent(view,event),queue=[...this.queue,event];
      if(!this.storage)throw new Error('浏览器无法保留操作');
      // Unique immutable keys stop another tab's cache write from destroying this event.
      this.storage.setItem(this.eventKey(view.id,event),JSON.stringify(event));
      this.persist(projected,queue);this.queue=queue;this.update({view:projected,pending:queue.length,error:null});void this.drain();return true;}
    catch(e){this.update({error:sentenceErrorMessage(e,'local')});return false;}
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
    const drafts=this.storedDrafts(live.id);let preservedDraft=false;
    for(const draft of drafts){
      const event:SentenceEvent={type:'checkpoint',version:draft.version,clientEventId:draft.clientEventId,sentenceId:draft.sentenceId,unitVersion:draft.unitVersion,revealCount:draft.practice.revealCount,maxRevealCount:draft.practice.maxRevealCount,draft:draft.practice.draft,retryDraft:draft.practice.retryDraft};
      try{live=await this.client.event(live.id,event);}
      catch(error){if(!(error instanceof SentenceStudyError)||!['version_conflict','material_changed','stage_changed','experience_required'].includes(error.code))throw error;
        this.storage?.setItem(`sentence_conflict_draft:${live.id}:${draft.clientEventId}`,JSON.stringify(draft));preservedDraft=true;live=await this.client.get(live.id);
      }
      this.storage?.removeItem(this.draftKey(draft));
    }
    this.draft=null;
    this.persist(live,[]);this.queue=[];this.update({view:{...live,notice:rejected.length||preservedDraft?'已恢复服务端位置；被拒绝的冲突操作和原草稿保留在本机，没有套用到其他句子。':'待保存的操作已确认，已恢复真实学习位置。'},pending:0,conflict:false,error:null});
  }catch(e){this.update({error:sentenceErrorMessage(e,this.queue.length?'queued':'request')});}finally{this.update({loading:false});}return;}
    if(this.state.view)this.queue=this.storedEvents(this.state.view.id,this.queue);
    this.update({error:null,pending:this.queue.length});await this.drain();if(!this.state.error){await this.flushPractice();await this.upgradeIfNeeded();}}
  private async drain(){if(this.running||this.state.conflict||!this.state.view)return;const generation=this.generation;this.running=true;this.update({saving:true});
    try{while(this.queue.length){const event=this.queue[0],id=this.state.view!.id;let response:SentenceSession;
      try{response=await this.client.event(id,event);if(generation!==this.generation)return;}catch(e){if(generation!==this.generation)return;this.update({error:sentenceErrorMessage(e,'queued'),conflict:e instanceof SentenceStudyError&&['version_conflict','progress_conflict','material_changed','event_conflict'].includes(e.code)});break;}
      const remaining=this.queue.slice(1);let view=remaining.length?this.state.view!:response;
      if(this.draft?.version===view.version&&this.draft.sentenceId===view.cards[view.index]?.id&&this.draft.stage===view.stage)view={...view,practice:this.draft.practice};
      // If local cleanup fails, retain the acknowledged event and retry its exact id.
      try{this.persist(view,remaining);this.storage?.removeItem(this.eventKey(id,event));}catch{this.update({error:'服务端已保存，但本机回执未更新；可以重试确认。'});break;}
      this.queue=remaining;this.update({view,pending:remaining.length,error:null});
    }}finally{if(generation===this.generation){this.running=false;this.update({saving:false});}}}
  dispose(){this.disposed=true;this.generation++;if(this.draftTimer)clearTimeout(this.draftTimer);this.releaseWriter?.();this.releaseWriter=null;this.listeners.clear();}
}

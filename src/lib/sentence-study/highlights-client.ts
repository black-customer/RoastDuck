import {highlightAddSchema,highlightContextSchema,type HighlightAdd,type HighlightContext,type HighlightList,type HighlightMark} from './highlights';

export interface HighlightApi {list(context:HighlightContext):Promise<HighlightList>;add(input:HighlightAdd):Promise<HighlightList>;remove(id:string,context:HighlightContext):Promise<HighlightList>}
export class HighlightHttpError extends Error {constructor(message:string,readonly code:string){super(message);}}
async function request(url:string,init?:RequestInit):Promise<HighlightList>{
  const response=await fetch(url,init);const body=await response.json();
  if(!response.ok)throw new HighlightHttpError(body.error??'高亮尚未保存，请重试',body.code??'unavailable');
  if(!Array.isArray(body.highlights)||typeof body.unmappedCount!=='number')throw new HighlightHttpError('高亮响应不完整，请重试','invalid_response');
  return body;
}
export const highlightApi:HighlightApi={
  list:context=>request(`/api/sentence-study/highlights?${new URLSearchParams({sentenceId:context.sentenceId,textVersion:context.textVersion})}`),
  add:input=>request('/api/sentence-study/highlights',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)}),
  remove:(id,context)=>request(`/api/sentence-study/highlights/${encodeURIComponent(id)}`,{method:'DELETE',headers:{'content-type':'application/json'},body:JSON.stringify(context)}),
};
export const HIGHLIGHT_OUTBOX_PREFIX='roastduck_sentence_highlight_op:';
type Operation={id:string;createdAt:number;context:HighlightContext}&({kind:'add';input:HighlightAdd}|{kind:'remove';markId:string});
export interface HighlightClientState {highlights:HighlightMark[];pendingCount:number;syncing:boolean;error:string;notice:string}
type CacheEntry={data:HighlightList;listeners:Set<()=>void>;pending?:Promise<HighlightList>;mutations:Promise<unknown>;pendingWrites:number};
const entries=new Map<string,CacheEntry>();
const cacheKey=(context:HighlightContext)=>`${context.sentenceId}:${context.textVersion}`;
function cacheEntry(context:HighlightContext,initial?:HighlightMark[]){
  const key=cacheKey(context);if(!entries.has(key))entries.set(key,{data:{highlights:initial??[],unmappedCount:0},listeners:new Set(),mutations:Promise.resolve(),pendingWrites:0});
  return entries.get(key)!;
}
/** A later visit has a fresh server bundle. Do not let an inactive cache erase
 * marks changed in another window while this sentence was off screen. */
function releaseInactive(context:HighlightContext,entry:CacheEntry){
  const key=cacheKey(context);
  if(!entry.listeners.size&&!entry.pending&&!entry.pendingWrites&&entries.get(key)===entry)entries.delete(key);
}
const announce=(entry:CacheEntry)=>entry.listeners.forEach(listener=>listener());
async function readShared(context:HighlightContext,api:HighlightApi,entry:CacheEntry){
  if(!entry.pending){const priorWrites=entry.mutations;entry.pending=priorWrites.catch(()=>{}).then(()=>api.list(context));try{const data=await entry.pending;entry.data=data;announce(entry);return data;}finally{entry.pending=undefined;releaseInactive(context,entry);}}
  return entry.pending;
}
/** One durable record per operation: another tab cannot overwrite an outstanding selection. */
export class HighlightController {
  private entry:CacheEntry;
  private error='';private notice='';private syncing=false;private disposed=false;private running:Promise<void>|null=null;
  private confirmed=new Set<string>();
  private observer:()=>void;
  constructor(private context:HighlightContext,private storage:Pick<Storage,'length'|'key'|'getItem'|'setItem'|'removeItem'>,private update:(state:HighlightClientState)=>void,private api:HighlightApi=highlightApi,initial?:HighlightMark[]){
    this.entry=cacheEntry(context,initial);this.observer=()=>this.emit();this.entry.listeners.add(this.observer);
  }
  private operations(){
    const result:Operation[]=[];
    for(let i=0;i<this.storage.length;i++){
      const key=this.storage.key(i);if(!key?.startsWith(HIGHLIGHT_OUTBOX_PREFIX))continue;
      try {const value=JSON.parse(this.storage.getItem(key)??'null') as Operation;if(!value||value.id!==key.slice(HIGHLIGHT_OUTBOX_PREFIX.length)||typeof value.createdAt!=='number')continue;
        const context=highlightContextSchema.safeParse(value.context);if(!context.success||context.data.sentenceId!==this.context.sentenceId||context.data.language!==this.context.language)continue;
        if(context.data.textVersion!==this.context.textVersion){this.notice='旧版本的待保存高亮没有应用到当前文本；原操作仍保留。';continue;}
        if(value.kind==='add'){const input=highlightAddSchema.safeParse(value.input);if(!input.success||input.data.clientRequestId!==value.id||JSON.stringify(highlightContextSchema.parse(input.data))!==JSON.stringify(context.data))continue;}
        else if(value.kind!=='remove'||typeof value.markId!=='string')continue;
        if(!this.confirmed.has(value.id))result.push(value);
      }catch{/* Unrelated/corrupt local records are not erased or submitted. */}
    }
    return result.sort((a,b)=>a.createdAt-b.createdAt||a.id.localeCompare(b.id));
  }
  private emit(){
    if(this.disposed)return;
    let pending:Operation[]=[];
    try{pending=this.operations();}catch{this.error='浏览器无法读取高亮暂存，暂时不能新增标记。';}
    let highlights=this.entry.data.highlights.filter(mark=>mark.language===this.context.language);
    for(const operation of pending){
      if(operation.kind==='remove')highlights=highlights.filter(mark=>mark.id!==operation.markId);
      else highlights=[...highlights,{...operation.context,id:`pending:${operation.id}`,sourceVersion:operation.context.textVersion,start:operation.input.start,end:operation.input.end,quote:operation.input.quote,pending:true}];
    }
    this.update({highlights,pendingCount:pending.length,syncing:this.syncing,error:this.error,notice:this.notice||(this.entry.data.unmappedCount?'有旧版高亮无法准确对应，已保留在旧版本中。':'')});
  }
  async load(preloaded=false){
    this.emit();
    try{if(!preloaded)await readShared(this.context,this.api,this.entry);this.error='';await this.drain();}
    catch(error){this.error=error instanceof Error?error.message:'暂时无法读取高亮，请重试';}
    this.emit();
  }
  private queue(operation:Operation){
    if(this.error)throw new Error('先重试上一次高亮保存，再继续标记。');
    try{this.storage.setItem(HIGHLIGHT_OUTBOX_PREFIX+operation.id,JSON.stringify(operation));}
    catch{this.error='高亮尚未保存：浏览器无法暂存选区。请允许本机存储后重试。';this.emit();return false;}
    this.emit();void this.drain();return true;
  }
  add(input:Omit<HighlightAdd,keyof HighlightContext|'clientRequestId'>,id=crypto.randomUUID()){
    return this.queue({id,context:this.context,createdAt:Date.now(),kind:'add',input:{...this.context,...input,clientRequestId:id}});
  }
  remove(markId:string,id=crypto.randomUUID()){
    if(markId.startsWith('pending:'))return false;
    return this.queue({id,context:this.context,createdAt:Date.now(),kind:'remove',markId});
  }
  private async drain(){
    if(this.running)return this.running;
    this.running=Promise.resolve().then(async()=>{
      this.syncing=true;this.emit();
      try{
        for(const id of this.confirmed){try{this.storage.removeItem(HIGHLIGHT_OUTBOX_PREFIX+id);this.confirmed.delete(id);}catch{this.notice='高亮已保存，但浏览器暂存清理失败；重试不会重复新增。';}}
        while(!this.disposed){
          const operation=this.operations()[0];if(!operation)break;
          // Serialize sibling Chinese/English writes and their reads so an old response
          // cannot overwrite a newly saved mark in this tab's shared projection.
          const priorRead=this.entry.pending;
          this.entry.pendingWrites++;
          const work=this.entry.mutations.catch(()=>{}).then(async()=>{
            if(priorRead)await priorRead.catch(()=>{});
            return operation.kind==='add'?this.api.add(operation.input):this.api.remove(operation.markId,operation.context);
          });
          this.entry.mutations=work;
          let data:HighlightList;
          try{data=await work;}finally{this.entry.pendingWrites--;releaseInactive(this.context,this.entry);}
          this.entry.data=data;this.confirmed.add(operation.id);
          try{this.storage.removeItem(HIGHLIGHT_OUTBOX_PREFIX+operation.id);this.confirmed.delete(operation.id);}
          catch{this.notice='高亮已保存，但浏览器暂存清理失败；重试不会重复新增。';}
          this.error='';announce(this.entry);
        }
      }catch(error){this.error=error instanceof Error?error.message:'高亮尚未保存，选区已暂存，请重试';}
      finally{this.syncing=false;this.running=null;this.emit();}
    });return this.running;
  }
  async retry(){this.error='';this.notice='';await this.load(false);}
  dispose(){this.disposed=true;this.entry.listeners.delete(this.observer);releaseInactive(this.context,this.entry);}
}

import { lightEventSchema,type LightEvent } from "./contracts";
export type PendingOperation={id:string;event:LightEvent};
type Store=Pick<Storage,"getItem"|"setItem"|"removeItem"|"key"|"length">;
const prefix=(id:string)=>`roastduck_light_pending:${id}:`;
const key=(op:PendingOperation)=>prefix(op.id)+op.event.clientEventId;
/** 每个未决事件独立键；旧窗口完成只能清除自己的事件。这里不保存材料正文。 */
export function savePending(op:PendingOperation,storage:Store=localStorage) {
  try{storage.setItem(key(op),JSON.stringify(op));return true;}catch{return false;}
}
export function clearPending(op:PendingOperation,storage:Store=localStorage) {
  try{storage.removeItem(key(op));}catch{/* 内存中的当前状态仍可继续。 */}
}
export function restorePending(id:string,storage:Store=localStorage):PendingOperation|null {
  try{
    const candidates:PendingOperation[]=[];
    for(let index=0;index<storage.length;index++){
      const entry=storage.key(index);if(!entry?.startsWith(prefix(id)))continue;
      try{
        const raw=JSON.parse(storage.getItem(entry)??"null"),event=lightEventSchema.safeParse(raw?.event);
        if(raw?.id===id&&event.success&&entry===key({id,event:event.data}))candidates.push({id,event:event.data});
      }catch{/* 损坏的浏览器记录不执行。 */}
    }
    return candidates.sort((a,b)=>b.event.version-a.event.version||a.event.clientEventId.localeCompare(b.event.clientEventId))[0]??null;
  }catch{return null;}
}

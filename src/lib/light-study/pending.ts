import { lightEventSchema,type LightEvent } from "./contracts";
export type PendingOperation={id:string;event:LightEvent};
type Store=Pick<Storage,"getItem"|"setItem"|"removeItem"|"key"|"length">;
const prefix=(id:string)=>`roastduck_light_pending:${id}:`;
const key=(op:PendingOperation)=>prefix(op.id)+op.event.clientEventId;
const acknowledged=new Map<string,string>();
const signature=(op:PendingOperation)=>JSON.stringify({id:op.id,event:lightEventSchema.parse(op.event)});
/** 每个未决事件独立键；旧窗口完成只能清除自己的事件。这里不保存材料正文。 */
export function savePending(op:PendingOperation,storage:Store=localStorage) {
  try{storage.setItem(key(op),JSON.stringify(op));return true;}catch{return false;}
}
export function clearPending(op:PendingOperation,storage:Store=localStorage) {
  // A browser cleanup failure is not a server-save failure. Retry receipts stay safe on reload.
  acknowledged.set(key(op),signature(op));
  if(acknowledged.size>2048)acknowledged.delete(acknowledged.keys().next().value!);
  try{storage.removeItem(key(op));return true;}catch{return false;}
}
export function listPending(id:string,storage:Store=localStorage):PendingOperation[] {
  try{
    const candidates:PendingOperation[]=[];
    for(let index=0;index<storage.length;index++){
      const entry=storage.key(index);if(!entry?.startsWith(prefix(id)))continue;
      try{
        const raw=JSON.parse(storage.getItem(entry)??"null"),event=lightEventSchema.safeParse(raw?.event);
        const operation=event.success?{id,event:event.data}:null;
        if(raw?.id===id&&operation&&entry===key(operation)&&acknowledged.get(entry)!==signature(operation))candidates.push(operation);
      }catch{/* 损坏的浏览器记录不执行。 */}
    }
    return candidates.sort((a,b)=>a.event.version-b.event.version||a.event.clientEventId.localeCompare(b.event.clientEventId));
  }catch{return [];}
}
export function restorePending(id:string,storage:Store=localStorage):PendingOperation|null {return listPending(id,storage)[0]??null;}

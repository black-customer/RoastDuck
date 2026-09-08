import {expect,it} from "vitest";
import {savePending,clearPending,restorePending,type PendingOperation} from "@/lib/light-study/pending";
function store(){
  const items=new Map<string,string>();
  return {getItem:(key:string)=>items.get(key)??null,setItem:(key:string,value:string)=>{items.set(key,value);},removeItem:(key:string)=>{items.delete(key);},key:(index:number)=>[...items.keys()][index]??null,get length(){return items.size;}};
}
it("旧窗口迟到确认只移除旧事件，不删除另一窗口的新自评",()=>{
  const storage=store();
  const old:PendingOperation={id:"session",event:{type:"reveal",clientEventId:"old",version:0}};
  const newer:PendingOperation={id:"session",event:{type:"rate",rating:"forgot",clientEventId:"new",version:1}};
  savePending(old,storage);savePending(newer,storage);clearPending(old,storage);
  expect(restorePending("session",storage)).toEqual(newer);
  clearPending(newer,storage);expect(restorePending("session",storage)).toBeNull();
});
it("隔离不同会话并忽略损坏/非法的重试记录",()=>{
  const storage=store();
  savePending({id:"other",event:{type:"pause",clientEventId:"id",version:4}},storage);
  storage.setItem("roastduck_light_pending:session:invalid","{");
  storage.setItem("roastduck_light_pending:session:bad",JSON.stringify({id:"session",event:{type:"grade_mastered"}}));
  expect(restorePending("session",storage)).toBeNull();expect(restorePending("other",storage)?.event.type).toBe("pause");
});
it("浏览器存储不可用时明确返回未保存，不冒充持久化",()=>{
  const storage={...store(),setItem:()=>{throw new Error("quota");}};
  expect(savePending({id:"s",event:{type:"pause",clientEventId:"id",version:1}},storage)).toBe(false);
});

import {useCallback,useEffect,useRef,useState} from "react";
import type {AppServices} from "@/lib/app-services";
import {stepNames,type TrainingEvent,type TrainingView} from "@/lib/four-step/contracts";
export function TrainingPage({services,materialId,mode}:{services:AppServices;materialId:string;mode:"learn"|"review"}){
  const [view,setView]=useState<TrainingView|null>(null),[text,setText]=useState(""),[error,setError]=useState(""),[busy,setBusy]=useState(false),[unknown,setUnknown]=useState(false);
  const current=useRef<TrainingView|null>(null),input=useRef(""),alive=useRef(true),saving=useRef(Promise.resolve()),pending=useRef<TrainingEvent|null>(null),locked=useRef(false);
  current.current=view;input.current=text;
  const apply=useCallback((next:TrainingView)=>{current.current=next;if(alive.current){setView(next);setText(next.draft);}},[]);
  const load=useCallback(async()=>{try{const next=await services.training.createTraining(materialId,mode);pending.current=next.pendingEvent??null;apply(next);}catch(error){if(alive.current)setError(error instanceof Error?error.message:"无法打开训练");}},[services,materialId,mode,apply]);
  useEffect(()=>{void load();return()=>{alive.current=false;};},[load]);
  useEffect(()=>{if(!view?.busy||busy)return;const timer=setTimeout(()=>void services.training.trainingView(view.id).then(next=>{pending.current=next.pendingEvent??null;apply(next);}).catch(error=>{if(alive.current)setError(error.message);}),1500);return()=>clearTimeout(timer);},[services,view,busy,apply]);
  const save=useCallback(async()=>{
    if(!current.current||current.current.status!=="active"||locked.current)return;
    const value=input.current;
    const task=saving.current.then(async()=>{
      const before=current.current;if(!before||before.busy||before.status!=="active")return;
      if(before.draft===value)return;
      const next=await services.training.saveDraft(before.id,{stepVersion:before.stepVersion,draftVersion:before.draftVersion??0,text:value});
      current.current=next;if(alive.current)setView(next);
    });saving.current=task.catch(()=>undefined);await task;
  },[services]);
  useEffect(()=>{if(!view||text===view.draft||busy)return;const timer=setTimeout(()=>void save().catch(error=>setError(error.message)),300);return()=>clearTimeout(timer);},[text,view,busy,save]);
  useEffect(()=>()=>{void save().catch(()=>undefined);},[save]);
  async function act(type:TrainingEvent["type"],force=false,retry=false){
    if(!view||locked.current)return;if(force&&!window.confirm("重新请求可能再次产生费用，确认吗？"))return;
    setBusy(true);setError("");setUnknown(false);
    try{
      if(!retry)await save();
      locked.current=true;
      const base={clientEventId:crypto.randomUUID(),stepVersion:current.current!.stepVersion};
      const event:TrainingEvent=retry&&pending.current?pending.current:type==="submit"?{...base,type,input:input.current,...(force?{retryUnknown:true}:{})}:{...base,type};
      pending.current=event;
      const next=await services.training.applyTrainingEvent(view.id,event);pending.current=null;apply(next);
    }catch(error){if(alive.current){setError(error instanceof Error?error.message:"暂时不能判定，输入已保存");setUnknown((error as {code?:string}).code==="result_unknown");}}
    finally{locked.current=false;if(alive.current)setBusy(false);}
  }
  if(!view)return <><h1>四步强化</h1><p role="status">{error||"正在恢复训练…"}</p>{error&&<button onClick={()=>void load()}>重试</button>}</>;
  if(view.status!=="active")return <><h1>{view.status==="paused"?"位置已保存":view.status==="no_training_required"?"本次无需强化":"本轮强化完成"}</h1><p>强化完成不等于稳定口语掌握，可以之后再无提示回答。</p>{view.status==="paused"&&<button className="primary-button" onClick={()=>void load()}>继续训练</button>}<a className="back-link" href={view.questionId?`#/questions/${view.questionId}`:`#/materials/${materialId}`}>返回原题或对话</a></>;
  return <section className="training-page"><header className="page-heading"><h1>四步强化</h1><button disabled={busy} onClick={()=>void act("pause")}>保存并暂停</button></header><ol className="step-indicator">{stepNames.map((name,index)=><li key={name} aria-current={index+1===view.step?"step":undefined}>{index+1}. {name}</li>)}</ol>
    {error&&<div className="error-box" role="alert"><p>{error}</p>{pending.current&&!unknown&&<button disabled={busy} onClick={()=>void act(pending.current!.type,false,true)}>重试原操作</button>}{unknown&&<button disabled={busy} onClick={()=>void act("submit",true)}>确认重新请求</button>}<button disabled={busy} onClick={()=>void services.training.trainingView(view.id).then(apply)}>恢复本机进度</button></div>}
    {(view.pendingEvent||pending.current)&&!busy&&<button className="secondary-button" onClick={()=>{pending.current=view.pendingEvent??pending.current;void act(pending.current!.type,false,true);}}>恢复上次未完成操作</button>}
    <p className="quiet">第 {view.taskIndex+1} / {view.taskCount} 项</p><h2>{view.promptZh}</h2>{view.before!==undefined&&<p className="preserve" lang="en">{view.before}<strong> _____ </strong>{view.after}</p>}
    {view.hint&&<p className="hint-panel">{view.hint}</p>}{view.answer&&<p className="material-target" lang="en">{view.answer}</p>}
    {!view.passed&&<textarea aria-label="我的英文表达" value={text} onChange={event=>setText(event.target.value)} disabled={busy||view.busy||!!view.hint||!!view.answer} lang="en" rows={5}/>}
    {view.feedback&&<p className="hint-panel" role="status">{view.feedback.feedbackZh}</p>}
    <div className="training-actions">{view.passed?<button className="primary-button" disabled={busy} onClick={()=>void act("continue")}>继续下一项</button>:view.hint||view.answer?<button className="primary-button" disabled={busy} onClick={()=>void act("recall")}>遮住提示，再回想一次</button>:<><button className="primary-button" disabled={busy||!text.trim()||view.busy} onClick={()=>void act("submit")}>{busy?"正在判定…":"检查表达"}</button><button className="secondary-button" disabled={busy||view.busy} onClick={()=>void act("assist")}>给我一点提示</button></>}</div><p className="quiet">四步是可选强化；非精确答案会使用你的 DeepSeek 服务判定。这里不会自动请求麦克风。</p>
  </section>;
}

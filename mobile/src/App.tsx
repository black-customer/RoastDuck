import {createContext,useCallback,useContext,useEffect,useMemo,useRef,useState,type ReactNode} from "react";
import type {AppServices} from "@/lib/app-services";
import type {AppQuestionFilters} from "@/lib/app-services/queries";
import type {AnswerDraft} from "@/lib/app-services/answers";
import type {MaterialRow} from "@/lib/four-step/material-types";
import type {LightScope} from "@/lib/light-study/contracts";
import {LightStudyPanel} from "@/components/light-study/LightStudyPanel";
import {BrandMark,Icon,type IconName} from "@/components/ui/Icon";
import {speakingAttemptAnalysisSchema} from "@/lib/speaking-practice/schemas";
import {parseJson} from "@/lib/app-services/shared";
import {credentials,createNativeLightClient} from "./platform";
import {TrainingPage} from "./Training";
import {MemoryPage,ExpressionsPage} from './Library';
import {SyncPage} from './Sync';
import {BackupPage} from './Backup';
import {AudioPage} from './Audio';

const Context=createContext<AppServices|null>(null);
const useApp=()=>useContext(Context)!;
export const go=(href:string)=>{window.location.hash=href;};
function Link({href,children,className}:{href:string;children:ReactNode;className?:string}){return <a href={`#${href}`} className={className}>{children}</a>;}
const message=(error:unknown)=>error instanceof Error?error.message:"操作暂未完成，请重试，已保存的资料不会被清空";
function ErrorBox({error,retry}:{error:string;retry?:()=>void}){return error?<div className="error-box" role="alert"><p>{error}</p>{retry&&<button onClick={retry}>重试</button>}</div>:null;}
function useData<T>(load:()=>Promise<T>,key:string){
  const [value,setValue]=useState<T|null>(null),[error,setError]=useState(""),[tick,setTick]=useState(0);
  const latest=useRef(load);latest.current=load;
  useEffect(()=>{let alive=true;setError("");void latest.current().then(data=>{if(alive)setValue(data);}).catch(error=>{if(alive)setError(message(error));});return()=>{alive=false;};},[key,tick]);
  return {value,error,reload:()=>setTick(value=>value+1)};
}
function Header({title,children}:{title:string;children?:ReactNode}){return <header className="page-heading"><h1>{title}</h1>{children}</header>;}
function Loading(){return <p className="quiet" role="status">正在读取本机资料…</p>;}
function Today(){
  const app=useApp(),data=useData(async()=>({overview:await app.light.lightOverview({type:"all"}),recent:await app.recent()}),"home");
  const [error,setError]=useState(""),[busy,setBusy]=useState(false);const request=useRef(crypto.randomUUID());
  const value=data.value,session=value?.recent.sessions[0];
  const title=session?"继续上次学习":value?.overview.dueCount?"复习到期表达":value?.overview.newCount?"学几个新表达":"回答一道题";
  async function begin(){
    if(!value||busy)return;if(!session&&!value.overview.dueCount&&!value.overview.newCount){go("/questions");return;}
    setBusy(true);setError("");
    try{const next=await app.light.createLightSession({scope:session?parseJson<LightScope>(session.scope_json,{type:"all"}):{type:"all"},mode:session?.mode??value.overview.defaultMode,clientRequestId:request.current});go(`/light-study?session=${encodeURIComponent(next.id)}`);}
    catch(error){setError(message(error));}finally{setBusy(false);}
  }
  return <><Header title="今天，从一点开始"/><section className="today-action"><p>先想一下，再听见答案。<br/>有空就学几个，不用一次做完。</p><button className="primary-button" disabled={!value||busy} onClick={()=>void begin()}>{busy?"正在准备…":title}<Icon name="arrow"/></button>{value&&<p className="quiet">{value.overview.dueCount?`${value.overview.dueCount} 个表达到期，可按一小组复习。`:value.overview.newCount?"已经整理好的材料，随时可以开始。":"可以先浏览题库；有资料后，离线也能学习。"}</p>}</section><ErrorBox error={error||data.error} retry={data.reload}/>
    <div className="two-actions"><Link href="/questions"><Icon name="questions"/>选择雅思题</Link><Link href="/free-talk"><Icon name="speaking"/>随便聊聊</Link></div>
    {!!value?.recent.materials.length&&<section><h2>最近的回答与对话</h2><div className="list-surface">{value.recent.materials.map(item=><Link key={item.id} href={item.question_id?`/questions/${item.question_id}/attempts/${item.source_id}`:`/materials/${item.id}`} className="list-row"><span><strong>{item.title||"我的表达"}</strong><small>{item.status==="ready"?"查看反馈与学习材料":item.status==="failed"?"处理未完成，可以恢复":"材料处理中，可继续查看"}</small></span><Icon name="arrow"/></Link>)}</div></section>}
  </>;
}
function Questions(){
  const app=useApp(),[filters,setFilters]=useState<AppQuestionFilters>({}),[search,setSearch]=useState(""),[error,setError]=useState("");
  const data=useData(()=>app.questions.list(filters),JSON.stringify(filters)),facets=useData(()=>app.questions.facets(),"facets");
  function update(patch:AppQuestionFilters){setFilters(current=>({...current,...patch,page:patch.page??1}));}
  return <><Header title="选一道想聊的题"/><form className="search-form" onSubmit={event=>{event.preventDefault();update({q:search});}}><input aria-label="搜索题目或话题" type="search" value={search} onChange={event=>setSearch(event.target.value)} placeholder="搜索题目或话题"/><button className="secondary-button">搜索</button></form>
    <div className="filters"><select aria-label="题季" value={filters.set??""} onChange={event=>update({set:event.target.value||undefined})}><option value="">全部题季</option>{facets.value?.sets.map(set=><option key={set.id} value={set.id}>{set.name_zh}</option>)}</select><select aria-label="Part" value={filters.part??""} onChange={event=>update({part:event.target.value?Number(event.target.value):undefined})}><option value="">全部 Part</option>{[1,2,3].map(part=><option key={part} value={part}>Part {part}</option>)}</select><select aria-label="话题" value={filters.topic??""} onChange={event=>update({topic:event.target.value||undefined})}><option value="">全部话题</option>{facets.value?.topics.filter(topic=>!filters.part||topic.part===filters.part).map(topic=><option key={topic.id} value={topic.id}>{topic.name_zh||topic.name_en}</option>)}</select></div>
    <div className="filter-actions"><label><input type="checkbox" checked={filters.favorite??false} onChange={event=>update({favorite:event.target.checked})}/>只看收藏</label><button onClick={()=>void app.questions.random(filters).then(item=>go(`/questions/${item.id}`)).catch(error=>setError(message(error)))}><Icon name="shuffle"/>随机一题</button></div><ErrorBox error={data.error||error} retry={data.reload}/>
    {!data.value?<Loading/>:<><p className="quiet">找到 {data.value.total} 道题</p><div className="list-surface">{data.value.items.map(item=><Link className="question-row" key={item.id} href={`/questions/${item.id}`}><small>Part {item.part} · {item.topic_zh||item.topic_en||"其他话题"}</small><strong lang="en">{item.text||item.text_zh}</strong>{item.text_zh&&<span>{item.text_zh}</span>}<small>{item.answer_count?`已有 ${item.answer_count} 次回答`:"还没有回答"}{item.favorite?" · 已收藏":""}</small></Link>)}</div>{!data.value.total&&<p>换个关键词或筛选条件看看。</p>}<div className="pagination"><button disabled={data.value.page===1} onClick={()=>update({page:data.value!.page-1})}>上一页</button><span>{data.value.page}</span><button disabled={data.value.page*data.value.pageSize>=data.value.total} onClick={()=>update({page:data.value!.page+1})}>下一页</button></div></>}
  </>;
}
function Question({id}:{id:string}){
  const app=useApp(),data=useData(async()=>({question:await app.questions.get(id),history:await app.answers.history(id),drafts:await app.answers.drafts(id)}),id);
  const [busy,setBusy]=useState(false),[error,setError]=useState("");const request=useRef(crypto.randomUUID());
  async function start(){setBusy(true);try{const draft=data.value?.drafts[0]??await app.answers.start(id,request.current);go(`/drafts/${draft.id}`);}catch(error){setError(message(error));}finally{setBusy(false);}}
  if(!data.value)return <><Loading/><ErrorBox error={data.error} retry={data.reload}/></>;
  const {question,history}=data.value;
  return <><Header title={`Part ${question.part} · ${question.topic_zh||"雅思口语"}`}/><section className="question-detail"><h2 lang="en">{question.text||question.text_zh}</h2>{question.text_zh&&<p>{question.text_zh}</p>}<button className="primary-button" disabled={busy} onClick={()=>void start()}>{data.value.drafts.length?"继续我的草稿":"开始回答"}</button><button className="text-button" onClick={()=>void app.questions.favorite(id,!question.favorite).then(data.reload).catch(error=>setError(message(error)))}>{question.favorite?"取消收藏":"收藏这道题"}</button></section><ErrorBox error={error}/>
    <section><h2>我的回答</h2>{history.length?<div className="list-surface">{history.map(answer=><Link key={answer.id} className="list-row" href={`/questions/${id}/attempts/${answer.id}`}><span><strong>{answer.answer_text.slice(0,90)||"从中文原意开始的回答"}</strong><small>{new Date(answer.created_at).toLocaleDateString("zh-CN")} · {answer.status==="completed"?"查看反馈":answer.status==="failed"?"可恢复处理":"已保存"}</small></span><Icon name="arrow"/></Link>)}</div>:<p className="quiet">先试着表达，再把真正想说的意思告诉 Chloe。</p>}</section>
    <details className="details"><summary>题目与来源</summary>{question.sources.map((source,index)=><p key={index}>{source.set_name} · {source.source_file}，第 {source.source_page} 页</p>)}{!question.sources.length&&<p>本地个人题目；原始英文可能未完整保留。</p>}</details>
  </>;
}
function Draft({id}:{id:string}){
  const app=useApp(),data=useData(()=>app.answers.getDraft(id),id);return data.value?<DraftEditor key={id} initial={data.value}/>:<><Loading/><ErrorBox error={data.error} retry={data.reload}/></>;
}
function DraftEditor({initial}:{initial:AnswerDraft}){
  const app=useApp(),[english,setEnglish]=useState(initial.english_text),[chinese,setChinese]=useState(initial.chinese_text),[unknown,setUnknown]=useState(Boolean(initial.english_unknown));
  const [saved,setSaved]=useState(true),[error,setError]=useState(""),[busy,setBusy]=useState(false),version=useRef(initial.version),tail=useRef(Promise.resolve()),alive=useRef(true);
  const [englishCommitted,setEnglishCommitted]=useState(!!initial.english_committed_at),independent=initial.kind==='independent';
  const question=useData(()=>app.questions.get(initial.question_id),initial.question_id);
  const snapshot=useRef({english,chinese,englishUnknown:unknown});snapshot.current={english,chinese,englishUnknown:unknown};
  const persist=useCallback(async()=>{
    const input={...snapshot.current};let failure:unknown;
    const task=tail.current.then(async()=>{try{const updated=await app.answers.saveDraft(initial.id,{...input,version:version.current});version.current=updated.version;if(alive.current&&JSON.stringify(input)===JSON.stringify(snapshot.current))setSaved(true);}catch(error){failure=error;if(alive.current)setError(message(error));}});
    tail.current=task;await task;if(failure)throw failure;
  },[app,initial.id]);
  useEffect(()=>()=>{alive.current=false;void persist().catch(()=>undefined);},[persist]);
  useEffect(()=>{setSaved(false);const timer=setTimeout(()=>void persist().catch(()=>undefined),300);return()=>clearTimeout(timer);},[english,chinese,unknown,persist]); // Also save a revert to the original text; don't compare only with the mount snapshot.
  async function submit(){if(busy)return;setBusy(true);setError("");try{await persist();const result=await app.answers.submit(initial.id,version.current);const detail=await app.answers.detail(result.attemptId);if(detail.material)void app.materials.process(detail.material.id).catch(()=>undefined);go(`/questions/${initial.question_id}/attempts/${result.attemptId}`);}catch(error){setError(message(error));}finally{setBusy(false);}}
  async function seal(){setBusy(true);setError('');try{await persist();const result=await app.answers.commitEnglish(initial.id,version.current);version.current=result.version;setEnglishCommitted(true);}catch(error){setError(message(error));}finally{setBusy(false);}}
  if(initial.submitted_attempt_id)return <><Header title="这份回答已保存"/><Link className="primary-button" href={`/questions/${initial.question_id}/attempts/${initial.submitted_attempt_id}`}>查看反馈与材料</Link></>;
  return <><Header title={independent?'不看提示，重新回答':initial.kind==='edit'?'编辑为新的回答版本':'先表达，再一起整理'}/><p className="prompt-question" lang="en">{question.value?.text||question.value?.text_zh}</p><ErrorBox error={error} retry={()=>void persist().catch(()=>undefined)}/><form className="answer-form" onSubmit={event=>{event.preventDefault();void (independent&&!englishCommitted?seal():submit());}}>
    <label>我的英文尝试<textarea value={english} disabled={unknown||(independent&&englishCommitted)} onChange={event=>setEnglish(event.target.value)} placeholder="不完整、卡壳也没关系，先试着写出来。" lang="en" spellCheck={!independent}/></label><label className="check-label"><input type="checkbox" disabled={independent&&englishCommitted} checked={unknown} onChange={event=>setUnknown(event.target.checked)}/>暂时不会用英文表达</label>
    {(!independent||englishCommitted)&&<label>我真正想表达的中文意思<textarea value={chinese} onChange={event=>setChinese(event.target.value)} placeholder="说清楚你的事实、观点和思路；不用翻译腔。"/></label>}<p className="quiet">可以使用输入法听写。本应用只收到文字，不保存原始录音。</p><p className="save-state" role="status">{saved?"草稿已保存在本机":"正在保存草稿…"}</p>{independent&&!englishCommitted?<button className="primary-button" disabled={busy||(!unknown&&!english.trim())}>先保存英文，再补充原意</button>:<button className="primary-button" disabled={busy||!chinese.trim()||(!unknown&&!english.trim())}>{busy?"正在保存…":"保存并分析我的表达"}</button>}
  </form></>;
}
function MaterialBody({material,reload,verified}:{material:MaterialRow;reload:()=>void;verified:boolean}){
  const app=useApp(),[busy,setBusy]=useState(false),[error,setError]=useState("");const input=parseJson<{actualAnswer?:string;intendedMeaningZh?:string}>(material.input_json,{}),parsed=speakingAttemptAnalysisSchema.safeParse(parseJson(material.analysis_json,null));
  const [poll,setPoll]=useState(0);
  useEffect(()=>{if(!["queued","generating","reviewing"].includes(material.status))return;const timer=setTimeout(()=>{reload();setPoll(value=>value+1);},2000);return()=>clearTimeout(timer);},[material.status,poll,reload]);
  async function resume(force=false){if(busy)return;if(force&&!window.confirm("上次请求结果未知，重新请求可能再次产生费用。确认继续吗？"))return;setBusy(true);setError("");try{await app.materials.process(material.id,{retry:true,retryUnknown:force});reload();}catch(error){setError(message(error));}finally{setBusy(false);}}
  const ready=material.status==="ready"&&parsed.success&&verified;
  if(material.status==="ready"&&!ready)return <><ErrorBox error="这份材料的证据或内容不完整，暂不进入学习。原回答仍保留。" retry={reload}/><details className="details"><summary>查看原回答</summary><p>{input.actualAnswer}</p><p>{input.intendedMeaningZh}</p></details></>;
  return <><ErrorBox error={error}/>{!ready?<section className="status-panel"><h2>{material.status==="failed"?"处理遇到了问题":"材料正在整理"}</h2><p>原回答已保存在本机，可以离开这页。恢复时只继续未完成的步骤。</p>{material.error_code==="result_unknown"?<><p>上次请求的结果还没有确认。</p><button className="primary-button" disabled={busy} onClick={()=>void resume(false)}>先恢复已有结果</button><button className="text-button" disabled={busy} onClick={()=>void resume(true)}>确认重新请求</button></>:<button className="primary-button" disabled={busy} onClick={()=>void resume()}>{busy?"正在处理…":"继续处理"}</button>}<details><summary>查看处理信息</summary><p>{material.error_code||material.status}</p><Link href="/settings">检查我的 API 设置</Link></details></section>:<>
    <section className="feedback"><h2>{parsed.data.learningMaterials.length?"这些表达，值得再熟悉一下":"本次没有需要加入训练的表达"}</h2><p>{parsed.data.learningMaterials.length?`从你的原意出发，整理了 ${parsed.data.learningMaterials.length} 项表达。已自然的部分不会强行重写。`:"这不等于所有方面都已掌握；仍不确定的片段保留在问题账本中。"}</p>{parsed.data.learningMaterials.length>0&&<Link className="primary-button" href={`/light-study?scope=material&id=${material.id}`}>轻松学本次表达</Link>}</section>
    <section><h2>本次学习材料</h2>{parsed.data.learningMaterials.map((row,index)=><article className="material-row" key={row.gapId??index}><h3>{row.chineseChunk}</h3><p className="material-target" lang="en">{row.englishChunk}</p><p>{row.yourChineseSentence}</p><p lang="en">{row.naturalEnglishSentence}</p><details><summary>为什么学这一项</summary><p>{row.inclusionReasonZh}</p><p>原表达：{row.originalEnglish||"没有提供英文尝试"}</p></details></article>)}</section>
    <details className="details"><summary>可选四步强化</summary><p>需要更严格地检验时，再做语块、整句、填空和整段提取；不是轻松学的前置条件。</p><Link className="secondary-button" href={`/training/${material.id}`}>开始或继续强化</Link></details>
    <details className="details"><summary>地道表达全文</summary><p className="preserve" lang="en">{parsed.data.naturalVersion||"没有可确认的完整表达"}</p></details><details className="details"><summary>问题账本与原意</summary>{parsed.data.evidence?.diagnosis.units.map(unit=><article key={unit.id}><strong>{unit.intentZh}</strong><p>{unit.reasonZh}</p><p className="quiet">{unit.status==="natural"?"已自然表达":unit.status==="uncertain"?"仍待确认":unit.status==="non_answer"?"不是正式回答":"可修复或补充"}</p></article>)}</details>
  </>}<details className="details"><summary>我的原回答</summary><p className="preserve" lang="en">{input.actualAnswer||"明确选择了暂时不会用英文表达"}</p><p className="preserve">{input.intendedMeaningZh}</p></details></>;
}
function Attempt({id}:{id:string}){
  const app=useApp(),data=useData(()=>app.answers.detail(id),id),[error,setError]=useState(''),[busy,setBusy]=useState(false),request=useRef(crypto.randomUUID());
  async function next(kind:'independent'|'edit'){if(!data.value||busy)return;setBusy(true);try{const draft=await app.answers.start(data.value.attempt.question_id,request.current,id,kind);go(`/drafts/${draft.id}`);}catch(error){setError(message(error));}finally{setBusy(false);}}
  if(!data.value)return <><Loading/><ErrorBox error={data.error} retry={data.reload}/></>;
  return <><Header title="我的回答与表达"/><Link href={`/questions/${data.value.attempt.question_id}`} className="back-link">回到这道题</Link><ErrorBox error={error}/><div className="row-actions"><button disabled={busy} onClick={()=>void next('independent')}>不看提示，重新回答</button><button disabled={busy} onClick={()=>void next('edit')}>编辑新版本</button></div>{data.value.previous&&<details className="details"><summary>前后回答对照</summary><h2>此前的表达</h2><p className="preserve" lang="en">{data.value.previous.answer_text}</p><h2>这次的表达</h2><p className="preserve" lang="en">{data.value.attempt.answer_text}</p><p className="quiet">{data.value.origin?.kind==='independent'?'本次英文先于中文原意封存。':'这是编辑版本，不计为独立输出。'}没有再次提及旧问题，不代表已经掌握。</p></details>}{data.value.material?<MaterialBody material={data.value.material} reload={data.reload} verified={!!data.value.audit?.ok}/>:<p>原回答已保留，尚未关联学习材料。</p>}</>;
}
function Material({id}:{id:string}){const app=useApp(),data=useData(()=>app.materials.inspect(id),id);return <><Header title="这段对话里的表达"/>{data.value?<MaterialBody material={data.value.material} reload={data.reload} verified={data.value.verified}/>:<><Loading/><ErrorBox error={data.error} retry={data.reload}/></>}</>;}
function LightRoute({url}:{url:URL}){
  const app=useApp(),id=url.searchParams.get("session"),data=useData(()=>id?app.light.getLightView(id):Promise.resolve(null),id??"new");
  const client=useMemo(()=>createNativeLightClient(app),[app]);
  if(id&&!data.value)return <><Loading/><ErrorBox error={data.error} retry={data.reload}/></>;
  const scope:LightScope=data.value?.scope??(url.searchParams.get("scope")==="material"?{type:"material",id:url.searchParams.get("id")??""}:url.searchParams.get("scope")==="question"?{type:"question",id:url.searchParams.get("id")??""}:{type:"all"});
  return <LightStudyPanel scope={scope} initialSessionId={id??undefined} initialMode={url.pathname==='/review'?'review':undefined} client={client} Link={Link}/>;
}
function Conversations(){
  const app=useApp(),data=useData(()=>app.chat.list(),"conversations"),[error,setError]=useState(""),[busy,setBusy]=useState(false),request=useRef(crypto.randomUUID());
  return <><Header title="和 Chloe 聊聊"/><p>中文、英文、中英混合，都可以放心说。</p><button className="primary-button" disabled={busy} onClick={()=>{setBusy(true);void app.chat.create({clientRequestId:request.current}).then(conversation=>go(`/free-talk/${conversation.id}`)).catch(error=>setError(message(error))).finally(()=>setBusy(false));}}>开始一段新对话</button><ErrorBox error={error||data.error} retry={data.reload}/><div className="list-surface">{data.value?.map(conversation=><Link className="list-row" href={`/free-talk/${conversation.id}`} key={conversation.id}><span><strong>{conversation.title}</strong><small>{new Date(conversation.updated_at).toLocaleDateString("zh-CN")}</small></span><Icon name="arrow"/></Link>)}</div></>;
}
function Chat({id}:{id:string}){
  const app=useApp(),data=useData(async()=>({conversation:await app.chat.get(id),messages:await app.chat.messages(id)}),id),[text,setText]=useState(""),[busy,setBusy]=useState(false),[error,setError]=useState(""),[range,setRange]=useState(false);
  const [selected,setSelected]=useState<string[]>([]),request=useRef<{text:string;id:string}|null>(null),alive=useRef(true),endRef=useRef<HTMLDivElement>(null),follow=useRef(true);useEffect(()=>()=>{alive.current=false;},[]);
  useEffect(()=>{const scroll=()=>{follow.current=window.innerHeight+window.scrollY>=document.documentElement.scrollHeight-220;};window.addEventListener('scroll',scroll,{passive:true});return()=>window.removeEventListener('scroll',scroll);},[]);
  useEffect(()=>{if(!range&&follow.current)endRef.current?.scrollIntoView({block:'end'});},[data.value?.messages.length,range]);
  async function reply(userId:string,retry=false,unknown=false){setBusy(true);try{const rows=await app.chat.process(id,userId,{retryFailed:retry,retryUnknown:unknown});if(alive.current){const target=rows.find(row=>row.id===userId)?.conversation_id;if(target&&target!==id)go(`/free-talk/${target}`);else data.reload();}}catch(error){if(alive.current){setError(message(error));data.reload();}}finally{if(alive.current)setBusy(false);}}
  async function send(){if(!text.trim()||busy)return;setBusy(true);setError("");follow.current=true;if(request.current?.text!==text)request.current={text,id:crypto.randomUUID()};try{const user=await app.chat.prepare(id,{clientMessageId:request.current.id,text});setText("");request.current=null;data.reload();await reply(user.id);}catch(error){setError(message(error));setBusy(false);}}
  async function recap(){if(!data.value)return;const chosen=data.value.messages.filter(row=>selected.includes(row.id));if(!chosen.length)return;setBusy(true);try{const material=await app.chat.recap(id,chosen[0].id,chosen.at(-1)!.id);void app.materials.process(material.id).catch(()=>undefined);go(`/materials/${material.id}`);}catch(error){setError(message(error));}finally{setBusy(false);}}
  function rangeChange(start:string,end:string){const rows=data.value?.messages??[],a=rows.findIndex(row=>row.id===start),b=rows.findIndex(row=>row.id===end);setSelected(rows.slice(Math.min(a,b),Math.max(a,b)+1).map(row=>row.id));}
  return <div className="chat-page"><Header title={data.value?.conversation.title??"Chloe"}><span className="quiet">AI 英语学习搭子</span></Header><div className="chat-tools"><button onClick={()=>{setRange(value=>!value);setSelected(data.value?.messages.slice(-8).map(row=>row.id)??[]);}}>{range?"取消选择":"复盘这段对话"}</button>{range&&<><p className="quiet">选择连续的一段，保留真实对话上下文。</p><label>从这条开始<select value={selected[0]??''} onChange={e=>rangeChange(e.target.value,selected.at(-1)??e.target.value)}>{data.value?.messages.map(row=><option key={row.id} value={row.id}>{row.role==='user'?'我':'Chloe'}：{row.text.slice(0,45)}</option>)}</select></label><label>到这条结束<select value={selected.at(-1)??''} onChange={e=>rangeChange(selected[0]??e.target.value,e.target.value)}>{data.value?.messages.map(row=><option key={row.id} value={row.id}>{row.role==='user'?'我':'Chloe'}：{row.text.slice(0,45)}</option>)}</select></label><button className="secondary-button" disabled={busy||!selected.length} onClick={()=>void recap()}>整理所选消息</button></>}</div><ErrorBox error={error||data.error} retry={data.reload}/>
    <div className="messages">{data.value?.messages.map(row=>{const metadata=parseJson<{translationZh?:string;deliveryStatus?:string;errorCode?:string}>(row.metadata_json,{});return <article key={row.id} className={`message ${row.role}`}>
      {range&&selected.includes(row.id)&&<small className="quiet">在所选范围内</small>}<p className="preserve">{row.text}</p>{metadata.translationZh&&<details><summary>中文对照</summary><p>{metadata.translationZh}</p></details>}
      {row.role==="user"&&metadata.deliveryStatus!=="completed"&&metadata.deliveryStatus&&<div className="message-state"><small>{busy?"Chloe 正在回复…":"消息已保存，回复待恢复"}</small>{!busy&&<button onClick={()=>void reply(row.id,true)}>恢复回复</button>}{!busy&&metadata.errorCode==="result_unknown"&&<button onClick={()=>{if(window.confirm("重新请求可能再次产生费用，确认吗？"))void reply(row.id,true,true);}}>确认重新请求</button>}</div>}
    </article>;})}<div ref={endRef}/></div><form className="chat-compose" onSubmit={event=>{event.preventDefault();void send();}}><textarea aria-label="给 Chloe 的消息" value={text} onChange={event=>setText(event.target.value)} placeholder="想说什么就说，中文也可以…" rows={2}/><button className="primary-button" disabled={busy||!text.trim()}>发送</button></form></div>;
}
function Settings(){
  const app=useApp(),data=useData(async()=>({settings:await app.settings.get(),keys:await credentials.status()}),"settings"),[error,setError]=useState("");
  async function configure(provider:"deepseek"|"mimo"){try{await credentials.configure({provider});data.reload();}catch(error){setError(message(error));}}
  return <><Header title="我的"/><ErrorBox error={error||data.error} retry={data.reload}/><section><h2>我的 API 设置</h2><p className="quiet">使用你自己的新 Key。密钥只保存在本机安全存储，不会同步到电脑。</p>{(["deepseek","mimo"] as const).map(provider=><div className="setting-row" key={provider}><span><strong>{provider==="deepseek"?"DeepSeek 文本服务":"MiMo 示范声音"}</strong><small>{data.value?.keys[provider]?"已配置（不代表已验证可用）":"尚未配置，可先学已导入的材料"}</small></span><button className="secondary-button" onClick={()=>void configure(provider)}>配置</button></div>)}</section>
    {data.value&&<section><h2>学习偏好</h2><label className="setting-row"><span>自动播放示范声音</span><input type="checkbox" checked={data.value.settings.autoPlay} onChange={event=>void app.settings.save({...data.value!.settings,autoPlay:event.target.checked}).then(data.reload).catch(error=>setError(message(error)))}/></label><label className="setting-row"><span>查询时自动收藏<span className="quiet">默认关闭，不代表确认的 Gap</span></span><input type="checkbox" checked={data.value.settings.autoCollectDifficulties} onChange={event=>void app.settings.save({...data.value!.settings,autoCollectDifficulties:event.target.checked}).then(data.reload)}/></label></section>}
    <div className="list-surface"><Link className="list-row" href="/sync">电脑同步<Icon name="arrow"/></Link><Link className="list-row" href="/backup">备份与恢复<Icon name="arrow"/></Link><Link className="list-row" href="/audio">离线声音<Icon name="arrow"/></Link><Link className="list-row" href="/expressions">查找我的表达<Icon name="arrow"/></Link><Link className="list-row" href="/memories">Chloe 记得什么<Icon name="arrow"/></Link><Link className="list-row" href="/notes">表达收藏与备注<Icon name="arrow"/></Link></div><p className="quiet">本机资料不会自动上传云端。没有原始音频时，不提供发音或流利度评分。</p>
  </>;
}
function Notes(){const app=useApp(),data=useData(()=>app.settings.notes(),"notes"),[error,setError]=useState("");return <><Header title="表达收藏与备注"/><ErrorBox error={error||data.error} retry={data.reload}/>{data.value?.map(note=><article className="material-row" key={note.id}><h2 lang="en">{note.surface}</h2><p>{note.meaning_zh}</p><p>{note.user_remark}</p><button onClick={()=>{const remark=window.prompt("补充自己的备注",note.user_remark);if(remark!==null)void app.settings.saveNote({id:note.id,remark}).then(data.reload).catch(error=>setError(message(error)));}}>编辑备注</button></article>)}{data.value&&!data.value.length&&<p>还没有收藏。普通查询不会自动创建难点。</p>}</>;}
export function MobileApp({services}:{services:AppServices}){
  const [href,setHref]=useState(window.location.hash.slice(1)||"/");useEffect(()=>{const change=()=>{setHref(window.location.hash.slice(1)||"/");window.scrollTo(0,0);};window.addEventListener("hashchange",change);return()=>window.removeEventListener("hashchange",change);},[]);
  const [keyboard,setKeyboard]=useState(false),[setupComplete,setSetupComplete]=useState(()=>{try{return localStorage.getItem('roastduck_mobile_setup')==='1';}catch{return false;}});
  useEffect(()=>{
    let largest=window.innerHeight;const update=()=>{const height=window.visualViewport?.height??window.innerHeight;largest=Math.max(largest,window.innerHeight);setKeyboard(largest-height>140&&['INPUT','TEXTAREA'].includes(document.activeElement?.tagName??''));};
    window.visualViewport?.addEventListener('resize',update);window.addEventListener('resize',update);document.addEventListener('focusin',update);document.addEventListener('focusout',update);
    return()=>{window.visualViewport?.removeEventListener('resize',update);window.removeEventListener('resize',update);document.removeEventListener('focusin',update);document.removeEventListener('focusout',update);};
  },[]);
  const url=new URL(href,"https://localhost"),path=url.pathname,parts=path.split("/").filter(Boolean);
  let content:ReactNode;
  if(path==="/")content=<Today/>;
  else if(path==="/questions")content=<Questions/>;
  else if(parts[0]==="questions"&&parts[2]==="attempts"&&parts[3])content=<Attempt id={parts[3]}/>;
  else if(parts[0]==="questions"&&parts[1])content=<Question id={parts[1]}/>;
  else if(parts[0]==="drafts"&&parts[1])content=<Draft id={parts[1]}/>;
  else if(parts[0]==="materials"&&parts[1])content=<Material id={parts[1]}/>;
  else if(parts[0]==="training"&&parts[1])content=<TrainingPage services={services} materialId={parts[1]} mode={url.searchParams.get("mode")==="review"?"review":"learn"}/>;
  else if(path==="/light-study"||path==="/review")content=<LightRoute url={url}/>;
  else if(path==="/free-talk")content=<Conversations/>;
  else if(parts[0]==="free-talk"&&parts[1])content=<Chat id={parts[1]}/>;
  else if(path==="/settings")content=<Settings/>;
  else if(path==="/memories")content=<MemoryPage app={services}/>;
  else if(path==="/expressions")content=<ExpressionsPage app={services}/>;
  else if(path==="/sync")content=<SyncPage app={services}/>;
  else if(path==="/backup")content=<BackupPage app={services}/>;
  else if(path==="/audio")content=<AudioPage app={services} materialId={url.searchParams.get('material')??undefined}/>;
  else if(path==="/notes")content=<Notes/>;
  else content=<><Header title="这个页面暂时无法打开"/><Link href="/">回到今天</Link></>;
  const tabs:Array<{href:string;label:string;icon:IconName}>=[{href:"/",label:"今天",icon:"home"},{href:"/questions",label:"题库",icon:"questions"},{href:"/free-talk",label:"对话",icon:"speaking"},{href:"/review",label:"复习",icon:"answers"},{href:"/settings",label:"我的",icon:"settings"}];
  function finishSetup(destination:string){try{localStorage.setItem('roastduck_mobile_setup','1');}catch{/* Choice still applies to this launch. */}setSetupComplete(true);go(destination);}
  if(!setupComplete&&path==='/')return <div className="boot-screen"><BrandMark/><h1>把你的表达，带在身边</h1><p>连接电脑，直接带入已经整理好的资料；也可以先设置自己的 API，从一道题开始。</p><div className="training-actions"><button className="primary-button" onClick={()=>finishSetup('/sync')}>连接电脑，导入我的资料</button><button className="secondary-button" onClick={()=>finishSetup('/settings')}>直接开始设置</button></div><p className="quiet">API Key 可以稍后配置。不重新生成历史材料。</p></div>;
  return <Context.Provider value={services}><div className="native-app" data-keyboard={keyboard}><header className="app-bar"><Link href="/" className="brand"><BrandMark/><span>鱼块学英语</span></Link>{path!=="/"&&<button onClick={()=>window.history.length>1?window.history.back():go("/")}>返回</button>}</header><main className="app-main" key={href}>{content}</main><nav className="bottom-nav" aria-label="主要导航">{tabs.map(tab=><Link key={tab.href} href={tab.href} className={path===tab.href||(tab.href!=="/"&&path.startsWith(tab.href))?"selected":""}><Icon name={tab.icon}/><span>{tab.label}</span></Link>)}</nav></div></Context.Provider>;
}

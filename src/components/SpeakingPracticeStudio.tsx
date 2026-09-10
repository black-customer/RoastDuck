"use client";
import Link from 'next/link';
import {useRouter} from 'next/navigation';
import {useCallback,useEffect,useRef,useState} from 'react';
import type {QuestionDetail} from '@/lib/questions/service';
import type {AnswerDraft} from '@/lib/app-services/answers';
import {credentialValue} from '@/lib/app-services/shared';
import {SpeakButton} from './SpeakButton';
import {z} from 'zod';
type Values={english:string;chinese:string;englishUnknown:boolean;inputText?:string};
const localDraftSchema=z.object({clientId:z.string().min(1).max(160),draftId:z.string().optional(),version:z.number().int().optional(),values:z.object({english:z.string().max(16000),chinese:z.string().max(16000),englishUnknown:z.boolean(),inputText:z.string().max(16000).optional()})});
type LocalDraft=z.infer<typeof localDraftSchema>;
const empty:Values={english:'',chinese:'',englishUnknown:false};
const combined=(v:Values)=>[v.englishUnknown?'':v.english,v.chinese].filter(Boolean).join('\n\n');
const fromDraft=(d:AnswerDraft):Values=>({english:d.english_text,chinese:d.chinese_text,englishUnknown:!!d.english_unknown,...(d.input_format==='mixed-v1'?{inputText:d.raw_input??''}:{})});
const sensitive=(v:Values)=>credentialValue((v.inputText??'')+'\n'+v.english+'\n'+v.chinese);
async function request(url:string,method='GET',body?:unknown){
  const response=await fetch(url,{method,cache:'no-store',headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const data=await response.json();if(!response.ok)throw Object.assign(new Error(data.error??'保存未成功，请重试'),{code:data.code});return data;
}
/** Durable server drafts plus a browser recovery copy for the debounce/network window. */
export function SpeakingPracticeStudio({question,sourceAttemptId,kind='practice'}:{question:QuestionDetail;sourceAttemptId?:string;kind?:AnswerDraft['kind'];initialMode?:'practice'|'exam_style'}){
  const router=useRouter(),key=`roastduck_answer_draft:${question.id}:${kind}:${sourceAttemptId??''}`;
  const [values,setValues]=useState<Values>(empty),[draft,setDraft]=useState<AnswerDraft|null>(null),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[status,setStatus]=useState(''),[error,setError]=useState('');
  const [chineseReminder,setChineseReminder]=useState(false);
  const row=useRef<AnswerDraft|null>(null),recovery=useRef<AnswerDraft|null>(null),input=useRef(values),clientId=useRef(''),saving=useRef<Promise<AnswerDraft>|null>(null),mounted=useRef(true),locked=useRef(false),changed=useRef(false);
  const store=useCallback((next:Values)=>{try{if(!sensitive(next))localStorage.setItem(key,JSON.stringify({clientId:clientId.current,draftId:row.current?.id,version:row.current?.version,values:next}));}catch{/* Server save stays authoritative. */}},[key]);
  useEffect(()=>{
    mounted.current=true;let cancelled=false;
    void(async()=>{try{
      let local:LocalDraft|null=null;try{const parsed=localDraftSchema.safeParse(JSON.parse(localStorage.getItem(key)??'null'));if(parsed.success)local=parsed.data;}catch{/* Malformed local metadata is not a saved answer. */}
      clientId.current=local?.clientId||crypto.randomUUID();
      if(local){input.current=local.values;setValues(local.values);}
      const list=await request(`/api/answer-drafts?questionId=${encodeURIComponent(question.id)}`);
      let found=local?.draftId?(list.drafts as AnswerDraft[]).find(d=>d.id===local?.draftId):(list.drafts as AnswerDraft[]).find(d=>d.kind===kind&&d.source_attempt_id===(sourceAttemptId??null));
      if(!found&&local?.draftId){const result=await request(`/api/answer-drafts/${encodeURIComponent(local.draftId)}`);found=result.draft;}
      if(cancelled)return;
      if(found?.submitted_attempt_id){localStorage.removeItem(key);router.replace(`/questions/${question.id}/attempts/${found.submitted_attempt_id}`);return;}
      let original:Values=empty;
      if(!local&&!found&&kind==='edit'&&sourceAttemptId){const source=await request(`/api/speaking-practice/attempts/${encodeURIComponent(sourceAttemptId)}`);if(source.attempt.questionId!==question.id)throw new Error('原回答不属于当前题目');original={english:source.attempt.answerText,chinese:source.attempt.intendedMeaningZh,englishUnknown:!source.attempt.answerText.trim()};}
      if(cancelled)return;
      const next=local?.values??(found?fromDraft(found):original);
      row.current=found??null;setDraft(found??null);input.current=next;setValues(next);
      if(local?.values&&found&&local.version!==undefined&&found.version>local.version&&JSON.stringify(next)!==JSON.stringify(fromDraft(found))){
        setError('另一窗口已更新草稿。你的未保存文字已保留，请先复制需要的内容，再恢复服务器版本。');locked.current=true;recovery.current=found;
      }
      setStatus(local?'已恢复本机草稿，请确认内容':found?'已恢复保存的草稿':'输入后自动保存；不会自动调用 AI');
    }catch(reason){if(!cancelled){locked.current=true;setError(reason instanceof Error?reason.message:'读取草稿失败');}}finally{if(!cancelled)setLoading(false);}})();
    return()=>{cancelled=true;mounted.current=false;};
  },[key,question.id,kind,sourceAttemptId,router]);
  const save=useCallback(async function saveLatest():Promise<AnswerDraft>{
    if(locked.current)throw new Error('请先恢复服务器状态，未保存文字仍然保留');
    if(saving.current){await saving.current;return saveLatest();}
    if(row.current?.submitted_attempt_id)return row.current;
    const snapshot={...input.current};
    const work=(async()=>{
      if(sensitive(snapshot))throw new Error('输入疑似包含密钥或凭证，请移除后保存');
      if(!row.current){const created=await request('/api/answer-drafts','POST',{questionId:question.id,clientId:clientId.current,kind,sourceAttemptId:sourceAttemptId??null});row.current=created.draft;store(input.current);}
      let response;
      try{response=await request(`/api/answer-drafts/${row.current!.id}`,'PATCH',kind==='independent'?{english:snapshot.english,chinese:snapshot.chinese,englishUnknown:snapshot.englishUnknown,version:row.current!.version}:{inputText:snapshot.inputText??combined(snapshot),version:row.current!.version});}
      catch(error){if(error instanceof Error&&'code' in error){
        if(error.code==='draft_submitted'){const latest=await request(`/api/answer-drafts/${row.current!.id}`);row.current=latest.draft;return latest.draft as AnswerDraft;}
        if(error.code==='draft_version_conflict'||error.code==='english_committed'){locked.current=true;const latest=await request(`/api/answer-drafts/${row.current!.id}`);recovery.current=latest.draft;}
      }throw error;}
      row.current=response.draft;store(input.current);
      if(mounted.current){setDraft(response.draft);setStatus(JSON.stringify(input.current)===JSON.stringify(snapshot)?'已保存到本机':'还有改动正在保存');}
      return response.draft as AnswerDraft;
    })();saving.current=work;
    try{return await work;}finally{if(saving.current===work)saving.current=null;}
  },[kind,question.id,sourceAttemptId,store]);
  useEffect(()=>{if(loading||busy||!changed.current||locked.current)return;const timer=setTimeout(()=>{void save().catch(reason=>{if(mounted.current){setStatus('尚未保存到服务端');setError(reason.message);}});},650);return()=>clearTimeout(timer);},[values,loading,busy,save]);
  function update(next:Values){input.current=next;setValues(next);changed.current=true;setStatus('正在保存…');store(next);}
  async function act(action:'commitEnglish'|'submit',skipChineseReminder=false){
    if(action==='submit'&&kind!=='independent'&&!skipChineseReminder&&!/[\u3400-\u9fff]/u.test(values.inputText??combined(values))){setChineseReminder(true);return;}
    if(busy||locked.current)return;setBusy(true);setError('');
    try{const current=await save();const result=await request(`/api/answer-drafts/${current.id}`,'POST',{action,version:current.version});
      if(action==='submit'){localStorage.removeItem(key);router.push(`/questions/${question.id}/attempts/${result.attemptId}`);}
      else{row.current=result.draft;setDraft(result.draft);store(input.current);setStatus('英文已封存，可以补充中文原意，也可直接分析');}
    }catch(reason){setStatus('操作尚未确认，原输入保留');setError(reason instanceof Error?reason.message:'请重试');}finally{setBusy(false);}
  }
  const independent=kind==='independent',committed=!!draft?.english_committed_at;
  return <div className="studio-shell"><div className="studio-frame"><header className="studio-header"><Link href={`/questions/${question.id}`} className="exit-button">← 返回题目</Link><span>{independent?'无提示重答':kind==='edit'?'编辑回答':'本次作答'}</span></header>
    <div className="studio-layout"><aside className="studio-question-panel"><p className="quiet">IELTS Speaking · Part {question.part}</p><h2 className="studio-question-title" lang="en">{question.textEn}</h2><p>{question.textZh}</p><SpeakButton text={question.textEn} label="播放题目"/><p className="guidance-box">{independent?'只看题目，先用自己的英文回答。这里不会展示旧答案或提示。':'先说清你想表达什么。中文、英文，或者混着说都可以；不用把同一份答案再写一遍。'}</p></aside>
    <section className="studio-editor-panel" aria-busy={loading||busy}><h1>{independent?'先记录这一次的英文':'你想表达什么？'}</h1>{loading?<p role="status">正在恢复草稿…</p>:<>
      {error&&<div className="error-banner" role="alert"><p>{error}</p>{locked.current?<button type="button" onClick={()=>{const current=recovery.current;if(current){const next=fromDraft(current);row.current=current;setDraft(current);recovery.current=null;locked.current=false;update(next);setError('');}else window.location.reload();}}>恢复服务器版本（先复制未保存文字）</button>:<button type="button" disabled={busy} onClick={()=>void save().then(saved=>{if(saved.submitted_attempt_id)router.push(`/questions/${question.id}/attempts/${saved.submitted_attempt_id}`);else setError('');}).catch(reason=>setError(reason.message))}>重试保存草稿</button>}</div>}
      {!independent?<div className="input-group"><label htmlFor="input-thoughts"><strong>我的回答与想法</strong></label><textarea id="input-thoughts" value={values.inputText??combined(values)} rows={10} maxLength={16000} disabled={busy} onChange={e=>update({...values,inputText:e.target.value})} placeholder="可以先用中文说清自己的想法，也可以加入英文尝试。只写中文也能开始。"/><p className="quiet">可用 Win + H 或输入法麦克风直接说。应用不会主动请求录音权限。</p></div>:<div className="input-group"><label htmlFor="input-answer"><strong>我的英文尝试</strong></label><textarea id="input-answer" value={values.english} rows={6} maxLength={16000} disabled={busy||committed||values.englishUnknown} onChange={e=>update({...values,english:e.target.value})} placeholder="用你现在会的英文回答。不完整、卡住都没关系。"/><label><input type="checkbox" disabled={busy||committed} checked={values.englishUnknown} onChange={e=>update({...values,englishUnknown:e.target.checked})}/>暂时不会用英文表达</label><p className="quiet">可使用 Win + H 或输入法麦克风。应用不会主动请求录音权限。</p></div>}
      {independent&&committed&&<div className="input-group"><label htmlFor="input-intention"><strong>我真正想表达的中文意思（可选）</strong></label><textarea id="input-intention" value={values.chinese} rows={5} maxLength={16000} disabled={busy} onChange={e=>update({...values,chinese:e.target.value})} placeholder="写下你自己的事实、观点和细节，不必逐字翻译。"/><p>不填写时，只分析这次英文能证明的问题，不借用旧中文答案。</p></div>}
      {chineseReminder&&!independent&&<section className="page-panel" aria-label="补充中文原意"><h2>用中文补充一下，会更贴近你的想法</h2><p>中文帮助AI理解你想说什么；英文尝试帮助发现哪里需要练习。不补充也可以继续。</p><div className="row-actions"><button type="button" className="secondary-button" onClick={()=>{setChineseReminder(false);document.getElementById('input-thoughts')?.focus();}}>回去补充中文</button><button type="button" className="secondary-button" disabled={busy} onClick={()=>void act('submit',true)}>仅根据英文继续</button></div></section>}
      <p role="status" className="quiet">{status}</p><div className="studio-submit-row"><button className="primary-button" disabled={busy||locked.current||(independent?(!values.english.trim()&&!values.englishUnknown):!(values.inputText??combined(values)).trim())} onClick={()=>void act(independent&&!committed?'commitEnglish':'submit')}>{busy?'正在保存…':independent&&!committed?'封存英文，再继续':'保存并分析我的表达'}</button></div><p className="quiet">原回答先保存，再分析；分析使用你的 API，页面可以离开后再回来。</p>
    </>}</section></div></div></div>;
}

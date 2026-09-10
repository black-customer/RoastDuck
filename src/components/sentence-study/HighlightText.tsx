'use client';

import {createElement,useCallback,useEffect,useId,useMemo,useRef,useState,type Ref} from 'react';
import type {SentenceCard} from '@/lib/sentence-study/contracts';
import {HighlightController,type HighlightClientState} from '@/lib/sentence-study/highlights-client';
import {highlightSegments,type SentenceHighlight} from '@/lib/sentence-study/highlights';
import styles from './HighlightText.module.css';

interface Props {
  card:Pick<SentenceCard,'id'|'version'|'chinese'|'english'|'usages'>;
  language:'zh'|'en';as?:'h1'|'h2'|'h3'|'p'|'div';className?:string;
  initialHighlights?:SentenceHighlight[];headingRef?:Ref<HTMLElement>;
  aiRanges?:Array<{start:number;end:number}>;
}
type SelectionAction={kind:'add';start:number;end:number;quote:string}|{kind:'remove';ids:string[];pending:boolean};
const initialState=(highlights:SentenceHighlight[],language:'zh'|'en'):HighlightClientState=>({highlights:highlights.filter(mark=>mark.language===language),pendingCount:0,syncing:false,error:'',notice:''});

/** Selection offsets cover only the sentence; controls never become part of the selected text. */
export function HighlightText({card,language,as='p',className,initialHighlights,headingRef,aiRanges}:Props){
  const text=language==='zh'?card.chinese:card.english,id=useId(),root=useRef<HTMLElement|null>(null),controller=useRef<HighlightController|null>(null),toolbar=useRef<HTMLDivElement|null>(null);
  const [state,setState]=useState(()=>initialState(initialHighlights??[],language)),[action,setAction]=useState<SelectionAction|null>(null),[localError,setLocalError]=useState('');
  const mountedIdentity=useRef(''),identity=`${card.id}:${card.version}:${language}`;
  const keyboardRange=useRef({anchor:0,focus:0});
  const marks=mountedIdentity.current===identity?state.highlights:(initialHighlights??[]).filter(mark=>mark.language===language);
  const segments=useMemo(()=>highlightSegments(text,marks,aiRanges??(language==='en'?card.usages:[])),[text,marks,aiRanges,language,card.usages]);
  const saveRef=useCallback((node:HTMLElement|null)=>{root.current=node;if(typeof headingRef==='function')headingRef(node);else if(headingRef)headingRef.current=node;},[headingRef]);
  useEffect(()=>{
    mountedIdentity.current=identity;keyboardRange.current={anchor:0,focus:0};setState(initialState(initialHighlights??[],language));setAction(null);setLocalError('');
    let instance:HighlightController;
    try{instance=new HighlightController({sentenceId:card.id,textVersion:card.version,language},window.localStorage,setState,undefined,initialHighlights);controller.current=instance;void instance.load(initialHighlights!==undefined);}
    catch{setLocalError('浏览器无法读取高亮存储，学习仍可继续。');return;}
    const refresh=(event:StorageEvent)=>{if(event.key?.startsWith('roastduck_sentence_highlight_op:'))void instance.retry();};window.addEventListener('storage',refresh);
    return ()=>{instance.dispose();window.removeEventListener('storage',refresh);if(controller.current===instance)controller.current=null;};
  // A fresh sentence/version starts from its own bundled marks. A parent's unrelated
  // state render must not replace newer optimistic marks with the old bundle.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[card.id,card.version,language,identity]);
  const captureSelection=useCallback(()=>{
    const element=root.current,selection=window.getSelection();if(!element||!selection||selection.rangeCount!==1||selection.isCollapsed)return false;
    const range=selection.getRangeAt(0);if(!element.contains(range.startContainer)||!element.contains(range.endContainer))return false;
    const before=document.createRange();before.selectNodeContents(element);before.setEnd(range.startContainer,range.startOffset);const start=before.toString().length,end=start+range.toString().length,quote=text.slice(start,end);
    if(!quote.trim()||text.slice(start,end)!==selection.toString())return false;
    setAction(previous=>previous?.kind==='add'&&previous.start===start&&previous.end===end&&previous.quote===quote?previous:{kind:'add',start,end,quote});if(controller.current)setLocalError('');return true;
  },[text]);
  useEffect(()=>{
    let frame:number|undefined;
    const changed=()=>{if(frame!==undefined)cancelAnimationFrame(frame);frame=requestAnimationFrame(()=>captureSelection());};
    document.addEventListener('selectionchange',changed);
    return ()=>{document.removeEventListener('selectionchange',changed);if(frame!==undefined)cancelAnimationFrame(frame);};
  },[captureSelection]);
  function captureAfterTouch(){requestAnimationFrame(()=>captureSelection());}
  function keyboardSelect(event:React.KeyboardEvent){
    if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)||event.altKey||event.metaKey)return;
    const element=root.current;if(!element)return;event.preventDefault();
    const positions=[0];for(const char of text)positions.push(positions.at(-1)!+char.length);
    const old=keyboardRange.current,index=Math.max(0,positions.indexOf(old.focus));
    const next=event.key==='Home'?0:event.key==='End'?text.length:positions[Math.max(0,Math.min(positions.length-1,index+(event.key==='ArrowRight'?1:-1)))];
    keyboardRange.current={anchor:event.shiftKey?old.anchor:next,focus:next};
    const locate=(offset:number)=>{const walker=document.createTreeWalker(element,NodeFilter.SHOW_TEXT);let remaining=offset,node:Node|null;while((node=walker.nextNode())){const length=node.textContent?.length??0;if(remaining<=length)return {node,offset:remaining};remaining-=length;}return {node:element as Node,offset:element.childNodes.length};};
    const anchor=locate(keyboardRange.current.anchor),focus=locate(next);
    window.getSelection()?.setBaseAndExtent(anchor.node,anchor.offset,focus.node,focus.offset);
    if(event.shiftKey)captureSelection();else setAction(null);
  }
  function markClick(ids:string[]){if(captureSelection())return;setAction({kind:'remove',ids,pending:ids.some(markId=>markId.startsWith('pending:'))});}
  function saveSelection(){
    if(!action)return;if(!controller.current){setLocalError('浏览器无法读取高亮存储，请允许本机存储后重新打开当前句子。');return;}
    try{
      const accepted=action.kind==='add'?controller.current.add({start:action.start,end:action.end,quote:action.quote}):action.ids.every(markId=>controller.current!.remove(markId));
      if(accepted){window.getSelection()?.removeAllRanges();setAction(null);root.current?.focus({preventScroll:true});}
    }catch(error){setLocalError(error instanceof Error?error.message:'高亮尚未保存，请重试');}
  }
  const children=segments.map(segment=>{
    const manual=segment.manualIds.length>0,cls=[manual?styles.manual:'',segment.ai?styles.automatic:''].filter(Boolean).join(' ');
    return manual?<mark key={segment.start} className={cls} onClick={()=>markClick(segment.manualIds)} title="个人高亮；点击后可取消" data-highlight-id={segment.manualIds.join(' ')}>{segment.text}</mark>:<span key={segment.start} className={cls||undefined}>{segment.text}</span>;
  });
  const message=localError||state.error;
  return <div className={styles.wrapper}>
    {createElement(as,{ref:saveRef,className,lang:language==='en'?'en':'zh',tabIndex:0,'aria-describedby':`${id}-hint`,'aria-keyshortcuts':'Alt+H',onMouseUp:captureSelection,onTouchEnd:captureAfterTouch,onKeyUp:(event:React.KeyboardEvent)=>{if(event.shiftKey)captureSelection();},onKeyDown:(event:React.KeyboardEvent)=>{keyboardSelect(event);if(event.key==='Escape'){setAction(null);window.getSelection()?.removeAllRanges();}if(event.altKey&&event.key.toLowerCase()==='h'){event.preventDefault();if(captureSelection())requestAnimationFrame(()=>toolbar.current?.querySelector('button')?.focus());}}},children)}
    <div className={styles.tools}>
      <span id={`${id}-hint`} className={styles.hint}>选中文字可高亮</span>
      <button type="button" className={styles.keyboardTool} onClick={()=>{if(!captureSelection()){root.current?.focus();setLocalError('可用鼠标或触屏选词；键盘可在正文中用 Shift＋方向键选择，再按 Alt＋H。');}else requestAnimationFrame(()=>toolbar.current?.querySelector('button')?.focus());}} aria-label={language==='zh'?'标记中文选区':'标记英文选区'}>标记选区</button>
      {state.highlights.some(mark=>!mark.pending)&&<details className={styles.management}><summary>管理高亮</summary><ul>{state.highlights.filter(mark=>!mark.pending).map(mark=><li key={mark.id}><span>{mark.quote}</span><button type="button" onClick={()=>{try{controller.current?.remove(mark.id);}catch(error){setLocalError((error as Error).message);}}} aria-label={`取消高亮：${mark.quote}`}>取消</button></li>)}</ul></details>}
    </div>
    {action&&<div ref={toolbar} className={styles.toolbar} role="toolbar" aria-label="文字高亮操作" onMouseDown={event=>event.preventDefault()}>
      <button type="button" className={styles.primary} disabled={Boolean(state.error)||action.kind==='remove'&&action.pending} onClick={saveSelection}>{action.kind==='add'?'高亮':action.pending?'保存中':'取消高亮'}</button>
      <button type="button" onClick={()=>{setAction(null);root.current?.focus({preventScroll:true});}}>关闭</button>
    </div>}
    {message&&<p role="status" className={styles.status}>{message} <button type="button" onClick={()=>{setLocalError('');void controller.current?.retry();}}>重试高亮保存</button></p>}
    {!message&&state.notice&&<p className={styles.status}>{state.notice}</p>}
  </div>;
}

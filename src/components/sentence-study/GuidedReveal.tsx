'use client';

import {Fragment, useEffect, useId, useMemo, useRef, useState} from 'react';
import styles from './GuidedReveal.module.css';

export function sentenceWords(text:string){return text.match(/\S+/gu)??[];}

interface Props {
  english:string;
  count:number;
  disabled?:boolean;
  onChange:(count:number)=>void;
  onCommit:()=>void;
}

/** Unseen words never enter the rendered text, attributes, clipboard or accessibility tree. */
export function GuidedReveal({english,count,disabled,onChange,onCommit}:Props){
  const words=useMemo(()=>sentenceWords(english),[english]),id=useId(),paragraph=useRef<HTMLParagraphElement>(null);
  const [widths,setWidths]=useState<number[]>([]),revealed=Math.max(0,Math.min(words.length,count));
  useEffect(()=>{
    let cancelled=false;
    const measure=()=>{
      if(cancelled||!paragraph.current)return;
      const style=getComputedStyle(paragraph.current),context=document.createElement('canvas').getContext('2d');
      if(!context)return;
      context.font=`${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const size=Number.parseFloat(style.fontSize);
      setWidths(words.map(word=>context.measureText(word).width/size));
    };
    measure();void document.fonts?.ready.then(measure);
    return()=>{cancelled=true;};
  },[words]);
  function change(next:number){if(!disabled)onChange(Math.max(0,Math.min(words.length,next)));}
  return <section className={styles.section} aria-label="按需揭晓英文">
    <p className={styles.hint} id={`${id}-hint`}>能说的先说，需要时往右揭一点。</p>
    <p ref={paragraph} className={styles.sentence} lang="en" data-testid="guided-english">
      {words.map((word,index)=><Fragment key={index}>
        {index>0?' ':null}
        <span className={index<revealed?styles.word:`${styles.word} ${styles.covered}`} style={{width:`${widths[index]??Math.max(.65,word.length*.5)}em`}} aria-hidden={index<revealed?undefined:true}>
          {index<revealed?word:<span className={styles.frost} />}
        </span>
      </Fragment>)}
    </p>
    <label className={styles.sliderLabel} htmlFor={id}><span>拖动揭晓</span><span>{revealed} / {words.length} 词</span></label>
    <input id={id} type="range" className={styles.slider} min={0} max={words.length} step={1} value={revealed} disabled={disabled}
      aria-label="揭晓英文进度" aria-describedby={`${id}-hint`} aria-valuetext={`已揭晓 ${revealed} 个词，共 ${words.length} 个词`}
      onChange={event=>change(Number(event.target.value))} onPointerUp={onCommit} onKeyUp={onCommit} onBlur={onCommit}/>
    <div className={styles.tools}>
      <button type="button" disabled={disabled||revealed===words.length} onClick={()=>{change(revealed+1);onCommit();}}>揭晓一点</button>
      <button type="button" disabled={disabled||revealed===words.length} onClick={()=>{change(words.length);onCommit();}}>全部揭晓</button>
      {revealed>0&&<button type="button" disabled={disabled} onClick={()=>{change(0);onCommit();}}>重新遮住</button>}
    </div>
  </section>;
}

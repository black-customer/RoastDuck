'use client';
import {useEffect,useState} from 'react';
export function SentenceSettings(){const [enabled,setEnabled]=useState(false),[error,setError]=useState('');useEffect(()=>{try{setEnabled(localStorage.getItem('roastduck_sentence_reexpress_v1')==='1');}catch{/* defaults off */}},[]);
  return <section className="settings-section"><div className="settings-section-copy"><h2>句子学习</h2><p>默认只需回想、揭晓和自评。输出练习由你选择。</p></div><label className="settings-switch-row"><span><strong>再表达一次</strong><small>开启后，每句自评后可以隐藏英文，再用自己的话表达。提交给老师时使用你的 API；始终可以跳过。</small></span><input type="checkbox" checked={enabled} onChange={e=>{try{localStorage.setItem('roastduck_sentence_reexpress_v1',e.target.checked?'1':'0');setEnabled(e.target.checked);setError('');}catch{setError('浏览器未能保存这个设置');}}}/><span className="settings-switch" aria-hidden="true"/></label>{error&&<p role="alert">{error}</p>}</section>;
}

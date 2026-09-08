'use client';
import {useState} from 'react';
export function DataBackupSettings(){
  const [password,setPassword]=useState(''),[file,setFile]=useState<File|null>(null),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[preview,setPreview]=useState<{added:number;conflicts:number}|null>(null);
  async function act(action:'export'|'preview'|'restore'){
    if(busy)return;setBusy(true);setMessage('');try{
      let archive:string|undefined;if(action!=='export'){if(!file)throw new Error('请选择备份文件');if(file.size>64*1024*1024)throw new Error('备份超过安全大小上限');const bytes=new Uint8Array(await file.arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=16384)binary+=String.fromCharCode(...bytes.subarray(i,i+16384));archive=btoa(binary);}
      const response=await fetch('/api/data-backup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,password,archive})});if(!response.ok){const data=await response.json();throw new Error(data.error);}
      if(action==='export'){const url=URL.createObjectURL(await response.blob()),a=document.createElement('a');a.href=url;a.download=`roastduck-${new Date().toISOString().slice(0,10)}.rdbackup`;a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);setMessage('已生成加密业务备份；不含 API Key、配对凭据和音频文件。');}
      else{const result=await response.json();if(action==='preview')setPreview(result);else{setPreview(null);setMessage(`已恢复 ${result.added} 条缺失记录；保留 ${result.conflicts} 条当前版本差异。没有覆盖现有资料，也没有启动 AI 任务。`);}}
    }catch(reason){setMessage(reason instanceof Error?reason.message:'备份未完成');}finally{setBusy(false);}
  }
  return <section className="settings-section"><h2>本机数据备份</h2><p>保存原回答、材料、备注和进度。密码无法找回；备份含私人学习内容，请自行妥善保管。</p><label className="settings-field">备份密码（至少 10 位）<input type="password" autoComplete="new-password" value={password} onChange={e=>{setPassword(e.target.value);setPreview(null);}}/></label><button className="secondary-button" disabled={busy||password.length<10} onClick={()=>void act('export')}>下载加密业务备份</button><label className="settings-field">恢复已有备份<input type="file" accept=".rdbackup" onChange={e=>{setFile(e.target.files?.[0]??null);setPreview(null);}}/></label><button disabled={busy||!file||password.length<10} onClick={()=>void act('preview')}>检查备份，不改数据</button>{preview&&<div><p>可补回 {preview.added} 条；{preview.conflicts} 条与当前版本不同，将保留当前版本。恢复前还会保留一份加密备份。</p><button className="primary-button" disabled={busy} onClick={()=>void act('restore')}>确认补回缺失记录</button></div>}{message&&<p role="status">{message}</p>}</section>;
}

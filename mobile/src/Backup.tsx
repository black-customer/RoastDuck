import {useState} from 'react';
import {registerPlugin} from '@capacitor/core';
import type {AppServices} from '@/lib/app-services';
import {createEncryptedBackup,restoreEncryptedBackup,toBase64,fromBase64} from '@/lib/device-sync/backup';
const files=registerPlugin<{exportFile(input:{payload:string}):Promise<{saved:boolean;bytes?:number}>;importFile():Promise<{cancelled?:boolean;payload?:string}>}>('RoastDuckBackup');
export function BackupPage({app}:{app:AppServices}){
  const [password,setPassword]=useState(''),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState('');
  async function run(action:'export'|'import'){
    if(busy)return;if(action==='import'&&!confirm('恢复会合并资料，不清空当前记录；旧备份不会覆盖较新的删除。确认继续？'))return;
    setBusy(true);setError('');setMessage(action==='export'?'正在加密资料…':'选择加密备份文件…');
    try{
      if(action==='export'){const bytes=await createEncryptedBackup(app.sync,password),result=await files.exportFile({payload:toBase64(bytes)});setMessage(result.saved?'加密备份已保存。请保管好文件和密码。':'已取消保存，原资料保留。');}
      else{const picked=await files.importFile();if(picked.payload){const result=await restoreEncryptedBackup(app.sync,fromBase64(picked.payload),password,setMessage);setMessage(`恢复完成，合并 ${result.restored} 条记录。API Key 与电脑配对需要另行设置。`);}else setMessage('已取消恢复。');}
      setPassword('');
    }catch(e){setError(e instanceof Error?e.message:'备份操作未完成');}finally{setBusy(false);}
  }
  return <><header className="page-heading"><h1>本机备份与恢复</h1></header><p>回答、材料、聊天和学习记录会加密保存。备份不包含 API Key、设备配对秘密或原始私人文件目录。</p><p className="quiet">声音缓存可以稍后从电脑同步。卸载前请先保存备份；密码无法找回。</p><label className="setting-row"><span>备份密码（至少 10 个字符）</span><input type="password" autoComplete="new-password" value={password} onChange={e=>setPassword(e.target.value)} aria-label="备份密码"/></label><div className="row-actions"><button className="primary-button" disabled={busy||password.length<10} onClick={()=>void run('export')}>加密并保存备份</button><button disabled={busy||password.length<10} onClick={()=>void run('import')}>选择文件恢复</button></div>{message&&<p role="status">{message}</p>}{error&&<div className="error-box" role="alert">{error}</div>}</>;
}

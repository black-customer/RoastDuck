import {useEffect,useRef,useState} from 'react';
import {z} from 'zod';
import type {AppServices} from '@/lib/app-services';
import {nativeSync} from '@/lib/platform/android/device-sync';
import {getStoredVoicePreference} from '@/lib/tts';
import {VOICE_PRESETS,type SpeechSynthesisInput} from '@/lib/speech/contracts';
import {speechContentHash} from '@/lib/speech/wire';
const inventorySchema=z.object({assets:z.array(z.object({contentHash:z.string(),bytes:z.number()}))});
export function AudioPage({app,materialId}:{app:AppServices;materialId?:string}){
  const [id,setId]=useState(materialId??''),[materials,setMaterials]=useState<Array<{id:string;title:string}>>([]),[inputs,setInputs]=useState<SpeechSynthesisInput[]>([]),[assets,setAssets]=useState<Array<{contentHash:string;bytes:number}>>([]),[busy,setBusy]=useState(false),[error,setError]=useState(''),[progress,setProgress]=useState('');
  const stopped=useRef(false);useEffect(()=>()=>{stopped.current=true;},[]);
  const reload=async()=>setAssets(inventorySchema.parse(await nativeSync.mediaInventory()).assets);
  useEffect(()=>{void app.recent().then(result=>setMaterials(result.materials.filter(row=>row.status==='ready')));void reload().catch(e=>setError(e.message));},[app]);
  useEffect(()=>{let live=true;setInputs([]);if(id)void app.expressions.list('',{type:'material',id}).then(rows=>{
    const voice=VOICE_PRESETS.find(row=>row.id===getStoredVoicePreference())!,texts=[...new Set(rows.flatMap(row=>[row.english,row.sentenceEn]))];if(live)setInputs(texts.map(text=>({text,voice:voice.mimoVoice,accent:voice.accent,purpose:'example',rate:.95})));
  }).catch(e=>{if(live)setError(e.message);});return()=>{live=false;};},[app,id]);
  const missing=inputs.filter(input=>!assets.some(asset=>asset.contentHash===speechContentHash(input,input.voice!)));
  async function download(){
    if(busy||!app.speech||!confirm(`将为这份材料准备 ${missing.length} 段尚未缓存的声音，可能使用 MiMo 余额。不会生成其他材料的声音。继续吗？`))return;
    setBusy(true);setError('');try{let completed=0;for(const input of missing){if(stopped.current)break;await app.speech.prepare(input,{regenerateMissing:true});if(!stopped.current)setProgress(`已准备 ${++completed} / ${missing.length} 段声音`);}if(!stopped.current)await reload();}catch(e){if(!stopped.current)setError(e instanceof Error?e.message:'声音暂未准备好；已完成的缓存保留');}finally{if(!stopped.current)setBusy(false);}
  }
  return <><header className="page-heading"><h1>离线声音</h1></header><p>已有 {assets.length} 段缓存，约 {(assets.reduce((sum,item)=>sum+item.bytes,0)/1024/1024).toFixed(1)} MB。声音失败不影响文字学习。</p><label className="setting-row"><span>只准备这一份材料</span><select value={id} onChange={e=>setId(e.target.value)} disabled={busy}><option value="">选择最近的材料</option>{materials.map(row=><option key={row.id} value={row.id}>{row.title}</option>)}</select></label>{id&&<><p>当前声线：{VOICE_PRESETS.find(row=>row.id===getStoredVoicePreference())?.label}。这份材料还有 {missing.length} 段声音未缓存。</p><button className="primary-button" disabled={busy||!missing.length} onClick={()=>void download()}>下载本次表达与例句声音</button></>}{progress&&<p role="status">{progress}</p>}{error&&<div className="error-box" role="alert">{error}<button onClick={()=>void reload().catch(e=>setError(e.message))}>重新读取缓存</button></div>}<details className="details"><summary>管理已有缓存</summary><p className="quiet">只删除本机声音，不删除学习材料；可以之后从电脑重新同步。</p>{assets.map((asset,index)=><div className="setting-row" key={asset.contentHash}><span>声音 {index+1} · {Math.round(asset.bytes/1024)} KB</span><button disabled={busy} onClick={()=>{if(confirm('移除这段本机声音？文字材料与学习进度保留。'))void nativeSync.removeAudio({contentHash:asset.contentHash}).then(reload).catch(e=>setError(e.message));}}>移除缓存</button></div>)}</details></>;
}

/** Explicitly authorized listening experiment; never invoked by automated tests or the application. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {MimoTtsProvider} from '../src/lib/speech/mimo-provider';
import {readSpeechEnvironment} from '../src/lib/speech/config';
import {buildMimoBody} from '../src/lib/speech/wire';

if(!process.argv.includes('--execute-four-samples'))throw new Error('需要明确授权 --execute-four-samples；本脚本不自动执行');
if(process.env.VITEST||process.env.ROASTDUCK_E2E==='1'||process.env.AI_PROVIDER==='mock'||process.env.NODE_ENV==='test')throw new Error('自动化环境禁止真实试听');
const require=createRequire(import.meta.url);
require('@next/env').loadEnvConfig(process.cwd(),true,{info(){},error(){}});
if(process.env.AI_PROVIDER==='mock'||process.env.ROASTDUCK_E2E==='1'||process.env.VITEST||process.env.NODE_ENV==='test')throw new Error('本机配置选择了自动化模式，不执行真实试听');
const config=readSpeechEnvironment();
if(!config.apiKey||new URL(config.baseUrl).origin!=='https://api.xiaomimimo.com')throw new Error('需要本机已配置的官方 MiMo 服务；未发出请求');
const root=path.resolve('data/audio/prosody-preview-20260908');
await fs.mkdir(root,{recursive:true});
const vlog="So I went to that little coffee shop near my apartment this morning, thinking I'd finally get some studying done. I found a table, ordered a coffee, opened my laptop... and realized my charger was still at home. The battery had, like, twelve percent left. I actually considered walking back, but I'd just paid for the coffee. So I stayed, made some notes on paper, and honestly, it was a pretty decent hour.";
const preserve="Speak only the supplied English text, preserving its words and existing fillers. Do not speak these instructions or add a preamble, extra filler words, other characters, or background sounds. Use natural General American English.";
const samples=[
  {id:'01-vlog-baseline',title:'A：vlog，同文普通指令',scene:'普通人在镜头前分享忘带充电器的小插曲。',text:vlog,instruction:buildMimoBody({text:vlog,purpose:'example',accent:'en-US',rate:.95},'Chloe').messages[0].content},
  {id:'02-vlog-conversational',title:'B：vlog，同文会话指令',scene:'与A完全相同的文字和声线，仅调整表演指令。',text:vlog,instruction:`You're casually telling a friend what happened this morning, as if speaking spontaneously into a vlog camera. Understated, relaxed, slightly amused at forgetting the charger. Use connected conversational phrasing, light reductions on unstressed words, and varied phrase lengths. Briefly hesitate after "laptop"; put a little contrast on "still at home" and "twelve percent". Let "like" and "honestly" pass lightly, not as emphatic vocabulary words. No announcer cadence, teaching voice, sing-song intonation, or dramatic ending. ${preserve}`},
  {id:'03-phone-reschedule',title:'电话改期：通话中的一方',scene:'打电话给考试中心改期；只包含本人发言，短暂停顿表示听对方说话。',text:"Hi, I'm calling about my test appointment for next Friday. Something's come up at work, and I was hoping to move it to the following week. Yeah, either Tuesday or Thursday would work for me. Um, is there a morning slot on Thursday? Okay, ten thirty sounds good. Before we change it, could you tell me if there's a fee? Right, that's fine. And will I get an updated confirmation by email, or should I check my account?",instruction:`You're one person on a real phone call to a test center, politely sorting out an appointment, not reading a customer-service script. Sound practical and friendly, with short listening pauses before "Yeah", "Okay", and "Right". Let the question intonation rise naturally, especially around the Thursday slot and confirmation email. Give the dates and "ten thirty" enough emphasis to be clear; keep connecting words light and fluent. "Um" is a small moment of thought, not theatrical uncertainty. Clean close-microphone audio, no telephone filter or second voice. ${preserve}`},
  {id:'04-podcast-reflection',title:'播客访谈：边想边回答',scene:'受访者谈为什么开始喜欢独自散步，不是励志演讲。',text:"Well, I used to think walking alone would feel a little awkward, like I needed somewhere to go. Then I started taking a short walk after work, mostly because I'd been sitting all day. And I liked not having to talk. I mean, I enjoy seeing people, but sometimes I'm still sorting out the day in my head. Now I'll take the long way home, maybe stop for groceries. It's nothing special. I just tend to feel less restless afterward.",instruction:`You're answering a podcast host's casual question about why you started enjoying walks alone. Think aloud naturally, with a thoughtful but unpolished conversational rhythm. "Well" opens the thought gently. Briefly pause after "not having to talk" before clarifying with "I mean". Vary the pace instead of giving every sentence the same rise and fall. Lightly emphasize "less restless"; end matter-of-factly, not like an inspirational speech. No exaggerated breathiness or performative hesitation. ${preserve}`},
];
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const reportPath=path.join(root,'results.json');
type Result={id:string;status:'requesting'|'completed'|'failed';requestHash:string;elapsedMs?:number;durationSeconds?:number;words?:number;file?:string;bytes?:number;sha256?:string;responseId?:string|null;errorCode?:string};
const results:Result[]=await fs.readFile(reportPath,'utf8').then(JSON.parse).catch(error=>{if(error.code==='ENOENT')return [];throw error;});
const report=async()=>{const tmp=reportPath+'.tmp';await fs.writeFile(tmp,JSON.stringify(results,null,2));await fs.rename(tmp,reportPath);};
const scriptFile=path.join(root,'scripts.json');
const scriptBody=JSON.stringify({kind:'original_listening_experiment_not_published_learning_material',provider:'mimo',model:config.model,voice:'Chloe',accent:'en-US',maximumRequests:4,samples},null,2);
try{await fs.writeFile(scriptFile,scriptBody,{flag:'wx'});}catch(error){if(!(error&&typeof error==='object'&&'code' in error&&error.code==='EEXIST'))throw error;if(await fs.readFile(scriptFile,'utf8')!==scriptBody)throw new Error('保留旧试听文案，不覆盖不同版本');}
for(const sample of samples){
  const requestHash=hash(JSON.stringify([config.model,'Chloe',sample.text,sample.instruction])),prior=results.find(r=>r.id===sample.id);
  if(prior){if(prior.requestHash!==requestHash)throw new Error('样稿已经变化，不覆盖旧结果或自动重复合成');console.log(JSON.stringify({...prior,reusedCheckpoint:true}));continue;}
  if(results.length>=4)throw new Error('达到本次授权的4次请求上限');
  const result:Result={id:sample.id,status:'requesting',requestHash};results.push(result);await report();
  console.log(JSON.stringify({id:sample.id,status:'requesting',words:sample.text.split(/\s+/).length}));
  const started=Date.now();
  try{
    const provider=new MimoTtsProvider({apiKey:config.apiKey,baseUrl:config.baseUrl,timeoutMs:150000,fetchImpl:async(url,init)=>{
      const body=JSON.parse(String(init?.body));body.messages[0].content=sample.instruction;
      return fetch(url,{...init,body:JSON.stringify(body)});
    }});
    const audio=await provider.synthesize({text:sample.text,purpose:'example',voice:'Chloe',accent:'en-US',rate:.95});
    result.elapsedMs=Date.now()-started;
    const file=path.join(root,`${sample.id}.wav`);await fs.writeFile(file+'.tmp',audio.bytes,{flag:'wx'});await fs.rename(file+'.tmp',file);
    const info=JSON.parse(execFileSync('ffprobe',['-v','error','-show_entries','format=duration','-of','json',file],{encoding:'utf8',windowsHide:true}));
    Object.assign(result,{status:'completed',file,bytes:audio.bytes.length,sha256:hash(audio.bytes),responseId:audio.responseId,durationSeconds:Number(info.format.duration),words:sample.text.split(/\s+/).length});
  }catch(error){result.status='failed';result.elapsedMs=Date.now()-started;result.errorCode=error&&typeof error==='object'&&'code' in error?String(error.code):'preview_failed';}
  await report();console.log(JSON.stringify(result));
}
if(results.some(result=>result.status!=='completed'))process.exitCode=1;

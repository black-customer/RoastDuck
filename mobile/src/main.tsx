import {createRoot} from "react-dom/client";
import {openNativeDatabase} from "@/lib/platform/android/database";
import {AndroidAiProvider} from "@/lib/platform/android/ai-provider";
import {createAndroidSpeech} from "@/lib/platform/android/speech";
import {installQuestionBank} from "@/lib/platform/android/question-bank";
import {createAppServices} from "@/lib/app-services";
import bank from "@public-question-bank";
import {loadPrompt} from "./prompts";
import {MobileApp} from "./App";
import "./styles.css";
const root=createRoot(document.getElementById("root")!);
async function boot(){
  root.render(<main className="boot-screen"><h1>鱼块学英语</h1><p role="status">正在打开本机资料…</p></main>);
  try{
    const {database}=await openNativeDatabase();await installQuestionBank(database,bank);
    const services=await createAppServices({database,provider:new AndroidAiProvider(),speech:createAndroidSpeech(database),now:()=>new Date(),newId:()=>crypto.randomUUID(),bootId:crypto.randomUUID(),loadPrompt});
    if((await services.recent()).materials.length)try{localStorage.setItem('roastduck_mobile_setup','1');}catch{/* A preference write cannot block local learning. */}
    root.render(<MobileApp services={services}/>);
  }catch(error){root.render(<main className="boot-screen"><h1>暂时无法打开本机资料</h1><p role="alert">{error instanceof Error?error.message:"读取失败，原资料没有删除"}</p><button className="primary-button" onClick={()=>void boot()}>重新打开</button></main>);}
}
void boot();

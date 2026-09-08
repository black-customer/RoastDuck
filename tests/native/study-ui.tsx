import {createRoot} from "react-dom/client";
import {LightStudyPanel} from "../../src/components/light-study/LightStudyPanel";
import {createLightService} from "../../src/lib/light-study/core-service";
import {LightAudioPlayer} from "../../src/lib/light-study/audio";
import {createBrowserSpeechProvider,getStoredVoicePreference,setStoredVoicePreference} from "../../src/lib/tts";
import type {DatabasePort} from "../../src/lib/platform/database";
import type {LightStudyClient,LightLink} from "../../src/lib/light-study/client";
import "../../src/app/tokens.css";
import "../../src/app/ui.css";
import "./study-ui.css";

/** Internal native UI exercise: production has no mock client or synthetic fixture import. */
export async function mountNativeStudy(database:DatabasePort) {
  const service=createLightService(database,{now:()=>new Date("2026-09-09T08:00:00Z"),newId:()=>crypto.randomUUID(),enabled:()=>true,allowMock:true});
  const client:LightStudyClient={
    overview:service.lightOverview,get:service.getLightView,create:service.createLightSession,event:service.applyLightEvent,
    autoPlay:async()=>false,voice:getStoredVoicePreference,setVoice:setStoredVoicePreference,
    // Test harness must never make real synthesis requests. Device speech is labelled as fallback.
    audio:update=>new LightAudioPlayer(createBrowserSpeechProvider(),update,async()=>new Response("{}",{status:503})),
    rememberSession:()=>undefined,
  };
  const session=await service.createLightSession({scope:{type:"all"},mode:"review",clientRequestId:`ui-${crypto.randomUUID()}`});
  const root=document.createElement("div");root.className="native-study-test";document.body.replaceChildren(root);
  const Link:LightLink=({children,...props})=><a {...props} href="#" onClick={event=>{event.preventDefault();window.location.reload();}}>{children}</a>;
  createRoot(root).render(<LightStudyPanel scope={{type:"all"}} initialSessionId={session.id} client={client} Link={Link}/>);
}

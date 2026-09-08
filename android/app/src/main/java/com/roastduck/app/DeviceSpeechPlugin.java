package com.roastduck.app;
import android.net.Uri;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import com.getcapacitor.*;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.Locale;

@CapacitorPlugin(name="RoastDuckDeviceSpeech")
public class DeviceSpeechPlugin extends Plugin {
    private TextToSpeech engine;private boolean ready=false,failed=false,closed=false;private String currentId,queuedText,queuedLocale;
    private void event(String id,boolean success){JSObject result=new JSObject();result.put("id",id);result.put("success",success);notifyListeners("finished",result);}
    @PluginMethod public void speak(PluginCall call){
        if(getActivity()==null){call.reject("页面已关闭");return;}
        getActivity().runOnUiThread(()->{
            String page=getBridge().getWebView()==null?null:getBridge().getWebView().getUrl();Uri uri=page==null?null:Uri.parse(page);
            if(closed||uri==null||!"https".equals(uri.getScheme())||!"localhost".equals(uri.getHost())||uri.getPort()!=-1){call.reject("只允许本机设备声音");return;}
            String text=call.getString("text",""),id=call.getString("id","");if(text.isBlank()||text.length()>4000){call.reject("声音文本无效");return;}
            currentId=id;queuedText=text;queuedLocale=call.getString("locale","en-US");
            if(engine==null){engine=new TextToSpeech(getContext(),status->{if(closed)return;ready=status==TextToSpeech.SUCCESS;failed=!ready;if(ready){engine.setOnUtteranceProgressListener(new UtteranceProgressListener(){public void onStart(String id){}public void onDone(String id){event(id,true);}public void onError(String id){event(id,false);}});}playQueued();});}
            else playQueued();call.resolve();
        });
    }
    private void playQueued(){
        if(closed||currentId==null)return;if(failed){event(currentId,false);queuedText=null;return;}if(!ready||queuedText==null)return;
        String id=currentId,text=queuedText;queuedText=null;
        int language=engine.setLanguage(Locale.forLanguageTag("en-GB".equals(queuedLocale)?"en-GB":"en-US"));
        if(language==TextToSpeech.LANG_MISSING_DATA||language==TextToSpeech.LANG_NOT_SUPPORTED){event(id,false);return;}
        engine.setSpeechRate(.95f);if(engine.speak(text,TextToSpeech.QUEUE_FLUSH,null,id)==TextToSpeech.ERROR)event(id,false);
    }
    @PluginMethod public void stop(PluginCall call){if(currentId!=null&&currentId.equals(call.getString("id",""))){currentId=null;queuedText=null;if(engine!=null)engine.stop();}call.resolve();}
    @Override protected void handleOnPause(){currentId=null;queuedText=null;if(engine!=null)engine.stop();}
    @Override protected void handleOnDestroy(){closed=true;currentId=null;queuedText=null;if(engine!=null)engine.shutdown();}
}

package com.roastduck.app;
import android.net.Uri;
import android.util.Base64;
import com.getcapacitor.*;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.*;
import javax.net.ssl.HttpsURLConnection;
import java.net.URL;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;

@CapacitorPlugin(name="RoastDuckSpeech")
public class SpeechPlugin extends Plugin {
    private AudioStore store;private SecretVault vault;private volatile boolean stopped;
    private final ExecutorService synthesis=new ThreadPoolExecutor(1,1,0,TimeUnit.MILLISECONDS,new ArrayBlockingQueue<>(8));
    private final ExecutorService reader=Executors.newSingleThreadExecutor();
    private final Set<String> active=ConcurrentHashMap.newKeySet();
    @Override public void load(){vault=new SecretVault(getContext());try{store=AudioStore.open(getContext());}catch(Exception ignored){store=null;}}
    private void local(PluginCall call,Runnable work){
        if(getActivity()==null||stopped){call.reject("页面已关闭","activity_unavailable");return;}
        getActivity().runOnUiThread(()->{
            if(stopped||getActivity()==null||getActivity().isDestroyed()){call.reject("页面已关闭","activity_unavailable");return;}
            String url=getBridge().getWebView()==null?null:getBridge().getWebView().getUrl();Uri uri=url==null?null:Uri.parse(url);
            if(store==null||uri==null||!"https".equals(uri.getScheme())||!"localhost".equals(uri.getHost())||uri.getPort()!=-1){call.reject("只允许本机声音请求","untrusted_origin");return;}work.run();
        });
    }
    private void resolve(PluginCall call,JSONObject asset,boolean cached) throws Exception {JSObject output=new JSObject();output.put("available",asset!=null);if(asset!=null){output.put("asset",new JSObject(asset.toString()));output.put("cached",cached);}call.resolve(output);}
    @PluginMethod public void lookup(PluginCall call){local(call,()->{try{reader.execute(()->{try{resolve(call,store.lookup(call.getString("contentHash","")),true);}catch(Exception error){call.reject("声音缓存暂不可读","cache_unavailable");}});}catch(RejectedExecutionException error){call.reject("声音服务已暂停","activity_unavailable");}});}
    @PluginMethod public void synthesize(PluginCall call){local(call,()->{
        String key=call.getString("contentHash",""),descriptor=call.getString("descriptor",""),body=call.getString("body","");
        try{validate(key,descriptor,body);}catch(Exception error){call.reject("声音参数不合法","invalid_request");return;}
        if(!active.add(key)){call.reject("这段声音正在准备","synthesis_pending");return;}
        try{synthesis.execute(()->{
            try{
                JSONObject cached=null;try{cached=store.lookup(key);}catch(Exception broken){if(!call.getBoolean("retry",false))throw broken;}if(cached!=null){resolve(call,cached,true);return;}
                String secret=vault.read("mimo");if(secret==null||secret.isEmpty()){call.reject("未配置MiMo，使用设备声音","missing_key");return;}
                store.begin(key,call.getBoolean("retry",false));
                byte[] audio=post(secret,body);JSONObject asset=store.save(key,descriptor,audio);resolve(call,asset,false);
            }catch(IllegalStateException error){call.reject("上次声音结果未确认，可先使用设备声音","synthesis_unknown");}
            catch(Exception error){call.reject("MiMo声音暂不可用，可继续学习","synthesis_failed");}
            finally{active.remove(key);}
        });}catch(RejectedExecutionException error){active.remove(key);call.reject("声音准备队列已满，可稍后再试","synthesis_pending");}
    });}
    static void validate(String key,String descriptor,String body) throws Exception {
        if(descriptor.getBytes(StandardCharsets.UTF_8).length>16000||body.getBytes(StandardCharsets.UTF_8).length>32000)throw new IllegalArgumentException("Request too large");
        AudioStore.validateHash(key);if(!RuntimeReceiptStore.hash(descriptor).equals(key))throw new IllegalArgumentException("Descriptor mismatch");
        JSONObject meta=new JSONObject(descriptor),request=new JSONObject(body);String text=meta.getString("text"),voice=meta.getString("voice");
        Set<String> fields=new HashSet<>(Arrays.asList("model","messages","audio","stream"));for(Iterator<String> keys=request.keys();keys.hasNext();)if(!fields.contains(keys.next()))throw new IllegalArgumentException("Unsupported audio option");
        JSONObject audio=request.getJSONObject("audio");for(Iterator<String> keys=audio.keys();keys.hasNext();)if(!Arrays.asList("format","voice").contains(keys.next()))throw new IllegalArgumentException("Unsupported voice option");
        if(text.isBlank()||text.length()>4000||!Arrays.asList("Mia","Chloe","Milo","Dean").contains(voice)||!Arrays.asList("en-US","en-GB").contains(meta.getString("accent")))throw new IllegalArgumentException("Voice/input invalid");
        if(!"mimo-v2.5-tts".equals(meta.optString("model"))||!"mimo-tts-v1".equals(meta.optString("version"))||meta.getDouble("rate")<.65||meta.getDouble("rate")>1.25)throw new IllegalArgumentException("Model/version invalid");
        if(!"mimo-v2.5-tts".equals(request.optString("model"))||request.optBoolean("stream")||request.has("tools")||!"wav".equals(request.getJSONObject("audio").optString("format"))||!voice.equals(request.getJSONObject("audio").optString("voice")))throw new IllegalArgumentException("Body mismatch");
        JSONArray messages=request.getJSONArray("messages");if(messages.length()!=2||!"user".equals(messages.getJSONObject(0).optString("role"))||!"assistant".equals(messages.getJSONObject(1).optString("role"))||!text.equals(messages.getJSONObject(1).getString("content")))throw new IllegalArgumentException("Text mismatch");
        String speed=meta.getDouble("rate")<.85?"slow and carefully articulated":meta.getDouble("rate")>1.08?"lively but still easy to follow":"natural conversational pace";
        String accent="en-GB".equals(meta.getString("accent"))?"natural contemporary British English":"natural contemporary General American English";
        String style="Speak in "+accent+", at a "+speed+". Sound warm, human, and appropriate for an adult language learner. Preserve every word exactly; do not add explanations or omit content.";
        if(!style.equals(messages.getJSONObject(0).getString("content")))throw new IllegalArgumentException("Only fixed pronunciation styles are supported");
    }
    private byte[] post(String key,String body) throws Exception {
        HttpsURLConnection connection=(HttpsURLConnection)new URL("https://api.xiaomimimo.com/v1/chat/completions").openConnection();
        ScheduledExecutorService timer=Executors.newSingleThreadScheduledExecutor();timer.schedule(connection::disconnect,120,TimeUnit.SECONDS);
        try{
            connection.setInstanceFollowRedirects(false);connection.setRequestMethod("POST");connection.setDoOutput(true);connection.setConnectTimeout(15000);connection.setReadTimeout(90000);
            connection.setRequestProperty("Content-Type","application/json");connection.setRequestProperty("api-key",key);
            byte[] input=body.getBytes(StandardCharsets.UTF_8);connection.setFixedLengthStreamingMode(input.length);try(OutputStream output=connection.getOutputStream()){output.write(input);}
            if(connection.getResponseCode()!=200)throw new IOException("Synthesis service rejected request");
            ByteArrayOutputStream bytes=new ByteArrayOutputStream();try(InputStream stream=connection.getInputStream()){byte[] chunk=new byte[8192];int n;while((n=stream.read(chunk))!=-1){if(bytes.size()+n>29*1024*1024)throw new IOException("Response too large");bytes.write(chunk,0,n);}}
            JSONObject result=new JSONObject(new String(bytes.toByteArray(),StandardCharsets.UTF_8));if(result.has("model")&&!"mimo-v2.5-tts".equals(result.getString("model")))throw new IOException("Wrong model");
            byte[] audio=Base64.decode(result.getJSONArray("choices").getJSONObject(0).getJSONObject("message").getJSONObject("audio").getString("data"),Base64.DEFAULT);AudioStore.validateWav(audio);return audio;
        }finally{timer.shutdownNow();connection.disconnect();}
    }
    @Override protected void handleOnDestroy(){stopped=true;synthesis.shutdown();reader.shutdown();}
}

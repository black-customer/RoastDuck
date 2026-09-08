package com.roastduck.app;
import android.net.Uri;
import android.content.*;
import android.content.pm.ApplicationInfo;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.*;
import com.getcapacitor.annotation.*;
import com.journeyapps.barcodescanner.ScanOptions;
import org.json.*;
import java.security.SecureRandom;
import java.util.concurrent.*;
import java.io.*;

@CapacitorPlugin(name="RoastDuckDeviceSync")
public class DeviceSyncPlugin extends Plugin {
    private final ExecutorService queue=Executors.newSingleThreadExecutor();
    private SecretVault vault;private SharedPreferences preferences;private volatile boolean stopped;private boolean debug;
    @Override public void load(){vault=new SecretVault(getContext(),"roastduck.pairing.v1");preferences=getContext().getSharedPreferences("roastduck.pairing.metadata.v1",Context.MODE_PRIVATE);debug=(getContext().getApplicationInfo().flags&ApplicationInfo.FLAG_DEBUGGABLE)!=0;}
    private void local(PluginCall call,Runnable action){
        if(getActivity()==null||stopped){call.reject("页面已关闭");return;}
        getActivity().runOnUiThread(()->{String url=getBridge().getWebView()==null?null:getBridge().getWebView().getUrl();Uri uri=url==null?null:Uri.parse(url);if(stopped||uri==null||!"https".equals(uri.getScheme())||!"localhost".equals(uri.getHost())||uri.getPort()!=-1){call.reject("只允许本机配对操作");return;}action.run();});
    }
    private interface Work {JSONObject run() throws Exception;}
    private void work(PluginCall call,Work action){local(call,()->{try{queue.execute(()->{try{call.resolve(new JSObject(action.run().toString()));}catch(Exception error){call.reject("同步尚未完成。请确认同一 Wi-Fi、电脑已开启同步，并检查配对是否过期。检查点已保留。","sync_unavailable");}});}catch(RejectedExecutionException error){call.reject("同步已暂停");}});}
    private static String nonce(){byte[] bytes=new byte[32];new SecureRandom().nextBytes(bytes);StringBuilder output=new StringBuilder();for(byte b:bytes)output.append(String.format("%02x",b&255));return output.toString();}
    private JSONObject read(String key) throws Exception {String value=preferences.getString(key,null);return value==null?null:new JSONObject(value);}
    private void save(String key,JSONObject value) throws Exception {SharedPreferences.Editor edit=preferences.edit();if(value==null)edit.remove(key);else edit.putString(key,value.toString());if(!edit.commit())throw new java.io.IOException("Pair metadata persistence failed");}
    private JSONObject safeStatus() throws Exception {
        JSONObject peer=read("peer"),pending=read("pending"),result=new JSONObject();
        if(peer!=null)result.put("peer",new JSONObject().put("deviceId",peer.getString("deviceId")).put("datasetId",peer.getString("datasetId")).put("url",peer.getString("url")));
        if(pending!=null)result.put("pending",new JSONObject().put("verification",pending.optString("verification")).put("expiresAt",pending.optLong("expiresAt")).put("started",pending.has("requestId")));
        return result;
    }
    @PluginMethod public void status(PluginCall call){work(call,this::safeStatus);}
    @PluginMethod public void scan(PluginCall call){local(call,()->{
        ScanOptions options=new ScanOptions().setDesiredBarcodeFormats(ScanOptions.QR_CODE).setPrompt("扫描电脑鱼块设置页的配对码").setBeepEnabled(false).setBarcodeImageEnabled(false).setOrientationLocked(false);
        startActivityForResult(call,options.createScanIntent(getContext()),"scanned");
    });}
    @ActivityCallback private void scanned(PluginCall call,ActivityResult result){
        if(call==null)return;String content=result.getData()==null?null:result.getData().getStringExtra("SCAN_RESULT");
        if(content==null){JSObject value=new JSObject();value.put("cancelled",true);call.resolve(value);return;}
        if(content.length()>4000||!content.startsWith("roastduck-pair:")){call.reject("这不是鱼块电脑端的配对二维码");return;}
        JSObject value=new JSObject();value.put("pairingInfo",content);call.resolve(value);
    }
    @PluginMethod public void begin(PluginCall call){work(call,()->{
        String info=call.getString("pairingInfo",""),localId=call.getString("localDeviceId","");
        if(info.length()>4000||!info.startsWith("roastduck-pair:")||!localId.matches("[a-zA-Z0-9_-]{8,160}"))throw new IllegalArgumentException();
        JSONObject parsed=new JSONObject(new String(Base64.decode(info.substring(15),Base64.URL_SAFE|Base64.NO_WRAP),java.nio.charset.StandardCharsets.UTF_8));
        if(parsed.getInt("protocol")!=1||parsed.getLong("expiresAt")<System.currentTimeMillis()||parsed.getLong("expiresAt")>System.currentTimeMillis()+600000)throw new IllegalArgumentException();
        String endpoint=parsed.getString("url"),fingerprint=parsed.getString("fingerprint"),code=parsed.getString("code");PinnedSyncHttp.validateEndpoint(endpoint,debug);PinnedSyncHttp.trust(fingerprint);
        if(!code.matches("[a-f0-9]{64}"))throw new IllegalArgumentException();
        String proof=nonce();vault.store("pair_pending_proof",proof);vault.store("pair_pending_code",code);
        JSONObject pending=new JSONObject().put("url",endpoint).put("fingerprint",fingerprint).put("localId",localId).put("expiresAt",parsed.getLong("expiresAt")).put("expectedDeviceId",parsed.getString("deviceId"));save("pending",pending);
        beginRequest(pending);return safeStatus();
    });}
    private void beginRequest(JSONObject pending) throws Exception {
        JSONObject body=new JSONObject().put("deviceId",pending.getString("localId")).put("name",android.os.Build.MODEL).put("proof",vault.read("pair_pending_proof")).put("code",vault.read("pair_pending_code"));
        JSONObject result=PinnedSyncHttp.request(pending.getString("url"),pending.getString("fingerprint"),"/pair/request","POST",body.toString(),null,null,debug);
        pending.put("requestId",result.getString("id")).put("verification",result.getString("verification")).put("expiresAt",result.getLong("expiresAt"));save("pending",pending);
    }
    @PluginMethod public void finish(PluginCall call){work(call,()->{
        JSONObject pending=read("pending");if(pending==null||pending.getLong("expiresAt")<System.currentTimeMillis())throw new IllegalStateException();
        if(!pending.has("requestId")){beginRequest(pending);return safeStatus();}
        JSONObject body=new JSONObject().put("id",pending.getString("requestId")).put("proof",vault.read("pair_pending_proof"));
        JSONObject result=PinnedSyncHttp.request(pending.getString("url"),pending.getString("fingerprint"),"/pair/result","POST",body.toString(),null,null,debug);
        if(result.getBoolean("approved")){
            if(!pending.getString("expectedDeviceId").equals(result.getString("deviceId")))throw new SecurityException();
            String slot="pair_peer_"+RuntimeReceiptStore.hash(result.getString("deviceId"));vault.store(slot,result.getString("token"));
            save("peer",new JSONObject().put("url",pending.getString("url")).put("fingerprint",pending.getString("fingerprint")).put("localId",pending.getString("localId")).put("deviceId",result.getString("deviceId")).put("datasetId",result.getString("datasetId")).put("slot",slot));
            save("pending",null);vault.clear("pair_pending_proof");vault.clear("pair_pending_code");
        }return safeStatus();
    });}
    @PluginMethod public void request(PluginCall call){work(call,()->{
        JSONObject peer=read("peer");if(peer==null)throw new IllegalStateException();
        String route=call.getString("route",""),method=call.getString("method","GET"),body=call.getString("body",null);
        if(route.startsWith("/pair/"))throw new SecurityException();
        return PinnedSyncHttp.request(peer.getString("url"),peer.getString("fingerprint"),route,method,body,peer.getString("localId"),vault.read(peer.getString("slot")),debug);
    });}
    private JSONObject peerRequest(JSONObject peer,String route,String method,String body) throws Exception {return PinnedSyncHttp.request(peer.getString("url"),peer.getString("fingerprint"),route,method,body,peer.getString("localId"),vault.read(peer.getString("slot")),debug);}
    @PluginMethod public void mediaInventory(PluginCall call){work(call,()->new JSONObject().put("assets",AudioStore.open(getContext()).inventory()));}
    @PluginMethod public void removeAudio(PluginCall call){work(call,()->{AudioStore.open(getContext()).remove(call.getString("contentHash",""));return new JSONObject().put("removed",true);});}
    @PluginMethod public void downloadMedia(PluginCall call){work(call,()->{
        JSONObject peer=read("peer"),asset=call.getObject("asset");if(peer==null||asset==null)throw new IllegalArgumentException();
        String contentHash=asset.getString("contentHash"),fileHash=asset.getString("fileHash");AudioStore.validateHash(contentHash);AudioStore.validateHash(fileHash);
        long total=asset.getLong("bytes");if(total<44||total>20*1024*1024)throw new IllegalArgumentException();
        AudioStore store=AudioStore.open(getContext());if(store.lookup(contentHash)!=null)return new JSONObject().put("cached",true);
        File directory=new File(getContext().getFilesDir(),"audio-sync-parts");if(!directory.isDirectory()&&!directory.mkdirs())throw new IOException();
        File partial=new File(directory,contentHash+"-"+fileHash+".part");
        try(RandomAccessFile file=new RandomAccessFile(partial,"rw")){
            if(file.length()>total)throw new IOException("Invalid partial size");
            while(file.length()<total){
                if(stopped)throw new IOException("Sync paused");long offset=file.length();JSONObject chunk=peerRequest(peer,"/media/chunk?hash="+contentHash+"&offset="+offset,"GET",null);
                byte[] bytes=Base64.decode(chunk.getString("data"),Base64.NO_WRAP);
                if(bytes.length==0||bytes.length>128*1024||offset+bytes.length>total||chunk.getLong("offset")!=offset||chunk.getLong("nextOffset")!=offset+bytes.length)throw new IOException("Invalid media chunk");
                file.seek(offset);file.write(bytes);file.getFD().sync();
            }
        }
        byte[] bytes=java.nio.file.Files.readAllBytes(partial.toPath());if(!AudioStore.digest(bytes).equals(fileHash))throw new IOException("Media hash mismatch");
        store.save(contentHash,"{\"imported\":true}",bytes);partial.delete();return new JSONObject().put("cached",false).put("bytes",total);
    });}
    @PluginMethod public void uploadMedia(PluginCall call){work(call,()->{
        JSONObject peer=read("peer");if(peer==null)throw new IllegalStateException();String key=call.getString("contentHash","");
        byte[] bytes=AudioStore.open(getContext()).bytes(key);JSONObject asset=new JSONObject().put("contentHash",key).put("fileHash",AudioStore.digest(bytes)).put("bytes",bytes.length);long offset=0;
        while(offset<bytes.length){
            if(stopped)throw new IOException("Sync paused");int count=(int)Math.min(128*1024,bytes.length-offset);
            String chunk=Base64.encodeToString(bytes,(int)offset,count,Base64.NO_WRAP);
            JSONObject result=peerRequest(peer,"/media/chunk","POST",new JSONObject().put("asset",asset).put("offset",offset).put("data",chunk).toString());
            long next=result.getLong("nextOffset");if(next<=offset||next>bytes.length)throw new IOException("Media cursor mismatch");offset=next;
        }return new JSONObject().put("bytes",bytes.length);
    });}
    @PluginMethod public void forget(PluginCall call){work(call,()->{JSONObject peer=read("peer");if(peer!=null)vault.clear(peer.getString("slot"));save("peer",null);save("pending",null);vault.clear("pair_pending_proof");vault.clear("pair_pending_code");return safeStatus();});}
    @Override protected void handleOnDestroy(){stopped=true;queue.shutdown();}
}

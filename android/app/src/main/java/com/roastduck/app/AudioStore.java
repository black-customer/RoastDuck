package com.roastduck.app;
import android.content.Context;
import android.net.Uri;
import android.util.AtomicFile;
import org.json.JSONObject;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

/** Audio bytes are immutable and content-addressed; the descriptor index is atomically replaced. */
final class AudioStore {
    private static final java.util.Map<String,AudioStore> instances=new java.util.HashMap<>();
    static synchronized AudioStore open(Context context) throws IOException {String path=context.getFilesDir().getAbsolutePath();AudioStore found=instances.get(path);if(found==null){found=new AudioStore(context);instances.put(path,found);}return found;}
    private final File media, index, states;
    AudioStore(Context context) throws IOException {
        media=new File(context.getFilesDir(),"audio-media");index=new File(context.getFilesDir(),"audio-index");states=new File(context.getFilesDir(),"audio-state");
        for(File directory:new File[]{media,index,states})if(!directory.isDirectory()&&!directory.mkdirs())throw new IOException("Audio storage unavailable");
    }
    static void validateHash(String hash){if(hash==null||!hash.matches("[a-f0-9]{64}"))throw new IllegalArgumentException("Invalid content hash");}
    static void validateWav(byte[] bytes) throws IOException {
        if(bytes.length<44||bytes.length>20*1024*1024||!"RIFF".equals(new String(bytes,0,4,StandardCharsets.US_ASCII))||!"WAVE".equals(new String(bytes,8,4,StandardCharsets.US_ASCII)))throw new IOException("Invalid WAV");
    }
    static String digest(byte[] bytes) throws Exception {StringBuilder result=new StringBuilder();for(byte b:MessageDigest.getInstance("SHA-256").digest(bytes))result.append(String.format("%02x",b&255));return result.toString();}
    private static JSONObject read(File file) throws Exception {
        try(FileInputStream input=new AtomicFile(file).openRead()){
            if(input.getChannel().size()>20000)throw new IOException("Audio metadata too large");
            ByteArrayOutputStream out=new ByteArrayOutputStream();byte[] buffer=new byte[4096];int n;while((n=input.read(buffer))!=-1)out.write(buffer,0,n);
            return new JSONObject(new String(out.toByteArray(),StandardCharsets.UTF_8));
        }catch(FileNotFoundException missing){return null;}
    }
    private static void write(File file,byte[] bytes) throws IOException {
        AtomicFile target=new AtomicFile(file);FileOutputStream output=null;
        try{output=target.startWrite();output.write(bytes);target.finishWrite(output);}catch(IOException error){if(output!=null)target.failWrite(output);throw error;}
    }
    synchronized JSONObject lookup(String key) throws Exception {
        validateHash(key);JSONObject data=read(new File(index,key+".json"));if(data==null)return null;
        String fileHash=data.getString("fileHash");validateHash(fileHash);File file=new File(media,fileHash+".wav");
        if(!file.isFile()||file.length()!=data.getLong("bytes")||file.length()>20*1024*1024)return null;
        byte[] bytes=java.nio.file.Files.readAllBytes(file.toPath());
        if(!digest(bytes).equals(fileHash))return null;
        try{validateWav(bytes);}catch(IOException corrupt){return null;}
        return new JSONObject(data.toString()).put("uri",Uri.fromFile(file).toString());
    }
    synchronized void begin(String key,boolean retry) throws Exception {
        validateHash(key);File stateFile=new File(states,key+".json");JSONObject previous=null;try{previous=read(stateFile);}catch(Exception corrupt){if(!retry)throw corrupt;}
        if(previous!=null&&!"completed".equals(previous.optString("state"))&&!retry)throw new IllegalStateException("synthesis_unknown");
        write(stateFile,new JSONObject().put("state","pending").put("at",System.currentTimeMillis()).toString().getBytes(StandardCharsets.UTF_8));
    }
    synchronized JSONObject save(String key,String descriptor,byte[] bytes) throws Exception {
        validateHash(key);validateWav(bytes);String fileHash=digest(bytes);File file=new File(media,fileHash+".wav");
        // An existing same-size file may be corrupt. A validated incoming result repairs it atomically.
        write(file,bytes);
        JSONObject metadata=new JSONObject().put("contentHash",key).put("fileHash",fileHash).put("bytes",bytes.length).put("descriptor",new JSONObject(descriptor));
        write(new File(index,key+".json"),metadata.toString().getBytes(StandardCharsets.UTF_8));
        write(new File(states,key+".json"),new JSONObject().put("state","completed").toString().getBytes(StandardCharsets.UTF_8));
        return lookup(key);
    }
    synchronized org.json.JSONArray inventory() throws Exception {
        org.json.JSONArray result=new org.json.JSONArray();File[] files=index.listFiles();if(files==null)return result;
        for(File file:files){String name=file.getName();if(!name.matches("[a-f0-9]{64}\\.json"))continue;try{JSONObject asset=lookup(name.substring(0,64));if(asset!=null)result.put(new JSONObject().put("contentHash",asset.getString("contentHash")).put("fileHash",asset.getString("fileHash")).put("bytes",asset.getLong("bytes")));}catch(Exception corrupt){/* Corrupt entries aren't downloadable media. */}}
        return result;
    }
    synchronized byte[] bytes(String key) throws Exception {JSONObject asset=lookup(key);if(asset==null)throw new IOException("Audio missing");return java.nio.file.Files.readAllBytes(new File(media,asset.getString("fileHash")+".wav").toPath());}
    synchronized void remove(String key) throws Exception {
        validateHash(key);JSONObject data=read(new File(index,key+".json"));new AtomicFile(new File(index,key+".json")).delete();new AtomicFile(new File(states,key+".json")).delete();if(data==null)return;
        String fileHash=data.getString("fileHash");validateHash(fileHash);File[] files=index.listFiles();
        if(files!=null)for(File candidate:files){try{JSONObject other=read(candidate);if(other!=null&&fileHash.equals(other.optString("fileHash")))return;}catch(Exception ignored){/* Keep other index entries. */}}
        File target=new File(media,fileHash+".wav");if(target.isFile()&&!target.delete())throw new IOException("Audio deletion failed");
    }
}

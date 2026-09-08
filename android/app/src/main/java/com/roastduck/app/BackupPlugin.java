package com.roastduck.app;
import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.*;
import com.getcapacitor.annotation.*;
import java.io.*;
import java.util.concurrent.*;

@CapacitorPlugin(name="RoastDuckBackup")
public class BackupPlugin extends Plugin {
    private final ExecutorService queue=Executors.newSingleThreadExecutor();
    private volatile boolean stopped;private boolean dialogOpen;
    private void local(PluginCall call,Runnable action){
        if(getActivity()==null||stopped){call.reject("页面已关闭");return;}
        getActivity().runOnUiThread(()->{String url=getBridge().getWebView()==null?null:getBridge().getWebView().getUrl();Uri uri=url==null?null:Uri.parse(url);if(stopped||uri==null||!"https".equals(uri.getScheme())||!"localhost".equals(uri.getHost())||uri.getPort()!=-1){call.reject("只允许本机备份操作");return;}if(dialogOpen){call.reject("请先完成当前文件选择");return;}dialogOpen=true;action.run();});
    }
    @PluginMethod public void exportFile(PluginCall call){local(call,()->{
        String encoded=call.getString("payload","");call.getData().remove("payload");
        try{queue.execute(()->{try{
            if(encoded.length()>90_000_000)throw new IOException("Backup too large");
            byte[] bytes=Base64.decode(encoded,Base64.NO_WRAP);if(bytes.length<32||bytes.length>64*1024*1024)throw new IOException("Invalid encrypted backup");
            File directory=new File(getContext().getCacheDir(),"encrypted-backup-export");if(!directory.isDirectory()&&!directory.mkdirs())throw new IOException("Storage unavailable");
            File temporary=File.createTempFile("backup-",".encrypted",directory);try(FileOutputStream out=new FileOutputStream(temporary)){out.write(bytes);out.getFD().sync();}
            call.getData().put("temporary",temporary.getName());
            Intent intent=new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("application/octet-stream").putExtra(Intent.EXTRA_TITLE,"RoastDuck-"+new java.text.SimpleDateFormat("yyyy-MM-dd",java.util.Locale.US).format(new java.util.Date())+".rdbackup");
            getActivity().runOnUiThread(()->startActivityForResult(call,intent,"exported"));
        }catch(Exception error){dialogOpen=false;call.reject("备份文件尚未保存，现有资料保留","backup_export_failed");}});}catch(RejectedExecutionException error){dialogOpen=false;call.reject("备份已暂停");}
    });}
    @ActivityCallback private void exported(PluginCall call,ActivityResult result){
        dialogOpen=false;if(call==null)return;
        String name=call.getString("temporary","");if(!name.matches("backup-[a-zA-Z0-9-]+\\.encrypted")){call.reject("临时备份不可确认");return;}
        File temporary=new File(new File(getContext().getCacheDir(),"encrypted-backup-export"),name);
        if(result.getResultCode()!=Activity.RESULT_OK||result.getData()==null){temporary.delete();JSObject output=new JSObject();output.put("saved",false);call.resolve(output);return;}
        Uri uri=result.getData().getData();
        queue.execute(()->{try{
            try(InputStream in=new FileInputStream(temporary);OutputStream out=getContext().getContentResolver().openOutputStream(uri,"w")){if(out==null)throw new IOException("File unavailable");byte[] buffer=new byte[65536];int n;while((n=in.read(buffer))!=-1)out.write(buffer,0,n);out.flush();}
            JSObject output=new JSObject();output.put("saved",true);output.put("bytes",temporary.length());call.resolve(output);temporary.delete();
        }catch(Exception error){call.reject("导出未确认，请重新保存","backup_export_failed");}});
    }
    @PluginMethod public void importFile(PluginCall call){local(call,()->startActivityForResult(call,new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*"),"imported"));}
    @ActivityCallback private void imported(PluginCall call,ActivityResult result){
        dialogOpen=false;if(call==null)return;if(result.getResultCode()!=Activity.RESULT_OK||result.getData()==null){JSObject value=new JSObject();value.put("cancelled",true);call.resolve(value);return;}
        Uri uri=result.getData().getData();queue.execute(()->{try{
            ByteArrayOutputStream bytes=new ByteArrayOutputStream();try(InputStream in=getContext().getContentResolver().openInputStream(uri)){if(in==null)throw new IOException();byte[] buffer=new byte[65536];int n;while((n=in.read(buffer))!=-1){if(bytes.size()+n>64*1024*1024)throw new IOException("Backup too large");bytes.write(buffer,0,n);}}
            JSObject output=new JSObject();output.put("payload",Base64.encodeToString(bytes.toByteArray(),Base64.NO_WRAP));call.resolve(output);
        }catch(Exception error){call.reject("无法读取备份，现有资料未改变","backup_import_failed");}});
    }
    @Override protected void handleOnDestroy(){stopped=true;queue.shutdown();}
}

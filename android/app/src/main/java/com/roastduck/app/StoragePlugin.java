package com.roastduck.app;
import android.net.Uri;
import com.getcapacitor.*;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.*;
import java.util.UUID;

@CapacitorPlugin(name="RoastDuckStorage")
public class StoragePlugin extends Plugin {
    /** Called only while the application's database connection is closed for a numbered migration. */
    @PluginMethod public void backupDatabase(PluginCall call){
        if(getActivity()==null){call.reject("页面已关闭");return;}
        getActivity().runOnUiThread(()->{
            String url=getBridge().getWebView()==null?null:getBridge().getWebView().getUrl();Uri uri=url==null?null:Uri.parse(url);
            if(uri==null||!"https".equals(uri.getScheme())||!"localhost".equals(uri.getHost())||uri.getPort()!=-1){call.reject("只允许本机迁移备份");return;}
            String name=call.getString("name","");
            if(!name.matches("[a-z][a-z0-9_]{1,60}")){call.reject("数据库名无效");return;}
            new Thread(()->{
                try{
                    File source=getContext().getDatabasePath(name+"SQLite.db");
                    if(!source.isFile()||source.length()==0)throw new IOException("Database not found");
                    File wal=new File(source.getAbsolutePath()+"-wal");
                    if(wal.isFile()&&wal.length()>0)throw new IOException("Database must be closed and checkpointed before backup");
                    File directory=new File(getContext().getFilesDir(),"database-backups");if(!directory.isDirectory()&&!directory.mkdirs())throw new IOException("Backup directory unavailable");
                    File target=new File(directory,name+"-"+UUID.randomUUID()+".db");
                    java.security.MessageDigest originalHash=java.security.MessageDigest.getInstance("SHA-256"),backupHash=java.security.MessageDigest.getInstance("SHA-256");
                    try(InputStream in=new FileInputStream(source);FileOutputStream out=new FileOutputStream(target)){
                        byte[] buffer=new byte[65536];int n;while((n=in.read(buffer))!=-1){out.write(buffer,0,n);originalHash.update(buffer,0,n);}out.getFD().sync();
                    }
                    if(target.length()!=source.length())throw new IOException("Backup length mismatch");
                    try(InputStream in=new FileInputStream(target)){byte[] buffer=new byte[65536];int n;while((n=in.read(buffer))!=-1)backupHash.update(buffer,0,n);}
                    if(!java.security.MessageDigest.isEqual(originalHash.digest(),backupHash.digest()))throw new IOException("Backup hash mismatch");
                    JSObject result=new JSObject();result.put("backupRef",target.getName());result.put("bytes",target.length());call.resolve(result);
                }catch(Exception error){call.reject("迁移备份未确认，原资料未改动","backup_failed");}
            },"roastduck-backup").start();
        });
    }
}

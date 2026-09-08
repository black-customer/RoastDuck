import { Capacitor,registerPlugin } from "@capacitor/core";
import { CapacitorSQLite,SQLiteConnection } from "@capacitor-community/sqlite";
import { SerialDatabase } from "../database";
import { AndroidSqliteDriver } from "./sqlite-driver";
import { bootstrapNativeSchema } from "./bootstrap";
import schema from "./generated/schema.json";
const storage=registerPlugin<{backupDatabase(input:{name:string}):Promise<{backupRef:string}>}>("RoastDuckStorage");

export interface NativeDatabaseHandle {database:SerialDatabase;close:()=>Promise<void>}
export function createNativeDatabaseManager(name="roastduck"){
if(!/^[a-z][a-z0-9_]{1,60}$/.test(name))throw new Error("本机数据库名称无效");
let opening:Promise<NativeDatabaseHandle>|null=null;
let closing:Promise<void>|null=null;
let failure:Error|null=null;
/** One native application-private database. Never silently substitutes browser storage. */
function openNativeDatabase():Promise<NativeDatabaseHandle> {
  if(Capacitor.getPlatform()!=="android")return Promise.reject(new Error("需要安卓本地存储，未使用临时网页缓存替代。"));
  if(failure)return Promise.reject(failure);
  if(closing)return closing.then(()=>openNativeDatabase());
  if(opening)return opening;
  let cleanupConfirmed=true;
  const task=(async()=>{
    const manager=new SQLiteConnection(CapacitorSQLite);
    await manager.checkConnectionsConsistency();
    const connection=await manager.createConnection(name,false,"no-encryption",1,false);
    try {
      await connection.open();
      const database=new SerialDatabase(new AndroidSqliteDriver(connection));
      await bootstrapNativeSchema(database,schema,new Date(),async()=>{
        await connection.close();
        try{return (await storage.backupDatabase({name})).backupRef;}
        finally{await connection.open();}
      });
      return {database,close:()=>{
        if(opening!==task)return Promise.resolve(); // A stale handle cannot close a later connection.
        if(closing)return closing;
        const operation=database.close(()=>manager.closeConnection(name,false));
        closing=operation;
        void operation.then(()=>{
          if(opening===task)opening=null;
          if(closing===operation)closing=null;
        },()=>{
          failure=new Error("本地存储关闭未确认，请重启应用；原数据没有删除。");
          if(closing===operation)closing=null;
        });
        return operation;
      }};
    } catch(error) {
      // Initialization failure never deletes the database. Keep a failed close visible.
      try{await manager.closeConnection(name,false);}
      catch(closeError){cleanupConfirmed=false;throw new AggregateError([error,closeError],"本地存储初始化失败，关闭未确认，请重启应用。");}
      throw error;
    }
  })();
  opening=task;
  void task.catch(()=>{
    if(cleanupConfirmed&&opening===task)opening=null;
    if(!cleanupConfirmed)failure=new Error("本地存储初始化及关闭未确认，请重启应用；原数据没有删除。");
  });
  return task;
}

return openNativeDatabase;
}
export const openNativeDatabase=createNativeDatabaseManager();

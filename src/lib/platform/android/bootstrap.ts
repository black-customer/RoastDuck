import type { DatabasePort } from "../database";
import { sha256Text } from "../hash";
import {V26_DDL} from "../../../../db/migrations/v26-device-runtime";
import {V27_DDL} from "../../../../db/migrations/v27-memory-recovery";
import {V28_DDL} from "../../../../db/migrations/v28-device-sync";

export interface NativeSchemaSnapshot { formatVersion:number;schemaVersion:number;sha256:string;statements:string[] }
/** Trusted bundled snapshot, never sync input. Fresh install only; no invented desktop history. */
export async function bootstrapNativeSchema(database:DatabasePort,snapshot:NativeSchemaSnapshot,now=new Date(),beforeUpgrade?:()=>Promise<string>) {
  if(snapshot.formatVersion!==1||![25,26,27,28].includes(snapshot.schemaVersion)||sha256Text(JSON.stringify(snapshot.statements))!==snapshot.sha256)throw new Error("原生数据库初始模板校验失败。");
  const existing=await database.read(async tx=>{
    const tables=await tx.all({sql:"SELECT name FROM sqlite_master WHERE type='table' AND name='_native_schema_bootstrap'"});
    return tables.length?(await tx.all<{schema_version:number;schema_hash:string}>({sql:"SELECT schema_version,schema_hash FROM _native_schema_bootstrap WHERE singleton=1"}))[0]:null;
  });
  const hashes:Record<number,string>={25:"2cc6f080e99503813cb45a182f7cd5da30747f7dbead4e638f478743ee15b1ef",26:"a9bc28a878682349af78d800900ea880cef8abeb34fce726cb2ea8272f4a1e4e",27:"ed03f65b6fd778c31da116367412660e85ad452765508b274f0c3ffe298862c9"};
  const upgrade=!!existing&&existing.schema_version<snapshot.schemaVersion&&hashes[existing.schema_version]===existing.schema_hash;
  let backup:string|null=null;
  if(upgrade){if(!beforeUpgrade)throw new Error("原生数据库升级前需要备份，原数据已保留。");backup=await beforeUpgrade();if(!backup)throw new Error("升级备份未确认，已停止。");}
  return database.write(async tx=>{
    const tables=await tx.all<{name:string}>({sql:"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"});
    if(tables.some(table=>table.name==="_native_schema_bootstrap")){
      const [receipt]=await tx.all<{schema_version:number;schema_hash:string}>({sql:"SELECT schema_version,schema_hash FROM _native_schema_bootstrap WHERE singleton=1"});
      if(upgrade&&receipt?.schema_version===existing?.schema_version&&receipt?.schema_hash===existing?.schema_hash){
        await tx.run({sql:"CREATE TABLE IF NOT EXISTS _native_schema_history(version INTEGER PRIMARY KEY,checksum TEXT NOT NULL,backup_ref TEXT NOT NULL,applied_at TEXT NOT NULL)"});
        for(const [version,statements] of [[26,V26_DDL],[27,V27_DDL],[28,V28_DDL]] as const){
          if(version<=receipt.schema_version||version>snapshot.schemaVersion)continue;
          for(const statement of statements)await tx.run({sql:statement});
          await tx.run({sql:"INSERT INTO _native_schema_history VALUES(?,?,?,?)",args:[version,sha256Text(JSON.stringify(statements)),backup!,now.toISOString()]});
        }
        await tx.run({sql:"UPDATE _native_schema_bootstrap SET schema_version=?,schema_hash=? WHERE singleton=1",args:[snapshot.schemaVersion,snapshot.sha256]});
        return {schemaVersion:snapshot.schemaVersion,created:false};
      }
      if(receipt?.schema_version!==snapshot.schemaVersion||receipt.schema_hash!==snapshot.sha256)throw new Error("数据库需要编号升级，不能覆盖已有资料。");
      return {schemaVersion:receipt.schema_version,created:false};
    }
    if(tables.length)throw new Error("已有数据库没有可确认的原生初始化记录，已保留数据并停止覆盖。");
    for(const statement of snapshot.statements)await tx.run({sql:statement});
    await tx.run({sql:"CREATE TABLE _native_schema_bootstrap (singleton INTEGER PRIMARY KEY CHECK(singleton=1),schema_version INTEGER NOT NULL,schema_hash TEXT NOT NULL,created_at TEXT NOT NULL)"});
    await tx.run({sql:"INSERT INTO _native_schema_bootstrap(singleton,schema_version,schema_hash,created_at) VALUES(1,?,?,?)",args:[snapshot.schemaVersion,snapshot.sha256,now.toISOString()]});
    return {schemaVersion:snapshot.schemaVersion,created:true};
  });
}

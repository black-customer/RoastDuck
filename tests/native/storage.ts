import { Capacitor } from "@capacitor/core";
import { CapacitorSQLite,SQLiteConnection } from "@capacitor-community/sqlite";
import { SerialDatabase } from "../../src/lib/platform/database";
import { AndroidSqliteDriver } from "../../src/lib/platform/android/sqlite-driver";
import { bootstrapNativeSchema } from "../../src/lib/platform/android/bootstrap";
import snapshot from "../../src/lib/platform/android/generated/schema.json";
import {testNativeLearning} from "./learning";
import {mountNativeStudy} from "./study-ui";
import "./style.css";

const output=document.getElementById("result")!;
const results:string[]=[];
function assert(condition:unknown,name:string){if(!condition)throw new Error(name);results.push(name);}
async function test(){
  if(Capacitor.getPlatform()!=="android")throw new Error("需要Android测试设备，不使用浏览器数据库冒充原生。");
  const manager=new SQLiteConnection(CapacitorSQLite);
  await manager.checkConnectionsConsistency(); // Harness owns all connections in this debug-only page.
  const connection=await manager.createConnection(`roastduck_harness_${Date.now()}`,false,"no-encryption",1,false);
  await connection.open();
  const database=new SerialDatabase(new AndroidSqliteDriver(connection));
  let keepOpen=false;
  try{
    assert((await bootstrapNativeSchema(database,snapshot)).created,`真实SQLite初始化${snapshot.statements.length}条结构`);
    assert(!(await bootstrapNativeSchema(database,snapshot)).created,"重复初始化不覆盖");
    await database.write(tx=>tx.run({sql:"CREATE TABLE harness_values(id TEXT PRIMARY KEY,value TEXT)"}));
    const original="中文🙂 ' ? ; 原文";
    await database.write(tx=>tx.run({sql:"INSERT INTO harness_values VALUES(?,?)",args:["saved",original]}));
    const [row]=await database.read(tx=>tx.all<{value:string}>({sql:"SELECT value FROM harness_values WHERE id=?",args:["saved"]}));
    assert(row.value===original,"Unicode与参数绑定无损");
    try{await database.write(async tx=>{await tx.run({sql:"INSERT INTO harness_values VALUES('rollback','synthetic')"});throw new Error("expected rollback");});}catch{/* Assert the actual result next. */}
    assert((await database.read(tx=>tx.all({sql:"SELECT * FROM harness_values WHERE id='rollback'"}))).length===0,"失败事务回滚");
    let readOnlyRejected=false;
    try{await database.read(tx=>tx.all({sql:"INSERT INTO harness_values VALUES('readonly','forbidden')"}));}catch{readOnlyRejected=true;}
    assert(readOnlyRejected&&(await database.read(tx=>tx.all({sql:"SELECT * FROM harness_values WHERE id='readonly'"}))).length===0,"只读作用域拒绝写入");
    let missingRejected=false;
    try{await database.write(tx=>tx.run({sql:"INSERT INTO harness_values VALUES(?,?)",args:["missing"]}));}catch{missingRejected=true;}
    assert(missingRejected&&(await database.read(tx=>tx.all({sql:"SELECT * FROM harness_values WHERE id='missing'"}))).length===0,"参数缺失不静默写NULL");
    let namedRejected=false;
    try{await database.read(tx=>tx.all({sql:"SELECT :中文"}));}catch{namedRejected=true;}
    assert(namedRejected,"中文命名参数不静默写NULL");
    const history=await database.read(tx=>tx.all({sql:"SELECT * FROM _schema_migrations"}));
    assert(history.length===0,"不伪造桌面历史迁移");
    await connection.close();await connection.open();
    const [reopened]=await database.read(tx=>tx.all<{value:string}>({sql:"SELECT value FROM harness_values WHERE id='saved'"}));
    assert(reopened.value===original,"关闭重开仍保留数据");
    await testNativeLearning(database,assert);
    output.textContent=JSON.stringify({status:"passed",tests:results},null,2);
    console.info("ROASTDUCK_NATIVE_HARNESS",output.textContent);
    const open=document.createElement("button");open.textContent="打开原生轻学习界面";open.style.minHeight="48px";
    open.onclick=()=>{open.disabled=true;void mountNativeStudy(database).catch(error=>{open.disabled=false;output.textContent=String(error);});};
    document.body.insertBefore(open,output);keepOpen=true;
  }finally{if(!keepOpen)await connection.close();}
}
void test().catch(error=>{output.textContent=JSON.stringify({status:"failed",error:error instanceof Error?error.message:String(error),tests:results},null,2);console.info("ROASTDUCK_NATIVE_HARNESS",output.textContent);});

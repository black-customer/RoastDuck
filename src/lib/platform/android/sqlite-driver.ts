import type { SQLiteDBConnection } from "@capacitor-community/sqlite";
import type { SqlCommand,SqlValue,TransactionDriver,WriteResult } from "../database";
import { bindingSegments } from "../sql";

type Connection=Pick<SQLiteDBConnection,"execute"|"query"|"run"|"beginTransaction"|"commitTransaction"|"rollbackTransaction"|"isTransactionActive">;
function values(command:SqlCommand) {
  bindingSegments(command);
  return (command.args??[]).map((value:SqlValue)=>{
    if(value instanceof Uint8Array)throw new Error("二进制资料必须通过媒体存储，不作为SQL文本绑定。");
    if(typeof value==="bigint"){
      const number=Number(value);
      if(!Number.isSafeInteger(number))throw new Error("大整数须以文本保存，不能丢失精度。");
      return number;
    }
    if(typeof value==="number"&&!Number.isFinite(value))throw new Error("SQL参数必须是有限数值。");
    return value;
  });
}

/** Use only behind SerialDatabase: the plugin's automatic per-statement transactions stay OFF. */
export class AndroidSqliteDriver implements TransactionDriver {
  private mode:"read"|"write"|null=null;
  constructor(private connection:Connection){}
  async begin(mode:"read"|"write") {
    if(this.mode!==null)throw new Error("不允许隐式嵌套原生事务。");
    // Android plugin begins a write transaction; query_only ON before BEGIN rejects it.
    await this.connection.execute("PRAGMA query_only=OFF",false);
    try{
      await this.connection.beginTransaction();this.mode=mode;
      if(mode==="read")await this.connection.execute("PRAGMA query_only=ON",false);
    }
    catch(error){
      await this.connection.execute("PRAGMA query_only=OFF",false);
      if((await this.connection.isTransactionActive()).result)await this.connection.rollbackTransaction();
      this.mode=null;
      throw error;
    }
  }
  async all<T>(command:SqlCommand):Promise<T[]> {
    if(this.mode===null)throw new Error("必须在数据库作用域内查询。");
    const result=await this.connection.query(command.sql,values(command));
    return (result.values??[]) as T[];
  }
  async run(command:SqlCommand):Promise<WriteResult> {
    if(this.mode!=="write")throw new Error("只读作用域不能写入数据。");
    const args=values(command);
    const ddl=!command.args?.length&&/^\s*(CREATE|ALTER|DROP|PRAGMA)\b/i.test(command.sql);
    const result=ddl?await this.connection.execute(command.sql,false):await this.connection.run(command.sql,args,false,"no");
    const changes=result.changes?.changes;
    if(changes===undefined||changes<0)throw new Error("原生数据库未确认写入。");
    return {changes,lastInsertRowId:result.changes?.lastId};
  }
  async commit() {
    if(this.mode===null)throw new Error("没有可提交的事务。");
    await this.connection.execute("PRAGMA query_only=OFF",false);
    await this.connection.commitTransaction();
    this.mode=null;
  }
  async rollback() {
    await this.connection.execute("PRAGMA query_only=OFF",false);
    if(this.mode!==null)await this.connection.rollbackTransaction();
    this.mode=null;
  }
}

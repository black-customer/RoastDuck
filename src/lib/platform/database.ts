export type SqlValue = string|number|bigint|null|Uint8Array;
export interface SqlCommand { sql:string; args?:SqlValue[] }
export interface WriteResult { changes:number; lastInsertRowId?:string|number }
export interface SqlReader { all<T>(command:SqlCommand):Promise<T[]> }
export interface SqlWriter extends SqlReader { run(command:SqlCommand):Promise<WriteResult> }
export interface TransactionDriver extends SqlWriter {
  begin(mode:"read"|"write"):Promise<void>;
  commit():Promise<void>;
  rollback():Promise<void>;
}
export interface DatabasePort {
  read<T>(work:(reader:SqlReader)=>Promise<T>):Promise<T>;
  write<T>(work:(writer:SqlWriter)=>Promise<T>):Promise<T>;
}

/**
 * One native connection: outside reads AND writes queue, with explicit scoped handles.
 * Never infer a nested transaction from a global currentTx. Within callbacks, use the
 * provided handle; do not reenter the outer DatabasePort or await network requests.
 */
export class SerialDatabase implements DatabasePort {
  private tail:Promise<unknown>=Promise.resolve();
  private poisoned=false;
  private accepting=true;
  private closing:Promise<void>|null=null;
  constructor(private driver:TransactionDriver){}
  read<T>(work:(reader:SqlReader)=>Promise<T>) { return this.scope("read",work); }
  write<T>(work:(writer:SqlWriter)=>Promise<T>) { return this.scope("write",work); }
  /** Stop accepting work immediately, drain accepted transactions, then close native storage. */
  close(closeDriver:()=>Promise<void>):Promise<void> {
    if(this.closing)return this.closing;
    this.accepting=false;
    this.closing=this.tail.then(closeDriver);
    this.tail=this.closing.catch(()=>undefined);
    return this.closing;
  }
  private scope<T>(mode:"read"|"write",work:(scope:SqlWriter)=>Promise<T>):Promise<T> {
    if(!this.accepting)return Promise.reject(new Error("数据库正在关闭，请重新打开存储。"));
    const operation=this.tail.then(async()=>{
      if(this.poisoned)throw new Error("数据库回滚未确认，请重新打开存储后再试。");
      let active=true;
      const assertOpen=()=>{if(!active)throw new Error("数据库事务上下文已关闭。");};
      const all=async<R>(command:SqlCommand)=>{assertOpen();return this.driver.all<R>(structuredClone(command));};
      const run=async(command:SqlCommand)=>{assertOpen();return this.driver.run(structuredClone(command));};
      // A read scope has no write method at runtime either.
      const handle=(mode==="read"?{all}:{all,run}) as SqlWriter;
      try{await this.driver.begin(mode);}
      catch(error){active=false;this.poisoned=true;throw error;}
      try{
        const value=await work(handle);
        active=false;
        await this.driver.commit();
        return value;
      }catch(error){
        active=false;
        try{await this.driver.rollback();}
        catch(rollbackError){this.poisoned=true;throw new AggregateError([error,rollbackError],"数据库回滚未确认，请重新打开存储。");}
        throw error;
      }
    });
    this.tail=operation.catch(()=>undefined);
    return operation;
  }
}

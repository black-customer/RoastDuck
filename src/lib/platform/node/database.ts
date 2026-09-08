import { sql } from "drizzle-orm";
import { getDbReady,withDbTransaction } from "@db/client";
import type { DatabasePort,SqlCommand,SqlReader,SqlWriter } from "../database";
import { bindingSegments } from "../sql";

function statement(command:SqlCommand) {
  const segments=bindingSegments(command),output=sql.empty();
  segments.forEach((segment,index)=>{
    output.append(sql.raw(segment));
    if(index<segments.length-1)output.append(sql`${command.args![index]}`);
  });
  return output;
}

/** Platform boundary only: reuse the desktop transaction queue; domain code receives explicit handles. */
export const nodeDatabase:DatabasePort={
  read<T>(work:(reader:SqlReader)=>Promise<T>){return withDbTransaction(async()=>{
    const db=await getDbReady();
    await db.run(sql`PRAGMA query_only=ON`);
    let active=true;
    const reader:SqlReader={async all<R>(command:SqlCommand){if(!active)throw new Error("数据库作用域已关闭。");return db.all<R>(statement(command));}};
    try{return await work(reader);}
    finally{active=false;await db.run(sql`PRAGMA query_only=OFF`);}
  });},
  write<T>(work:(writer:SqlWriter)=>Promise<T>){return withDbTransaction(async()=>{
    const db=await getDbReady();let active=true;
    const assertOpen=()=>{if(!active)throw new Error("数据库作用域已关闭。");};
    const writer:SqlWriter={
      async all<R>(command:SqlCommand){assertOpen();return db.all<R>(statement(command));},
      async run(command){assertOpen();const result=await db.run(statement(command));return {changes:result.rowsAffected,lastInsertRowId:result.lastInsertRowid?.toString()};},
    };
    try{return await work(writer);}finally{active=false;}
  });},
};

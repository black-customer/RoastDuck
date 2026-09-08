import type { SqlCommand,SqlValue } from "./database";

/** Internal query composition: values are bound, only explicit SqlCommand fragments are SQL. */
export function query(parts:TemplateStringsArray,...values:Array<SqlValue|SqlCommand>):SqlCommand {
  let sql=parts[0];const args:SqlValue[]=[];
  values.forEach((value,index)=>{
    if(value!==null&&typeof value==="object"&&!(value instanceof Uint8Array)&&"sql" in value){sql+=value.sql;args.push(...value.args??[]);}
    else{sql+="?";args.push(value as SqlValue);}
    sql+=parts[index+1];
  });
  return {sql,args};
}

/** Split positional bind markers, not question marks in SQL literals, names or comments. */
export function bindingSegments(command:SqlCommand):string[] {
  const text=command.sql,segments:string[]=[];let start=0,state="";
  for(let index=0;index<text.length;index++){
    const char=text[index],next=text[index+1];
    if(state==="line"){if(char==="\n")state="";continue;}
    if(state==="comment"){if(char==="*"&&next==="/"){state="";index++;}continue;}
    if(state){
      const end=state==="["?"]":state;
      if(char===end){if(next===end&&state!=="[")index++;else state="";}
      continue;
    }
    if(char==="-"&&next==="-"){state="line";index++;continue;}
    if(char==="/"&&next==="*"){state="comment";index++;continue;}
    if(["'",'"',"`","["].includes(char)){state=char;continue;}
    // SQLite also accepts non-ASCII parameter names. ':'/'@' are never unquoted
    // identifier characters; '$' is allowed inside an existing identifier.
    const identifier=(value:string)=>/[A-Za-z0-9_$\u0080-\uFFFF]/.test(value);
    if(char===":"||char==="@"||(char==="$"&&(index===0||!identifier(text[index-1]))))throw new Error("不支持命名SQL参数，请使用顺序绑定。");
    if(char==="?"){
      if(next&&/\d/.test(next))throw new Error("仅支持顺序绑定参数，不支持编号占位符。");
      segments.push(text.slice(start,index));start=index+1;
    }
  }
  segments.push(text.slice(start));
  if(segments.length-1!==(command.args?.length??0))throw new Error("SQL绑定参数数量不匹配。");
  return segments;
}

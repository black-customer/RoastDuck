import {z} from "zod";
import type {DatabasePort,SqlValue} from "../database";
import {sha256Text} from "../hash";
const record=z.record(z.string(),z.union([z.string(),z.number(),z.null()]));
const bankSchema=z.object({version:z.literal(1),sha256:z.string(),questions:z.array(record),topics:z.array(record),sets:z.array(record),links:z.array(record)});
/** Trusted bundled public content only, never a substitute for the business sync importer. */
export async function installQuestionBank(database:DatabasePort,raw:unknown){
  const bank=bankSchema.parse(raw),data={questions:bank.questions,topics:bank.topics,links:bank.links,sets:bank.sets};
  if(sha256Text(JSON.stringify(data))!==bank.sha256)throw new Error("题库文件校验失败，未写入资料");
  const ids=bank.questions.map(row=>row.id as string);
  const [{count}]=await database.read(tx=>tx.all<{count:number}>({sql:`SELECT count(*) count FROM questions WHERE id IN (${ids.map(()=>"?").join(",")||"NULL"})`,args:ids}));
  if(count===ids.length)return {questions:ids.length};
  await database.write(async tx=>{
    for(const [table,rows] of [["topics",bank.topics],["question_sets",bank.sets],["questions",bank.questions],["question_set_links",bank.links]] as const){
      const columns=new Set((await tx.all<{name:string}>({sql:`PRAGMA table_info(${table})`})).map(row=>row.name));
      for(const row of rows){
        const names=Object.keys(row);if(names.some(name=>!columns.has(name)))throw new Error("题库字段不匹配");
        await tx.run({sql:`INSERT INTO ${table}(${names.join(",")}) VALUES(${names.map(()=>"?").join(",")}) ON CONFLICT DO NOTHING`,args:names.map(name=>row[name]) as SqlValue[]});
      }
    }
  });return {questions:bank.questions.length};
}

/** Export only public question-set-linked questions. No answers, personal questions or keys enter the APK. */
import fs from "node:fs";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";
import {sha256Text} from "../src/lib/platform/hash";
const database=new DatabaseSync(path.resolve("data/app.db"),{readOnly:true});
try{
  const questions=database.prepare(`SELECT q.id,q.book_id,q.topic_id,q.part,q.text,q.text_zh,q.norm_text,q.created_at FROM questions q WHERE trim(q.text)!='' AND q.part IN(1,2,3) AND EXISTS(SELECT 1 FROM question_set_links s WHERE s.question_id=q.id) ORDER BY q.id`).all();
  const ids=new Set(questions.map(row=>String(row.id))),topicIds=new Set(questions.map(row=>row.topic_id).filter(Boolean));
  const topics=database.prepare("SELECT * FROM topics ORDER BY id").all().filter(row=>topicIds.has(row.id));
  const links:Record<string,unknown>[]=database.prepare("SELECT * FROM question_set_links ORDER BY question_id,question_set_id,source_slug,source_page").all().filter(row=>ids.has(String(row.question_id))).map(row=>({...row,source_file:path.basename(String(row.source_file).replaceAll("\\","/"))}));
  const setIds=new Set(links.map(row=>row.question_set_id)),sets=database.prepare("SELECT * FROM question_sets ORDER BY id").all().filter(row=>setIds.has(row.id));
  const data={questions,topics,links,sets};
  if(!questions.length)throw new Error("No public questions; cannot emit an empty bank as successful");
  const result={version:1,sha256:sha256Text(JSON.stringify(data)),notice:"本机已导入的整理题库，仅供个人备考；题季以来源为准，不保证考试原题。",...data};
  fs.mkdirSync("data/generated",{recursive:true});fs.writeFileSync("data/generated/mobile-question-bank.json",JSON.stringify(result));
  console.log(JSON.stringify({questions:questions.length,topics:topics.length,sets:sets.length,sha256:result.sha256,privateAnswers:0,runtimeCalls:0}));
}finally{database.close();}

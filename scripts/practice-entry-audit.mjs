/** 实际 Web 题目入口只读核查；绝不提交回答、启动训练或自动生成。 */
import {createClient} from "@libsql/client";
import fs from "node:fs";
const base=new URL(process.argv[2]??"http://localhost:3001");
if(!["localhost","127.0.0.1"].includes(base.hostname)||base.username||base.password)throw new Error("只能检查本机服务");
const db=createClient({url:process.env.ROASTDUCK_DB??"file:./data/app.db"});
const results=[];
try{
  await db.execute("PRAGMA query_only=ON");
  const questions=(await db.execute("SELECT DISTINCT question_id FROM practice_materials WHERE question_id IS NOT NULL")).rows;
  for(const q of questions){
    try{
      const response=await fetch(new URL(`/api/questions/${encodeURIComponent(q.question_id)}/learning-pack`,base),{signal:AbortSignal.timeout(30000)});
      if(!response.ok)throw new Error(`HTTP ${response.status}`);
      const {pack}=await response.json();
      const current=pack?.currentPractice;
      if(!current||current.status!=="ready"||!current.href||pack.summary.requiredTotal!==current.rows.length)throw new Error("current_material_unavailable_or_count_mismatch");
      if(current.rows.length&&!current.completed&&pack.primaryAction.href!==current.href)throw new Error("primary_action_points_to_wrong_source");
      results.push({questionId:q.question_id,ok:true,rows:current.rows.length,state:pack.state});
    }catch(error){results.push({questionId:q.question_id,ok:false,error:error.message});}
  }
}finally{db.close();}
fs.mkdirSync("test-results/material-audit",{recursive:true});
fs.writeFileSync("test-results/material-audit/entries.json",JSON.stringify({readOnly:true,results},null,2));
const failures=results.filter(r=>!r.ok);
console.log(JSON.stringify({questions:results.length,readOnly:true,writes:0,failures}));
if(failures.length||!results.length)process.exitCode=1;

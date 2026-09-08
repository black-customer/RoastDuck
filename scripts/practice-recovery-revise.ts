/** 生成修订候选而非覆盖已审核快照。修改清单本身由 Agent 撰写，不作自动内容裁决。 */
import fs from "node:fs";
import path from "node:path";
const [base,target]=process.argv.slice(2);
if(![base,target].every(s=>/^batch-\d+(?:-r\d+)?$/.test(s??"")))throw new Error("传入两个批次名");
const directory=path.resolve("data/imports/private/four-step-recovery");
type Unit=Record<string,unknown>;
const authors=JSON.parse(fs.readFileSync(path.join(directory,`${base}.author.json`),"utf8")) as Array<{index:number;units:Unit[]}>;
const edits=JSON.parse(fs.readFileSync(path.join(directory,`${target}.changes.json`),"utf8")) as Array<{index:number;replace?:Unit[];units?:Record<string,Unit>;append?:Unit[]}>;
for(const edit of edits){
  const author=authors.find(a=>a.index===edit.index);if(!author)throw new Error("未知源索引");
  if(edit.replace)author.units=edit.replace;
  else for(const [index,replacement] of Object.entries(edit.units??{}))author.units[Number(index)]={...author.units[Number(index)],...replacement};
  author.units.push(...edit.append??[]);
}
if(fs.existsSync(path.join(directory,`${target}.candidates.json`))||fs.existsSync(path.join(directory,`${target}.review.json`)))throw new Error("候选已送审，必须新建修订编号");
fs.writeFileSync(path.join(directory,`${target}.author.json`),JSON.stringify(authors,null,2));
console.log({base,target,edited:edits.length});

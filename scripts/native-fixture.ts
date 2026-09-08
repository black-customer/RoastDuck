/** Generate ONLY synthetic native test commands; never imports a user's database. */
import fs from "node:fs";
import path from "node:path";
const directory=path.resolve("test-results",`native-fixture-${Date.now()}`);
fs.mkdirSync(directory,{recursive:true});
process.env.ROASTDUCK_DB=`file:${path.join(directory,"synthetic.db").replaceAll("\\","/")}`;
process.env.ROASTDUCK_SKIP_DB_BACKUP="1";
process.env.AI_PROVIDER="mock";
process.env.DEEPSEEK_API_KEY="";process.env.MIMO_API_KEY="";
globalThis.fetch=async()=>{throw new Error("Native test fixture must not use network");};
const {getDbReady}=await import("../db/client");
const {publishLightFixture}=await import("../tests/helpers/light-material");
const db=await getDbReady();
for(const [i,[en,zh]] of [["brush my teeth","刷牙"],["wash my hands","洗手"],["wipe the table","擦桌子"],["charge my phone","给手机充电"],["take a shower","洗澡"]].entries()){
  await publishLightFixture(db,`native-${i}`,en,zh,"native-question");
}
const commands=[];
for(const table of ["questions","speaking_question_attempts","learning_items","practice_materials","practice_material_items","practice_material_stages","practice_offline_runs"]){
  const rows=(await db.$client.execute(`SELECT * FROM ${table}`)).rows;
  for(const row of rows){
    const columns=Object.keys(row);
    commands.push({sql:`INSERT INTO ${table}(${columns.join(",")}) VALUES(${columns.map(()=>"?").join(",")})`,args:columns.map(name=>row[name])});
  }
}
const target=path.resolve("test-results/native-fixture.json");
fs.writeFileSync(target,JSON.stringify(commands));
console.log(JSON.stringify({source:"synthetic test compiler",networkCalls:0,commands:commands.length,target}));
db.$client.close();

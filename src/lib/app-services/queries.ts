import {z} from "zod";
import type {DatabasePort,SqlCommand} from "@/lib/platform/database";
import {query as sql} from "@/lib/platform/sql";
import {TrainingError} from "@/lib/four-step/shared";
export interface AppQuestion {id:string;text:string;text_zh:string;part:number;topic_id:string|null;topic_zh:string;topic_en:string;favorite:number;answer_count:number;material_count:number;source_refs_json:string}
const filterSchema=z.object({q:z.string().trim().max(120).default(""),part:z.number().int().min(1).max(3).optional(),topic:z.string().max(160).optional(),set:z.string().max(160).optional(),favorite:z.boolean().default(false),answered:z.boolean().optional(),page:z.number().int().min(1).default(1),pageSize:z.number().int().min(1).max(48).default(24)}).strict();
export type AppQuestionFilters=z.input<typeof filterSchema>;
const select=sql`SELECT q.id,q.text,q.text_zh,q.part,q.topic_id,q.source_refs_json,COALESCE(t.name_zh,'') topic_zh,COALESCE(t.name_en,'') topic_en,
  EXISTS(SELECT 1 FROM question_favorites f WHERE f.question_id=q.id) favorite,
  (SELECT count(*) FROM speaking_question_attempts a WHERE a.question_id=q.id AND NOT EXISTS(SELECT 1 FROM practice_answer_sources m JOIN personal_answers p ON p.id=m.answer_id WHERE m.attempt_id=a.id AND p.superseded_by_revision_id IS NOT NULL)) answer_count,
  (SELECT count(*) FROM practice_materials m WHERE m.question_id=q.id AND m.status='ready') material_count
  FROM questions q LEFT JOIN topics t ON t.id=q.topic_id`;
export function createQuestionService(database:DatabasePort){
  async function list(raw:AppQuestionFilters={}){
    const input=filterSchema.parse(raw),clauses:SqlCommand[]=[sql`q.part IN (1,2,3)`];
    if(input.q)clauses.push(sql`(q.text LIKE ${`%${input.q}%`} OR q.text_zh LIKE ${`%${input.q}%`} OR t.name_zh LIKE ${`%${input.q}%`} OR t.name_en LIKE ${`%${input.q}%`})`);
    if(input.part)clauses.push(sql`q.part=${input.part}`);
    if(input.topic)clauses.push(sql`q.topic_id=${input.topic}`);
    if(input.set)clauses.push(sql`EXISTS(SELECT 1 FROM question_set_links s WHERE s.question_id=q.id AND s.question_set_id=${input.set})`);
    if(input.favorite)clauses.push(sql`EXISTS(SELECT 1 FROM question_favorites f WHERE f.question_id=q.id)`);
    if(input.answered!==undefined)clauses.push(sql`EXISTS(SELECT 1 FROM speaking_question_attempts a WHERE a.question_id=q.id AND NOT EXISTS(SELECT 1 FROM practice_answer_sources m JOIN personal_answers p ON p.id=m.answer_id WHERE m.attempt_id=a.id AND p.superseded_by_revision_id IS NOT NULL))=${Number(input.answered)}`);
    const where=clauses.reduce((a,b)=>sql`${a} AND ${b}`);
    return database.read(async tx=>{
      const [{total}]=await tx.all<{total:number}>(sql`SELECT count(*) total FROM questions q LEFT JOIN topics t ON t.id=q.topic_id WHERE ${where}`);
      const items=await tx.all<AppQuestion>(sql`${select} WHERE ${where} ORDER BY q.part,COALESCE(t.name_zh,''),q.norm_text,q.id LIMIT ${input.pageSize} OFFSET ${(input.page-1)*input.pageSize}`);
      return {items,total,page:input.page,pageSize:input.pageSize};
    });
  }
  async function get(id:string){return database.read(async tx=>{
    const [question]=await tx.all<AppQuestion>(sql`${select} WHERE q.id=${id}`);
    if(!question)throw new TrainingError("题目不存在",404,"question_missing");
    const sources=await tx.all<{question_set_id:string;source_slug:string;source_file:string;source_page:number;set_name:string}>(sql`SELECT s.*,COALESCE(qs.name_zh,'本地题库') set_name FROM question_set_links s LEFT JOIN question_sets qs ON qs.id=s.question_set_id WHERE s.question_id=${id} ORDER BY qs.sort,s.source_page`);
    return {...question,sources:sources.map(source=>({...source,source_file:source.source_file.replaceAll("\\","/").split("/").at(-1)!}))};
  });}
  async function random(raw:AppQuestionFilters={}){
    const page=await list({...raw,page:1,pageSize:1});
    if(!page.total)throw new TrainingError("当前筛选下没有题目",404,"no_questions");
    return (await list({...raw,page:Math.floor(Math.random()*page.total)+1,pageSize:1})).items[0];
  }
  async function favorite(id:string,value:boolean){return database.write(async tx=>{
    if(!(await tx.all(sql`SELECT id FROM questions WHERE id=${id}`)).length)throw new TrainingError("题目不存在",404,"question_missing");
    if(value)await tx.run(sql`INSERT INTO question_favorites(question_id) VALUES(${id}) ON CONFLICT DO NOTHING`);
    else await tx.run(sql`DELETE FROM question_favorites WHERE question_id=${id}`);
    return {favorite:value};
  });}
  const facets=()=>database.read(async tx=>({
    sets:await tx.all<{id:string;name_zh:string;year:number;start_month:number;end_month:number;question_count:number}>(sql`SELECT s.*,(SELECT count(DISTINCT question_id) FROM question_set_links WHERE question_set_id=s.id) question_count FROM question_sets s WHERE s.status='active' ORDER BY s.sort,s.year DESC,s.start_month DESC`),
    topics:await tx.all<{id:string;name_zh:string;name_en:string;part:number|null;question_count:number}>(sql`SELECT t.id,t.name_zh,t.name_en,t.ielts_part part,count(q.id) question_count FROM topics t JOIN questions q ON q.topic_id=t.id GROUP BY t.id ORDER BY t.name_zh,t.id`),
  }));
  return {list,get,random,favorite,facets};
}

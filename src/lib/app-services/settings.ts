import {z} from "zod";
import type {DatabasePort} from "@/lib/platform/database";
import {query as sql} from "@/lib/platform/sql";
import {hash} from "@/lib/four-step/shared";
const settingsSchema=z.object({autoPlay:z.boolean(),autoCollectDifficulties:z.boolean(),defaultAccent:z.enum(["en-US","en-GB"])});
export function createAppSettings(database:DatabasePort,now:()=>Date){
  async function get(){return database.read(async tx=>{
    const [row]=await tx.all<{auto_play:number;auto_collect_difficulties:number;default_accent:string}>(sql`SELECT * FROM user_settings WHERE id=1`);
    return row?{autoPlay:Boolean(row.auto_play),autoCollectDifficulties:Boolean(row.auto_collect_difficulties),defaultAccent:row.default_accent==="en-GB"?"en-GB" as const:"en-US" as const}:{autoPlay:true,autoCollectDifficulties:false,defaultAccent:"en-US" as const};
  });}
  async function save(raw:unknown){
    const value=settingsSchema.parse(raw);
    await database.write(tx=>tx.run(sql`INSERT INTO user_settings(id,auto_play,auto_collect_difficulties,default_accent,updated_at)
      VALUES(1,${Number(value.autoPlay)},${Number(value.autoCollectDifficulties)},${value.defaultAccent},${now().toISOString()})
      ON CONFLICT(id) DO UPDATE SET auto_play=excluded.auto_play,auto_collect_difficulties=excluded.auto_collect_difficulties,default_accent=excluded.default_accent,updated_at=excluded.updated_at`));return value;
  }
  const notes=()=>database.read(tx=>tx.all<{id:string;surface:string;meaning_zh:string;user_remark:string;status:string;source_id:string}>(sql`SELECT id,surface,meaning_zh,user_remark,status,source_id FROM difficult_notes ORDER BY updated_at DESC,id`));
  async function saveNote(input:{id?:string;itemId?:string;surface?:string;meaningZh?:string;remark:string;status?:"open"|"resolved"}){
    z.string().max(4000).parse(input.remark);
    const id=input.id??`note_${hash("learning_item",input.itemId??"",input.surface??"").slice(0,24)}`;
    await database.write(async tx=>{
      const found=await tx.all(sql`SELECT 1 FROM difficult_notes WHERE id=${id}`);
      if(!found.length){
        if(!input.itemId||!input.surface)throw new Error("收藏需要关联实际表达");
        if(!(await tx.all(sql`SELECT 1 FROM learning_items WHERE id=${input.itemId} AND status='active'`)).length)throw new Error("表达已移除");
        await tx.run(sql`INSERT INTO difficult_notes(id,surface,meaning_zh,source_type,source_id,last_trigger,user_remark) VALUES(${id},${input.surface},${input.meaningZh??""},'learning_item',${input.itemId},'explicit_favorite',${input.remark})`);
      }
      await tx.run(sql`UPDATE difficult_notes SET user_remark=${input.remark},status=${input.status??"open"},updated_at=${now().toISOString()} WHERE id=${id}`);
    });return {id};
  }
  return {get,save,notes,saveNote};
}

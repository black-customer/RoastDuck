import type {DatabasePort} from '@/lib/platform/database';
import {query as sql} from '@/lib/platform/sql';
import {createLightCatalogue} from '@/lib/light-study/core-catalogue';
import type {LightScope} from '@/lib/light-study/contracts';
import {normalizeKey} from './shared';
import {credentialValue} from './shared';
import {z} from 'zod';
import {TrainingError,hash} from '@/lib/four-step/shared';
export interface ExpressionPreference {hidden:number;favorite:number;note:string;version:number}
export function createExpressionService(database:DatabasePort,allowMock=false){
  async function list(search='',scope:LightScope={type:'all'},includeHidden=false){return database.read(async tx=>{
    const {cards}=await createLightCatalogue(tx,allowMock).readLightCatalogue(scope,includeHidden),query=normalizeKey(search).slice(0,160);
    const notes=await tx.all<{id:string;source_id:string;user_remark:string}>(sql`SELECT id,source_id,user_remark FROM difficult_notes WHERE source_type='learning_item'`);
    const preferences=await tx.all<ExpressionPreference&{learning_item_id:string}>(sql`SELECT * FROM expression_preferences`);
    return cards.filter(card=>normalizeKey(card.english+' '+card.chinese+' '+card.sentenceEn).includes(query))
      .map(card=>({...card,note:notes.find(note=>note.source_id===card.itemId)??null,preference:preferences.find(p=>p.learning_item_id===card.itemId)??{hidden:0,favorite:0,note:'',version:0}}));
  });}
  async function update(raw:unknown){
    const input=z.object({itemId:z.string(),materialId:z.string(),version:z.number().int().nonnegative(),hidden:z.boolean().optional(),favorite:z.boolean().optional(),note:z.string().max(4000).optional(),feedback:z.string().min(2).max(2000).optional(),clientEventId:z.string().min(1).max(160).optional()}).strict().parse(raw);
    if(credentialValue((input.note??'')+(input.feedback??'')))throw new TrainingError('请去除备注中的密钥或凭证',400,'sensitive_note');
    return database.write(async tx=>{
      const {cards}=await createLightCatalogue(tx,allowMock).readLightCatalogue({type:'material',id:input.materialId},true),card=cards.find(c=>c.itemId===input.itemId);
      if(!card)throw new TrainingError('材料已失效；不会恢复或覆盖原内容',409,'material_unavailable');
      const [old]=await tx.all<ExpressionPreference>(sql`SELECT * FROM expression_preferences WHERE learning_item_id=${input.itemId}`),current=old??{hidden:0,favorite:0,note:'',version:0};
      const hidden=input.hidden===undefined?current.hidden:Number(input.hidden),favorite=input.favorite===undefined?current.favorite:Number(input.favorite),note=input.note??current.note;
      if(current.version!==input.version&&(hidden!==current.hidden||favorite!==current.favorite||note!==current.note))throw new TrainingError('另一窗口已更新，请重新读取',409,'preference_conflict');
      const timestamp=new Date().toISOString();
      if(input.feedback){if(!input.clientEventId)throw new TrainingError('反馈缺少请求编号',400,'event_missing');const id=`feedback_${hash(input.clientEventId).slice(0,24)}`;
        const [receipt]=await tx.all<{material_id:string;learning_item_id:string;reason:string}>(sql`SELECT * FROM material_feedback WHERE id=${id}`);
        if(receipt&&(receipt.material_id!==card.materialId||receipt.learning_item_id!==card.itemId||receipt.reason!==input.feedback))throw new TrainingError('反馈请求编号重复',409,'event_conflict');
        await tx.run(sql`INSERT INTO material_feedback(id,material_id,material_hash,learning_item_id,row_index,reason,created_at) VALUES(${id},${card.materialId},${card.materialHash},${card.itemId},${card.rowIndex},${input.feedback},${timestamp}) ON CONFLICT DO NOTHING`);
      }
      if(!old||hidden!==current.hidden||favorite!==current.favorite||note!==current.note)await tx.run(sql`INSERT INTO expression_preferences(learning_item_id,hidden,favorite,note,version,updated_at) VALUES(${input.itemId},${hidden},${favorite},${note},1,${timestamp}) ON CONFLICT(learning_item_id) DO UPDATE SET hidden=excluded.hidden,favorite=excluded.favorite,note=excluded.note,version=expression_preferences.version+1,updated_at=excluded.updated_at`);
      return (await tx.all<ExpressionPreference>(sql`SELECT * FROM expression_preferences WHERE learning_item_id=${input.itemId}`))[0];
    });
  }
  return {list,update};
}

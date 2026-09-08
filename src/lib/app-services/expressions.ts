import type {DatabasePort} from '@/lib/platform/database';
import {query as sql} from '@/lib/platform/sql';
import {createLightCatalogue} from '@/lib/light-study/core-catalogue';
import type {LightScope} from '@/lib/light-study/contracts';
import {normalizeKey} from './shared';
import {credentialValue} from './shared';
import {z} from 'zod';
import {TrainingError,hash} from '@/lib/four-step/shared';
export interface ExpressionPreference {hidden:number;favorite:number;self_known:number;note:string;version:number}
export interface ExpressionSummary {total:number;eligibleTotal:number;studied:number;eligibleStudied:number;selfKnownUnstudied:number;eligibleSelfKnownUnstudied:number;new:number;due:number;hidden:number}
const emptyPreference=():ExpressionPreference=>({hidden:0,favorite:0,self_known:0,note:'',version:0});
export function createExpressionService(database:DatabasePort,allowMock=false){
  async function list(search='',scope:LightScope={type:'all'},includeHidden=false){return database.read(async tx=>{
    const {cards,progress}=await createLightCatalogue(tx,allowMock).readLightCatalogue(scope,includeHidden,true),query=normalizeKey(search).slice(0,160);
    const notes=await tx.all<{id:string;source_id:string;user_remark:string}>(sql`SELECT id,source_id,user_remark FROM difficult_notes WHERE source_type='learning_item'`);
    const preferences=await tx.all<ExpressionPreference&{learning_item_id:string}>(sql`SELECT * FROM expression_preferences`);
    return cards.filter(card=>normalizeKey(card.english+' '+card.chinese+' '+card.sentenceEn).includes(query))
      .map(card=>({...card,sources:card.sources??[],progress:progress.get(card.itemId)??null,note:notes.find(note=>note.source_id===card.itemId)??null,preference:preferences.find(p=>p.learning_item_id===card.itemId)??emptyPreference()}));
  });}
  /** Lifetime exposure and current-material completion are separate projections. */
  async function summary(scope:LightScope={type:'all'},now=new Date()):Promise<ExpressionSummary>{return database.read(async tx=>{
    const {cards,progress}=await createLightCatalogue(tx,allowMock).readLightCatalogue(scope,true,true);
    const preferences=new Map((await tx.all<ExpressionPreference&{learning_item_id:string}>(sql`SELECT * FROM expression_preferences`)).map(p=>[p.learning_item_id,p]));
    const result:ExpressionSummary={total:cards.length,eligibleTotal:0,studied:0,eligibleStudied:0,selfKnownUnstudied:0,eligibleSelfKnownUnstudied:0,new:0,due:0,hidden:0};
    for(const card of cards){
      const preference=preferences.get(card.itemId),studied=progress.get(card.itemId);
      if(studied)result.studied++;
      if(preference?.self_known&&!studied)result.selfKnownUnstudied++;
      if(preference?.hidden){result.hidden++;continue;}
      result.eligibleTotal++;
      if(studied)result.eligibleStudied++;
      else if(preference?.self_known)result.eligibleSelfKnownUnstudied++;
      if(preference?.self_known)continue;
      if(!studied)result.new++;
      else if(new Date(studied.due_at).getTime()<=now.getTime())result.due++;
    }
    const sourceScope=scope.type==='question'?sql`pm.question_id=${scope.id}`:scope.type==='material'?sql`pm.id=${scope.id}`:scope.type==='collection'?sql`pm.source_type=${scope.id==='ielts'?'ielts_practice':'free_talk'}`:sql`1=1`;
    const filters=scope.type==='collection'&&scope.id==='ielts'?scope:null;
    const [{count}]=await tx.all<{count:number}>(sql`SELECT COUNT(DISTINCT lp.learning_item_id) count FROM light_study_progress lp
      JOIN practice_material_items mi ON mi.learning_item_id=lp.learning_item_id JOIN practice_materials pm ON pm.id=mi.material_id
      LEFT JOIN questions q ON q.id=pm.question_id LEFT JOIN topics t ON t.id=q.topic_id
      WHERE ${sourceScope}
      AND (${filters?.questionId?sql`pm.question_id=${filters.questionId}`:sql`1=1`})
      AND (${filters?.topicId?(filters.topicId==='unmarked'?sql`q.topic_id IS NULL OR t.id IS NULL`:sql`q.topic_id=${filters.topicId}`):sql`1=1`})
      AND (${filters?.seasonId?(filters.seasonId==='unmarked'?sql`NOT EXISTS(SELECT 1 FROM question_set_links qsl JOIN question_sets qs ON qs.id=qsl.question_set_id WHERE qsl.question_id=q.id)`:sql`EXISTS(SELECT 1 FROM question_set_links qsl JOIN question_sets qs ON qs.id=qsl.question_set_id WHERE qsl.question_id=q.id AND qs.id=${filters.seasonId})`):sql`1=1`})`);
    result.studied=Number(count); // A material revision must not erase the learner's past work.
    return result;
  });}
  async function update(raw:unknown){
    const input=z.object({itemId:z.string(),materialId:z.string(),version:z.number().int().nonnegative(),hidden:z.boolean().optional(),favorite:z.boolean().optional(),selfKnown:z.boolean().optional(),note:z.string().max(4000).optional(),feedback:z.string().min(2).max(2000).optional(),clientEventId:z.string().min(1).max(160).optional()}).strict().parse(raw);
    if(credentialValue((input.note??'')+(input.feedback??'')))throw new TrainingError('请去除备注中的密钥或凭证',400,'sensitive_note');
    return database.write(async tx=>{
      const {cards}=await createLightCatalogue(tx,allowMock).readLightCatalogue({type:'material',id:input.materialId},true,true),card=cards.find(c=>c.itemId===input.itemId);
      if(!card)throw new TrainingError('材料已失效；不会恢复或覆盖原内容',409,'material_unavailable');
      const [old]=await tx.all<ExpressionPreference>(sql`SELECT * FROM expression_preferences WHERE learning_item_id=${input.itemId}`),current=old??emptyPreference();
      const hidden=input.hidden===undefined?current.hidden:Number(input.hidden),favorite=input.favorite===undefined?current.favorite:Number(input.favorite),selfKnown=input.selfKnown===undefined?current.self_known:Number(input.selfKnown),note=input.note??current.note;
      const changed=hidden!==current.hidden||favorite!==current.favorite||selfKnown!==current.self_known||note!==current.note;
      if(current.version!==input.version&&changed)throw new TrainingError('另一窗口已更新，请重新读取',409,'preference_conflict');
      const timestamp=new Date().toISOString();
      if(input.feedback){if(!input.clientEventId)throw new TrainingError('反馈缺少请求编号',400,'event_missing');const id=`feedback_${hash(input.clientEventId).slice(0,24)}`;
        const [receipt]=await tx.all<{material_id:string;learning_item_id:string;reason:string}>(sql`SELECT * FROM material_feedback WHERE id=${id}`);
        if(receipt&&(receipt.material_id!==card.materialId||receipt.learning_item_id!==card.itemId||receipt.reason!==input.feedback))throw new TrainingError('反馈请求编号重复',409,'event_conflict');
        await tx.run(sql`INSERT INTO material_feedback(id,material_id,material_hash,learning_item_id,row_index,reason,created_at) VALUES(${id},${card.materialId},${card.materialHash},${card.itemId},${card.rowIndex},${input.feedback},${timestamp}) ON CONFLICT DO NOTHING`);
      }
      if(!old||changed)await tx.run(sql`INSERT INTO expression_preferences(learning_item_id,hidden,favorite,self_known,note,version,updated_at) VALUES(${input.itemId},${hidden},${favorite},${selfKnown},${note},1,${timestamp}) ON CONFLICT(learning_item_id) DO UPDATE SET hidden=excluded.hidden,favorite=excluded.favorite,self_known=excluded.self_known,note=excluded.note,version=expression_preferences.version+1,updated_at=excluded.updated_at`);
      return (await tx.all<ExpressionPreference>(sql`SELECT * FROM expression_preferences WHERE learning_item_id=${input.itemId}`))[0];
    });
  }
  return {list,summary,update};
}

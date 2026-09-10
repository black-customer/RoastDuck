import type {DatabasePort,SqlReader} from '@/lib/platform/database';
import {query as sql} from '@/lib/platform/sql';
import {sha256Text} from '@/lib/platform/hash';
import {readSentenceCatalogue} from './catalogue';
import {SentenceStudyError,type SentenceCard} from './contracts';
import {highlightAddSchema,highlightAnchor,highlightContextSchema,highlightReadSchema,projectStoredSentenceHighlights,validHighlightRange,type HighlightContext,type HighlightList,type StoredSentenceHighlight} from './highlights';

type HighlightRow=StoredSentenceHighlight;
export function createSentenceHighlights(database:DatabasePort,clock:{now:()=>Date;newId:()=>string}) {
  async function currentCard(db:SqlReader,context:Omit<HighlightContext,'language'>){
    const [unit]=await db.all<{material_id:string}>(sql`SELECT material_id FROM sentence_learning_units WHERE id=${context.sentenceId} AND active=1`);
    if(!unit)throw new SentenceStudyError('这条句子已不再提供学习，请返回材料查看最新版本',409,'material_changed');
    const catalogue=await readSentenceCatalogue(db,{type:'material',id:unit.material_id});
    const card=catalogue.cards.find(value=>value.id===context.sentenceId);
    if(!card||card.version!==context.textVersion)throw new SentenceStudyError('句子版本已更新，旧高亮操作不会应用到新文本，请重新打开当前句子',409,'material_changed');
    return card;
  }
  async function listFor(db:SqlReader,card:SentenceCard):Promise<HighlightList>{
    const rows=await db.all<HighlightRow>(sql`SELECT * FROM sentence_highlights WHERE sentence_id=${card.id} AND state='active' ORDER BY start_offset,end_offset,id`);
    const zh=projectStoredSentenceHighlights(rows,{sentenceId:card.id,language:'zh',textVersion:card.version},card.chinese),en=projectStoredSentenceHighlights(rows,{sentenceId:card.id,language:'en',textVersion:card.version},card.english);
    return {highlights:[...zh.highlights,...en.highlights],unmappedCount:zh.unmappedCount+en.unmappedCount};
  }
  return {
    list:async(raw:unknown)=>{const context=highlightReadSchema.parse(raw);return database.read(async db=>listFor(db,await currentCard(db,context)));},
    add:async(raw:unknown)=>{
      const input=highlightAddSchema.parse(raw),requestHash=sha256Text(JSON.stringify(input));
      return database.write(async tx=>{
        const card=await currentCard(tx,input),text=input.language==='zh'?card.chinese:card.english;
        const [existing]=await tx.all<HighlightRow>(sql`SELECT * FROM sentence_highlights WHERE client_request_id=${input.clientRequestId}`);
        if(existing){if(existing.request_hash!==requestHash)throw new SentenceStudyError('此高亮操作编号已用于其他内容，请重新选择',409,'request_conflict');return listFor(tx,card);}
        if(!validHighlightRange(text,input.start,input.end,input.quote))throw new SentenceStudyError('所选文字与当前句子不一致，请重新选中',400,'invalid_selection');
        const anchor=highlightAnchor(text,input.start,input.end),id=clock.newId(),at=clock.now().toISOString();
        await tx.run(sql`INSERT INTO sentence_highlights(id,sentence_id,language,text_version,text_hash,start_offset,end_offset,quote,prefix,suffix,state,client_request_id,request_hash,created_at,updated_at)
          VALUES(${id},${input.sentenceId},${input.language},${input.textVersion},${anchor.text_hash},${anchor.start_offset},${anchor.end_offset},${anchor.quote},${anchor.prefix},${anchor.suffix},'active',${input.clientRequestId},${requestHash},${at},${at})`);
        return listFor(tx,card);
      });
    },
    remove:async(id:string,raw:unknown)=>{
      const context=highlightContextSchema.parse(raw);
      return database.write(async tx=>{
        const card=await currentCard(tx,context);
        const [row]=await tx.all<HighlightRow>(sql`SELECT * FROM sentence_highlights WHERE id=${id}`);
        if(!row||row.sentence_id!==context.sentenceId||row.language!==context.language)throw new SentenceStudyError('此高亮已不可用，请重新读取',404,'highlight_not_found');
        if(row.state==='active')await tx.run(sql`UPDATE sentence_highlights SET state='deleted',updated_at=${clock.now().toISOString()} WHERE id=${id} AND state='active'`);
        return listFor(tx,card);
      });
    },
  };
}

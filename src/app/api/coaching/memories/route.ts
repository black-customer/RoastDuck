import {NextResponse} from 'next/server';
import {nodeDatabase} from '@/lib/platform/node/database';
import {query as sql} from '@/lib/platform/sql';
import {parseJson} from '@/lib/app-services/shared';
import {webError} from '@/lib/http/web-error';
import {TrainingError} from '@/lib/four-step/shared';
import type {LearningOccurrence} from '@/lib/coaching/learning-memory';
export const dynamic='force-dynamic';
export async function GET(request:Request){
  try{const id=new URL(request.url).searchParams.get('id');if(!id||id.length>160)throw new TrainingError('记忆编号无效',400,'memory_id_invalid');
    const evidence=await nodeDatabase.read(async tx=>{
      const [memory]=await tx.all<{detail_json:string;status:string}>(sql`SELECT detail_json,status FROM companion_memories WHERE id=${id}`);
      if(!memory||memory.status!=='active')throw new TrainingError('记忆已撤销或不存在',404,'memory_missing');
      const detail=parseJson<{occurrences?:LearningOccurrence[]}>(memory.detail_json,{});
      const rows=[];
      for(const entry of (detail.occurrences??[]).slice(-20)){
        const [message]=entry.messageId?await tx.all<{text:string;created_at:string}>(sql`SELECT text,created_at FROM companion_messages WHERE id=${entry.messageId} AND role='user'`):entry.sourceType==='ielts_practice'&&entry.sourceId?await tx.all<{text:string;created_at:string}>(sql`SELECT answer_text text,created_at FROM speaking_question_attempts WHERE id=${entry.sourceId}`):entry.sourceType==='free_talk'&&entry.sourceId?await tx.all<{text:string;created_at:string}>(sql`SELECT text,created_at FROM free_talk_messages WHERE id=${entry.sourceId} AND role='user'`):[];
        if(!message||!message.text.includes(entry.quote))continue;
        rows.push({messageId:entry.messageId??entry.occurrenceId??entry.sourceId,sourceText:message.text,quote:entry.quote,correction:entry.correction,reasonZh:entry.reviewerReason,assisted:entry.assisted,assistance:entry.assistance??(entry.assisted?'assisted':'independent'),kind:entry.kind??'confirmed_error',mode:entry.mode,createdAt:message.created_at});
      }
      return rows;
    });return NextResponse.json({evidence});
  }catch(error){return webError(error);}
}

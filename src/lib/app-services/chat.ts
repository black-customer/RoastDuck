import {z} from "zod";
import type {DatabasePort,SqlWriter} from "@/lib/platform/database";
import {query as sql} from "@/lib/platform/sql";
import type {RuntimeCalls,RuntimeCallOptions} from "@/lib/ai/runtime-ledger";
import {RuntimeRequestError} from "@/lib/ai/runtime-ledger";
import {AiProviderError} from "@/lib/ai/errors";
import {createLightCatalogue} from "@/lib/light-study/core-catalogue";
import type {MaterialService} from "@/lib/four-step/core-materials";
import {TrainingError} from "@/lib/four-step/shared";
import type {MemoryService} from "./memory";
import {dialogueResponseSchema} from "./dialogue-contracts";
import {credentialValue,parseJson,stableId} from "./shared";
import {SPOKEN_STYLE_VERSION,SELECTION_POLICY_VERSION} from '@/lib/four-step/stage-contracts';
export interface AppConversation {id:string;title:string;mode:"relaxed"|"strict";status:string;created_at:string;updated_at:string;thread_id:string|null;question_id:string|null}
export interface AppMessage {id:string;conversation_id:string;sequence_no:number;role:"user"|"assistant";text:string;metadata_json:string;created_at:string;teaching_state:string|null;target_repetition:string|null;gap_count:number}
type Meta={clientMessageId?:string;deliveryStatus?:string;replyTo?:string;leaseToken?:string|null;leaseExpiresAt?:string|null;payload?:unknown;errorCode?:string;runId?:string;translationZh?:string;glossary?:unknown;purpose?:string};
const meta=(message:AppMessage)=>parseJson<Meta>(message.metadata_json,{});
export function createChatService(database:DatabasePort,runtime:RuntimeCalls,memories:MemoryService,materials:MaterialService,platform:{now:()=>Date;newId:()=>string;bootId:string;loadPrompt:(name:string)=>string|Promise<string>;allowMock?:boolean}){
  const active=new Map<string,Promise<AppMessage[]>>();
  const now=()=>platform.now().toISOString();
  const conversationSql=sql`SELECT f.*,t.id thread_id,t.scope_id question_id FROM free_talk_conversations f LEFT JOIN companion_threads t ON t.scope_key='free_talk:'||f.id`;
  const list=()=>database.read(tx=>tx.all<AppConversation>(sql`${conversationSql} WHERE f.status='active' ORDER BY julianday(f.updated_at) DESC,f.id`));
  async function get(id:string){const [result]=await database.read(tx=>tx.all<AppConversation>(sql`${conversationSql} WHERE f.id=${id}`));if(!result)throw new TrainingError("对话不存在",404,"conversation_missing");return result;}
  const messages=(id:string)=>database.read(tx=>tx.all<AppMessage>(sql`SELECT * FROM free_talk_messages WHERE conversation_id=${id} ORDER BY sequence_no`));
  async function mirror(tx:SqlWriter,conversationId:string,threadId:string){
    const rows=await tx.all<AppMessage>(sql`SELECT * FROM free_talk_messages WHERE conversation_id=${conversationId} ORDER BY sequence_no`);
    for(const row of rows){
      const metadata=meta(row),status=row.role==="user"&&metadata.deliveryStatus&&metadata.deliveryStatus!=="completed"?metadata.deliveryStatus:"sent";
      const [existing]=await tx.all<{id:string}>(sql`SELECT id FROM companion_messages WHERE thread_id=${threadId} AND source_type='free_talk' AND source_id=${row.id} LIMIT 1`);
      await tx.run(sql`INSERT INTO companion_messages(id,thread_id,sequence_no,role,text,status,client_message_id,source_type,source_id,ai_run_id,metadata_json,created_at)
        VALUES(${existing?.id??stableId("companion_message",conversationId,row.id)},${threadId},${row.sequence_no},${row.role==="assistant"?"teacher":"user"},${row.text},${status},${row.id},'free_talk',${row.id},${metadata.runId??null},${row.metadata_json},${row.created_at})
        ON CONFLICT(id) DO UPDATE SET status=excluded.status,ai_run_id=excluded.ai_run_id,metadata_json=excluded.metadata_json`);
    }
  }
  async function ensureThread(tx:SqlWriter,conversation:AppConversation,questionId:string|null=null){
    const id=conversation.thread_id??stableId("companion","free_talk:"+conversation.id);
    await tx.run(sql`INSERT INTO companion_threads(id,scope_key,scope_type,scope_id,title,created_at,updated_at)
      VALUES(${id},${"free_talk:"+conversation.id},${questionId?"question":"general"},${questionId},${conversation.title},${now()},${now()}) ON CONFLICT DO NOTHING`);
    await mirror(tx,conversation.id,id);return id;
  }
  async function create(raw:{clientRequestId:string;title?:string;mode?:"relaxed"|"strict";questionId?:string}){
    const input=z.object({clientRequestId:z.string().min(8).max(160),title:z.string().trim().min(1).max(200).default("和 Chloe 随便聊聊"),mode:z.enum(["relaxed","strict"]).default("relaxed"),questionId:z.string().max(160).optional()}).parse(raw);
    const id=stableId("ft_conv",input.clientRequestId);
    await database.write(async tx=>{
      const [prior]=await tx.all<AppConversation>(sql`SELECT * FROM free_talk_conversations WHERE id=${id}`);
      if(prior){if(prior.title!==input.title||prior.mode!==input.mode)throw new TrainingError("创建编号已用于其他对话",409,"conversation_conflict");return;}
      if(input.questionId&&!(await tx.all(sql`SELECT id FROM questions WHERE id=${input.questionId}`)).length)throw new TrainingError("题目不存在",404,"question_missing");
      await tx.run(sql`INSERT INTO free_talk_conversations(id,title,mode,status,created_at,updated_at) VALUES(${id},${input.title},${input.mode},'active',${now()},${now()})`);
      await tx.run(sql`INSERT INTO free_talk_messages(id,conversation_id,sequence_no,role,text,metadata_json,created_at)
        VALUES(${stableId("ft_opening",id)},${id},1,'assistant',${"Hi, I'm Chloe, your AI English-learning companion. What's on your mind? Chinese, English, or a mix is welcome."},${JSON.stringify({isWelcome:true,translationZh:"我是 Chloe，你的 AI 英语学习搭子。想聊什么？中文、英文或中英混合都可以。"})},${now()})`);
      await ensureThread(tx,{id,title:input.title,mode:input.mode,status:"active",created_at:now(),updated_at:now(),thread_id:null,question_id:input.questionId??null},input.questionId??null);
    });return get(id);
  }
  async function prepare(conversationId:string,input:{clientMessageId:string;text:string}){
    z.string().trim().min(1).max(8000).parse(input.text);z.string().min(8).max(160).parse(input.clientMessageId);
    if(credentialValue(input.text))throw new TrainingError("内容看起来包含凭证，不会保存或发送，请先去除",400,"sensitive_message");
    const conversation=await get(conversationId);
    if(conversation.status!=="active")throw new TrainingError("对话已经归档",409,"conversation_archived");
    return database.write(async tx=>{
      const history=await tx.all<AppMessage>(sql`SELECT * FROM free_talk_messages WHERE conversation_id=${conversationId} ORDER BY sequence_no`);
      const prior=history.find(row=>row.role==="user"&&meta(row).clientMessageId===input.clientMessageId);
      if(prior){if(prior.text!==input.text)throw new TrainingError("消息编号已用于其他内容",409,"message_conflict");return prior;}
      if(history.some(row=>row.role==="user"&&["pending","failed"].includes(meta(row).deliveryStatus??"")))throw new TrainingError("上一条消息已保留，请先恢复回复",409,"previous_message_unresolved");
      const id=stableId("ft_user",conversationId,input.clientMessageId),sequence=(history.at(-1)?.sequence_no??0)+1;
      await tx.run(sql`INSERT INTO free_talk_messages(id,conversation_id,sequence_no,role,text,metadata_json,created_at)
        VALUES(${id},${conversationId},${sequence},'user',${input.text},${JSON.stringify({clientMessageId:input.clientMessageId,deliveryStatus:"pending",previousMessageId:history.at(-1)?.id??null})},${now()})`);
      await ensureThread(tx,conversation,conversation.question_id);
      await tx.run(sql`UPDATE free_talk_conversations SET updated_at=${now()} WHERE id=${conversationId}`);
      return (await tx.all<AppMessage>(sql`SELECT * FROM free_talk_messages WHERE id=${id}`))[0];
    });
  }
  async function processUser(conversationId:string,userId:string,options:RuntimeCallOptions){
    const conversation=await get(conversationId),history=await messages(conversationId),user=history.find(row=>row.id===userId&&row.role==="user");
    if(!user)throw new TrainingError("用户消息不存在",404,"message_missing");
    if(meta(user).deliveryStatus==="completed")return history;
    const relevant=await memories.relevant(conversation.title+" "+user.text);
    const due=await database.read(async tx=>{
      const {cards,progress}=await createLightCatalogue(tx,platform.allowMock).readLightCatalogue({type:'all'});
      return cards.filter(card=>(progress.get(card.itemId)?.due_at??'9999')<=now())
        .sort((a,b)=>progress.get(a.itemId)!.due_at.localeCompare(progress.get(b.itemId)!.due_at)||a.itemId.localeCompare(b.itemId))
        .slice(0,conversation.question_id?2:1).map(card=>({id:card.itemId,target_english:card.english,intention_zh:card.chinese}));
    });
    const token=`native.${platform.bootId}.${platform.newId()}`;
    const reserved=await database.write(async tx=>{
      const [current]=await tx.all<AppMessage>(sql`SELECT * FROM free_talk_messages WHERE id=${userId}`);
      if(!current)throw new TrainingError("消息已移除",409,"message_missing");
      const metadata=meta(current);
      if(metadata.deliveryStatus==="completed")return null;
      if(metadata.deliveryStatus==="failed"&&!options.retryFailed&&!options.retryUnknown)throw new TrainingError("消息已保留，请明确重试",409,"message_retry_required");
      if(metadata.leaseExpiresAt&&metadata.leaseExpiresAt>now())throw new TrainingError("回复还在处理，请稍后恢复",409,"message_busy");
      const base=metadata.payload as {dialogueVersion?:'v2'|'v3';dueExpressions?:Array<{id:string}>;relevantMemories?:Array<{id:string}>}|undefined;
      // A retry cannot reintroduce invalidated material or memories removed since the initial request.
      const payload=base?{...base,dueExpressions:base.dueExpressions?.filter(item=>due.some(row=>row.id===item.id))??[],relevantMemories:base.relevantMemories?.filter(item=>relevant.some(row=>row.id===item.id))??[]}:{dialogueVersion:'v3' as const,mode:conversation.mode,questionId:conversation.question_id,recentHistory:history.filter(row=>row.sequence_no<=user.sequence_no).slice(-12).map(row=>({id:row.id,role:row.role,text:row.text})),latestUserMessage:user.text,relevantMemories:relevant.map(row=>({id:row.id,summary:row.summary,category:row.category})),dueExpressions:due};
      const updated={...metadata,payload,deliveryStatus:"pending",leaseToken:token,leaseExpiresAt:new Date(platform.now().getTime()+180000).toISOString(),errorCode:undefined};
      await tx.run(sql`UPDATE free_talk_messages SET metadata_json=${JSON.stringify(updated)} WHERE id=${userId}`);
      return {payload,metadata:updated,threadId:await ensureThread(tx,conversation,conversation.question_id)};
    });
    if(!reserved)return messages(conversationId);
    let deliveredConversationId=conversationId,deliveredThreadId=reserved.threadId;
    try{
      const dialogueVersion=reserved.payload.dialogueVersion==='v3'?'v3':'v2';
      const result=await runtime.call({role:"companion_response",instructions:await platform.loadPrompt(`companion_dialogue.chloe.${dialogueVersion}.md`),input:JSON.stringify(reserved.payload),schema:dialogueResponseSchema,schemaName:"companion_dialogue_v2",promptVersion:`companion-dialogue-${dialogueVersion}`,schemaVersion:"companion-dialogue-v2",idempotencyKey:stableId("ft_resp",conversationId,meta(user).clientMessageId??userId)},options);
      const allowed=(reserved.payload as {dueExpressions?:Array<{id:string}>}).dueExpressions??[];
      if(result.data.usedLearningItemIds.some(id=>!allowed.some(item=>item.id===id))||result.data.usedLearningItemIds.length>allowed.length)throw new TrainingError("回复引用了未提供的旧表达",422,"dialogue_invalid_reference");
      await database.write(async tx=>{
        const [owner]=await tx.all<AppMessage>(sql`SELECT * FROM free_talk_messages WHERE id=${userId}`);
        if(!owner||meta(owner).leaseToken!==token||owner.text!==user.text)throw new TrainingError("旧回复不能覆盖新操作",409,"message_lease_lost");
        deliveredConversationId=owner.conversation_id;
        const [actualConversation]=await tx.all<AppConversation>(sql`${conversationSql} WHERE f.id=${deliveredConversationId}`);
        deliveredThreadId=await ensureThread(tx,actualConversation,actualConversation.question_id);
        let previousMessageId=userId;
        for(const [index,message] of result.data.messages.entries()){
          const id=index===0?stableId("ft_assistant",conversationId,meta(user).clientMessageId!):stableId("ft_assistant",conversationId,meta(user).clientMessageId!,String(index));
          const [prior]=await tx.all<AppMessage>(sql`SELECT * FROM free_talk_messages WHERE id=${id}`);
          if(prior&&(prior.text!==message.text||prior.conversation_id!==deliveredConversationId))throw new TrainingError('已保存回复与本次结果冲突，保留原数据',409,'reply_conflict');
          await tx.run(sql`INSERT INTO free_talk_messages(id,conversation_id,sequence_no,role,text,metadata_json,created_at)
            VALUES(${id},${deliveredConversationId},${owner.sequence_no+1+index},'assistant',${message.text},${JSON.stringify({replyTo:userId,previousMessageId,runId:result.runId,translationZh:message.translationZh,purpose:message.purpose,glossary:result.data.glossary,usedLearningItemIds:result.data.usedLearningItemIds})},${now()}) ON CONFLICT(id) DO NOTHING`);
          previousMessageId=id;
        }
        await tx.run(sql`UPDATE free_talk_messages SET metadata_json=${JSON.stringify({...reserved.metadata,deliveryStatus:"completed",leaseToken:null,leaseExpiresAt:null,runId:result.runId})} WHERE id=${userId}`);
        await mirror(tx,deliveredConversationId,deliveredThreadId);
        await tx.run(sql`UPDATE free_talk_conversations SET updated_at=${now()} WHERE id=${deliveredConversationId}`);
        await tx.run(sql`UPDATE companion_threads SET updated_at=${now()} WHERE id=${deliveredThreadId}`);
      });
      // Personal facts are a separate request and never block delivery of the teacher's messages.
      void memories.extract(deliveredThreadId).catch(()=>undefined);
    }catch(error){
      await database.write(async tx=>{
        const [owner]=await tx.all<AppMessage>(sql`SELECT * FROM free_talk_messages WHERE id=${userId}`);
        if(meta(owner).leaseToken!==token)return;
        const code=error instanceof RuntimeRequestError||error instanceof TrainingError||error instanceof AiProviderError?error.code:"message_service_failed";
        await tx.run(sql`UPDATE free_talk_messages SET metadata_json=${JSON.stringify({...reserved.metadata,deliveryStatus:"failed",leaseToken:null,leaseExpiresAt:null,errorCode:code})} WHERE id=${userId}`);
        await mirror(tx,conversationId,reserved.threadId);
      });throw error;
    }
    return messages(deliveredConversationId);
  }
  function process(conversationId:string,userId:string,options:RuntimeCallOptions={}){
    const running=active.get(userId);if(running)return running;
    const task=processUser(conversationId,userId,options);active.set(userId,task);
    void task.finally(()=>{if(active.get(userId)===task)active.delete(userId);}).catch(()=>undefined);return task;
  }
  async function recap(conversationId:string,startId:string,endId:string){
    const history=await messages(conversationId),start=history.findIndex(row=>row.id===startId),end=history.findIndex(row=>row.id===endId);
    if(start<0||end<start)throw new TrainingError("请选择有效的消息范围",400,"invalid_range");
    const selected=history.slice(start,end+1);
    if(selected.length>24||selected.reduce((sum,row)=>sum+row.text.length,0)>24000)throw new TrainingError("这一段较长，请选择较短范围复盘",400,"recap_too_large");
    if(!selected.some(row=>row.role==="user"))throw new TrainingError("需要包含你的实际表达",400,"no_user_message");
    if(selected.some(row=>row.role==="user"&&meta(row).deliveryStatus!=="completed"&&!(meta(row).deliveryStatus===undefined&&history.some(reply=>reply.role==="assistant"&&reply.sequence_no>row.sequence_no))))throw new TrainingError("请先恢复未完成的回复，再复盘",409,"message_unresolved");
    return materials.prepare({sourceType:"free_talk",sourceId:conversationId,question:null,mode:"free_talk",actualAnswer:selected.filter(row=>row.role==="user").map(row=>row.text).join("\n"),intendedMeaningZh:"",sourceMessages:selected.map(row=>({id:row.id,role:row.role,text:row.text})),spokenStyleVersion:SPOKEN_STYLE_VERSION,selectionPolicyVersion:SELECTION_POLICY_VERSION});
  }
  return {list,get,messages,create,prepare,process,recap};
}
export type ChatService=ReturnType<typeof createChatService>;

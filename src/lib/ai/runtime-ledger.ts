import {z} from "zod";
import type {DatabasePort} from "@/lib/platform/database";
import {query as sql} from "@/lib/platform/sql";
import {hashParts,sha256Text} from "@/lib/platform/hash";
import {AI_ROLE_CONFIG,type AiProvider,type StructuredAiRequest,type StructuredAiResult} from "./contracts";
import {AiProviderError,normalizeAiError,safeErrorSummary} from "./errors";

interface Receipt {
  logical_key:string;run_id:string;owner_boot_id:string;state:"pending"|"completed"|"failed"|"unknown";
  request_hash:string;response_json:string|null;error_code:string|null;updated_at:string;
}
export class RuntimeRequestError extends Error {
  constructor(message:string,readonly code:"request_pending"|"result_unknown"|"request_failed"|"receipt_conflict") {super(message);}
}
export interface RuntimeCallOptions {jobId?:string|null;retryFailed?:boolean;retryUnknown?:boolean}
export type RuntimeResult<T>=StructuredAiResult<T>&{runId:string;attempts:number};
export interface RuntimeCalls {call<T>(request:StructuredAiRequest<T>,options?:RuntimeCallOptions):Promise<RuntimeResult<T>>}

/** Network and stage writes are separate. A completed request can finish a lost stage without paying again. */
export function createRuntimeCalls(database:DatabasePort,provider:AiProvider,clock:{now:()=>Date;newId:()=>string;bootId:string}):RuntimeCalls {
  const active=new Map<string,Promise<unknown>>();
  const received=new Map<string,StructuredAiResult<unknown>>();
  async function save<T>(key:string,runId:string,request:StructuredAiRequest<T>,result:StructuredAiResult<T>) {
    const validated={...result,data:request.schema.parse(result.data)};
    received.set(runId,validated);
    const owned=await database.write(async tx=>{
      const [current]=await tx.all<Receipt>(sql`SELECT * FROM runtime_requests WHERE logical_key=${key}`);
      // A late response keeps audit evidence, but cannot replace a newer explicitly retried request.
      await tx.run(sql`UPDATE ai_runs SET status='completed',response_id=${validated.responseId},response_model=${validated.responseModel??null},error_details_json='{}',latency_ms=${validated.latencyMs},
        input_tokens=${validated.usage.inputTokens},output_tokens=${validated.usage.outputTokens},reasoning_tokens=${validated.usage.reasoningTokens},cached_tokens=${validated.usage.cachedTokens},error_code=NULL,error_summary=NULL WHERE run_id=${runId}`);
      if(current?.run_id!==runId)return false;
      await tx.run(sql`UPDATE runtime_requests SET state='completed',response_json=${JSON.stringify(validated)},error_code=NULL,updated_at=${clock.now().toISOString()} WHERE logical_key=${key}`);
      return true;
    });
    received.delete(runId);
    if(!owned)throw new RuntimeRequestError("请求已由新的操作接手，旧结果不覆盖新材料","receipt_conflict");
    return {...validated,runId,attempts:1};
  }
  async function execute<T>(key:string,requestHash:string,request:StructuredAiRequest<T>,options:RuntimeCallOptions):Promise<RuntimeResult<T>> {
    const [receipt]=await database.read(tx=>tx.all<Receipt>(sql`SELECT * FROM runtime_requests WHERE logical_key=${key}`));
    if(receipt?.state==="completed"){
      const cached=JSON.parse(receipt.response_json!) as StructuredAiResult<T>;
      return {...cached,data:request.schema.parse(cached.data),runId:receipt.run_id,attempts:0};
    }
    if(receipt?.state==="pending"||receipt?.state==="unknown"){
      const local=received.get(receipt.run_id) as StructuredAiResult<T>|undefined;
      let recovered:StructuredAiResult<T>|"pending"|null|undefined=local;
      let knownFailure=false;
      if(!recovered)try{recovered=await provider.recover?.(request,{runId:receipt.run_id});}
      catch(reason){
        if(reason instanceof AiProviderError&&!["network_error","timeout"].includes(reason.code)){
          await database.write(async tx=>{
            await tx.run(sql`UPDATE ai_runs SET status='failed',error_code=${reason.code},error_summary=${safeErrorSummary(reason)},error_details_json=${JSON.stringify(reason.details??{})} WHERE run_id=${receipt.run_id}`);
            await tx.run(sql`UPDATE runtime_requests SET state='failed',error_code=${reason.code} WHERE logical_key=${key} AND run_id=${receipt.run_id}`);
          });
          receipt.state="failed";knownFailure=true;
          if(!options.retryFailed)throw reason;
        }else if(!options.retryUnknown)throw new RuntimeRequestError("无法确认上次响应；明确确认后才重新请求","result_unknown");
      }
      if(recovered&&recovered!=="pending")return save(key,receipt.run_id,request,recovered);
      if(!knownFailure&&(recovered==="pending"||(receipt.state==="pending"&&receipt.owner_boot_id===clock.bootId&&clock.now().getTime()-Date.parse(receipt.updated_at)<180_000))){
        throw new RuntimeRequestError("这一步仍在处理，请稍后恢复结果","request_pending");
      }
      if(!knownFailure&&!options.retryUnknown){
        await database.write(tx=>tx.run(sql`UPDATE runtime_requests SET state='unknown',error_code='result_unknown' WHERE logical_key=${key} AND run_id=${receipt.run_id} AND state='pending'`));
        throw new RuntimeRequestError("上次请求结果未知；确认重新请求可能再次产生费用，原回答已保留","result_unknown");
      }
    }
    if(receipt?.state==="failed"&&!options.retryFailed)throw new RuntimeRequestError("这一步上次处理失败，请明确点击重试","request_failed");
    const runId=clock.newId(),timestamp=clock.now().toISOString();
    const claimed=await database.write(async tx=>{
      const [current]=await tx.all<Receipt>(sql`SELECT * FROM runtime_requests WHERE logical_key=${key}`);
      if((current?.run_id??null)!==(receipt?.run_id??null)||current?.state==="completed")return false;
      await tx.run(sql`INSERT INTO ai_runs(run_id,job_id,role,provider,model,prompt_version,schema_version,thinking_mode,input_hash,status,created_at)
        VALUES(${runId},${options.jobId??null},${request.role},${provider.providerName},${provider.model},${request.promptVersion},${request.schemaVersion},${request.thinking??AI_ROLE_CONFIG[request.role].thinking},${sha256Text(request.input.normalize("NFKC"))},'pending',${timestamp})`);
      await tx.run(sql`INSERT INTO runtime_requests(logical_key,run_id,owner_boot_id,state,request_hash,updated_at)
        VALUES(${key},${runId},${clock.bootId},'pending',${requestHash},${timestamp})
        ON CONFLICT(logical_key) DO UPDATE SET run_id=excluded.run_id,owner_boot_id=excluded.owner_boot_id,state='pending',request_hash=excluded.request_hash,response_json=NULL,error_code=NULL,updated_at=excluded.updated_at`);
      if(options.jobId)await tx.run(sql`UPDATE ai_jobs SET attempts=attempts+1,updated_at=${timestamp} WHERE id=${options.jobId}`);
      return true;
    });
    if(!claimed)throw new RuntimeRequestError("已有请求更新这一步，请恢复最新结果","request_pending");
    let result:StructuredAiResult<T>;
    try{const generated=await provider.generate(request,{runId});result={...generated,data:request.schema.parse(generated.data)};}
    catch(reason){
      const error=reason instanceof z.ZodError?new AiProviderError("AI输出未通过Schema校验","invalid_output",true):normalizeAiError(reason),unknown=error.code==="network_error"||error.code==="timeout";
      await database.write(async tx=>{
        await tx.run(sql`UPDATE ai_runs SET status=${unknown?"unknown":"failed"},error_code=${error.code},error_summary=${safeErrorSummary(error)},error_details_json=${JSON.stringify(error.details??{})},response_id=${error.response?.responseId??null},response_model=${error.response?.responseModel??null},input_tokens=${error.response?.usage.inputTokens??null},output_tokens=${error.response?.usage.outputTokens??null},reasoning_tokens=${error.response?.usage.reasoningTokens??null},cached_tokens=${error.response?.usage.cachedTokens??null} WHERE run_id=${runId}`);
        await tx.run(sql`UPDATE runtime_requests SET state=${unknown?"unknown":"failed"},error_code=${error.code},updated_at=${clock.now().toISOString()} WHERE logical_key=${key} AND run_id=${runId}`);
      });
      if(unknown)throw new RuntimeRequestError("请求中断，结果未确认；请先恢复结果，重发需确认","result_unknown");
      throw error;
    }
    return save(key,runId,request,result);
  }
  return {call<T>(request:StructuredAiRequest<T>,options:RuntimeCallOptions={}){
    const requestHash=hashParts(provider.providerName,provider.model,request.role,request.promptVersion,request.schemaVersion,request.schemaName,request.maxOutputTokens??0,request.thinking??AI_ROLE_CONFIG[request.role].thinking,JSON.stringify(AI_ROLE_CONFIG[request.role]),request.instructions,request.input,JSON.stringify(z.toJSONSchema(request.schema)));
    const key=hashParts(options.jobId??"",request.idempotencyKey,requestHash);
    const existing=active.get(key);if(existing)return existing as Promise<RuntimeResult<T>>;
    const operation=execute(key,requestHash,request,options);
    active.set(key,operation);
    void operation.finally(()=>{if(active.get(key)===operation)active.delete(key);}).catch(()=>undefined);
    return operation;
  }};
}

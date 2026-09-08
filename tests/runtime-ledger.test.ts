import {afterEach,expect,it,vi} from "vitest";
import {z} from "zod";
import {portableTestDatabase} from "./helpers/portable-db";
import {createRuntimeCalls} from "@/lib/ai/runtime-ledger";
import type {AiProvider,StructuredAiRequest,StructuredAiResult} from "@/lib/ai/contracts";
import type {DatabasePort} from "@/lib/platform/database";
import {AiProviderError} from "@/lib/ai/errors";
const fixtures:Array<ReturnType<typeof portableTestDatabase>>=[];
afterEach(()=>{for(const fixture of fixtures.splice(0))fixture.close();});
function fixture(){const result=portableTestDatabase();fixtures.push(result);return result;}
const request:StructuredAiRequest<{answer:string}>={role:"generator",instructions:"synthetic prompt",input:"synthetic input",schema:z.object({answer:z.string()}),schemaName:"synthetic_v1",promptVersion:"synthetic.v1",schemaVersion:"synthetic-v1",idempotencyKey:"logical"};
const result:StructuredAiResult<{answer:string}>={data:{answer:"Hello"},responseId:"mock-response",latencyMs:1,usage:{inputTokens:1,outputTokens:1,cachedTokens:0,reasoningTokens:0}};
const clock=(bootId="boot")=>{let seq=0;return {bootId,now:()=>new Date("2026-09-07T12:00:00Z"),newId:()=>`${bootId}-${++seq}`};};
function provider(generate:(request:StructuredAiRequest<unknown>)=>Promise<StructuredAiResult<unknown>>,recover?:(request:StructuredAiRequest<unknown>)=>Promise<StructuredAiResult<unknown>>):AiProvider{
  // Vitest spies erase generic call signatures; the fixture supplies schema-aware implementations.
  return {providerName:"mock",model:"deepseek-v4-flash",generate:generate as AiProvider["generate"],recover:recover as AiProvider["recover"]};
}
it("persists pending audit before dispatch, joins double-clicks and reuses successful results without a second call",async()=>{
  const {database,connection}=fixture();
  const generate=vi.fn(async<T>(req:StructuredAiRequest<T>)=>{expect(connection.prepare("SELECT status FROM ai_runs").get()).toMatchObject({status:"pending"});return {...result,data:req.schema.parse(result.data)};});
  const calls=createRuntimeCalls(database,provider(generate),clock());
  const first=calls.call(request),duplicate=calls.call(request);expect(duplicate).toBe(first);
  const saved=await first;expect((await calls.call(request)).runId).toBe(saved.runId);
  expect(generate).toHaveBeenCalledTimes(1);expect(connection.prepare("SELECT state FROM runtime_requests").get()).toMatchObject({state:"completed"});
});
it("network uncertainty cannot auto-resend; explicit confirmation starts one new audited run",async()=>{
  const {database,connection}=fixture();let fail=true;
  const generate=vi.fn(async<T>(req:StructuredAiRequest<T>)=>{if(fail)throw new AiProviderError("timeout","timeout",true);return {...result,data:req.schema.parse(result.data)};});
  const calls=createRuntimeCalls(database,provider(generate),clock());
  await expect(calls.call(request)).rejects.toMatchObject({code:"result_unknown"});
  fail=false;await expect(calls.call(request,{retryFailed:true})).rejects.toMatchObject({code:"result_unknown"});
  expect(generate).toHaveBeenCalledTimes(1);
  await calls.call(request,{retryUnknown:true});expect(generate).toHaveBeenCalledTimes(2);
  expect(connection.prepare("SELECT status FROM ai_runs ORDER BY run_id").all()).toMatchObject([{status:"unknown"},{status:"completed"}]);
});
it("a result received before a failed database save can be saved again without another paid request",async()=>{
  const {database}=fixture();let received=false,storageFailed=false;
  const port:DatabasePort={read:work=>database.read(work),write:work=>{if(received&&!storageFailed){storageFailed=true;throw new Error("disk full");}return database.write(work);}};
  const generate=vi.fn(async<T>(req:StructuredAiRequest<T>)=>{received=true;return {...result,data:req.schema.parse(result.data)};});
  const calls=createRuntimeCalls(port,provider(generate),clock());
  await expect(calls.call(request)).rejects.toThrow("disk full");
  expect((await calls.call(request)).data).toEqual(result.data);expect(generate).toHaveBeenCalledTimes(1);
});
it("after app restart recovers native receipt with original runId and does not share Generator/Reviewer contexts",async()=>{
  const {database,connection}=fixture();
  const interrupted=createRuntimeCalls(database,provider(async()=>{throw new AiProviderError("lost","timeout",true);}),clock("old"));
  await expect(interrupted.call(request)).rejects.toMatchObject({code:"result_unknown"});
  const generate=vi.fn(async<T>(req:StructuredAiRequest<T>)=>({...result,data:req.schema.parse(result.data)}));
  const recover=vi.fn(async<T>(req:StructuredAiRequest<T>)=>({...result,data:req.schema.parse(result.data)}));
  const resumed=createRuntimeCalls(database,provider(generate,recover),clock("new"));
  expect((await resumed.call(request)).runId).toBe("old-1");expect(generate).not.toHaveBeenCalled();
  await resumed.call({...request,role:"reviewer",instructions:"independent review"});expect(generate).toHaveBeenCalledTimes(1);
  expect(connection.prepare("SELECT role,status FROM ai_runs ORDER BY role").all()).toMatchObject([{role:"generator",status:"completed"},{role:"reviewer",status:"completed"}]);
});
it("invalid structured output is failure, not a passed judgement or an endlessly running request",async()=>{
  const {database,connection}=fixture();
  const calls=createRuntimeCalls(database,provider(async()=>({...result,data:{bad:true}} as unknown as StructuredAiResult<never>)),clock());
  await expect(calls.call(request)).rejects.toMatchObject({code:"invalid_output"});
  expect(connection.prepare("SELECT state FROM runtime_requests").get()).toMatchObject({state:"failed"});
});

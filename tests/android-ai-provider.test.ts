import {expect,it,vi} from "vitest";
import {z} from "zod";
import {AndroidAiProvider} from "@/lib/platform/android/ai-provider";
const input={role:"generator" as const,instructions:"synthetic",input:"hello",schema:z.object({answer:z.string()}),schemaName:"test-v1",promptVersion:"test-v1",schemaVersion:"test-v1",idempotencyKey:"stable"};
const response={id:"synthetic-response",model:"deepseek-flash",status:"completed",output:[{type:"message",content:[{type:"output_text",text:'{"answer":"Hello"}'}]}]};
it("native bridge receives a structured request and receipt ID but no key, URL or headers",async()=>{
  const request=vi.fn().mockResolvedValue({state:"completed",httpStatus:200,body:JSON.stringify(response)});
  const provider=new AndroidAiProvider({request,lookup:vi.fn()});
  expect((await provider.generate(input,{runId:"run"})).data).toEqual({answer:"Hello"});
  expect(Object.keys(request.mock.calls[0][0]).sort()).toEqual(["body","runId"]);
  expect(JSON.parse(request.mock.calls[0][0].body)).toMatchObject({model:"deepseek-flash",input:"hello"});
  await expect(provider.generate(input)).rejects.toMatchObject({code:"invalid_request"});
});
it("native receipt recovery never sends a new network request and rejects wrong models",async()=>{
  const request=vi.fn(),lookup=vi.fn().mockResolvedValue({state:"pending"});const provider=new AndroidAiProvider({request,lookup});
  expect(await provider.recover(input,{runId:"same"})).toBe("pending");
  lookup.mockResolvedValue({state:"completed",httpStatus:200,body:JSON.stringify({...response,model:"wrong"})});
  await expect(provider.recover(input,{runId:"same"})).rejects.toMatchObject({code:"wrong_model"});expect(request).not.toHaveBeenCalled();
});

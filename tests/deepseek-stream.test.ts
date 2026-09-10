import {expect,it} from 'vitest';
import {z} from 'zod';
import {DeepSeekProvider} from '@/lib/ai/deepseek-provider';
const request={role:'gap_generator' as const,instructions:'Return JSON',input:'test',schema:z.object({ok:z.boolean()}),schemaName:'test',promptVersion:'v1',schemaVersion:'v1',idempotencyKey:'test'};
function streaming(events:unknown[]){return new Response(new ReadableStream({start(controller){const data=events.map(value=>'data: '+JSON.stringify(value)+'\r\n\r\n').join('');for(let i=0;i<data.length;i+=13)controller.enqueue(new TextEncoder().encode(data.slice(i,i+13)));controller.close();}}),{headers:{'content-type':'text/event-stream'}});}
const envelope=(status='completed',text='```json\n{"ok":true}\n```')=>({id:'response-stream',model:'deepseek-flash',status,output:[{type:'message',content:[{type:'output_text',text}]}],usage:{input_tokens:12,output_tokens:34,output_tokens_details:{reasoning_tokens:20}}});
it('receives split SSE events, ignores thinking deltas, and validates one fenced JSON result',async()=>{
  const provider=new DeepSeekProvider({apiKey:'fake',fetchImpl:async(_url,options)=>{expect(JSON.parse(String(options?.body)).stream).toBe(true);return streaming([{type:'response.reasoning_text.delta',delta:'hidden analysis never returned'}, {type:'response.completed',response:envelope()}]);}});
  const result=await provider.generate(request);expect(result.data).toEqual({ok:true});expect(result.usage.outputTokens).toBe(34);expect(JSON.stringify(result)).not.toContain('hidden analysis');
});
it('an ended stream without a terminal event is unknown, never a successful answer',async()=>{
  const provider=new DeepSeekProvider({apiKey:'fake',fetchImpl:async()=>streaming([{type:'response.output_text.delta',delta:'{"ok":true}'}])});
  await expect(provider.generate(request)).rejects.toMatchObject({code:'network_error'});
});
it('incomplete and malformed final output keep safe response usage for the audit record',async()=>{
  const provider=new DeepSeekProvider({apiKey:'fake',fetchImpl:async()=>streaming([{type:'response.incomplete',response:{...envelope('incomplete',''),incomplete_details:{reason:'max_output_tokens'}}}])});
  await expect(provider.generate(request)).rejects.toMatchObject({code:'incomplete_output',response:{responseId:'response-stream',usage:{outputTokens:34,reasoningTokens:20}}});
  const bad=new DeepSeekProvider({apiKey:'fake',fetchImpl:async()=>Response.json(envelope('completed','not JSON private text'))});
  try{await bad.generate(request);throw new Error('expected failure');}catch(error){expect(error).toMatchObject({code:'invalid_output',response:{responseId:'response-stream'}});expect(JSON.stringify(error)).not.toContain('private text');}
});
it('truncated or corrupt SSE before any terminal event is an unknown result, not a known bad answer',async()=>{
  for(const text of ['data: {"type":"response.output_text.delta","delta":"cut off','data: not-json\n\n']){
    const provider=new DeepSeekProvider({apiKey:'fake',fetchImpl:async()=>new Response(text,{headers:{'content-type':'text/event-stream'}})});
    await expect(provider.generate(request)).rejects.toMatchObject({code:'network_error',details:{requestFormatVersion:'deepseek-responses-v3'}});
  }
});
it('the first complete terminal event wins; corrupt trailing bytes cannot discard a completed paid response',async()=>{
  const text='data: '+JSON.stringify({type:'response.completed',response:envelope()})+'\n\ndata: not-json\n\n';
  const provider=new DeepSeekProvider({apiKey:'fake',fetchImpl:async()=>new Response(text,{headers:{'content-type':'text/event-stream'}})});
  expect((await provider.generate(request)).data).toEqual({ok:true});
});

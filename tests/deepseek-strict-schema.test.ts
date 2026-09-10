import {expect,it} from 'vitest';
import {z} from 'zod';
import {strictResponseSchema,restoreOptionalValues} from '@/lib/ai/strict-response-schema';
import {diagnosisSchema,recallMaterialDraftSchema,recallEvidenceReviewSchema,selectionReviewSchema} from '@/lib/four-step/selection-contracts';
import {DeepSeekProvider} from '@/lib/ai/deepseek-provider';
import {errorFromResponse} from '@/lib/ai/errors';

it('all nested properties of real material schemas are required on the wire',()=>{
  const check=(node:unknown)=>{if(!node||typeof node!=='object')return;const s=node as Record<string,unknown>;
    if(s.properties){expect(s.required).toEqual(Object.keys(s.properties));expect(s.additionalProperties).toBe(false);}
    for(const value of Object.values(s))if(Array.isArray(value))value.forEach(check);else check(value);
  };
  for(const schema of [diagnosisSchema,selectionReviewSchema,recallMaterialDraftSchema,recallEvidenceReviewSchema])check(strictResponseSchema(z.toJSONSchema(schema)));
});
it('optional wire nulls become missing, while required or explicitly nullable values remain null',()=>{
  const schema=z.object({pattern:z.string().optional(),items:z.array(z.object({detail:z.string().optional(),confirmed:z.boolean()})),value:z.string().nullable(),optionalNullable:z.string().nullable().optional()});
  const original=z.toJSONSchema(schema),value={pattern:null,items:[{detail:null,confirmed:true}],value:null,optionalNullable:null};
  expect(schema.parse(restoreOptionalValues(original,value))).toEqual({items:[{confirmed:true}],value:null,optionalNullable:null});
});
it('real transport shape accepts canonical Flash response and still rejects another model',async()=>{
  const request={role:'gap_generator' as const,instructions:'Return JSON',input:'test',schema:z.object({ok:z.boolean(),note:z.string().optional()}),schemaName:'test',promptVersion:'v1',schemaVersion:'v1',idempotencyKey:'test'};
  const fetchImpl:typeof fetch=async(_url,options)=>{const body=JSON.parse(String(options?.body));expect(body.model).toBe('deepseek-flash');expect(body.text.format.schema.required).toEqual(['ok','note']);return Response.json({id:'response',model:'deepseek-flash',status:'completed',output:[{type:'message',content:[{type:'output_text',text:'{"ok":true,"note":null}'}]}]});};
  expect((await new DeepSeekProvider({apiKey:'fake',fetchImpl}).generate(request)).data).toEqual({ok:true});
  const wrong=new DeepSeekProvider({apiKey:'fake',fetchImpl:async()=>Response.json({id:'response',model:'deepseek-v4-pro',status:'completed',output:[]})});
  await expect(wrong.generate(request)).rejects.toMatchObject({code:'wrong_model'});
});
it('diagnostics retain safe identifiers, not the key or echoed private request',async()=>{
  const error=await errorFromResponse(Response.json({error:{code:'invalid_request_error',type:'invalid_request_error',param:'text.format.schema',message:'private original text sk-secretcredentialvalue'}},{status:400,headers:{'x-request-id':'request-1'}}));
  expect(error.retryable).toBe(false);expect(error.details).toMatchObject({httpStatus:400,parameter:'text.format.schema',requestId:'request-1'});expect(JSON.stringify(error)).not.toContain('private original');expect(JSON.stringify(error)).not.toContain('sk-secret');
});

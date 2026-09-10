import {expect,it,vi} from 'vitest';
import {z} from 'zod';
import {materialDraftSchema} from '@/lib/four-step/selection-contracts';
import {createRuntimeCalls} from '@/lib/ai/runtime-ledger';
import {MockAiProvider} from '@/lib/ai/mock-provider';
import {portableTestDatabase} from './helpers/portable-db';
import {AiProviderError} from '@/lib/ai/errors';

// Frozen definition from 8627898; optional new display fields must not alter old request identity.
const text=z.string().trim().min(1).max(8000),id=z.string().trim().min(1).max(100);
const legacy=z.object({sentences:z.array(z.object({id,intentUnitIds:z.array(id).min(1),english:text})),rows:z.array(z.object({gapId:id,sentenceId:id,surfaceInSentence:text})),examFeedback:z.object({transcriptBasedNotice:text,lexicalResource:text,grammaticalRange:text,coherence:text,paraphrasing:text,strengths:z.array(text),weaknesses:z.array(text),approximateBand:z.string().nullable()}).nullable().default(null)});
const draft={sentences:[{id:'s',intentUnitIds:['u'],english:'I enjoy cooking.'}],rows:[],examFeedback:null};
const request={role:'learning_material_compiler' as const,instructions:'Frozen v3 material prompt',input:'{"source":"same"}',schemaName:'four_step_material_v3',schemaVersion:'four-step-material-v3',promptVersion:'four_step_material.generator.v3.md',idempotencyKey:'same-stage',maxOutputTokens:12000};
it('legacy JSON Schema is unchanged and a completed receipt without a stage is reused after restart',async()=>{
  expect(z.toJSONSchema(materialDraftSchema)).toEqual(z.toJSONSchema(legacy));
  const f=portableTestDatabase();let n=0;const resolver=vi.fn(()=>draft),provider=new MockAiProvider(resolver);
  const clock={now:()=>new Date('2026-09-08T00:00:00Z'),newId:()=>`receipt-${++n}`,bootId:'old'};
  try{
    const first=await createRuntimeCalls(f.database,provider,clock).call({...request,schema:legacy});
    expect(f.connection.prepare('SELECT * FROM practice_material_stages').all()).toHaveLength(0);
    const recovered=await createRuntimeCalls(f.database,provider,{...clock,bootId:'new'}).call({...request,schema:materialDraftSchema});
    expect(recovered.runId).toBe(first.runId);expect(resolver).toHaveBeenCalledOnce();
  }finally{f.close();}
});
it('legacy unknown receipt cannot be bypassed by a new material schema after restart',async()=>{
  const f=portableTestDatabase();let n=0;const resolver=vi.fn(()=>{throw new AiProviderError('timeout','timeout',true);}),provider=new MockAiProvider(resolver);
  const clock={now:()=>new Date('2026-09-08T00:00:00Z'),newId:()=>`unknown-${++n}`,bootId:'old'};
  try{
    await expect(createRuntimeCalls(f.database,provider,clock).call({...request,schema:legacy})).rejects.toMatchObject({code:'result_unknown'});
    await expect(createRuntimeCalls(f.database,provider,{...clock,bootId:'new'}).call({...request,schema:materialDraftSchema})).rejects.toMatchObject({code:'result_unknown'});
    expect(resolver).toHaveBeenCalledOnce();expect(f.connection.prepare('SELECT * FROM runtime_requests').all()).toHaveLength(1);
  }finally{f.close();}
});

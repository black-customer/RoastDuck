import fs from 'node:fs/promises';
import path from 'node:path';
import {afterEach,expect,it,vi} from 'vitest';
import {portableTestDatabase} from './helpers/portable-db';
import {createSpeechRequests} from '@/lib/speech/request-service';
import {randomUUID} from 'node:crypto';
import {SpeechProviderError} from '@/lib/speech/contracts';
const opened:Array<ReturnType<typeof portableTestDatabase>>=[];
afterEach(()=>opened.splice(0).forEach(f=>f.close()));
const input=(text:string)=>({text,voice:'Chloe' as const,purpose:'example' as const,accent:'en-US' as const,rate:.95});
function wave(){const bytes=Buffer.alloc(64);bytes.write('RIFF');bytes.writeUInt32LE(56,4);bytes.write('WAVE',8);return bytes;}
async function setup(generate:Parameters<typeof createSpeechRequests>[0]['generate']){
  const f=portableTestDatabase();opened.push(f);await fs.mkdir('test-results',{recursive:true});const root=await fs.mkdtemp(path.resolve('test-results/speech-cache-'));let n=0;
  return {...f,root,service:createSpeechRequests({database:f.database,root,now:()=>new Date(),newId:()=>`job-${++n}`,bootId:'test-boot',generate})};
}
it('same actual speech shares one request across purposes and equivalent rates, with atomic verified cache reuse',async()=>{
  const generate=vi.fn(async()=>({bytes:wave(),responseId:'mock-audio'})),f=await setup(generate);
  const [a,b]=await Promise.all([f.service.synthesize(input('Hello.')),f.service.synthesize({...input('Hello.'),purpose:'chunk',rate:1})]);
  expect(a.assetId).toBe(b.assetId);expect(generate).toHaveBeenCalledTimes(1);
  expect((await f.service.synthesize(input('Hello.'))).cached).toBe(true);expect(generate).toHaveBeenCalledTimes(1);
  expect((await fs.readdir(f.root)).sort()).toHaveLength(2);expect((await fs.readdir(f.root)).some(name=>name.endsWith('.tmp'))).toBe(false);
  expect(f.connection.prepare('SELECT status FROM speech_requests').all()).toEqual([{status:'completed'}]);
});
it('foreground overtakes queued prefetch and an abandoned queued request is not synthesized',async()=>{
  let release!:()=>void;const blocked=new Promise<void>(r=>release=r),calls:string[]=[];
  const f=await setup(async value=>{calls.push(value.text);if(value.text==='first')await blocked;return {bytes:wave(),responseId:'mock'};});
  const a=f.service.synthesize(input('first'));await vi.waitFor(()=>expect(calls).toEqual(['first']));
  const cancelled=new AbortController();const b=f.service.synthesize(input('obsolete'),{priority:0,signal:cancelled.signal});void b.catch(()=>undefined);
  const next=f.service.synthesize(input('prefetch'),{priority:0});const current=f.service.synthesize(input('foreground'),{priority:1});
  await vi.waitFor(()=>expect(f.connection.prepare('SELECT * FROM speech_requests').all()).toHaveLength(4));cancelled.abort();release();
  await Promise.all([a,next,current]);await expect(b).rejects.toMatchObject({code:'cancelled'});
  expect(calls).toEqual(['first','foreground','prefetch']);
});
it('unknown outcomes require explicit retry instead of repeatedly consuming the same synthesis',async()=>{
  let fail=true;const generate=vi.fn(async()=>{if(fail)throw new SpeechProviderError('timeout','timeout',true);return {bytes:wave(),responseId:'mock'};}),f=await setup(generate);
  await expect(f.service.synthesize(input('Unknown.'))).rejects.toMatchObject({code:'result_unknown'});
  await expect(f.service.synthesize(input('Unknown.'))).rejects.toMatchObject({code:'result_unknown'});expect(generate).toHaveBeenCalledTimes(1);
  fail=false;await f.service.synthesize(input('Unknown.'),{retryUnknown:true});expect(generate).toHaveBeenCalledTimes(2);
});
it('damaged cached bytes cannot count as a hit or silently trigger another paid generation',async()=>{
  const generate=vi.fn(async()=>({bytes:wave(),responseId:'mock'})),f=await setup(generate);await f.service.synthesize(input('Cached.'));
  const file=(await fs.readdir(f.root)).find(name=>name.endsWith('.wav'))!;await fs.writeFile(path.join(f.root,file),Buffer.alloc(64));
  await expect(f.service.synthesize(input('Cached.'))).rejects.toMatchObject({code:'invalid_audio'});expect(generate).toHaveBeenCalledTimes(1);
  await f.service.synthesize(input('Cached.'),{retryUnknown:true});expect(generate).toHaveBeenCalledTimes(2);
});
it('two Web instances sharing a database never generate the same paid audio twice or overlap the synthesis lane',async()=>{
  let active=0,maxActive=0;const generate=vi.fn(async()=>{active++;maxActive=Math.max(active,maxActive);await new Promise(resolve=>setTimeout(resolve,30));active--;return {bytes:wave(),responseId:'mock'};});
  const f=await setup(generate),second=createSpeechRequests({database:f.database,root:f.root,now:()=>new Date(),newId:randomUUID,bootId:'another-web',generate});
  const [a,b]=await Promise.all([f.service.synthesize(input('Shared')),second.synthesize(input('Shared'))]);
  expect(a.assetId).toBe(b.assetId);expect(generate).toHaveBeenCalledTimes(1);
  await Promise.all([f.service.synthesize(input('Other one')),second.synthesize(input('Other two'))]);
  expect(maxActive).toBe(1);expect(generate).toHaveBeenCalledTimes(3);
});

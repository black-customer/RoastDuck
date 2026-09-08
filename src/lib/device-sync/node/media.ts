import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {DatabasePort} from '@/lib/platform/database';
import {query as sql} from '@/lib/platform/sql';
const hashSchema=z.string().regex(/^[a-f0-9]{64}$/);
const mediaSchema=z.object({contentHash:hashSchema,fileHash:hashSchema,bytes:z.number().int().min(44).max(20*1024*1024)}).strict();
export type SyncMedia=z.infer<typeof mediaSchema>;
const digest=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const wav=(bytes:Buffer)=>bytes.length>=44&&bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WAVE';
export function createNodeMedia(database:DatabasePort,root:string){
  const tasks=new Map<string,Promise<unknown>>();
  async function known(key:string){hashSchema.parse(key);const rows=await database.read(tx=>tx.all(sql`SELECT id FROM audio_assets WHERE content_hash=${key} AND provider='mimo' AND format='wav' AND status='ready'`));if(!rows.length)throw new Error('音频尚未关联业务资料');}
  async function file(key:string){
    hashSchema.parse(key);const target=path.join(root,key+'.wav');
    const resolved=await fs.realpath(target).catch(error=>{if(error.code==='ENOENT')return target;throw error;}),parent=await fs.realpath(root).catch(error=>{if(error.code==='ENOENT')return path.resolve(root);throw error;});
    if(path.dirname(resolved)!==parent)throw new Error('音频缓存路径越界');return target;
  }
  async function manifest(){
    const keys=await database.read(tx=>tx.all<{content_hash:string}>(sql`SELECT DISTINCT content_hash FROM audio_assets WHERE provider='mimo' AND format='wav' AND status='ready' LIMIT 10000`));
    const assets:SyncMedia[]=[];
    for(const {content_hash:key} of keys){
      const target=await file(key),stat=await fs.stat(target).catch(()=>null);if(!stat?.isFile()||stat.size<44||stat.size>20*1024*1024)continue;
      const bytes=await fs.readFile(target);if(!wav(bytes))continue;assets.push({contentHash:key,fileHash:digest(bytes),bytes:bytes.length});
    }return {assets};
  }
  async function chunk(key:string,offset:number){
    await known(key);if(!Number.isSafeInteger(offset)||offset<0||offset>20*1024*1024)throw new Error('音频偏移无效');
    const target=await file(key),handle=await fs.open(target,'r');
    try{const stat=await handle.stat();if(stat.size>20*1024*1024||offset>stat.size)throw new Error('音频范围无效');const buffer=Buffer.alloc(Math.min(128*1024,stat.size-offset)),result=await handle.read(buffer,0,buffer.length,offset);return {offset,nextOffset:offset+result.bytesRead,data:buffer.subarray(0,result.bytesRead).toString('base64'),done:offset+result.bytesRead===stat.size};}finally{await handle.close();}
  }
  async function upload(raw:unknown){
    const input=z.object({asset:mediaSchema,offset:z.number().int().nonnegative(),data:z.string().max(180000)}).strict().parse(raw),key=input.asset.contentHash;
    const prior=tasks.get(key)??Promise.resolve();
    const task=prior.catch(()=>undefined).then(async()=>{
      await known(key);await fs.mkdir(root,{recursive:true});const directory=path.join(root,'.sync-parts');await fs.mkdir(directory,{recursive:true});
      const target=await file(key),partial=path.join(directory,key+'-'+input.asset.fileHash+'.part');
      const present=await fs.stat(target).catch(()=>null);if(present?.size===input.asset.bytes&&digest(await fs.readFile(target))===input.asset.fileHash)return {nextOffset:input.asset.bytes,done:true};
      const bytes=Buffer.from(input.data,'base64');if(bytes.length>128*1024||!bytes.length||input.offset+bytes.length>input.asset.bytes)throw new Error('音频分块无效');
      const handle=await fs.open(partial,'a+');
      try{
        const size=(await handle.stat()).size;
        if(input.offset<size){const existing=Buffer.alloc(bytes.length);await handle.read(existing,0,existing.length,input.offset);if(!existing.equals(bytes))throw new Error('重复分块不一致');}
        else if(input.offset===size){await handle.write(bytes);await handle.sync();}
        else return {nextOffset:size,done:false};
        const next=(await handle.stat()).size;if(next<input.asset.bytes)return {nextOffset:next,done:false};
      }finally{await handle.close();}
      const whole=await fs.readFile(partial);if(whole.length!==input.asset.bytes||digest(whole)!==input.asset.fileHash||!wav(whole))throw new Error('音频校验失败，未发布缓存');
      await fs.rename(partial,target);return {nextOffset:input.asset.bytes,done:true};
    });tasks.set(key,task);void task.finally(()=>{if(tasks.get(key)===task)tasks.delete(key);}).catch(()=>undefined);return task;
  }
  return {manifest,chunk,upload};
}
export type NodeMedia=ReturnType<typeof createNodeMedia>;

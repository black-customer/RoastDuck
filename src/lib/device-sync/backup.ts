import {z} from 'zod';
import type {DeviceSync} from './service';
import {syncChangeSchema,contentHash,changeHash} from './contracts';
const encoder=new TextEncoder(),decoder=new TextDecoder('utf-8',{fatal:true});
const ITERATIONS=310000,MAX_BYTES=64*1024*1024;
const archiveSchema=z.object({format:z.literal('roastduck-business-backup-v1'),schemaVersion:z.literal(28),createdAt:z.string().datetime(),datasetId:z.string(),
  pages:z.array(z.object({from:z.number().int().nonnegative(),cursor:z.number().int().nonnegative(),changes:syncChangeSchema.array().max(200)}).strict()).max(5000)}).strict();
export function toBase64(bytes:Uint8Array){let text='';for(let i=0;i<bytes.length;i+=16384)text+=String.fromCharCode(...bytes.subarray(i,i+16384));return btoa(text);}
export function fromBase64(text:string){if(text.length>MAX_BYTES*1.5)throw new Error('备份文件过大');const binary=atob(text);return Uint8Array.from(binary,char=>char.charCodeAt(0));}
const buffer=(bytes:Uint8Array)=>new Uint8Array(bytes).buffer;
async function key(password:string,salt:Uint8Array,usage:KeyUsage){
  if(password.length<10||password.length>1024)throw new Error('备份密码至少 10 个字符，请妥善保管，无法找回');
  const material=await crypto.subtle.importKey('raw',encoder.encode(password),'PBKDF2',false,['deriveKey']);
  return crypto.subtle.deriveKey({name:'PBKDF2',hash:'SHA-256',iterations:ITERATIONS,salt:buffer(salt)},material,{name:'AES-GCM',length:256},false,[usage]);
}
async function transform(bytes:Uint8Array,direction:'compress'|'decompress'){
  const stream=new Blob([buffer(bytes)]).stream().pipeThrough(direction==='compress'?new CompressionStream('gzip'):new DecompressionStream('gzip'));
  const reader=stream.getReader(),parts:Uint8Array[]=[];let length=0;
  for(;;){const result=await reader.read();if(result.done)break;length+=result.value.length;if(length>MAX_BYTES){await reader.cancel();throw new Error('备份内容超过安全大小上限');}parts.push(result.value);}
  const output=new Uint8Array(length);let offset=0;for(const part of parts){output.set(part,offset);offset+=part.length;}return output;
}
export async function encryptBackup(plain:Uint8Array,password:string){
  if(plain.length>MAX_BYTES)throw new Error('备份资料过大');
  const salt=crypto.getRandomValues(new Uint8Array(16)),iv=crypto.getRandomValues(new Uint8Array(12));
  const header=encoder.encode(JSON.stringify({format:'RD-AESGCM-1',salt:toBase64(salt),iv:toBase64(iv),iterations:ITERATIONS,compression:'gzip'}));
  const encrypted=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:header},await key(password,salt,'encrypt'),buffer(await transform(plain,'compress'))));
  const output=new Uint8Array(4+header.length+encrypted.length);new DataView(output.buffer).setUint32(0,header.length);output.set(header,4);output.set(encrypted,4+header.length);return output;
}
export async function decryptBackup(bytes:Uint8Array,password:string){
  if(bytes.length<32||bytes.length>MAX_BYTES)throw new Error('备份文件无效');
  const length=new DataView(buffer(bytes)).getUint32(0);if(length>4096||length+20>bytes.length)throw new Error('备份头无效');
  const header=bytes.slice(4,4+length),value=z.object({format:z.literal('RD-AESGCM-1'),salt:z.string(),iv:z.string(),iterations:z.literal(ITERATIONS),compression:z.literal('gzip')}).strict().parse(JSON.parse(decoder.decode(header)));
  const salt=fromBase64(value.salt),iv=fromBase64(value.iv);if(salt.length!==16||iv.length!==12)throw new Error('备份参数无效');
  let plain:ArrayBuffer;
  try{plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:buffer(iv),additionalData:buffer(header)},await key(password,salt,'decrypt'),buffer(bytes.slice(4+length)));}catch{throw new Error('密码不正确，或备份文件已损坏；现有资料未修改');}
  return transform(new Uint8Array(plain),'decompress');
}
export async function createEncryptedBackup(sync:DeviceSync,password:string){
  const capture=await sync.capture();if(capture.excluded.length)throw new Error('部分资料疑似包含凭证，已停止导出；不会把密钥写入备份');
  const manifest=await sync.manifest(),pages:z.infer<typeof archiveSchema>['pages']=[];let after=0;
  for(;;){const page=await sync.changes(after);pages.push({from:page.from,cursor:page.cursor,changes:page.changes});after=page.cursor;if(!page.hasMore)break;}
  const archive=archiveSchema.parse({format:'roastduck-business-backup-v1',schemaVersion:28,createdAt:new Date().toISOString(),datasetId:manifest.datasetId,pages});
  return encryptBackup(encoder.encode(JSON.stringify(archive)),password);
}
export async function restoreEncryptedBackup(sync:DeviceSync,bytes:Uint8Array,password:string,onProgress:(message:string)=>void=()=>undefined){
  // Authenticate and validate the COMPLETE archive before the first database write.
  const plain=await decryptBackup(bytes,password),archive=archiveSchema.parse(JSON.parse(decoder.decode(plain)));
  let expected=0;const known=new Map<string,string>();
  for(const page of archive.pages){
    if(page.from!==expected||page.cursor<page.from)throw new Error('备份记录不连续，现有资料未修改');expected=page.cursor;
    for(const {id,...body} of page.changes){const record=body.entity+'|'+body.key;if(changeHash(body)!==id||body.parents.some(parent=>known.get(parent)!==record))throw new Error('备份记录校验失败，现有资料未修改');known.set(id,record);}
  }
  const peerId='backup_'+contentHash(archive),already=await sync.cursor(peerId);let restored=0;
  for(const page of archive.pages){if(page.cursor<=already)continue;const result=await sync.receive(peerId,page.from,page.cursor,page.changes);restored+=result.added;onProgress(`已合并 ${restored} 条历史记录…`);}
  return {restored,datasetId:archive.datasetId,createdAt:archive.createdAt};
}

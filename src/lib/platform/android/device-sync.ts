import {registerPlugin} from '@capacitor/core';
import {z} from 'zod';
import type {DeviceSync} from '@/lib/device-sync/service';
import {syncChangeSchema} from '@/lib/device-sync/contracts';
export interface PairingStatus {peer?:{deviceId:string;datasetId:string;url:string};pending?:{verification:string;expiresAt:number;started:boolean}}
export const nativeSync=registerPlugin<{
  status():Promise<PairingStatus>;scan():Promise<{pairingInfo?:string;cancelled?:boolean}>;
  begin(input:{pairingInfo:string;localDeviceId:string}):Promise<PairingStatus>;finish():Promise<PairingStatus>;forget():Promise<PairingStatus>;
  request(input:{route:string;method:'GET'|'POST';body?:string}):Promise<unknown>;
  mediaInventory():Promise<unknown>;downloadMedia(input:{asset:{contentHash:string;fileHash:string;bytes:number}}):Promise<unknown>;uploadMedia(input:{contentHash:string}):Promise<unknown>;removeAudio(input:{contentHash:string}):Promise<{removed:boolean}>;
}>('RoastDuckDeviceSync');
const manifestSchema=z.object({protocol:z.literal(1),schemaVersion:z.literal(28),deviceId:z.string(),datasetId:z.string(),sequence:z.number().int().nonnegative(),counts:z.record(z.string(),z.number().int().nonnegative())});
export async function previewComputer(){return manifestSchema.parse(await nativeSync.request({route:'/manifest',method:'GET'}));}
const pageSchema=z.object({from:z.number().int().nonnegative(),changes:syncChangeSchema.array().max(200),cursor:z.number().int().nonnegative(),hasMore:z.boolean()});
let running:Promise<{received:number;sent:number;conflicts:number}>|null=null;
/** Every page has its own durable cursor. Repeating after disconnection never regrades an event. */
export function syncWithComputer(sync:DeviceSync,onProgress:(message:string)=>void){
  if(running)return running;
  const task=(async()=>{
    const peer=await previewComputer(),status=await nativeSync.status();if(peer.deviceId!==status.peer?.deviceId)throw new Error('配对设备标识不一致');
    onProgress('保留手机的新增记录…');const captured=await sync.capture();if(captured.excluded.length)throw new Error('部分本机记录疑似包含凭证，已阻止传输；请先去除敏感内容');
    onProgress('准备电脑的资料…');await nativeSync.request({route:'/prepare',method:'POST'});
    let received=0,sent=0,conflicts=0,cursor=await sync.cursor(peer.deviceId);
    for(;;){
      const page=pageSchema.parse(await nativeSync.request({route:`/changes?after=${cursor}`,method:'GET'}));
      if(page.cursor<cursor||page.hasMore&&!page.changes.length)throw new Error('同步游标没有前进');
      const result=await sync.receive(peer.deviceId,page.from,page.cursor,page.changes);received+=result.added;conflicts+=result.conflicts;cursor=page.cursor;
      onProgress(`已接收 ${received} 条变更记录…`);if(!page.hasMore)break;
    }
    let remote=z.object({cursor:z.number().int().nonnegative()}).parse(await nativeSync.request({route:'/receipt',method:'GET'})).cursor;
    for(;;){const page=await sync.changes(remote);await nativeSync.request({route:'/changes',method:'POST',body:JSON.stringify({from:page.from,cursor:page.cursor,changes:page.changes})});sent+=page.changes.length;remote=page.cursor;onProgress(`已发送 ${sent} 条变更记录…`);if(!page.hasMore)break;}
    const mediaSchema=z.object({assets:z.array(z.object({contentHash:z.string().regex(/^[a-f0-9]{64}$/),fileHash:z.string().regex(/^[a-f0-9]{64}$/),bytes:z.number().int().min(44).max(20*1024*1024)})).max(10000)});
    onProgress('检查已缓存声音，不生成新的音频…');
    const remoteMedia=mediaSchema.parse(await nativeSync.request({route:'/media/manifest',method:'GET'})).assets,localMedia=mediaSchema.parse(await nativeSync.mediaInventory()).assets,allowed=new Set(await sync.mediaKeys());
    for(const asset of remoteMedia.filter(asset=>allowed.has(asset.contentHash)&&!localMedia.some(local=>local.contentHash===asset.contentHash))){onProgress('正在接收已有声音缓存…');await nativeSync.downloadMedia({asset});}
    for(const asset of localMedia.filter(asset=>allowed.has(asset.contentHash)&&!remoteMedia.some(remote=>remote.contentHash===asset.contentHash))){onProgress('正在同步手机里的声音缓存…');await nativeSync.uploadMedia({contentHash:asset.contentHash});}
    return {received,sent,conflicts};
  })();running=task;void task.finally(()=>{if(running===task)running=null;}).catch(()=>undefined);return task;
}

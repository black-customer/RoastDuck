import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {nodeDatabase} from '@/lib/platform/node/database';
import {query as sql} from '@/lib/platform/sql';
import {createDeviceSync} from '../service';
import {privateIPv4} from './identity';
import {startSyncServer,type LocalSyncServer} from './server';
import {createNodeMedia} from './media';
type State={server:LocalSyncServer|null;pending:Promise<void>|null};
const root=globalThis as typeof globalThis&{roastduckSync?:State};
const state=root.roastduckSync??={server:null,pending:null};
export function privateInterfaces(){return Object.entries(os.networkInterfaces()).flatMap(([name,values])=>(values??[]).filter(item=>item.family==='IPv4'&&!item.internal&&privateIPv4(item.address)).map(item=>({name,address:item.address})));}
export async function syncManager(action?:{type:'start'|'stop'|'approve'|'revoke'|'renew';host?:string;id?:string}){
  if(action?.type==='start'&&!state.server){
    if(!privateInterfaces().some(item=>item.address===action.host))throw new Error('请选择本机的 Wi-Fi/私人网络地址');
    if(!state.pending)state.pending=(async()=>{
      const identity=await nodeDatabase.write(async tx=>{
        await tx.run(sql`INSERT INTO app_device(singleton,device_id,dataset_id,created_at) VALUES(1,${'device_'+randomUUID()},${'dataset_'+randomUUID()},${new Date().toISOString()}) ON CONFLICT DO NOTHING`);
        return (await tx.all<{device_id:string;dataset_id:string}>(sql`SELECT * FROM app_device WHERE singleton=1`))[0];
      });
      const sync=createDeviceSync(nodeDatabase,identity,{now:()=>new Date()});
      await sync.capture();
      const directory=process.env.ROASTDUCK_E2E==='1'?path.resolve('test-results/device-sync'):path.resolve('data/device-sync');
      const media=createNodeMedia(nodeDatabase,path.resolve(process.env.ROASTDUCK_E2E==='1'?'test-results/audio-cache':'data/audio/cache'));
      state.server=await startSyncServer({host:action.host!,port:3443,directory,sync,media});
    })().finally(()=>{state.pending=null;});
    await state.pending;
  }else if(action?.type==='stop'){await state.pending;await state.server?.close();state.server=null;}
  else if(action?.type==='approve')await state.server?.approve(action.id??'');
  else if(action?.type==='revoke')await state.server?.revoke(action.id??'');
  else if(action?.type==='renew')state.server?.renew();
  return {interfaces:privateInterfaces(),connection:state.server?.state()??null};
}

import {afterEach,expect,it} from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import https from 'node:https';
import {createHash} from 'node:crypto';
import {portableTestDatabase} from './helpers/portable-db';
import {createDeviceSync} from '@/lib/device-sync/service';
import {startSyncServer,type LocalSyncServer} from '@/lib/device-sync/node/server';
const cleanup:Array<()=>unknown|Promise<unknown>>=[];
afterEach(async()=>{for(const clean of cleanup.splice(0).reverse())await clean();});
it('TLS, two-end pairing, authorization, revocation and blocked browser origins are enforced',async()=>{
  const fixture=portableTestDatabase();cleanup.push(()=>fixture.close());
  await fs.mkdir('test-results',{recursive:true});const directory=await fs.mkdtemp(path.resolve('test-results/sync-tls-'));
  const sync=createDeviceSync(fixture.database,{device_id:'desktop-test-device',dataset_id:'dataset-test'},{now:()=>new Date()});
  const server:LocalSyncServer=await startSyncServer({directory,host:'127.0.0.1',testLoopback:true,sync});cleanup.push(()=>server.close());
  const state=server.state(),ca=await fs.readFile(path.join(directory,'server.crt'));
  const info=JSON.parse(Buffer.from(state.pairingInfo.slice(15),'base64url').toString());
  function request(route:string,body?:unknown,headers:Record<string,string>={},trusted=true){return new Promise<{status:number;data:Record<string,unknown>}>((resolve,reject)=>{
    const connection=https.request(state.url+route,{method:body?'POST':'GET',ca:trusted?ca:undefined,headers:{...headers,...(body?{'Content-Type':'application/json'}:{})},timeout:5000},response=>{
      const chunks:Buffer[]=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>resolve({status:response.statusCode!,data:JSON.parse(Buffer.concat(chunks).toString())}));
    });connection.on('error',reject);connection.on('timeout',()=>connection.destroy(new Error('timeout')));connection.end(body?JSON.stringify(body):undefined);
  });}
  await expect(request('/manifest',undefined,{},false)).rejects.toThrow();
  expect((await request('/manifest')).status).toBe(401);
  const input={code:info.code,deviceId:'phone-test-device',name:'Synthetic Android',proof:createHash('sha256').update('synthetic pairing proof').digest('hex')};
  const begin=await request('/pair/request',input);expect(begin.status).toBe(200);
  expect((await request('/pair/request',{...input,deviceId:'forged-device'})).status).toBe(409);
  expect((await request('/pair/result',{id:begin.data.id,proof:input.proof})).data).toEqual({approved:false});
  await Promise.all([server.approve(String(begin.data.id)),server.approve(String(begin.data.id))]);
  const paired=await request('/pair/result',{id:begin.data.id,proof:input.proof});expect(paired.data.approved).toBe(true);
  const headers={'X-Device-Id':input.deviceId,Authorization:'Bearer '+paired.data.token};
  expect((await request('/manifest',undefined,headers)).data).toMatchObject({deviceId:'desktop-test-device',schemaVersion:28});
  expect((await request('/manifest',undefined,{...headers,Origin:'https://evil.invalid'})).status).toBe(403);
  expect((await request('/api/settings',undefined,headers)).status).toBe(404);
  expect((await request('/pair/request',input)).status).toBe(403);
  await server.revoke(input.deviceId);expect((await request('/manifest',undefined,headers)).status).toBe(401);
  expect(await fs.readFile(path.join(directory,'peers.json'),'utf8')).not.toContain(String(paired.data.token));
},30000);

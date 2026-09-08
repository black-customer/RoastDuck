import https from 'node:https';
import type {IncomingMessage,ServerResponse} from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomBytes,createHash,timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import type {DeviceSync} from '../service';
import {syncCertificate,privateIPv4} from './identity';
import type {NodeMedia} from './media';
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const secret=()=>randomBytes(32).toString('hex');
const equal=(a:string,b:string)=>a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
type Peer={deviceId:string;name:string;tokenHash:string;pairedAt:string;revoked:boolean};
type Pairing={id:string;deviceId:string;name:string;proofHash:string;verification:string;expiresAt:number;token?:string;approved:boolean};
export interface SyncServerOptions {directory:string;host:string;port?:number;sync:DeviceSync;media?:NodeMedia;testLoopback?:boolean}
export async function startSyncServer(options:SyncServerOptions){
  if(!privateIPv4(options.host,options.testLoopback))throw new Error('同步只允许选定的私人网络地址');
  const certificate=await syncCertificate(options.directory,options.host),peerPath=path.join(options.directory,'peers.json');
  let peers:Peer[]=await fs.readFile(peerPath,'utf8').then(text=>z.array(z.object({deviceId:z.string(),name:z.string(),tokenHash:z.string(),pairedAt:z.string(),revoked:z.boolean()})).parse(JSON.parse(text)),error=>{if(error.code==='ENOENT')return [];throw error;});
  const savePeers=async()=>{const temporary=peerPath+'.'+randomBytes(6).toString('hex')+'.tmp';await fs.writeFile(temporary,JSON.stringify(peers),{mode:0o600});await fs.rename(temporary,peerPath);};
  let code=secret(),expiresAt=Date.now()+5*60_000,pending:Pairing|null=null,closed=false;
  const limits=new Map<string,{since:number;count:number}>();
  async function read(request:IncomingMessage){
    const chunks:Buffer[]=[];let size=0;
    for await(const chunk of request){size+=chunk.length;if(size>4_500_000)throw new Error('body_limit');chunks.push(chunk);}
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  }
  const reply=(response:ServerResponse,status:number,value:unknown)=>{response.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});response.end(JSON.stringify(value));};
  const manifest=await options.sync.manifest();
  const server=https.createServer({...certificate,minVersion:'TLSv1.2',requestTimeout:30000,headersTimeout:10000},(request,response)=>{
    void (async()=>{
      const address=request.socket.remoteAddress?.replace(/^::ffff:/,'')??'';
      if(!privateIPv4(address,options.testLoopback)){reply(response,403,{error:'private_network_only'});return;}
      // Never allow an arbitrary website's fetch to drive the local pairing/sync service.
      if(request.headers.origin||request.headers['sec-fetch-site']){reply(response,403,{error:'native_client_required'});return;}
      const rate=limits.get(address);if(!rate||rate.since<Date.now()-60000){if(limits.size>512)limits.clear();limits.set(address,{since:Date.now(),count:1});}else if(++rate.count>240){reply(response,429,{error:'rate_limited'});return;}
      const url=new URL(request.url??'/',`https://${options.host}`);
      if(url.pathname==='/pair/request'&&request.method==='POST'){
        const input=z.object({code:z.string().length(64),deviceId:z.string().min(1).max(160),name:z.string().min(1).max(80),proof:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(await read(request));
        if(expiresAt<Date.now()||!equal(input.code,code)||input.deviceId===manifest.deviceId){reply(response,403,{error:'pairing_expired'});return;}
        if(pending&&pending.expiresAt>Date.now()&&(pending.deviceId!==input.deviceId||!equal(pending.proofHash,digest(input.proof)))){reply(response,409,{error:'pairing_reserved'});return;}
        if(pending&&pending.expiresAt<Date.now())pending=null;
        pending??={id:secret(),deviceId:input.deviceId,name:input.name,proofHash:digest(input.proof),verification:String(parseInt(digest(code+input.deviceId+input.proof).slice(0,10),16)%1_000_000).padStart(6,'0'),expiresAt:Date.now()+120000,approved:false};
        reply(response,200,{id:pending.id,verification:pending.verification,expiresAt:pending.expiresAt});return;
      }
      if(url.pathname==='/pair/result'&&request.method==='POST'){
        const input=z.object({id:z.string(),proof:z.string()}).strict().parse(await read(request));
        if(!pending||pending.id!==input.id||pending.expiresAt<Date.now()||!equal(pending.proofHash,digest(input.proof))){reply(response,403,{error:'pairing_expired'});return;}
        reply(response,200,pending.approved?{approved:true,token:pending.token,deviceId:manifest.deviceId,datasetId:manifest.datasetId}:{approved:false});return;
      }
      const id=String(request.headers['x-device-id']??''),token=String(request.headers.authorization??'').replace(/^Bearer /,'');
      const peer=peers.find(peer=>peer.deviceId===id&&!peer.revoked);
      if(!peer||!equal(peer.tokenHash,digest(token))){reply(response,401,{error:'device_not_authorized'});return;}
      if(url.pathname==='/manifest'&&request.method==='GET'){reply(response,200,await options.sync.manifest());return;}
      if(url.pathname==='/prepare'&&request.method==='POST'){reply(response,200,await options.sync.capture());return;}
      if(url.pathname==='/changes'&&request.method==='GET'){reply(response,200,await options.sync.changes(Number(url.searchParams.get('after')??0)));return;}
      if(url.pathname==='/receipt'&&request.method==='GET'){reply(response,200,{cursor:await options.sync.cursor(id)});return;}
      if(url.pathname==='/changes'&&request.method==='POST'){
        const input=z.object({from:z.number().int().nonnegative(),cursor:z.number().int().nonnegative(),changes:z.array(z.unknown()).max(200)}).strict().parse(await read(request));reply(response,200,await options.sync.receive(id,input.from,input.cursor,input.changes));return;
      }
      if(url.pathname==='/media/manifest'&&request.method==='GET'&&options.media){reply(response,200,await options.media.manifest());return;}
      if(url.pathname==='/media/chunk'&&request.method==='GET'&&options.media){reply(response,200,await options.media.chunk(url.searchParams.get('hash')??'',Number(url.searchParams.get('offset'))));return;}
      if(url.pathname==='/media/chunk'&&request.method==='POST'&&options.media){reply(response,200,await options.media.upload(await read(request)));return;}
      reply(response,404,{error:'route_not_found'});
    })().catch(()=>{if(!response.headersSent)reply(response,400,{error:'sync_request_rejected',message:'请求未完成，数据检查点保留。'});else response.end();});
  });
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(options.port??0,options.host,()=>{server.off('error',reject);resolve();});});
  server.on('error',()=>{closed=true;});
  const port=(server.address() as {port:number}).port;
  function state(){return {enabled:!closed,url:`https://${options.host}:${port}`,fingerprint:certificate.fingerprint,expiresAt,pairingInfo:'roastduck-pair:'+Buffer.from(JSON.stringify({protocol:1,url:`https://${options.host}:${port}`,fingerprint:certificate.fingerprint,code,expiresAt,deviceId:manifest.deviceId,datasetId:manifest.datasetId})).toString('base64url'),pending:pending?{id:pending.id,name:pending.name,verification:pending.verification,approved:pending.approved,expiresAt:pending.expiresAt}:null,peers:peers.map(peer=>({deviceId:peer.deviceId,name:peer.name,pairedAt:peer.pairedAt,revoked:peer.revoked}))};}
  let adminTail:Promise<unknown>=Promise.resolve();
  function serial<T>(work:()=>Promise<T>){const result=adminTail.then(work);adminTail=result.catch(()=>undefined);return result;}
  async function approveInner(id:string){if(!pending||pending.id!==id||pending.expiresAt<Date.now())throw new Error('配对请求已过期');if(pending.approved)return;
    const current=pending,token=secret(),entry:Peer={deviceId:current.deviceId,name:current.name,tokenHash:digest(token),pairedAt:new Date().toISOString(),revoked:false};peers=[...peers.filter(peer=>peer.deviceId!==entry.deviceId),entry];await savePeers();current.token=token;current.approved=true;if(pending===current){code=secret();expiresAt=0;}
  }
  async function revokeInner(id:string){peers=peers.map(peer=>peer.deviceId===id?{...peer,revoked:true}:peer);if(pending?.deviceId===id)pending=null;await savePeers();}
  function renew(){code=secret();expiresAt=Date.now()+300000;pending=null;return state();}
  async function close(){closed=true;pending=null;await new Promise<void>(resolve=>{server.close(()=>resolve());server.closeAllConnections();});}
  return {state,approve:(id:string)=>serial(()=>approveInner(id)),revoke:(id:string)=>serial(()=>revokeInner(id)),renew,close};
}
export type LocalSyncServer=Awaited<ReturnType<typeof startSyncServer>>;

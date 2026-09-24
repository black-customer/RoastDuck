export class LocalWriteError extends Error {constructor(message:string,readonly status:number){super(message);}}
/** Loopback Web only; rejects cross-site simple requests before parsing any sensitive body. */
export async function localJson(request:Request,maxBytes=65536):Promise<unknown>{
  const url=new URL(request.url),origin=request.headers.get('origin');
  // Next may canonicalize request.url to its listen hostname. Validate the actual Host header,
  // never X-Forwarded-Host, while still refusing non-loopback/DNS-rebinding hosts and other ports.
  let endpoint:URL;
  try{endpoint=request.headers.get('host')?new URL(`${url.protocol}//${request.headers.get('host')}`):url;}
  catch{throw new LocalWriteError('本机地址不正确',403);}
  if(!['localhost','127.0.0.1','[::1]'].includes(endpoint.hostname)||origin&&origin!==endpoint.origin||request.headers.get('sec-fetch-site')==='cross-site'||!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')??''))throw new LocalWriteError('只允许本机页面提交 JSON 请求',403);
  if(Number(request.headers.get('content-length')??0)>maxBytes)throw new LocalWriteError('请求过大',413);
  const reader=request.body?.getReader();if(!reader)throw new LocalWriteError('请求为空',400);
  const chunks:Uint8Array[]=[];let size=0;
  try{while(true){const result=await reader.read();if(result.done)break;size+=result.value.byteLength;if(size>maxBytes){await reader.cancel();throw new LocalWriteError('请求过大',413);}chunks.push(result.value);}}finally{reader.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  try{return JSON.parse(new TextDecoder().decode(bytes));}catch{throw new LocalWriteError('JSON 格式不正确',400);}
}

/** Route helper for mutating handlers: read a loopback-only JSON body, or a mapped error response. */
export async function localJsonBody(request:Request,maxBytes=65536):Promise<{ok:true;body:unknown}|{ok:false;response:import('next/server').NextResponse}>{
  try{return {ok:true,body:await localJson(request,maxBytes)};}
  catch(error){
    const status=error instanceof LocalWriteError?error.status:403;
    const message=error instanceof LocalWriteError?error.message:'只允许本机页面提交 JSON 请求';
    const {NextResponse}=await import('next/server');
    return {ok:false,response:NextResponse.json({error:message},{status})};
  }
}

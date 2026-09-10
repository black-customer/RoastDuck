import {AiProviderError} from './errors';

/** Consume terminal Responses events. Reasoning deltas are discarded, not exposed or persisted. */
export async function readResponsesStream(response:Response):Promise<unknown>{
  if(!response.body)throw new AiProviderError('AI 响应流为空','network_error',true);
  const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='',data:string[]=[];let terminal:unknown;
  const event=()=>{if(!data.length)return;const value=data.join('\n');data=[];if(value==='[DONE]')return;
    let parsed:Record<string,unknown>;try{parsed=JSON.parse(value);}catch{throw new AiProviderError('AI 响应事件中途损坏，尚未确认处理结果','network_error',true);}
    if(['response.completed','response.incomplete','response.failed'].includes(String(parsed.type)))terminal=parsed.response;
    if(parsed.type==='error')throw new AiProviderError('AI 响应流返回错误，结果尚未确认','network_error',true);
  };
  const line=(value:string)=>{if(value==='')event();else if(value.startsWith('data:'))data.push(value.slice(5).trimStart());};
  try{while(true){const {done,value}=await reader.read();buffer+=decoder.decode(value,{stream:!done});if(buffer.length>8_000_000)throw new AiProviderError('AI 响应事件超过接收限制，尚未确认处理结果','network_error',true);
    let end:number;while((end=buffer.indexOf('\n'))>=0){line(buffer.slice(0,end).replace(/\r$/,''));buffer=buffer.slice(end+1);if(terminal!==undefined){await reader.cancel().catch(()=>undefined);return terminal;}}
    if(terminal!==undefined){await reader.cancel().catch(()=>undefined);return terminal;}
    if(done){if(buffer)line(buffer.replace(/\r$/,''));event();break;}
  }}catch(error){await reader.cancel().catch(()=>undefined);if(error instanceof AiProviderError)throw error;throw new AiProviderError('AI 响应中途断开，结果尚未确认','network_error',true);}finally{reader.releaseLock();}
  if(terminal!==undefined)return terminal;
  throw new AiProviderError('AI 响应中断，未收到完成事件；请先恢复结果','network_error',true);
}

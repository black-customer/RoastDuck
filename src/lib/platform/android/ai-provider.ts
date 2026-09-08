import {registerPlugin} from "@capacitor/core";
import {z} from "zod";
import {DEEPSEEK_MODEL,type AiProvider,type StructuredAiRequest,type StructuredAiResult} from "@/lib/ai/contracts";
import {buildDeepSeekBody,parseDeepSeekResponse} from "@/lib/ai/deepseek-wire";
import {AiProviderError,httpError} from "@/lib/ai/errors";
const receiptSchema=z.object({state:z.enum(["pending","completed","failed","unknown"]),httpStatus:z.number().optional(),body:z.string().optional()});
interface Bridge {request(input:{runId:string;body:string}):Promise<unknown>;lookup(input:{runId:string}):Promise<unknown>}
const native=registerPlugin<Bridge>("RoastDuckRuntime");
/** No key, URL, authorization header or generic HTTP API is exposed to the WebView. */
export class AndroidAiProvider implements AiProvider {
  readonly providerName="deepseek" as const;readonly model=DEEPSEEK_MODEL;
  constructor(private bridge:Bridge=native){}
  private parse<T>(request:StructuredAiRequest<T>,raw:unknown,started:number):StructuredAiResult<T>|"pending"|null {
    const receipt=receiptSchema.parse(raw);
    if(receipt.state==="pending")return "pending";
    if(receipt.state==="unknown")return null;
    if(receipt.state==="failed")throw httpError(receipt.httpStatus??503);
    if(!receipt.body)throw new AiProviderError("本地响应回执缺失","invalid_output",true);
    return parseDeepSeekResponse(request,JSON.parse(receipt.body),Date.now()-started);
  }
  async generate<T>(request:StructuredAiRequest<T>,context?:{runId:string}):Promise<StructuredAiResult<T>> {
    if(!context)throw new AiProviderError("必须先保存请求记录","invalid_request",false);
    const started=Date.now();let raw:unknown;
    try{raw=await this.bridge.request({runId:context.runId,body:JSON.stringify(buildDeepSeekBody(request))});}
    catch(error){
      const code=(error as {code?:string})?.code;
      if(code==="missing_key")throw new AiProviderError("请在设置中配置自己的DeepSeek Key","invalid_configuration",false);
      if(code==="invalid_request")throw new AiProviderError("请求不符合模型契约","invalid_request",false);
      throw new AiProviderError("原生请求结果未确认，请恢复结果","network_error",true);
    }
    const result=this.parse(request,raw,started);
    if(!result||result==="pending")throw new AiProviderError("请求仍在处理或结果未确认","network_error",true);
    return result;
  }
  async recover<T>(request:StructuredAiRequest<T>,context:{runId:string}){return this.parse(request,await this.bridge.lookup(context),Date.now());}
}

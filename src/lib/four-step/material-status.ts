import {REQUEST_FORMAT_VERSION} from '@/lib/ai/errors';
/** 仅使用安全错误代码；不把 Provider 原始响应、私密上下文或堆栈下发客户端。 */
export function materialFailureMessage(code:string|null|undefined){
  if(code?.includes('invalid_request'))return '服务拒绝了应用发送的参数。原回答已保存，需要修正请求配置；反复点击原样重试不会解决。';
  if(code?.includes('wrong_model'))return '服务返回了与配置不一致的模型。原回答已保存，请先更新或检查应用配置。';
  if(code?.includes('rate_limited'))return 'AI 服务暂时限流，原回答已保存。稍后可继续尚未完成的阶段。';
  if(code==='result_unknown')return '上次请求结果尚未确认，先重新读取；再次发送可能重复计费。';
  if(code?.includes("timeout"))return "AI 请求超时，尚不能确认上次结果。回答已保存；再次发送可能重复计费，请先恢复结果。";
  if(code?.includes('network_error'))return '连接中断，上次结果尚未确认。回答已保存；再次发送可能重复计费。';
  if(code?.includes("invalid_output")||code?.includes("incomplete_output"))return "AI 返回的分析格式不完整，未能生成训练材料。原回答未丢失，可以重新处理。";
  if(code?.includes("source_quote")||code?.includes("source_coverage"))return "分析中的原文引用或覆盖不完整，材料未发布。需要重新核对原回答，不能直接当作学习材料。";
  if(code?.includes("rejected"))return "独立核对发现材料不符合原意或训练要求，已保留原回答，需要修正材料后再学习。";
  if(code?.includes("balance"))return "AI 账户余额不足，本次分析未完成。原回答已保留。";
  if(code?.includes("authentication")||code?.includes("configuration"))return "AI 服务配置不可用，请在设置中检查；原回答已经保存。";
  return "材料还没有完成处理。原回答已经保存，当前还不能开始句子学习。";
}
export const materialRequestNeedsFix=(code:string|null|undefined)=>!!code&&/invalid_request|wrong_model/.test(code);
export const materialNeedsSettings=(code:string|null|undefined)=>materialRequestNeedsFix(code)||!!code&&/authentication|configuration|balance|missing_key/.test(code);
export interface MaterialDiagnostic {code:string|null;stage:string;message:string;canRetry:boolean;needsSettings:boolean;requiresConfirmation:boolean;details:Record<string,unknown>}
export function materialDiagnostic(code:string|null|undefined,role?:string,detailsJson='{}'):MaterialDiagnostic{
  const stages:Record<string,string>={gap_generator:'分析你的意思与表达',gap_reviewer:'核对表达缺口',learning_material_compiler:'整理自然回答和句子',reviewer:'检查材料与原文'};
  const details:Record<string,unknown>={};try{const value=JSON.parse(detailsJson);for(const key of ['httpStatus','upstreamCode','upstreamType','parameter','requestId','requestFormatVersion','incompleteReason'])if(typeof value[key]==='number'||typeof value[key]==='string'&&/^[a-zA-Z0-9_.\[\]/:-]{1,160}$/.test(value[key])&&!value[key].startsWith('sk-'))details[key]=value[key];}catch{/* Old records keep their safe error code. */}
  const formatUpdated=materialRequestNeedsFix(code)&&details.requestFormatVersion!==REQUEST_FORMAT_VERSION;
  return {code:code??null,stage:stages[role??'']??'保存或发布材料',message:formatUpdated?'这次失败来自旧请求方式，应用已经更新，可以继续未完成的阶段。原回答保留。':materialFailureMessage(code),canRetry:!materialRequestNeedsFix(code)||formatUpdated,needsSettings:!formatUpdated&&materialNeedsSettings(code),requiresConfirmation:!!code&&/result_unknown|network_error|timeout/.test(code),details};
}

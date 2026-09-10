export type AiErrorCode =
  | "invalid_configuration"
  | "invalid_request"
  | "authentication_failed"
  | "insufficient_balance"
  | "rate_limited"
  | "server_error"
  | "network_error"
  | "timeout"
  | "invalid_output"
  | "incomplete_output"
  | "wrong_model";

export const REQUEST_FORMAT_VERSION='deepseek-responses-v3';
export interface AiErrorDetails {httpStatus?:number;upstreamCode?:string;upstreamType?:string;parameter?:string;requestId?:string;requestFormatVersion?:string;incompleteReason?:string;schemaPaths?:string[]}
export interface AiFailureResponse {responseId:string;responseModel:string;usage:{inputTokens:number;outputTokens:number;reasoningTokens:number;cachedTokens:number};latencyMs:number}

export class AiProviderError extends Error {
  constructor(
    message: string,
    public readonly code: AiErrorCode,
    public readonly retryable: boolean,
    public readonly httpStatus?: number,
    public readonly details?: AiErrorDetails,
    public readonly response?:AiFailureResponse,
  ) {
    super(message);
    this.name = "AiProviderError";
  }
}

export function safeErrorSummary(reason: unknown): string {
  const raw = reason instanceof Error ? reason.message : String(reason ?? "未知错误");
  return raw
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "[REDACTED_KEY]")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .slice(0, 300);
}

export function httpError(status: number, details?:AiErrorDetails): AiProviderError {
  if (status === 400 || status === 422) {
    return new AiProviderError("DeepSeek 请求参数不合法，需要修正请求配置后再继续", "invalid_request", false, status,details);
  }
  if (status === 401) {
    return new AiProviderError("DeepSeek 鉴权失败", "authentication_failed", false, status,details);
  }
  if (status === 402) {
    return new AiProviderError("DeepSeek 余额不足", "insufficient_balance", false, status,details);
  }
  if (status === 429) {
    return new AiProviderError("DeepSeek 请求达到速率限制", "rate_limited", true, status,details);
  }
  if (status === 500 || status === 503) {
    return new AiProviderError("DeepSeek 服务暂时不可用", "server_error", true, status,details);
  }
  return new AiProviderError(`DeepSeek 返回 HTTP ${status}`, "server_error", status >= 500, status,details);
}

/** Store identifiers only, never the upstream free-text message or echoed request. */
export async function errorFromResponse(response:Response){
  let raw:unknown;try{raw=await response.json();}catch{/* Non-JSON failures still have a meaningful status. */}
  const value=raw&&typeof raw==='object'&&'error'in raw?(raw as {error:unknown}).error:null;
  const e=value&&typeof value==='object'?value as Record<string,unknown>:{};
  const identifier=(value:unknown)=>typeof value==='string'&&/^[a-zA-Z0-9_.\[\]/:-]{1,160}$/.test(value)&&!value.startsWith('sk-')?value:undefined;
  return httpError(response.status,{httpStatus:response.status,upstreamCode:identifier(e.code),upstreamType:identifier(e.type),parameter:identifier(e.param),requestId:identifier(response.headers.get('x-request-id')??response.headers.get('request-id'))});
}

export function normalizeAiError(reason: unknown): AiProviderError {
  if (reason instanceof AiProviderError) return reason;
  if (reason instanceof DOMException && reason.name === "AbortError") {
    return new AiProviderError("DeepSeek 请求超时", "timeout", true);
  }
  return new AiProviderError(`DeepSeek 网络请求失败：${safeErrorSummary(reason)}`, "network_error", true);
}

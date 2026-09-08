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

export class AiProviderError extends Error {
  constructor(
    message: string,
    public readonly code: AiErrorCode,
    public readonly retryable: boolean,
    public readonly httpStatus?: number,
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

export function httpError(status: number): AiProviderError {
  if (status === 400 || status === 422) {
    return new AiProviderError("DeepSeek 请求参数不合法", "invalid_request", false, status);
  }
  if (status === 401) {
    return new AiProviderError("DeepSeek 鉴权失败", "authentication_failed", false, status);
  }
  if (status === 402) {
    return new AiProviderError("DeepSeek 余额不足", "insufficient_balance", false, status);
  }
  if (status === 429) {
    return new AiProviderError("DeepSeek 请求达到速率限制", "rate_limited", true, status);
  }
  if (status === 500 || status === 503) {
    return new AiProviderError("DeepSeek 服务暂时不可用", "server_error", true, status);
  }
  return new AiProviderError(`DeepSeek 返回 HTTP ${status}`, "server_error", status >= 500, status);
}

export function normalizeAiError(reason: unknown): AiProviderError {
  if (reason instanceof AiProviderError) return reason;
  if (reason instanceof DOMException && reason.name === "AbortError") {
    return new AiProviderError("DeepSeek 请求超时", "timeout", true);
  }
  return new AiProviderError(`DeepSeek 网络请求失败：${safeErrorSummary(reason)}`, "network_error", true);
}

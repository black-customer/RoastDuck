import { DEEPSEEK_MODEL, type AiProvider, type StructuredAiRequest, type StructuredAiResult } from "./contracts";
import { AiProviderError, httpError, normalizeAiError } from "./errors";
import {buildDeepSeekBody,parseDeepSeekResponse} from "./deepseek-wire";

export interface DeepSeekProviderOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class DeepSeekProvider implements AiProvider {
  readonly providerName = "deepseek" as const;
  readonly model = DEEPSEEK_MODEL;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: DeepSeekProviderOptions) {
    if (!options.apiKey.trim()) {
      throw new AiProviderError("未配置 DEEPSEEK_API_KEY", "invalid_configuration", false);
    }
    this.baseUrl = (options.baseUrl ?? "https://api.deepseek.com").replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async generate<T>(request: StructuredAiRequest<T>): Promise<StructuredAiResult<T>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const startedAt = Date.now();
    try {
      const body=buildDeepSeekBody(request);
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}/responses`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.options.apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (reason) {
        throw normalizeAiError(reason);
      }
      if (!response.ok) throw httpError(response.status);

      let rawJson: unknown;
      try { rawJson = await response.json(); }
      catch(reason) {
        if(controller.signal.aborted)throw new AiProviderError("DeepSeek 读取响应超时", "timeout", true);
        if(reason instanceof SyntaxError)throw new AiProviderError("DeepSeek 响应不是合法 JSON", "invalid_output", true);
        throw normalizeAiError(reason);
      }
      return parseDeepSeekResponse(request,rawJson,Date.now()-startedAt);
    } finally {
      clearTimeout(timeout);
    }
  }
}

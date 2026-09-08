import { z } from "zod";
import { MIMO_TTS_MODEL, type SpeechSynthesisInput, SpeechProviderError } from "./contracts";
import {buildMimoBody} from "./wire";

const mimoResponseSchema = z.object({
  id: z.string().optional(),
  model: z.string().optional(),
  choices: z.array(z.object({
    message: z.object({
      audio: z.object({
        data: z.string().min(1),
      }),
    }),
  })).min(1),
});

export interface MimoTtsProviderOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface MimoAudio {
  bytes: Buffer;
  responseId: string | null;
}

function validateWav(bytes: Buffer): void {
  if (bytes.byteLength < 44 || bytes.subarray(0, 4).toString("ascii") !== "RIFF" || bytes.subarray(8, 12).toString("ascii") !== "WAVE") {
    throw new SpeechProviderError("MiMo 返回的音频不是有效 WAV", "invalid_audio", true);
  }
  if (bytes.byteLength > 20 * 1024 * 1024) {
    throw new SpeechProviderError("MiMo 返回的音频超过安全大小限制", "invalid_audio", false);
  }
}

function upstreamError(status: number): SpeechProviderError {
  if (status === 401 || status === 403) return new SpeechProviderError("MiMo TTS 鉴权失败", "authentication_failed", false, 503);
  if (status === 429) return new SpeechProviderError("MiMo TTS 请求达到速率限制", "rate_limited", true, 503);
  return new SpeechProviderError(`MiMo TTS 暂时不可用（HTTP ${status}）`, "upstream_unavailable", status >= 500, 503);
}

export class MimoTtsProvider {
  readonly providerName = "mimo" as const;
  readonly model = MIMO_TTS_MODEL;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: MimoTtsProviderOptions) {
    if (!options.apiKey.trim()) throw new SpeechProviderError("未配置 MIMO_API_KEY", "missing_key", false, 503);
    this.baseUrl = (options.baseUrl ?? "https://api.xiaomimimo.com/v1").replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 150_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async synthesize(input: SpeechSynthesisInput & { voice: "Mia" | "Chloe" | "Milo" | "Dean" }): Promise<MimoAudio> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "api-key": this.options.apiKey,
            "content-type": "application/json",
          },
          body: JSON.stringify(buildMimoBody(input,input.voice)),
          signal: controller.signal,
        });
      } catch (reason) {
        if (controller.signal.aborted || (reason instanceof DOMException && reason.name === "AbortError")) {
          throw new SpeechProviderError("MiMo TTS 请求超时", "timeout", true, 503);
        }
        throw new SpeechProviderError("MiMo TTS 网络请求失败", "network_error", true, 503);
      }
      if (!response.ok) throw upstreamError(response.status);
      let body:unknown;
      try { body=await response.json(); }
      catch {
        if(controller.signal.aborted)throw new SpeechProviderError("MiMo 已响应，但未能在等待时间内接收完整音频；本次结果未确认","timeout",true,503);
        throw new SpeechProviderError("MiMo 响应未能解析为 JSON，尚未取得音频","invalid_audio",false);
      }
      const parsed = mimoResponseSchema.safeParse(body);
      if (!parsed.success) throw new SpeechProviderError("MiMo TTS 响应结构不合法", "invalid_audio", true);
      if (parsed.data.model && parsed.data.model !== this.model) {
        throw new SpeechProviderError("MiMo 返回了非预期 TTS 模型", "invalid_audio", false);
      }
      const bytes = Buffer.from(parsed.data.choices[0].message.audio.data, "base64");
      validateWav(bytes);
      return { bytes, responseId: parsed.data.id ?? null };
    } finally {
      clearTimeout(timeout);
    }
  }
}

import { z } from "zod";
import {AI_ROLE_CONFIG,DEEPSEEK_MODEL,type StructuredAiRequest,type StructuredAiResult} from "./contracts";
import {AiProviderError} from "./errors";
const responseSchema = z.object({
  id: z.string(),
  status: z.enum(["in_progress", "completed", "incomplete", "failed"]),
  model: z.string(),
  error: z.object({ code: z.string().optional(), message: z.string().optional() }).nullable().optional(),
  incomplete_details: z.object({ reason: z.string().optional() }).nullable().optional(),
  output: z.array(z.object({
    type: z.string(),
    content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
  })),
  usage: z.object({
    input_tokens: z.number().int().nonnegative().default(0),
    output_tokens: z.number().int().nonnegative().default(0),
    input_tokens_details: z.object({ cached_tokens: z.number().int().nonnegative().default(0) }).optional(),
    output_tokens_details: z.object({ reasoning_tokens: z.number().int().nonnegative().default(0) }).optional(),
  }).optional(),
});

function responseText(output: z.infer<typeof responseSchema>["output"]): string {
  return output
    .filter((item) => item.type === "message")
    .flatMap((item) => item.content ?? [])
    .filter((item) => item.type === "output_text")
    .map((item) => item.text ?? "")
    .join("")
    .trim();
}

export function buildDeepSeekBody<T>(request:StructuredAiRequest<T>) {
const roleConfig=AI_ROLE_CONFIG[request.role];
      const body: Record<string, unknown> = {
        model: DEEPSEEK_MODEL,
        instructions: request.instructions,
        input: request.input,
        reasoning: { effort: roleConfig.thinking },
        max_output_tokens: request.maxOutputTokens ?? roleConfig.maxOutputTokens,
        text: {
          format: {
            type: "json_schema",
            name: request.schemaName.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64),
            schema: z.toJSONSchema(request.schema),
            strict: true,
          },
        },
        user_id: request.idempotencyKey.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 512),
      };
      if (roleConfig.temperature !== undefined) body.temperature = roleConfig.temperature;

return body;
}
export function parseDeepSeekResponse<T>(request:StructuredAiRequest<T>,rawJson:unknown,latencyMs:number):StructuredAiResult<T> {
      const raw = responseSchema.safeParse(rawJson);
      if (!raw.success) {
        throw new AiProviderError("DeepSeek 响应结构不合法", "invalid_output", true);
      }
      if (raw.data.model !== DEEPSEEK_MODEL) {
        throw new AiProviderError("DeepSeek 返回了非预期模型", "wrong_model", false);
      }
      if (raw.data.status !== "completed") {
        const reason = raw.data.incomplete_details?.reason || raw.data.error?.code || raw.data.status;
        throw new AiProviderError(`DeepSeek 响应未完成：${reason}`, "incomplete_output", true);
      }
      const text = responseText(raw.data.output);
      if (!text) throw new AiProviderError("DeepSeek 返回空内容", "invalid_output", true);
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new AiProviderError("DeepSeek 返回的结构化内容不是合法 JSON", "invalid_output", true);
      }
      const parsed = request.schema.safeParse(json);
      if (!parsed.success) {
        throw new AiProviderError("DeepSeek 输出未通过 Zod Schema", "invalid_output", true);
      }
      return {
        data: parsed.data,
        responseId: raw.data.id,
        latencyMs,
        usage: {
          inputTokens: raw.data.usage?.input_tokens ?? 0,
          outputTokens: raw.data.usage?.output_tokens ?? 0,
          cachedTokens: raw.data.usage?.input_tokens_details?.cached_tokens ?? 0,
          reasoningTokens: raw.data.usage?.output_tokens_details?.reasoning_tokens ?? 0,
        },
      };
}

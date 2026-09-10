import { z } from "zod";
import {AI_ROLE_CONFIG,DEEPSEEK_MODEL,type StructuredAiRequest,type StructuredAiResult} from "./contracts";
import {AiProviderError} from "./errors";
import {strictResponseSchema,restoreOptionalValues} from './strict-response-schema';
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
        instructions: request.instructions+'\n\nReturn only the JSON value required by the supplied schema. No Markdown fences or commentary outside JSON.',
        input: request.input,
        reasoning: { effort: request.thinking??roleConfig.thinking },
        max_output_tokens: request.maxOutputTokens ?? roleConfig.maxOutputTokens,
        stream:true,
        text: {
          format: {
            type: "json_schema",
            name: request.schemaName.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64),
            schema: strictResponseSchema(z.toJSONSchema(request.schema)),
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
      const metadata={responseId:raw.data.id,responseModel:raw.data.model,latencyMs,usage:{inputTokens:raw.data.usage?.input_tokens??0,outputTokens:raw.data.usage?.output_tokens??0,cachedTokens:raw.data.usage?.input_tokens_details?.cached_tokens??0,reasoningTokens:raw.data.usage?.output_tokens_details?.reasoning_tokens??0}};
      // V4.1's official canonical API name; prior cached runs retain their original metadata.
      if (raw.data.model!==DEEPSEEK_MODEL) {
        throw new AiProviderError("DeepSeek 返回了非预期模型", "wrong_model", false,undefined,undefined,metadata);
      }
      if (raw.data.status !== "completed") {
        const reason = raw.data.incomplete_details?.reason || raw.data.error?.code || raw.data.status;
        throw new AiProviderError(`DeepSeek 响应未完成：${reason}`, "incomplete_output", true,undefined,{incompleteReason:reason},metadata);
      }
      const text = responseText(raw.data.output);
      if (!text) throw new AiProviderError("DeepSeek 返回空内容", "invalid_output", true,undefined,undefined,metadata);
      let json: unknown;
      try {
        const trimmed=text.replace(/^\uFEFF/,'').trim(),fenced=/^```(?:json)?\s*\n([\s\S]*)\n```$/i.exec(trimmed);
        json = JSON.parse(fenced?fenced[1]:trimmed);
      } catch {
        throw new AiProviderError("DeepSeek 返回的结构化内容不是合法 JSON", "invalid_output", true,undefined,undefined,metadata);
      }
      const parsed = request.schema.safeParse(restoreOptionalValues(z.toJSONSchema(request.schema),json));
      if (!parsed.success) {
        throw new AiProviderError("DeepSeek 输出未通过 Zod Schema", "invalid_output", true,undefined,{schemaPaths:parsed.error.issues.slice(0,10).map(issue=>issue.path.map(String).join('.'))},metadata);
      }
      return {
        data: parsed.data,
        responseModel:raw.data.model,
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

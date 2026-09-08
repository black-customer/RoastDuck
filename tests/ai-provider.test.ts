import { describe, expect, it } from "vitest";
import { z } from "zod";
import { readAiEnvironment } from "@/lib/ai/config";
import { DeepSeekProvider } from "@/lib/ai/deepseek-provider";
import { AiProviderError } from "@/lib/ai/errors";
import { MockAiProvider } from "@/lib/ai/mock-provider";
import type { AiRole, StructuredAiRequest } from "@/lib/ai/contracts";

const outputSchema = z.object({ greeting: z.string() });

function request(role: AiRole): StructuredAiRequest<z.infer<typeof outputSchema>> {
  return {
    role,
    instructions: `独立 ${role} prompt`,
    input: "hello",
    schema: outputSchema,
    schemaName: `${role}_schema`,
    promptVersion: `${role}.v1`,
    schemaVersion: "test.v1",
    idempotencyKey: `job_${role}_1`,
  };
}

function successResponse() {
  return {
    id: "response_test_1",
    status: "completed",
    model: "deepseek-v4-flash",
    output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ greeting: "Hello!" }) }] }],
    usage: {
      input_tokens: 11,
      output_tokens: 5,
      input_tokens_details: { cached_tokens: 3 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  };
}

describe("DeepSeek V4 Flash Provider", () => {
  it("读取响应体超时不能伪装成格式不合法",async()=>{
    const provider=new DeepSeekProvider({apiKey:"test-key-not-real",timeoutMs:5,fetchImpl:async(_url,init)=>({ok:true,json:()=>new Promise((_resolve,reject)=>{init?.signal?.addEventListener("abort",()=>reject(new DOMException("Aborted","AbortError")));})}) as Response});
    await expect(provider.generate(request("generator"))).rejects.toMatchObject({code:"timeout"});
  });
  it("环境配置只允许 deepseek-v4-flash", () => {
    const config = readAiEnvironment({
      NODE_ENV: "production",
      AI_PROVIDER: "deepseek",
      DEEPSEEK_API_KEY: "test-only",
      DEEPSEEK_BASE_URL: "https://api.deepseek.com/",
      DEEPSEEK_MODEL: "deepseek-v4-flash",
    });
    expect(config.model).toBe("deepseek-v4-flash");
    expect(config.baseUrl).toBe("https://api.deepseek.com");
    expect(() => readAiEnvironment({
      AI_PROVIDER: "deepseek",
      DEEPSEEK_API_KEY: "test-only",
      DEEPSEEK_MODEL: "another-model",
    })).toThrow();
  });

  it("Generator 使用关闭思考的独立请求，并从 output message 提取 JSON", async () => {
    let sentBody: Record<string, unknown> | null = null;
    const provider = new DeepSeekProvider({
      apiKey: "test-key-not-real",
      fetchImpl: async (_input, init) => {
        sentBody = JSON.parse(String(init?.body));
        return Response.json(successResponse());
      },
    });
    const result = await provider.generate(request("generator"));
    expect(result.data).toEqual({ greeting: "Hello!" });
    expect(result.usage).toEqual({ inputTokens: 11, outputTokens: 5, cachedTokens: 3, reasoningTokens: 0 });
    expect(sentBody).toMatchObject({
      model: "deepseek-v4-flash",
      reasoning: { effort: "none" },
      temperature: 0.2,
      user_id: "job_generator_1",
      text: { format: { type: "json_schema", name: "generator_schema", strict: true } },
    });
  });

  it("Reviewer 使用同一模型但开启独立思考，且不发送无效 temperature", async () => {
    let sentBody: Record<string, unknown> | null = null;
    const provider = new DeepSeekProvider({
      apiKey: "test-key-not-real",
      fetchImpl: async (_input, init) => {
        sentBody = JSON.parse(String(init?.body));
        return Response.json({
          ...successResponse(),
          usage: { ...successResponse().usage, output_tokens_details: { reasoning_tokens: 7 } },
        });
      },
    });
    const result = await provider.generate(request("reviewer"));
    expect(result.usage.reasoningTokens).toBe(7);
    expect(sentBody).toMatchObject({ model: "deepseek-v4-flash", reasoning: { effort: "high" } });
    expect(sentBody).not.toHaveProperty("temperature");
  });

  it("余额不足硬停止；非法结构化输出必须失败", async () => {
    const noBalance = new DeepSeekProvider({
      apiKey: "test-key-not-real",
      fetchImpl: async () => new Response("", { status: 402 }),
    });
    await expect(noBalance.generate(request("generator"))).rejects.toMatchObject({
      code: "insufficient_balance",
      retryable: false,
    });

    const invalid = new DeepSeekProvider({
      apiKey: "test-key-not-real",
      fetchImpl: async () => Response.json({
        ...successResponse(),
        output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ wrong: true }) }] }],
      }),
    });
    await expect(invalid.generate(request("generator"))).rejects.toMatchObject({ code: "invalid_output" });
  });

  it("Mock Provider 也必须通过同一 Zod Schema", async () => {
    const valid = new MockAiProvider(() => ({ greeting: "Mock hello" }));
    await expect(valid.generate(request("hint"))).resolves.toMatchObject({ data: { greeting: "Mock hello" } });

    const invalid = new MockAiProvider(() => ({ wrong: true }));
    await expect(invalid.generate(request("hint"))).rejects.toBeInstanceOf(AiProviderError);
  });
});

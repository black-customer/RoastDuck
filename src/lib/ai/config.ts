import { z } from "zod";
import { DEEPSEEK_MODEL, type AiProviderName } from "./contracts";

const environmentSchema = z.object({
  AI_PROVIDER: z.enum(["deepseek", "mock"]),
  DEEPSEEK_API_KEY: z.string(),
  DEEPSEEK_BASE_URL: z.string().url(),
  DEEPSEEK_MODEL: z.literal(DEEPSEEK_MODEL),
});

export interface AiEnvironment {
  provider: AiProviderName;
  apiKey: string;
  baseUrl: string;
  model: typeof DEEPSEEK_MODEL;
}

export function readAiEnvironment(env: Record<string, string | undefined> = process.env): AiEnvironment {
  if (typeof window !== "undefined") throw new Error("AI 配置只能在服务端读取");
  const parsed = environmentSchema.parse({
    AI_PROVIDER: env.AI_PROVIDER?.trim() || (env.NODE_ENV === "test" ? "mock" : "deepseek"),
    DEEPSEEK_API_KEY: env.DEEPSEEK_API_KEY?.trim() || "",
    DEEPSEEK_BASE_URL: (env.DEEPSEEK_BASE_URL?.trim() || "https://api.deepseek.com").replace(/\/+$/, ""),
    DEEPSEEK_MODEL: env.DEEPSEEK_MODEL?.trim() || DEEPSEEK_MODEL,
  });
  return {
    provider: parsed.AI_PROVIDER,
    apiKey: parsed.DEEPSEEK_API_KEY,
    baseUrl: parsed.DEEPSEEK_BASE_URL,
    model: parsed.DEEPSEEK_MODEL,
  };
}

export function getAiHealth(env: Record<string, string | undefined> = process.env) {
  try {
    const config = readAiEnvironment(env);
    const configured = config.provider === "mock" || config.apiKey.length > 0;
    return {
      configured,
      provider: config.provider,
      model: config.model,
      status: configured ? (config.provider === "mock" ? "mock" : "configured") : "missing_key",
    } as const;
  } catch {
    return {
      configured: false,
      provider: "deepseek" as const,
      model: DEEPSEEK_MODEL,
      status: "invalid_configuration" as const,
    };
  }
}

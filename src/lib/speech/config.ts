import { z } from "zod";
import { MIMO_TTS_MODEL, MIMO_TTS_VOICES } from "./contracts";

const speechEnvironmentSchema = z.object({
  MIMO_API_KEY: z.string(),
  MIMO_BASE_URL: z.string().url(),
  MIMO_TTS_MODEL: z.literal(MIMO_TTS_MODEL),
  MIMO_TTS_VOICE: z.enum(MIMO_TTS_VOICES),
  MIMO_TTS_ACCENT: z.literal("en-US"),
});

export interface SpeechEnvironment {
  apiKey: string;
  baseUrl: string;
  model: typeof MIMO_TTS_MODEL;
  voice: typeof MIMO_TTS_VOICES[number];
  accent: "en-US";
}

export function readSpeechEnvironment(env: Record<string, string | undefined> = process.env): SpeechEnvironment {
  if (typeof window !== "undefined") throw new Error("语音服务配置只能在服务端读取");
  const parsed = speechEnvironmentSchema.parse({
    MIMO_API_KEY: env.MIMO_API_KEY?.trim() ?? "",
    MIMO_BASE_URL: (env.MIMO_BASE_URL?.trim() || "https://api.xiaomimimo.com/v1").replace(/\/+$/, ""),
    MIMO_TTS_MODEL: env.MIMO_TTS_MODEL?.trim() || MIMO_TTS_MODEL,
    MIMO_TTS_VOICE: env.MIMO_TTS_VOICE?.trim() || "Chloe",
    MIMO_TTS_ACCENT: env.MIMO_TTS_ACCENT?.trim() || "en-US",
  });
  return {
    apiKey: parsed.MIMO_API_KEY,
    baseUrl: parsed.MIMO_BASE_URL,
    model: parsed.MIMO_TTS_MODEL,
    voice: parsed.MIMO_TTS_VOICE,
    accent: parsed.MIMO_TTS_ACCENT,
  };
}

export function getSpeechHealth(env: Record<string, string | undefined> = process.env) {
  try {
    const config = readSpeechEnvironment(env);
    return {
      configured: config.apiKey.length > 0,
      provider: "mimo" as const,
      model: config.model,
      voice: config.voice,
      accent: config.accent,
      status: config.apiKey.length > 0 ? "configured" as const : "missing_key" as const,
    };
  } catch {
    return {
      configured: false,
      provider: "mimo" as const,
      model: MIMO_TTS_MODEL,
      voice: "Chloe" as const,
      accent: "en-US" as const,
      status: "invalid_configuration" as const,
    };
  }
}

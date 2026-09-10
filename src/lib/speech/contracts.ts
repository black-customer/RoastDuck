import { z } from "zod";

export const MIMO_TTS_MODEL = "mimo-v2.5-tts" as const;
export const MIMO_TTS_VERSION = "mimo-young-american-v3" as const;
export const MIMO_TTS_VOICES = ["Mia", "Chloe", "Milo", "Dean"] as const;
export type MimoVoice = typeof MIMO_TTS_VOICES[number];
export type SpeechAccent = "en-US" | "en-GB";
export const PLAYBACK_RATES = [0.85, 1, 1.1, 1.2] as const;
export type PlaybackRate = typeof PLAYBACK_RATES[number];
export const DEFAULT_MIMO_VOICE: MimoVoice = "Milo";
export const DEFAULT_SPEECH_ACCENT: SpeechAccent = "en-US";
export const DEFAULT_VOICE_PRESET = "us-male" as const;
export const SPEECH_STYLES = ["short-expression", "daily-conversation", "ielts-answer"] as const;
export type SpeechStyle = typeof SPEECH_STYLES[number];

/** Callers with source context choose explicitly; unlabelled short snippets keep a compact cadence. */
export function resolveSpeechStyle(input: { text: string; style?: SpeechStyle }): SpeechStyle {
  return input.style ?? (input.text.trim().split(/\s+/).length <= 16 ? "short-expression" : "daily-conversation");
}

export type VoicePresetId = "us-female" | "us-male" | "uk-female" | "uk-male";

export interface VoicePresetConfig {
  id: VoicePresetId;
  label: string;
  sublabel: string;
  mimoVoice: typeof MIMO_TTS_VOICES[number];
  accent: "en-US" | "en-GB";
  gender: "female" | "male";
}

export const VOICE_PRESETS: VoicePresetConfig[] = [
  { id: "us-female", label: "美音女声 (Chloe)", sublabel: "美式自然亲和", mimoVoice: "Chloe", accent: "en-US", gender: "female" },
  { id: "us-male", label: "美音男声 (Milo)", sublabel: "年轻自然男声", mimoVoice: "Milo", accent: "en-US", gender: "male" },
  { id: "uk-female", label: "英音女声 (Mia)", sublabel: "英式优雅清脆", mimoVoice: "Mia", accent: "en-GB", gender: "female" },
  { id: "uk-male", label: "英音男声 (Milo)", sublabel: "年轻自然男声", mimoVoice: "Milo", accent: "en-GB", gender: "male" },
];


export const speechSynthesisInputSchema = z.object({
  text: z.string().trim().min(1).max(4_000),
  purpose: z.enum(["learning_context", "chunk", "example", "question", "teacher_message"]).default("example"),
  voice: z.enum(MIMO_TTS_VOICES).optional(),
  accent: z.enum(["en-US", "en-GB"]).default("en-US"),
  // Synthesis cadence only. Browser playback speed never changes this request.
  rate: z.number().min(0.65).max(1.25).default(1),
  style: z.enum(SPEECH_STYLES).optional(),
});

export type SpeechSynthesisInput = z.infer<typeof speechSynthesisInputSchema>;

export interface SpeechSynthesisResult {
  assetId: string;
  audioUrl: string;
  provider: "mimo";
  model: typeof MIMO_TTS_MODEL;
  voice: typeof MIMO_TTS_VOICES[number];
  accent: "en-US" | "en-GB";
  format: "wav";
  cached: boolean;
}

export type SpeechErrorCode =
  | "missing_key"
  | "invalid_configuration"
  | "authentication_failed"
  | "rate_limited"
  | "upstream_unavailable"
  | "network_error"
  | "timeout"
  | "invalid_audio"
  | "result_unknown"
  | "storage_error"
  | "cancelled";

export class SpeechProviderError extends Error {
  constructor(
    message: string,
    readonly code: SpeechErrorCode,
    readonly retryable: boolean,
    readonly httpStatus = 502,
  ) {
    super(message);
    this.name = "SpeechProviderError";
  }
}

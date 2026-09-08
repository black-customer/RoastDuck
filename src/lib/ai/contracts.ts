import { z } from "zod";

export const DEEPSEEK_MODEL = "deepseek-v4-flash" as const;
export const AI_ROLES = [
  "generator",
  "reviewer",
  "translator",
  "corrector",
  "hint",
  "teacher_response",
  "gap_generator",
  "gap_reviewer",
  "reattempt_comparator",
  "learning_material_compiler",
  "scenario_reviewer",
  "retrieval_judge",
  "variant_reviewer",
  "companion_response",
  "memory_extractor",
  "speaking_practice_analysis",
  "translation_evaluator",
  "free_talk_tutor",
] as const;
export type AiRole = (typeof AI_ROLES)[number];
export type AiProviderName = "deepseek" | "mock";
export type ThinkingEffort = "none" | "low" | "high" | "max";

export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
}

export interface StructuredAiRequest<T> {
  role: AiRole;
  instructions: string;
  input: string;
  schema: z.ZodType<T>;
  schemaName: string;
  promptVersion: string;
  schemaVersion: string;
  idempotencyKey: string;
  maxOutputTokens?: number;
}

export interface StructuredAiResult<T> {
  data: T;
  responseId: string;
  latencyMs: number;
  usage: AiUsage;
}

export interface AiProvider {
  readonly providerName: AiProviderName;
  readonly model: typeof DEEPSEEK_MODEL;
  generate<T>(request: StructuredAiRequest<T>,context?:{runId:string}): Promise<StructuredAiResult<T>>;
  /** Native transport can recover a response persisted before the WebView was closed. */
  recover?<T>(request:StructuredAiRequest<T>,context:{runId:string}):Promise<StructuredAiResult<T>|"pending"|null>;
}

export const AI_ROLE_CONFIG: Record<AiRole, {
  thinking: ThinkingEffort;
  temperature?: number;
  maxOutputTokens: number;
}> = {
  generator: { thinking: "none", temperature: 0.2, maxOutputTokens: 4096 },
  reviewer: { thinking: "high", maxOutputTokens: 4096 },
  translator: { thinking: "none", temperature: 0.2, maxOutputTokens: 4096 },
  corrector: { thinking: "high", maxOutputTokens: 6144 },
  hint: { thinking: "none", temperature: 0.3, maxOutputTokens: 2048 },
  teacher_response: { thinking: "low", temperature: 0.45, maxOutputTokens: 4096 },
  gap_generator: { thinking: "high", maxOutputTokens: 6144 },
  gap_reviewer: { thinking: "high", maxOutputTokens: 6144 },
  reattempt_comparator: { thinking: "high", maxOutputTokens: 6144 },
  learning_material_compiler: { thinking: "low", temperature: 0.2, maxOutputTokens: 8192 },
  scenario_reviewer: { thinking: "high", maxOutputTokens: 8192 },
  retrieval_judge: { thinking: "high", maxOutputTokens: 2048 },
  variant_reviewer: { thinking: "high", maxOutputTokens: 2048 },
  companion_response: { thinking: "low", temperature: 0.45, maxOutputTokens: 4096 },
  memory_extractor: { thinking: "high", maxOutputTokens: 2048 },
  speaking_practice_analysis: { thinking: "low", temperature: 0.2, maxOutputTokens: 8192 },
  translation_evaluator: { thinking: "low", temperature: 0.2, maxOutputTokens: 2048 },
  free_talk_tutor: { thinking: "low", temperature: 0.5, maxOutputTokens: 4096 },
};

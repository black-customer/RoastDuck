import { z } from "zod";
import { runtimeGlossaryEntrySchema } from "@/lib/speaking/schemas";

export const companionScopeTypeSchema = z.enum(["gap", "question", "general"]);

export const createCompanionThreadSchema = z.object({
  scopeType: companionScopeTypeSchema,
  scopeId: z.string().trim().min(1).max(160).nullable().default(null),
  title: z.string().trim().min(1).max(120).optional(),
}).superRefine((value, context) => {
  if (value.scopeType !== "general" && !value.scopeId) {
    context.addIssue({ code: "custom", path: ["scopeId"], message: "Gap 和题目线程必须提供 scopeId" });
  }
});

export const createCompanionMessageSchema = z.object({
  clientMessageId: z.string().uuid(),
  text: z.string().trim().min(1).max(8000),
  inputLanguage: z.enum(["zh", "en", "mixed"]).default("mixed"),
  messageKind: z.enum(["text", "voice"]).default("text"),
  retry: z.boolean().default(false),
});

export const companionResponseSchema = z.object({
  messages: z.array(z.object({
    text: z.string().trim().min(1).max(1200),
    purpose: z.enum(["natural_response", "key_issue", "natural_expression", "retry_request", "follow_up"]),
  })).min(1).max(4),
  glossary: z.array(runtimeGlossaryEntrySchema).max(500).default([]),
});

export const companionMemoryCandidateSchema = z.object({
  memoryKey: z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{2,79}$/),
  category: z.enum(["goal", "preference", "interest", "experience", "opinion"]),
  summary: z.string().trim().min(2).max(300),
  confidence: z.number().min(0).max(1),
  evidenceMessageIds: z.array(z.string().trim().min(1).max(160)).min(1).max(8),
});

export const companionMemoryExtractionSchema = z.object({
  memories: z.array(companionMemoryCandidateSchema).max(8),
});

export const updateCompanionMemorySchema = z.object({
  id: z.string().trim().min(1).max(160),
  summary: z.string().trim().min(2).max(300).optional(),
  category: z.enum(["goal", "preference", "interest", "experience", "opinion", "learning"]).optional(),
  status: z.enum(["active", "dismissed"]).optional(),
}).refine((value) => value.summary !== undefined || value.category !== undefined || value.status !== undefined, "至少修改一个字段");

export type CreateCompanionThread = z.infer<typeof createCompanionThreadSchema>;
export type CreateCompanionMessage = z.infer<typeof createCompanionMessageSchema>;
export type CompanionResponse = z.infer<typeof companionResponseSchema>;
export type CompanionMemoryExtraction = z.infer<typeof companionMemoryExtractionSchema>;

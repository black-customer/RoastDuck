import { z } from "zod";
import { gapItemSchema, learningItemCandidateSchema } from "@/lib/speaking-practice/schemas";

export const freeTalkModeSchema = z.enum(["relaxed", "strict"]);
export type FreeTalkMode = z.infer<typeof freeTalkModeSchema>;

export const userCorrectionSchema = z.object({
  natural: z.boolean().default(true),
  issue: z.string().trim().max(500).optional(),
  betterExpression: z.string().trim().max(500).optional(),
  explanationZh: z.string().trim().max(1000).optional(),
});
export type UserCorrection = z.infer<typeof userCorrectionSchema>;

export const freeTalkAiResponseSchema = z.object({
  reply: z.string().trim().min(1).max(4000),
  translationZh: z.string().trim().max(4000).optional(),
  userCorrection: userCorrectionSchema.nullable().optional(),
  teachingState: z.enum(["repetition_requested", "repetition_confirmed"]).nullable().default(null),
  targetRepetition: z.string().trim().max(1000).nullable().default(null),
  gaps: z.array(gapItemSchema).default([]),
  learningItems: z.array(learningItemCandidateSchema).default([]),
  gapCount: z.number().int().min(0).default(0),
  resurfacedItemKey: z.string().trim().max(160).nullable().default(null),
});
export type FreeTalkAiResponse = z.infer<typeof freeTalkAiResponseSchema>;

export const createFreeTalkConversationSchema = z.object({
  title: z.string().trim().min(1).max(200).default("AI Free Talk"),
  mode: freeTalkModeSchema.default("relaxed"),
});
export type CreateFreeTalkConversation = z.infer<typeof createFreeTalkConversationSchema>;

export const sendFreeTalkMessageSchema = z.object({
  clientMessageId: z.string().min(8).max(120).optional(),
  retry: z.boolean().optional(),
  text: z.string().trim().min(1).max(8000),
  mode: freeTalkModeSchema.optional(),
});
export type SendFreeTalkMessage = z.infer<typeof sendFreeTalkMessageSchema>;

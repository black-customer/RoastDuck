import {z} from "zod";
import {runtimeGlossaryEntrySchema} from "@/lib/speaking/schemas";
export const dialogueResponseSchema=z.object({
  messages:z.array(z.object({text:z.string().trim().min(1).max(1200),translationZh:z.string().max(1600).default(""),purpose:z.enum(["natural_response","key_issue","natural_expression","retry_request","follow_up"])})).min(1).max(4),
  usedLearningItemIds:z.array(z.string().max(160)).max(2).default([]),
  glossary:z.array(runtimeGlossaryEntrySchema).max(500).default([]),
});

import { z } from "zod";

export const answerInputLanguageSchema = z.enum(["zh", "en", "mixed"]);

export const createAnswerSchema = z.object({
  clientRequestId: z.string().uuid(),
  questionId: z.string().trim().min(1).max(120),
  inputLanguage: answerInputLanguageSchema,
  rawText: z.string().trim().min(1, "请先写下或说出你的回答").max(8000),
});

export const updateAnswerSchema = z.object({
  textEn: z.string().trim().min(1, "英文版本不能为空").max(8000),
  baseVersionNo: z.number().int().min(1),
});

export const processAnswerSchema = z.object({
  clientRequestId: z.string().uuid(),
  force: z.boolean().default(false),
});

export type AnswerInputLanguage = z.infer<typeof answerInputLanguageSchema>;

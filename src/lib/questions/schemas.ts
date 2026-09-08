import { z } from "zod";

const optionalId = z.string().trim().min(1).max(120).optional();

export const questionFiltersSchema = z.object({
  set: optionalId,
  part: z.coerce.number().int().min(1).max(3).optional(),
  topic: optionalId,
  status: z.enum([
    "all",
    "unanswered",
    "learning_incomplete",
    "learning_completed",
    "mastered",
    "answered",
    "has_history",
    "has_learning",
    "ready_to_learn",
    "ready_to_reattempt",
    "reattempted",
    "repeated_gaps",
  ]).default("all"),
  sortBy: z.enum(["default", "longest_unreviewed", "latest", "part"]).default("default"),
  favorite: z.enum(["0", "1"]).default("0").transform((value) => value === "1"),
  q: z.string().trim().max(120).default(""),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(12).max(48).default(24),
});

export type QuestionFilters = z.infer<typeof questionFiltersSchema>;

export const questionAttemptInputSchema = z.object({
  eventId: z.string().uuid(),
  questionId: z.string().trim().min(1).max(120),
  status: z.enum(["viewed", "started", "completed"]),
  origin: z.enum(["browse", "random", "answer"]).default("browse"),
});

export const favoriteInputSchema = z.object({
  favorite: z.boolean(),
});

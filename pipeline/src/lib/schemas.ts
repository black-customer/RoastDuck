/**
 * Content Compiler 全部数据结构的 zod Schema。
 * 所有 LLM 批次输出（Agent 填充）必须通过对应 Schema 校验才能入库。
 * Schema 版本与 CONTENT_SPEC.md / docs/DATA_MODEL.md 对应。
 */
import { z } from "zod";

/* ---------------- 通用 ---------------- */

export const UNIT_TYPES = [
  "collocation",
  "lexical_chunk",
  "phrasal_verb",
  "sentence_frame",
  "construction",
  "functional_expression",
  "idiom",
] as const;

export const DIFFICULTIES = ["basic", "intermediate", "advanced"] as const;

export const chunkIdSchema = z.string().regex(/^c_[0-9a-z]{6,16}$/, "chunk id 形如 c_<hash>");
export const questionIdSchema = z.string().regex(/^q_[0-9a-z]{6,16}$/);
export const topicIdSchema = z.string().regex(/^t\d_[0-9a-z]{4,12}$/);
export const sentenceIdSchema = z.string().regex(/^s_[0-9a-z]{6,16}$/);

/* ---------------- Blueprint 阶段 ---------------- */

export const blueprintDimensionSchema = z.object({
  dimId: z
    .string()
    .regex(/^[a-z0-9-]{2,40}$/, "dimId 为小写 kebab-case，如 year-of-study"),
  dimZh: z.string().min(1).max(30),
  dimEn: z.string().min(2).max(60),
});

export const questionBlueprintOutputSchema = z.object({
  questionId: questionIdSchema,
  dimensions: z.array(blueprintDimensionSchema).min(1).max(14),
});

/** 批级：一批多题 */
export const blueprintBatchOutputSchema = z.object({
  blueprints: z.array(questionBlueprintOutputSchema).min(1),
});

export const topicDomainsOutputSchema = z.object({
  topicId: topicIdSchema,
  domains: z
    .array(
      z.object({
        domainId: z.string().regex(/^[a-z0-9-]{2,40}$/),
        nameZh: z.string().min(1).max(30),
        nameEn: z.string().min(1).max(60),
      }),
    )
    .min(4)
    .max(20),
});

/** 批级：一批多话题 */
export const topicDomainsBatchOutputSchema = z.object({
  topics: z.array(topicDomainsOutputSchema).min(1),
});

/* ---------------- Chunk 候选阶段 ---------------- */

const dimensionRef = z.object({
  dimId: z.string(),
  dimZh: z.string(),
  dimEn: z.string(),
});

export const chunkCandidateInputUnitSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("question"),
    unitKey: z.string(),
    questionId: questionIdSchema,
    questionText: z.string(),
    part: z.number().int().min(1).max(3),
    topicNameZh: z.string().default(""),
    topicNameEn: z.string().default(""),
    dimensions: z.array(dimensionRef).min(1),
  }),
  z.object({
    kind: z.literal("topic"),
    unitKey: z.string(),
    topicId: topicIdSchema,
    topicNameZh: z.string(),
    topicNameEn: z.string(),
    domains: z
      .array(
        z.object({
          domainId: z.string(),
          nameZh: z.string(),
          nameEn: z.string(),
        }),
      )
      .min(1),
  }),
  z.object({
    kind: z.literal("sentence"),
    unitKey: z.string(),
    sentenceId: sentenceIdSchema,
    text: z.string().min(2),
    context: z.string().default(""),
  }),
]);

export const chunkCandidateItemSchema = z.object({
  unitKey: z.string(),
  /** 本单元产出的 chunk 候选；无产出时必须给 noNewUnitReason */
  chunks: z
    .array(
      z.object({
        displayChunk: z.string().min(1).max(80),
        unitType: z.enum(UNIT_TYPES),
        meaningZh: z.string().min(1).max(60),
        englishGloss: z.string().max(120).default(""),
        pattern: z.string().max(60).optional(),
        variants: z.array(z.string().max(60)).max(8).default([]),
        exampleEn: z.string().min(4).max(400),
        exampleZh: z.string().max(120).default(""),
        difficulty: z.enum(DIFFICULTIES),
        tags: z.array(z.string().max(24)).max(6).default([]),
        /** 覆盖的维度/语义域 id（question/topic 单元必填，可多个） */
        dimIds: z.array(z.string().max(40)).max(14).default([]),
      }),
    )
    .max(40),
  noNewUnitReason: z.string().max(200).optional(),
  /** 句子单元：内容已被已有 chunk 覆盖（记录 chunkId） */
  coveredBy: z.array(z.string().max(24)).max(8).optional(),
  /** 该句已由其他批次处理过（同文重复） */
  alreadyProcessed: z.boolean().optional(),
});

export const chunkCandidateBatchOutputSchema = z.object({
  items: z.array(chunkCandidateItemSchema).min(1),
});

/* ---------------- Dedup 语义裁决阶段 ---------------- */

export const dedupVerdictSchema = z.object({
  pairKey: z.string(),
  verdict: z.enum(["merge", "separate"]),
  /** verdict=merge 时保留的 chunk id */
  keepId: chunkIdSchema.optional(),
  /** verdict=merge 时被合并掉的 chunk id */
  dropId: chunkIdSchema.optional(),
  reason: z.string().min(4).max(200),
});

export const dedupBatchOutputSchema = z.object({
  verdicts: z.array(dedupVerdictSchema).min(1),
});

/* ---------------- 内容补全阶段 ---------------- */

export const contentEnrichmentItemSchema = z.object({
  chunkId: chunkIdSchema,
  englishGloss: z.string().min(4).max(120).optional(),
  exampleTranslations: z
    .array(
      z.object({
        exampleId: z.string().regex(/^ce_[0-9a-z_]{6,40}$/),
        textZh: z.string().min(1).max(300),
      }),
    )
    .default([]),
});

export const contentEnrichmentBatchOutputSchema = z.object({
  items: z.array(contentEnrichmentItemSchema).min(1),
});

export const pronunciationEnrichmentBatchOutputSchema = z.object({
  items: z
    .array(
      z.object({
        chunkId: chunkIdSchema,
        ipa: z.string().min(3).max(160),
        accent: z.string().min(2).max(24),
      }),
    )
    .min(1),
});

/* ---------------- 质检阶段 ---------------- */

export const qualityVerdictSchema = z.object({
  chunkId: chunkIdSchema,
  verdict: z.enum(["approved", "edited", "rejected"]),
  edited: z
    .object({
      displayChunk: z.string().min(1).max(80).optional(),
      meaningZh: z.string().min(1).max(60).optional(),
      englishGloss: z.string().min(1).max(120).optional(),
      difficulty: z.enum(DIFFICULTIES).optional(),
    })
    .optional(),
  exampleEdits: z
    .array(
      z.object({
        exampleId: z.string().regex(/^ce_[0-9a-z_]{6,40}$/),
        textEn: z.string().min(4).max(400).optional(),
        textZh: z.string().min(1).max(300).optional(),
      }),
    )
    .max(12)
    .optional(),
  pronunciationEdits: z
    .array(
      z.object({
        pronunciationId: z.string().min(4).max(80),
        ipa: z.string().min(3).max(160),
      }),
    )
    .max(4)
    .optional(),
  reason: z.string().max(200).default(""),
});

export const qualityBatchOutputSchema = z.object({
  reviewer: z.object({
    role: z.literal("independent_reviewer"),
    provider: z.string().min(2).max(80),
    model: z.string().min(2).max(120),
    runId: z.string().min(4).max(160),
  }),
  verdicts: z.array(qualityVerdictSchema).min(1),
});

/* ---------------- 批次信封（队列文件） ---------------- */

export const batchEnvelopeSchema = z.object({
  batchId: z.string(),
  stage: z.string(),
  promptVersion: z.string(),
  createdAt: z.string(),
  payload: z.unknown(),
});

export type BlueprintDimension = z.infer<typeof blueprintDimensionSchema>;
export type QuestionBlueprintOutput = z.infer<typeof questionBlueprintOutputSchema>;
export type TopicDomainsOutput = z.infer<typeof topicDomainsOutputSchema>;
export type ChunkCandidateItem = z.infer<typeof chunkCandidateItemSchema>;
export type ChunkCandidateBatchOutput = z.infer<typeof chunkCandidateBatchOutputSchema>;
export type DedupBatchOutput = z.infer<typeof dedupBatchOutputSchema>;
export type ContentEnrichmentBatchOutput = z.infer<typeof contentEnrichmentBatchOutputSchema>;
export type PronunciationEnrichmentBatchOutput = z.infer<typeof pronunciationEnrichmentBatchOutputSchema>;
export type QualityBatchOutput = z.infer<typeof qualityBatchOutputSchema>;

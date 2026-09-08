import { z } from "zod";

export const AGENT_WORKFLOW_VERSION = "agent-content.v1";
export const AGENT_REVIEW_PROVIDER = "codex_agent";
export const AGENT_REVIEW_MODEL = "development-agent";

export const agentStageSchema = z.enum([
  "dedup",
  "content_enrichment",
  "pronunciation_enrichment",
  "quality_review",
]);

export type AgentStage = z.infer<typeof agentStageSchema>;

export const artifactRoleSchema = z.enum(["generator", "reviewer"]);
export type ArtifactRole = z.infer<typeof artifactRoleSchema>;

export const upstreamEvidenceSchema = z.object({
  runId: z.string().min(4),
  stage: agentStageSchema,
  role: artifactRoleSchema,
  executorSessionId: z.string().min(4),
  outputSha256: z.string().regex(/^[0-9a-f]{64}$/),
  unitKeys: z.array(z.string()).min(1),
});

export const packetManifestSchema = z.object({
  workflowVersion: z.literal(AGENT_WORKFLOW_VERSION),
  batchId: z.string().min(1),
  stage: agentStageSchema,
  role: artifactRoleSchema,
  promptVersion: z.string().min(1),
  schemaVersion: z.string().min(1),
  inputSha256: z.string().regex(/^[0-9a-f]{64}$/),
  promptSha256: z.string().regex(/^[0-9a-f]{64}$/),
  preparedAt: z.string().datetime(),
  unitKeys: z.array(z.string()).min(1),
  upstreamEvidence: z.array(upstreamEvidenceSchema),
});

export const agentSubmissionSchema = z.object({
  workflowVersion: z.literal(AGENT_WORKFLOW_VERSION),
  batchId: z.string().min(1),
  stage: agentStageSchema,
  role: artifactRoleSchema,
  runId: z.string().regex(/^agent_run_[A-Za-z0-9._-]{4,120}$/),
  executor: z.object({
    kind: z.literal("codex_agent"),
    sessionId: z.string().min(4).max(160),
  }),
  inputSha256: z.string().regex(/^[0-9a-f]{64}$/),
  promptVersion: z.string().min(1),
  promptSha256: z.string().regex(/^[0-9a-f]{64}$/),
  schemaVersion: z.string().min(1),
  attestation: z.object({
    /** 明确证明开发期产物没有消耗 Product Owner 的 Runtime API。 */
    noExternalRuntimeApi: z.literal(true),
    /** Reviewer 必须在未继承 Generator 对话的独立上下文中完成。 */
    independentContext: z.boolean(),
  }),
  createdAt: z.string().datetime(),
  output: z.unknown(),
});

export const agentCheckpointSchema = z.object({
  workflowVersion: z.literal(AGENT_WORKFLOW_VERSION),
  runId: z.string(),
  batchId: z.string(),
  stage: agentStageSchema,
  role: artifactRoleSchema,
  executorSessionId: z.string(),
  inputSha256: z.string().regex(/^[0-9a-f]{64}$/),
  outputSha256: z.string().regex(/^[0-9a-f]{64}$/),
  promptVersion: z.string(),
  promptSha256: z.string().regex(/^[0-9a-f]{64}$/),
  schemaVersion: z.string(),
  unitKeys: z.array(z.string()).min(1),
  upstreamRunIds: z.array(z.string()),
  status: z.enum(["validated", "applied", "rejected"]),
  reason: z.string().default(""),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type PacketManifest = z.infer<typeof packetManifestSchema>;
export type AgentSubmission = z.infer<typeof agentSubmissionSchema>;
export type AgentCheckpoint = z.infer<typeof agentCheckpointSchema>;


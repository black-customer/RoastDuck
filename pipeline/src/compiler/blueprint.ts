/**
 * blueprint 阶段：题目 → Answer Dimensions（LLM 批次队列）。
 * questions.status: pending → blueprint_done
 */
import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { getDbReady } from "../../../db/client";
import { questions } from "../../../db/schema";
import { blueprintBatchOutputSchema } from "../lib/schemas";
import {
  applyBatches,
  createBatches,
  listPendingBatches,
  type BatchFile,
} from "../lib/queue";

export const BLUEPRINT_PROMPT_VERSION = "blueprint-v1";

interface BlueprintInput {
  unitKey: string;
  questionId: string;
  questionText: string;
  part: number;
}

export async function blueprintCreate(maxBatches = 50): Promise<number> {
  const db = await getDbReady();
  const rows = await db
    .select({ id: questions.id, text: questions.text, part: questions.part })
    .from(questions)
    .where(eq(questions.status, "pending"));
  const units: BlueprintInput[] = rows.map((r) => ({
    unitKey: r.id,
    questionId: r.id,
    questionText: r.text,
    part: r.part,
  }));
  return createBatches<BlueprintInput, unknown>({
    stage: "blueprint",
    promptVersion: BLUEPRINT_PROMPT_VERSION,
    units,
    batchSize: 12,
    maxBatches,
    getUnitKey: (u) => u.unitKey,
  });
}

export async function blueprintApply(): Promise<{ applied: number; rejected: number; pending: number }> {
  const db = await getDbReady();
  return applyBatches<BlueprintInput, z.infer<typeof blueprintBatchOutputSchema>>({
    stage: "blueprint",
    outputSchema: blueprintBatchOutputSchema,
    crossCheck: async (batch, output) => {
      const inputIds = new Set(batch.inputs.map((i) => i.questionId));
      for (const bp of output.blueprints) {
        if (!inputIds.has(bp.questionId)) return `output.questionId ${bp.questionId} 不在本批输入中`;
      }
      const missing = [...inputIds].filter((id) => !output.blueprints.some((bp) => bp.questionId === id));
      if (missing.length) return `缺少题目的蓝图: ${missing.join(",")}`;
      return null;
    },
    apply: async (_batch, output) => {
      for (const bp of output.blueprints) {
        await db
          .update(questions)
          .set({ blueprintJson: JSON.stringify(bp.dimensions), status: "blueprint_done" })
          .where(eq(questions.id, bp.questionId));
      }
    },
  });
}

/** 队列中待处理的题目（供状态展示）。 */
export async function blueprintPendingInQueue(): Promise<number> {
  const batches = await listPendingBatches<BlueprintInput, unknown>("blueprint");
  return batches.filter((b) => b.output == null).reduce((n, b) => n + b.inputs.length, 0);
}

export async function questionsWithBlueprint(ids: string[]) {
  const db = await getDbReady();
  return db.select().from(questions).where(inArray(questions.id, ids));
}

export type { BatchFile };

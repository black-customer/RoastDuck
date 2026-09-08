/**
 * topic_domains 阶段：话题 → 语义域（LLM 批次队列）。
 * topics.status: pending → domains_done
 */
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { getDbReady } from "../../../db/client";
import { questions, topics } from "../../../db/schema";
import { topicDomainsBatchOutputSchema } from "../lib/schemas";
import { applyBatches, createBatches } from "../lib/queue";

export const TOPIC_DOMAINS_PROMPT_VERSION = "topic_domains-v1";

interface TopicInput {
  unitKey: string;
  topicId: string;
  topicNameEn: string;
  topicNameZh: string;
  part: number;
  sampleQuestions: string[];
}

export async function topicDomainsCreate(maxBatches = 50): Promise<number> {
  const db = await getDbReady();
  const rows = await db.select().from(topics).where(eq(topics.status, "pending"));
  const units: TopicInput[] = [];
  for (const t of rows) {
    const samples = await db
      .select({ text: questions.text })
      .from(questions)
      .where(eq(questions.topicId, t.id))
      .orderBy(sql`RANDOM()`)
      .limit(5);
    units.push({
      unitKey: t.id,
      topicId: t.id,
      topicNameEn: t.nameEn,
      topicNameZh: t.nameZh,
      part: t.ieltsPart ?? 1,
      sampleQuestions: samples.map((s) => s.text.split("\n")[0]),
    });
  }
  return createBatches<TopicInput, unknown>({
    stage: "topic_domains",
    promptVersion: TOPIC_DOMAINS_PROMPT_VERSION,
    units,
    batchSize: 4,
    maxBatches,
    getUnitKey: (u) => u.unitKey,
  });
}

export async function topicDomainsApply(): Promise<{ applied: number; rejected: number; pending: number }> {
  const db = await getDbReady();
  return applyBatches<TopicInput, z.infer<typeof topicDomainsBatchOutputSchema>>({
    stage: "topic_domains",
    outputSchema: topicDomainsBatchOutputSchema,
    crossCheck: async (batch, output) => {
      const inputIds = new Set(batch.inputs.map((i) => i.topicId));
      for (const t of output.topics) {
        if (!inputIds.has(t.topicId)) return `output.topicId ${t.topicId} 不在本批输入中`;
      }
      const missing = [...inputIds].filter((id) => !output.topics.some((t) => t.topicId === id));
      if (missing.length) return `缺少话题的域: ${missing.join(",")}`;
      return null;
    },
    apply: async (_batch, output) => {
      for (const t of output.topics) {
        await db
          .update(topics)
          .set({ domainsJson: JSON.stringify(t.domains), status: "domains_done" })
          .where(eq(topics.id, t.topicId));
      }
    },
  });
}

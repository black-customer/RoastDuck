/**
 * sync_sentence_batches：把 DB 中已有状态的句子直接产出批次 output；
 * 全部已知的批次 → 写 output；部分未知的 → 输出 todo 清单供人工补判。
 */
import fs from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import { getDbReady } from "../../../db/client";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const QUEUE = path.join(ROOT, "pipeline/queue/chunk_candidate/pending");

export async function syncSentenceBatches() {
  const db = await getDbReady();
  const files = fs.readdirSync(QUEUE).filter((f) => f.endsWith(".json"));
  let synced = 0;
  const todos: Array<{ batchId: string; pending: Array<{ sid: string; text: string }> }> = [];
  for (const file of files) {
    const f = path.join(QUEUE, file);
    const batch = JSON.parse(fs.readFileSync(f, "utf-8"));
    if (batch.output || batch.inputs[0].kind !== "sentence") continue;
    const items: Array<Record<string, unknown>> = [];
    const pendingUnits: Array<{ sid: string; text: string }> = [];
    for (const unit of batch.inputs as Array<{ unitKey: string; sentenceId: string; text: string }>) {
      const row = (
        await db.all<{ status: string; no_new_unit_reason: string | null }>(sql`
          SELECT status, no_new_unit_reason FROM source_sentences WHERE id = ${unit.sentenceId} LIMIT 1`)
      )[0];
      if (!row || row.status === "pending") {
        pendingUnits.push({ sid: unit.sentenceId, text: unit.text });
        continue;
      }
      if (row.status === "chunked") {
        // 该句已由其他批次产生 chunk → 标记已处理
        items.push({ unitKey: unit.unitKey, chunks: [], alreadyProcessed: true });
      } else if (row.status === "covered") {
        items.push({ unitKey: unit.unitKey, chunks: [], coveredBy: [], alreadyProcessed: true });
      } else {
        items.push({ unitKey: unit.unitKey, chunks: [], noNewUnitReason: row.no_new_unit_reason ?? "重复判定" });
      }
    }
    if (items.length > 0) {
      batch.output = { items };
      fs.writeFileSync(f, JSON.stringify(batch, null, 1), "utf-8");
      synced++;
    }
    if (pendingUnits.length > 0) {
      todos.push({ batchId: batch.batchId, pending: pendingUnits });
    }
  }
  fs.writeFileSync(path.join(ROOT, "pipeline/reports/sentence-todos.json"), JSON.stringify(todos, null, 1), "utf-8");
  console.log(`synced=${synced}, 待人工批次=${todos.length}, 剩余待判句=${todos.reduce((n, t) => n + t.pending.length, 0)}`);
}

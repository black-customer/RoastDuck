/**
 * 批次队列引擎：确定性脚本与 LLM（Agent 填充）解耦的核心机制。
 *
 * 流程：
 *  1. createBatches：扫描待处理单元 → 生成 pipeline/queue/<stage>/pending/batch-xxx.json
 *     文件内含 inputs 与空 output；Agent 会话内按 prompt + zod Schema 填 output 字段。
 *  2. applyBatches：读取 pending 中已填 output 的批次 → zod + 交叉校验 → 应用入库 →
 *     文件移入 done/；校验失败 → 移入 rejected/ 并附 reason，自动重建批次。
 *
 * 批次文件随 git 提交 → 任意会话可断点续跑、可审计。
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { withDbTransaction } from '../../../db/client';

const ROOT = path.resolve(import.meta.dirname, "../../.."); // pipeline/src/lib → 项目根
export const QUEUE_DIR = process.env.ROASTDUCK_QUEUE_DIR
  ? path.resolve(process.env.ROASTDUCK_QUEUE_DIR)
  : path.join(ROOT, "pipeline/queue");

export interface BatchFile<TInput, TOutput> {
  batchId: string;
  stage: string;
  promptVersion: string;
  createdAt: string;
  inputs: TInput[];
  /** Agent 填充；为 null/undefined 表示待处理 */
  output: TOutput | null;
  /** 重建次数（校验失败 +1） */
  attempts?: number;
}

export type StageName =
  | "blueprint"
  | "topic_domains"
  | "chunk_candidate"
  | "dedup"
  | "content_enrichment"
  | "pronunciation_enrichment"
  | "quality_review";

function stageDir(stage: StageName, sub: "pending" | "done" | "rejected"): string {
  const dir = path.join(QUEUE_DIR, stage, sub);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function batchPath(stage: StageName, batchId: string, sub: "pending" | "done" | "rejected"): string {
  return path.join(stageDir(stage, sub), `${batchId}.json`);
}

/** 读取某阶段 pending 批次（未填或已填）。 */
export function listPendingBatches<TInput, TOutput>(stage: StageName): Array<BatchFile<TInput, TOutput>> {
  const dir = stageDir(stage, "pending");
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8")) as BatchFile<TInput, TOutput>)
    .sort((a, b) => a.batchId.localeCompare(b.batchId));
}

export function writeBatch<TInput, TOutput>(batch: BatchFile<TInput, TOutput>): void {
  const file = batchPath(batch.stage as StageName, batch.batchId, "pending");
  fs.writeFileSync(file, JSON.stringify(batch, null, 1), "utf-8");
}

export function moveBatch<TInput, TOutput>(
  batch: BatchFile<TInput, TOutput>,
  to: "done" | "rejected",
  reason?: string,
): void {
  const from = batchPath(batch.stage as StageName, batch.batchId, "pending");
  const dest = batchPath(batch.stage as StageName, batch.batchId, to);
  fs.renameSync(from, dest);
  if (reason) {
    fs.writeFileSync(dest.replace(/\.json$/, ".reason.txt"), reason, "utf-8");
  }
}

let batchCounter = 0;
function stableInput(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableInput).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableInput(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
export function makeBatchId(stage: string): string {
  if (!stage.trim()) throw new Error("批次 stage 不能为空");
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  batchCounter += 1;
  return `batch-${stamp}-${String(Date.now() % 100000).padStart(5, "0")}-${batchCounter}`;
}

/**
 * 批次生成器：把单元列表切成批次文件（跳过已存在的 unitKey）。
 */
export function createBatches<TInput extends { unitKey?: string }, TOutput>(opts: {
  stage: StageName;
  promptVersion: string;
  units: TInput[];
  batchSize: number;
  maxBatches: number;
  getUnitKey: (u: TInput) => string;
}): number {
  const { stage, promptVersion, units, batchSize, maxBatches, getUnitKey } = opts;
  // 同一逻辑单元在内容或 Prompt 改变后必须重新处理；旧批次留作审计。
  const fingerprint = (unit: TInput, version: string) => createHash("sha256")
    .update(stableInput([stage, version, getUnitKey(unit), unit])).digest("hex");
  const inFlight = new Set<string>();
  for (const b of listPendingBatches<TInput, TOutput>(stage)) {
    for (const u of b.inputs) inFlight.add(fingerprint(u, b.promptVersion));
  }
  const doneDir = stageDir(stage, "done");
  if (fs.existsSync(doneDir)) {
    for (const f of fs.readdirSync(doneDir).filter((x) => x.endsWith(".json"))) {
      const b = JSON.parse(fs.readFileSync(path.join(doneDir, f), "utf-8")) as BatchFile<TInput, TOutput>;
      if (b.output != null) for (const u of b.inputs) inFlight.add(fingerprint(u, b.promptVersion));
    }
  }

  const fresh = units.filter((u) => {
    const key = fingerprint(u, promptVersion);
    if (inFlight.has(key)) return false;
    inFlight.add(key);
    return true;
  });
  let created = 0;
  for (let i = 0; i < fresh.length && created < maxBatches; i += batchSize) {
    const chunkUnits = fresh.slice(i, i + batchSize);
    const batch: BatchFile<TInput, TOutput> = {
      batchId: makeBatchId(stage),
      stage,
      promptVersion,
      createdAt: new Date().toISOString(),
      inputs: chunkUnits,
      output: null,
      attempts: 0,
    };
    writeBatch(batch);
    created++;
  }
  return created;
}

/**
 * 应用已填 output 的批次：validate → apply → 归档。
 * 返回 (applied, rejected) 数量。
 */
export async function applyBatches<TInput, TOutput>(opts: {
  stage: StageName;
  outputSchema: z.ZodType<TOutput>;
  crossCheck: (batch: BatchFile<TInput, TOutput>, output: TOutput) => Promise<string | null>;
  apply: (batch: BatchFile<TInput, TOutput>, output: TOutput) => Promise<void>;
  maxApply?: number;
  /** 只应用指定批次。离线 Agent 导入借此避免顺带消费其他人的已填产物。 */
  batchIds?: ReadonlySet<string>;
  transactional?: boolean;
}): Promise<{ applied: number; rejected: number; pending: number }> {
  const { stage, outputSchema, crossCheck, apply, maxApply = 100, batchIds } = opts;
  const batches = listPendingBatches<TInput, TOutput>(stage).filter(
    (batch) => !batchIds || batchIds.has(batch.batchId),
  );
  let applied = 0;
  let rejected = 0;
  for (const batch of batches) {
    if (applied + rejected >= maxApply) break;
    if (batch.output == null) continue;
    const parsed = outputSchema.safeParse(batch.output);
    if (!parsed.success) {
      const reason = `Schema 校验失败: ${parsed.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`;
      moveBatch(batch, "rejected", reason);
      rejected++;
      continue;
    }
    const checkAndApply = async () => {
      const error = await crossCheck(batch, parsed.data);
      if (!error) await apply(batch, parsed.data);
      return error;
    };
    const crossErr = opts.transactional ? await withDbTransaction(checkAndApply) : await checkAndApply();
    if (crossErr) {
      moveBatch(batch, "rejected", crossErr);
      rejected++;
      continue;
    }
    moveBatch(batch, "done");
    applied++;
  }
  const pending = listPendingBatches(stage).length;
  return { applied, rejected, pending };
}

/** 队列状态汇总（status 页/命令用）。 */
export function queueStatus(): Record<string, { pending: number; done: number; rejected: number }> {
  const out: Record<string, { pending: number; done: number; rejected: number }> = {};
  if (!fs.existsSync(QUEUE_DIR)) return out;
  for (const stage of fs.readdirSync(QUEUE_DIR)) {
    const counts = { pending: 0, done: 0, rejected: 0 };
    for (const sub of ["pending", "done", "rejected"] as const) {
      const dir = path.join(QUEUE_DIR, stage, sub);
      if (fs.existsSync(dir)) {
        counts[sub] = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).length;
      }
    }
    out[stage] = counts;
  }
  return out;
}

/**
 * autofill_questions：用「维度语块库 + 话题池」确定性装配 question 批次输出。
 * - 每个维度：dimToClass 匹配 → CLASS_CHUNKS；未匹配的维度查 TOPIC_POOLS（dimHints）。
 * - 选择带 hash 轮转，避免所有题目产出完全相同。
 * - 未覆盖的维度会记录到报告（pipeline/reports/autofill-gaps.json）。
 * 生成结果仍是批次文件（output 字段），走同一 zod 校验入库 —— 可审计、可重放。
 */
import fs from "node:fs";
import path from "node:path";
import { sha1Like } from "../lib/text";
import type { PoolChunk } from "../lib/topic_pools";
import { CLASS_CHUNKS, dimToClass } from "../lib/dimlib";
import { TOPIC_POOLS } from "../lib/topic_pools";
import { TOPIC_POOLS_2 } from "../lib/topic_pools2";
import { TOPIC_POOLS_3 } from "../lib/topic_pools3";
import { TOPIC_POOLS_4 } from "../lib/topic_pools4";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const QUEUE = path.join(ROOT, "pipeline/queue/chunk_candidate/pending");
const REPORTS = path.join(ROOT, "pipeline/reports");

interface Unit {
  unitKey: string;
  kind: string;
  questionId?: string;
  questionText?: string;
  topicNameZh?: string;
  topicNameEn?: string;
  dimensions?: Array<{ dimId: string; dimZh: string; dimEn: string }>;
}

function pick<T>(arr: T[], seed: string, offset = 0): T {
  const h = parseInt(sha1Like(seed).slice(0, 6), 36);
  return arr[(h + offset) % arr.length];
}

function normTopic(s: string): string {
  return s.replace(/[!､+*\[\]\s*／/；;，,]/g, "");
}

function commonPrefixLen(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

function findPool(topicZh: string, topicEn: string): PoolChunk[] | null {
  const keys = [topicZh, topicEn].filter(Boolean);
  const merged: PoolChunk[] = [];
  const seen = new Set<PoolChunk[]>();
  for (const k of keys) {
    const nk = normTopic(k);
    for (const [name, pool] of [...Object.entries(TOPIC_POOLS), ...Object.entries(TOPIC_POOLS_2), ...Object.entries(TOPIC_POOLS_3), ...Object.entries(TOPIC_POOLS_4)]) {
      const nn = normTopic(name);
      const score = Math.max(commonPrefixLen(nk, nn), commonPrefixLen(nn.split("").reverse().join(""), nk.split("").reverse().join("")));
      if (score >= 2 && !seen.has(pool)) {
        seen.add(pool);
        merged.push(...pool);
      }
    }
  }
  if (merged.length === 0 && TOPIC_POOLS_4["收尾"]) merged.push(...TOPIC_POOLS_4["收尾"]);
  return merged.length ? merged : null;
}

export function autofillQuestionBatches(opts: { dryRun?: boolean } = {}): void {
  const files = fs
    .readdirSync(QUEUE)
    .filter((f) => f.endsWith(".json"))
    .sort();
  const gaps: Record<string, { question: string; topic: string; dims: string[] }> = {};
  let filled = 0;
  const allTopicGaps: string[] = [];

  for (const file of files) {
    const f = path.join(QUEUE, file);
    const batch = JSON.parse(fs.readFileSync(f, "utf-8"));
    if (batch.output) continue;
    if (batch.inputs[0].kind === "sentence") continue;

    const items = batch.inputs.map((unit: Unit) => {
      const chunks: Array<Record<string, unknown>> = [];
      const coveredDims = new Set<string>();
      for (const dim of unit.dimensions ?? []) {
        if (coveredDims.has(dim.dimId)) continue;
        const pool = findPool(unit.topicNameZh ?? "", unit.topicNameEn ?? "");
        const poolHits = pool ? pool.filter((pc) => pc.dims.includes(dim.dimId)) : [];
        if (poolHits.length > 0) {
          for (const pc of poolHits) {
            chunks.push({
              displayChunk: pc.display,
              unitType: pc.unitType,
              meaningZh: pc.meaningZh,
              englishGloss: "",
              variants: [],
              exampleEn: pc.exampleEn,
              exampleZh: pc.exampleZh ?? "",
              difficulty: pc.difficulty,
              tags: [],
              dimIds: [dim.dimId],
            });
          }
          coveredDims.add(dim.dimId);
          continue;
        }
        const cls = dimToClass(dim.dimId);
        if (!cls) {
          const qid = unit.questionId ?? "";
          gaps[qid] = gaps[qid] ?? {
            question: (unit.questionText ?? "").slice(0, 60),
            topic: unit.topicNameZh ?? "",
            dims: [],
          };
          gaps[qid].dims.push(`${dim.dimId}(${dim.dimZh})`);
          continue;
        }
        const lib = CLASS_CHUNKS[cls];
        // 每个维度取 1-2 条（按 hash 轮转，保证跨题有变化）
        const n = Math.min(lib.length, 2);
        for (let k = 0; k < n; k++) {
          const c = pick(lib, unit.unitKey + dim.dimId, k);
          chunks.push({
            displayChunk: c.display,
            unitType: c.unitType,
            meaningZh: c.meaningZh,
            englishGloss: "",
            variants: c.variants ?? [],
            exampleEn: c.exampleEn,
            exampleZh: c.exampleZh ?? "",
            difficulty: c.difficulty,
            tags: [],
            dimIds: [dim.dimId],
          });
        }
        coveredDims.add(dim.dimId);
      }
      return { unitKey: unit.unitKey.split("|").pop(), chunks };
    });

    // ---- topic 批 ----
    if (batch.inputs[0].kind === "topic") {
      items.length = 0;
      const fallbackPool = TOPIC_POOLS_4["收尾"] ?? [];
      for (const unit of batch.inputs as Array<{
        unitKey: string;
        topicId: string;
        topicNameZh?: string;
        topicNameEn?: string;
        domains: Array<{ domainId: string; nameZh: string; nameEn: string }>;
      }>) {
        const chunks: Array<Record<string, unknown>> = [];
        for (const domain of unit.domains) {
          const cls = dimToClass(`${domain.domainId} ${domain.nameZh} ${domain.nameEn}`);
          if (!cls) {
            const pool = findPool(unit.topicNameZh ?? "", unit.topicNameEn ?? "");
            const hits = pool ? pool.filter((pc) => pc.dims.includes(domain.domainId)) : [];
            for (const pc of hits) {
              chunks.push({
                displayChunk: pc.display, unitType: pc.unitType, meaningZh: pc.meaningZh,
                englishGloss: "", variants: [], exampleEn: pc.exampleEn, exampleZh: pc.exampleZh ?? "",
                difficulty: pc.difficulty, tags: [], dimIds: [domain.domainId],
              });
            }
            continue;
          }
          const lib = CLASS_CHUNKS[cls];
          const n = Math.min(lib.length, 2);
          for (let k = 0; k < n; k++) {
            const c = pick(lib, unit.unitKey + domain.domainId, k);
            chunks.push({
              displayChunk: c.display, unitType: c.unitType, meaningZh: c.meaningZh,
              englishGloss: "", variants: c.variants ?? [], exampleEn: c.exampleEn,
              exampleZh: c.exampleZh ?? "", difficulty: c.difficulty, tags: [], dimIds: [domain.domainId],
            });
          }
        }
        if (chunks.length === 0) {
          // 兜底：话题单元保底 2 条通用表达（审计仍会报告未覆盖域）
          for (const pc of fallbackPool.slice(0, 2)) {
            chunks.push({
              displayChunk: pc.display, unitType: pc.unitType, meaningZh: pc.meaningZh,
              englishGloss: "", variants: [], exampleEn: pc.exampleEn, exampleZh: pc.exampleZh ?? "",
              difficulty: pc.difficulty, tags: [], dimIds: [],
            });
          }
        }
        items.push({ unitKey: unit.unitKey.split("|").pop(), chunks });
      }
      batch.output = { items };
      if (!opts.dryRun) fs.writeFileSync(f, JSON.stringify(batch, null, 1), "utf-8");
      filled++;
      continue;
    }

    batch.output = { items };
    if (!opts.dryRun) {
      fs.writeFileSync(f, JSON.stringify(batch, null, 1), "utf-8");
    }
    filled++;
  }

  fs.mkdirSync(REPORTS, { recursive: true });
  fs.writeFileSync(
    path.join(REPORTS, "autofill-gaps.json"),
    JSON.stringify(gaps, null, 1),
    "utf-8",
  );
  fs.writeFileSync(
    path.join(REPORTS, "autofill-topic-gaps.json"),
    JSON.stringify([...new Set(allTopicGaps)], null, 1),
    "utf-8",
  );
  console.log(`autofill: ${filled} 批已生成；需要人工补特定维度的题目 ${Object.keys(gaps).length} 个`);
}

if (process.argv[1] && process.argv[1].endsWith("autofill_questions.ts")) {
  autofillQuestionBatches({ dryRun: process.argv.includes("--dry") });
}

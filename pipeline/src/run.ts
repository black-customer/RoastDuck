/**
 * 流水线运行器（Content Compiler 总控）。
 * 用法：
 *   npm run pipeline:run            # 推进所有确定性阶段 + 处理已填批次 + 生成新批次
 *   npm run pipeline:run -- audit   # 只跑覆盖审计
 *   npm run pipeline:run -- compile # 编译 Book 1（审计通过才行）
 *
 * Agent 填充循环：
 *   1. npm run pipeline:run        → 生成 queue/<stage>/pending/batch-xxx.json
 *   2. Agent 按 pipeline/prompts/<stage>.md 填每个批次的 output 字段
 *   3. npm run pipeline:run        → 校验入库、归档、生成后续批次
 */
import { extractAll } from "./stages/extract_content";
import { parseAllBooks } from "./stages/parse_questions";
import { importDb } from "./stages/import_db";
import { queueStatus } from "./lib/queue";
import { blueprintApply, blueprintCreate } from "./compiler/blueprint";
import { topicDomainsApply, topicDomainsCreate } from "./compiler/topic_domains";
import { chunkCandidateApply, chunkCandidateCreate } from "./compiler/chunk_candidate";
import { dedupDeterministic, dedupPairsApply, dedupPairsCreate } from "./compiler/dedup";
import { contentEnrichmentApply, contentEnrichmentCreate } from "./compiler/content_enrichment";
import {
  pronunciationEnrichmentApply,
  pronunciationEnrichmentCreate,
} from "./compiler/pronunciation_enrichment";
import { qualityApply, qualityCreate } from "./compiler/quality_review";
import { runAudit } from "./compiler/audit";
import { compileBook1 } from "./compiler/compile_book";
import { repairContent } from "./stages/repair_content";

async function reportQueue() {
  const q = queueStatus();
  console.log("\n== 队列状态 ==");
  for (const [stage, c] of Object.entries(q)) {
    console.log(`  ${stage}: pending=${c.pending} done=${c.done} rejected=${c.rejected}`);
  }
}

async function main() {
  const stage = process.argv[2];
  console.log("== 鱼块学英语 Content Compiler ==");

  if (stage === "audit") {
    const r = await runAudit();
    console.log(JSON.stringify(r, null, 1).slice(0, 3000));
    if (!r.ok) throw new Error(`内容发布审计未通过：${r.violations.length} 项违规`);
    return;
  }
  if (stage === "compile") {
    const r = await compileBook1();
    console.log(r.ok ? "编译成功" : "编译被拒：内容发布审计未通过");
    if (!r.ok) throw new Error("内容发布闸门拒绝编译 Book 1");
    return;
  }
  if (stage === "repair") {
    await repairContent();
    return;
  }

  // 确定性 Source 层
  if (!stage || stage === "extract") {
    console.log("\n[extract] PDF 行 → 书籍结构");
    extractAll();
  }
  if (!stage || stage === "parse") {
    console.log("\n[parse] 合并去重 → 统一题目清单");
    parseAllBooks();
  }
  if (!stage || stage === "import") {
    console.log("\n[import] 写入 SQLite");
    await importDb();
  }

  // LLM 批次阶段
  if (!stage || stage === "llm") {
    console.log("\n[llm] 应用已填批次 → 生成新批次");
    const b1 = await blueprintApply();
    console.log(`  blueprint: applied=${b1.applied} rejected=${b1.rejected} pendingBatches=${b1.pending}`);
    if (b1.applied + b1.rejected > 0 || b1.pending === 0) {
      const created = await blueprintCreate(40);
      if (created) console.log(`  blueprint: 新建 ${created} 批（每批 12 题）`);
    }

    const t1 = await topicDomainsApply();
    console.log(`  topic_domains: applied=${t1.applied} rejected=${t1.rejected} pendingBatches=${t1.pending}`);
    if (t1.applied + t1.rejected > 0 || t1.pending === 0) {
      const created = await topicDomainsCreate(30);
      if (created) console.log(`  topic_domains: 新建 ${created} 批（每批 4 题）`);
    }

    const c1 = await chunkCandidateApply();
    console.log(`  chunk_candidate: applied=${c1.applied} rejected=${c1.rejected} pendingBatches=${c1.pending}`);
    if (c1.applied + c1.rejected > 0 || c1.pending === 0) {
      const q = await chunkCandidateCreate({ questions: true, maxBatches: 20 });
      if (q) console.log(`  chunk_candidate(question): 新建 ${q} 批（每批 6 题）`);
      const t = await chunkCandidateCreate({ topics: true, maxBatches: 20 });
      if (t) console.log(`  chunk_candidate(topic): 新建 ${t} 批（每批 2 题）`);
      const s = await chunkCandidateCreate({ sentences: true, maxBatches: 15 });
      if (s) console.log(`  chunk_candidate(sentence): 新建 ${s} 批（每批 40 句）`);
    }

    const merged = await dedupDeterministic();
    if (merged) console.log(`  dedup 确定性合并: ${merged} 条`);
    const d1 = await dedupPairsApply();
    console.log(`  dedup 语义裁决: applied=${d1.applied} rejected=${d1.rejected} pendingBatches=${d1.pending}`);
    if (d1.applied + d1.rejected > 0 || d1.pending === 0) {
      const created = await dedupPairsCreate(15);
      if (created) console.log(`  dedup: 新建 ${created} 批（每批 12 对）`);
    }

    const e1 = await contentEnrichmentApply();
    console.log(
      `  content_enrichment: applied=${e1.applied} rejected=${e1.rejected} pendingBatches=${e1.pending}`,
    );
    const enrichmentCreated = await contentEnrichmentCreate(30);
    if (enrichmentCreated) console.log(`  content_enrichment: 新建 ${enrichmentCreated} 批（每批 10 条）`);

    const p1 = await pronunciationEnrichmentApply();
    console.log(
      `  pronunciation_enrichment: applied=${p1.applied} rejected=${p1.rejected} pendingBatches=${p1.pending}`,
    );
    const pronunciationCreated = await pronunciationEnrichmentCreate(20);
    if (pronunciationCreated) {
      console.log(`  pronunciation_enrichment: 新建 ${pronunciationCreated} 批（每批 10 条）`);
    }

    const q1 = await qualityApply();
    console.log(`  quality_review: applied=${q1.applied} rejected=${q1.rejected} pendingBatches=${q1.pending}`);
    const qualityCreated = await qualityCreate(30);
    if (qualityCreated) console.log(`  quality_review: 新建 ${qualityCreated} 批（每批 14 条）`);

    await reportQueue();
    return;
  }

  console.log("\n完成。下一步：npm run pipeline:status / audit / compile");
}

main()
  .then(() => undefined)
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });

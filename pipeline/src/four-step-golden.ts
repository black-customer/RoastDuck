import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { z } from "zod";
import { buildTasks, findTargetSpan, judgeSchema, normalizeExpression } from "../../src/lib/four-step/contracts";
import { runSelectionGolden } from "../golden/material-selection-v2";

const dataset = z.object({
  version: z.string(), privacy: z.string(),
  normalization: z.array(z.object({ id: z.string(), a: z.string(), b: z.string(), equal: z.boolean() })),
  spans: z.array(z.object({ id: z.string(), text: z.string(), targets: z.array(z.string()), surface: z.string().nullable() })),
});
export function runFourStepGolden() {
  const source = dataset.parse(JSON.parse(fs.readFileSync(path.resolve("pipeline/golden/four-step.json"), "utf8")));
  const results: Array<{ id: string; ok: boolean; error?: string }> = [];
  function check(id: string, work: () => void) {
    try { work(); results.push({ id, ok: true }); }
    catch (error) { results.push({ id, ok: false, error: error instanceof Error ? error.message : "失败" }); }
  }
  for (const item of source.normalization) check(item.id, () => assert.equal(normalizeExpression(item.a) === normalizeExpression(item.b), item.equal));
  for (const item of source.spans) check(item.id, () => assert.equal(findTargetSpan(item.text, item.targets)?.surface ?? null, item.surface));
  const rows = [
    { chineseChunk: "保持联系", englishChunk: "keep in touch", acceptableVariants: [], yourChineseSentence: "搬家之后我们通过电话保持联系。", naturalEnglishSentence: "We keep in touch by phone after moving away." },
    { chineseChunk: "搬走", englishChunk: "moving away", acceptableVariants: [], yourChineseSentence: "搬家之后我们通过电话保持联系。", naturalEnglishSentence: "We keep in touch by phone after moving away." },
  ];
  check("fixed-four-steps-and-sentence-dedup", () => assert.deepEqual(buildTasks(rows, rows[0].naturalEnglishSentence, "") .map((step) => step.length), [2, 1, 2, 1]));
  check("repeated-target-masked", () => {
    const tasks = buildTasks(rows.slice(0,1), "We keep in touch. We keep in touch by phone.", "");
    assert.ok(!tasks[2][0].after?.includes("keep in touch"));
  });
  check("no-reliable-cloze-no-fabrication", () => assert.equal(buildTasks(rows, "A wholly different sentence.", "")[2].length, 0));
  check("cloze-variants-require-context-judge", () => {
    const row = { ...rows[0], acceptableVariants: ["keeps in touch"] };
    assert.deepEqual(buildTasks([row], row.naturalEnglishSentence, "")[2][0].variants, []);
  });
  check("judge-passed-false-cannot-forge-verdict", () => assert.equal(judgeSchema.safeParse({ passed: false }).success, false));
  check("uncertain-is-not-correct", () => assert.equal(judgeSchema.parse({ verdict: "uncertain", meaningPreserved: false, feedbackZh: "不能确定" }).verdict, "uncertain"));
  results.push(...runSelectionGolden());
  return { version: source.version, type: "deterministic-contract-regression", checked: results.length, ok: results.every((r) => r.ok), retiredBookGolden: { status: "not_applicable", executed: 0 }, results };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = runFourStepGolden();
  const directory = path.resolve(process.env.ROASTDUCK_REPORTS_DIR || "test-results/four-step-golden");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "golden-latest.json"), JSON.stringify(report, null, 2));
  console.log(`当前四步 Golden：实际执行 ${report.checked} 个样本，失败 ${report.results.filter((r) => !r.ok).length}；退役词书样本执行 0。`);
  if (!report.ok) process.exitCode = 1;
}

/** 生成可机读的 Golden + 内容发布审计总报告。 */
import { runGolden } from "./golden";
import { runAudit } from "./compiler/audit";

const golden = await runGolden();
const audit = await runAudit();
const report = {
  ok: golden.ok && audit.ok,
  generatedAt: new Date().toISOString(),
  golden,
  audit,
};
console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exitCode = 1;

import { safeErrorSummary } from "@/lib/ai/errors";
import { agentStageSchema } from "@pipeline/src/agent/contracts";
import {
  agentWorkflowStatus,
  importAgentSubmission,
  prepareAgentPackets,
  runAgentCoverageAudit,
  validateAgentSubmission,
} from "@pipeline/src/agent/workflow";

function valueAfter(args: string[], name: string): string | undefined {
  const inline = args.find((value) => value.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function required(args: string[], name: string): string {
  const value = valueAfter(args, name);
  if (!value) throw new Error(`缺少 ${name}`);
  return value;
}

const args = process.argv.slice(2);
const command = args[0] ?? "status";

try {
  if (command === "prepare") {
    const stage = agentStageSchema.parse(required(args, "--stage"));
    const rawLimit = valueAfter(args, "--limit") ?? "20";
    const limit = Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("--limit 必须是 1–500 的整数");
    console.log(JSON.stringify(prepareAgentPackets({
      stage,
      limit,
      batchId: valueAfter(args, "--batch"),
    }), null, 2));
  } else if (command === "validate") {
    const validated = validateAgentSubmission(required(args, "--file"));
    console.log(JSON.stringify({
      ok: true,
      stage: validated.submission.stage,
      batchId: validated.submission.batchId,
      runId: validated.submission.runId,
      outputSha256: validated.outputSha256,
      networkCalls: 0,
    }, null, 2));
  } else if (command === "import") {
    const checkpoint = await importAgentSubmission(required(args, "--file"));
    console.log(JSON.stringify({ ...checkpoint, networkCalls: 0 }, null, 2));
  } else if (command === "audit") {
    const report = await runAgentCoverageAudit();
    console.log(JSON.stringify({
      ok: report.ok,
      chainViolations: report.evidence.chainViolations.length,
      publicationViolations: report.publicationAudit.violations.length,
      networkCalls: 0,
    }, null, 2));
    if (!report.ok) process.exitCode = 1;
  } else if (command === "status") {
    console.log(JSON.stringify(agentWorkflowStatus(), null, 2));
  } else {
    throw new Error(`未知命令 ${command}；可用 prepare / validate / import / audit / status`);
  }
} catch (error) {
  console.error(`Agent Content 失败：${safeErrorSummary(error)}`);
  process.exitCode = 1;
}


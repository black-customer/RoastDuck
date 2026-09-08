import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import nextEnv from "@next/env";
import { z } from "zod";

nextEnv.loadEnvConfig(process.cwd());

const [{ readAiEnvironment }, { DeepSeekProvider }, { executeAuditedAiCall }, { safeErrorSummary }] = await Promise.all([
  import("@/lib/ai/config"),
  import("@/lib/ai/deepseek-provider"),
  import("@/lib/ai/job-service"),
  import("@/lib/ai/errors"),
]);

const config = readAiEnvironment({ ...process.env, AI_PROVIDER: "deepseek" });
if (!config.apiKey) {
  console.log("AI Smoke 跳过：未配置 DEEPSEEK_API_KEY。");
  process.exit(0);
}

const promptPath = path.resolve("pipeline/prompts/smoke.generator.v1.md");
const prompt = fs.readFileSync(promptPath, "utf8");
const schema = z.object({ greeting: z.string().min(1).max(120) });
const idempotencyKey = `smoke_${randomUUID()}`;

try {
  const provider = new DeepSeekProvider({ apiKey: config.apiKey, baseUrl: config.baseUrl, timeoutMs: 60_000 });
  const result = await executeAuditedAiCall(provider, null, {
    role: "generator",
    instructions: prompt,
    input: "Return the requested JSON greeting.",
    schema,
    schemaName: "provider_smoke_v1",
    promptVersion: "smoke.generator.v1",
    schemaVersion: "provider-smoke.v1",
    idempotencyKey,
    maxOutputTokens: 128,
  }, { maxAttempts: 1 });
  console.log(JSON.stringify({
    ok: true,
    provider: provider.providerName,
    model: provider.model,
    runId: result.runId,
    responseId: result.responseId,
    usage: result.usage,
  }, null, 2));
} catch (reason) {
  console.error(`AI Smoke 失败：${safeErrorSummary(reason)}`);
  process.exitCode = 1;
}

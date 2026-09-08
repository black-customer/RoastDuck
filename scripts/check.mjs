import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { projectRuntime, runtimeEnvironment } from "./project-runtime.mjs";

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("无法定位 npm CLI；请通过 npm run check 执行质量门");
const evidenceDirectory = path.resolve("test-results", `check-${Date.now()}`);
fs.mkdirSync(evidenceDirectory, { recursive: true });
const runtime = projectRuntime();
console.log(`质量门运行时：${runtime.version}（${runtime.source}）`);
if (runtime.warning) console.warn(runtime.warning);
const checkEnvironment = { ...runtimeEnvironment(runtime), AI_PROVIDER: "mock", MIMO_API_KEY: "", DEEPSEEK_API_KEY: "", ROASTDUCK_REPORTS_DIR: evidenceDirectory };
const checks = [
  ["governance", ["run", "governance:check"]],
  ["lint", ["run", "lint"]],
  ["typecheck", ["run", "typecheck"]],
  ["unit", ["test"]],
  ["integration", ["run", "test:integration"]],
  ["golden", ["run", "pipeline:golden"]],
  ["build", ["run", "build:e2e"]],
  ["e2e", ["run", "e2e:run"]],
  ["current-material-audit", ["run", "audit:materials:e2e"]],
];

const failures = [];
const results = [];
for (const [name, args] of checks) {
  console.log(`\n===== ${name} =====`);
  const result = spawnSync(runtime.nodePath, [npmCli, ...args], { stdio: "inherit", shell: false, env: checkEnvironment });
  results.push({ name, command: `npm ${args.join(" ")}`, exitCode: result.status ?? 1 });
  fs.writeFileSync(path.join(evidenceDirectory, "check.json"), JSON.stringify({ checkedAt: new Date().toISOString(), runtime: { version:runtime.version, source:runtime.source }, results }, null, 2));
  if (result.status !== 0) {
    if (result.error) console.error(result.error);
    failures.push({ name, status: result.status ?? "spawn_failed" });
  }
}

console.log(`本轮证据：${evidenceDirectory}`);
console.log("\n===== 统一质量门结果 =====");
if (failures.length) {
  for (const failure of failures) console.error(`FAIL ${failure.name} (${failure.status})`);
  process.exitCode = 1;
} else {
  console.log("PASS：全部质量门通过");
}

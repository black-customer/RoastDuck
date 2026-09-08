/** 复用唯一完整门，避免审查与CI的检查范围漂移。 */
import { spawnSync } from "node:child_process";
const npmCli = process.env.npm_execpath;
const result = spawnSync(npmCli ? process.execPath : (process.platform === "win32" ? "npm.cmd" : "npm"), npmCli ? [npmCli,"run","check"] : ["run","check"], {
  stdio: "inherit", windowsHide: true, shell: !npmCli && process.platform === "win32",
  env: { ...process.env, AI_PROVIDER: "mock", MIMO_API_KEY: "", DEEPSEEK_API_KEY: "" },
});
if (result.error) console.error("审查命令未执行完成：", result.error.code ?? "spawn_failed");
process.exitCode = result.status ?? 1;

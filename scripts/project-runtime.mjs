import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

/** 只读取本项目本机配置；无自动安装，也不更改宿主环境。 */
export function projectRuntime(root = process.cwd()) {
  const file = path.join(root, "data", "desktop", "runtime.json");
  if (!fs.existsSync(file)) return { nodePath: process.execPath, version: process.version, source: "current", warning: null };
  let config;
  try { config = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { throw new Error("本项目Node运行时配置损坏，请修复data/desktop/runtime.json"); }
  if (typeof config.nodePath !== "string" || !path.isAbsolute(config.nodePath) || !/^node(?:\.exe)?$/i.test(path.basename(config.nodePath))) {
    throw new Error("本项目运行时必须是绝对路径的Node可执行文件");
  }
  if (!fs.existsSync(config.nodePath) || !fs.statSync(config.nodePath).isFile()) throw new Error("已配置的Node运行时不可用，请修复本机配置；未修改系统环境");
  const probe = spawnSync(config.nodePath, ["--version"], { encoding: "utf8", shell: false, windowsHide: true, timeout: 5000, env: { ...process.env, NODE_OPTIONS: "" } });
  const version = probe.stdout?.trim();
  if (probe.status !== 0 || !/^v\d+\.\d+\.\d+$/.test(version ?? "")) throw new Error("无法验证已配置的Node运行时");
  return { nodePath: config.nodePath, version, source: "project",
    warning: config.validatedVersion && config.validatedVersion !== version ? "Node版本已变化，请重新执行完整质量门" : null };
}

export function runtimeEnvironment(runtime, base = process.env) {
  const environment = { ...base };
  const pathKeys = Object.keys(environment).filter(key => key.toUpperCase() === "PATH");
  const key = pathKeys[0] ?? "PATH";
  const original = environment[key] ?? "";
  for (const duplicate of pathKeys.slice(1)) delete environment[duplicate];
  environment[key] = path.dirname(runtime.nodePath) + path.delimiter + original;
  return environment;
}

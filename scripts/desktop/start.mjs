import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import net from "node:net";
import http from "node:http";
import { projectRuntime, runtimeEnvironment } from "../project-runtime.mjs";
import { activeRelease } from "./releases.mjs";

const root = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const messages = JSON.parse(fs.readFileSync(new URL("./messages.json", import.meta.url), "utf8"));
const args = process.argv.slice(2);
const portArgument = args.find((arg) => arg.startsWith("--port="))?.slice(7) ?? "3001";
if (!/^\d+$/.test(portArgument) || Number(portArgument) < 1024 || Number(portArgument) > 65535) {
  throw new Error("本地端口必须是 1024–65535 的整数");
}
const port = Number(portArgument);
const noBrowser = args.includes("--no-browser");
const address = `http://127.0.0.1:${port}`;
const workspaceId = createHash("sha256").update(root.replace(/[\\/]+$/, "").toLowerCase()).digest("hex");
const directory = path.join(root, "data", "desktop");
fs.mkdirSync(directory, { recursive: true });
const lockFile = path.join(directory, `launch-${port}.lock`);
const lockId = randomUUID();
let ownsLock = false;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function appReady() {
  return new Promise((resolve) => {
    const request = http.get(`${address}/api/health`, { timeout: 1500 }, (response) => {
      let body = "";
      response.on("data", (chunk) => {
        body += chunk;
        if (body.length > 8192) request.destroy();
      });
      response.on("end", () => {
        try {
          const data = JSON.parse(body);
          resolve(response.statusCode === 200 && data.application === "roastduck" && data.workspaceId === workspaceId);
        } catch { resolve(false); }
      });
      response.on("error", () => resolve(false));
    });
    request.on("timeout", () => request.destroy());
    request.on("error", () => resolve(false));
  });
}

function portBusy() {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const done = (busy) => { socket.destroy(); resolve(busy); };
    socket.setTimeout(500);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

function acquireLock() {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, lockId }), { flag: "wx" });
      ownsLock = true;
      return true;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      // 只清理已退出启动器留下的本机锁；绝不结束任何已有进程。
      let previous;
      try { previous = JSON.parse(fs.readFileSync(lockFile, "utf8")); } catch { return false; }
      try { process.kill(previous.pid, 0); return false; } catch (probeError) {
        if (probeError.code !== "ESRCH") return false;
        try {
          if (JSON.parse(fs.readFileSync(lockFile, "utf8")).lockId === previous.lockId) fs.unlinkSync(lockFile);
        } catch { return false; }
      }
    }
  }
  return false;
}

async function openBrowser(target) {
  await new Promise((resolve, reject) => {
    const browser = spawn(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "rundll32.exe"),
      ["url.dll,FileProtocolHandler", target], { detached: true, stdio: "ignore", windowsHide: true });
    browser.once("error", reject);
    browser.once("spawn", () => { browser.unref(); resolve(); });
  });
}

async function waitForApp(server) {
  const deadline = Date.now() + 120_000;
  do {
    if (server?.exitCode != null || server?.signalCode != null) throw new Error(messages.serverExited);
    if (await appReady()) return;
    await delay(350);
  } while (Date.now() < deadline);
  throw new Error(messages.timeout);
}

try {
  if (!await appReady()) {
    if (!acquireLock()) await waitForApp();
    else if (await portBusy()) throw new Error(messages.portBusy);
    else {
      const runtime = projectRuntime(root);
      const release = activeRelease(root);
      if (runtime.warning) console.warn(runtime.warning);
      const nextCli = path.join(root, "node_modules", "next", "dist", "bin", "next");
      if (!fs.existsSync(nextCli)) throw new Error(messages.missingDependencies);
      const stamp = Date.now();
      const stdout = path.join(directory, `server-${port}-${stamp}.out.log`);
      const stderr = path.join(directory, `server-${port}-${stamp}.err.log`);
      const out = fs.openSync(stdout, "a");
      const err = fs.openSync(stderr, "a");
      let server;
      try {
        server = spawn(runtime.nodePath, [nextCli, "start", "--hostname", "127.0.0.1", "--port", String(port)], {
          cwd: root, detached: true, windowsHide: true, stdio: ["ignore", out, err],
          env: { ...runtimeEnvironment(runtime), NODE_OPTIONS: "", NODE_ENV:"production", ROASTDUCK_E2E: "", ROASTDUCK_DESKTOP: "1", ROASTDUCK_DESKTOP_RELEASE:release.releaseId,ROASTDUCK_PROMPT_ROOT:path.join(release.directory,'runtime-prompts') },
        });
        await new Promise((resolve, reject) => { server.once("spawn", resolve); server.once("error", reject); });
      } finally { fs.closeSync(out); fs.closeSync(err); }
      server.unref();
      fs.writeFileSync(path.join(directory, `instance-${port}.json`), JSON.stringify({
        pid: server.pid, port, workspaceId, nodeVersion:runtime.version, releaseId:release.releaseId, startedAt: new Date().toISOString(), stdout, stderr,
      }, null, 2));
      await waitForApp(server);
    }
  }
  if (!noBrowser) await openBrowser(address);
  console.log(`READY ${address}`);
} catch (error) {
  const message = error instanceof Error ? error.message : messages.timeout;
  console.error(message);
  if (!noBrowser) {
    const escape = (text) => text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
    const errorPage = path.join(directory, "startup-error.html");
    fs.writeFileSync(errorPage, `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${messages.title}</title><body><h1>${messages.title}</h1><p>${escape(messages.failure)}</p><pre>${escape(message)}</pre></body></html>`);
    await openBrowser(errorPage).catch(() => {});
  }
  process.exitCode = 1;
} finally {
  if (ownsLock) {
    try { if (JSON.parse(fs.readFileSync(lockFile, "utf8")).lockId === lockId) fs.unlinkSync(lockFile); } catch { /* 不覆盖其他启动器的锁 */ }
  }
}

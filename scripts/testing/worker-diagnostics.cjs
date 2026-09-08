/* eslint-disable @typescript-eslint/no-require-imports -- Vitest filters --require before forking; this probe must instrument only its parent. */
const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("node:child_process");
const { syncBuiltinESMExports } = require("node:module");
const directory = path.resolve("test-results", `worker-probe-${Date.now()}-${process.pid}`);
fs.mkdirSync(directory, { recursive: true });
const file = path.join(directory, "workers.jsonl");
function write(event) { fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), parent: process.pid, ...event }) + "\n"); }
write({ kind: "runtime", node: process.version });
const fork = childProcess.fork;
childProcess.fork = function (...args) {
  const child = fork.apply(this, args);
  write({ kind: "fork", pid: child.pid, entry: String(args[0]) });
  for (const event of ["spawn", "disconnect", "error", "exit", "close"]) child.on(event, (code, signal) => {
    write({ kind: event, pid: child.pid, code: event === "error" ? code?.code : typeof code === "number" ? code : null, signal: typeof signal === "string" ? signal : null });
  });
  const kill = child.kill;
  child.kill = function (...killArgs) { write({ kind: "kill_requested", pid: child.pid, signal: killArgs[0] ?? null }); return kill.apply(this, killArgs); };
  return child;
};
syncBuiltinESMExports();

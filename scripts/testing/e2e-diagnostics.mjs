// Test-only preload: no request bodies, query strings, headers, or user database.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
const output = process.env.ROASTDUCK_E2E_DIAGNOSTIC_DIR;
if (process.env.ROASTDUCK_E2E !== "1" || process.env.AI_PROVIDER !== "mock" || !output ||
    !path.resolve(output).startsWith(path.resolve("test-results") + path.sep) ||
    process.env.ROASTDUCK_DB !== "file:./test-results/e2e.db") throw new Error("Diagnostics requires an isolated E2E process");
const file = path.join(output, "requests.jsonl");
const write = event => fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n");
write({ kind: "runtime", node: process.version, execPath: process.execPath, pid: process.pid });
for(const event of ["beforeExit","exit"])process.on(event,code=>write({kind:event,code}));
process.on("uncaughtExceptionMonitor",error=>write({kind:"uncaughtExceptionMonitor",code:error.code??null,name:error.name}));
const emit = http.Server.prototype.emit;
let sequence = 0;
http.Server.prototype.emit = function (event, ...args) {
  if (event === "request") {
    const [request, response] = args;
    const id = ++sequence;
    write({ kind: "request", id, method: request.method, path: request.url.split("?")[0] });
    response.once("finish", () => write({ kind: "finish", id, status: response.statusCode }));
  }
  return emit.call(this, event, ...args);
};
let modules = "";
setInterval(() => {
  const next = JSON.stringify(process.report.getReport().sharedObjects.filter(file => file.endsWith(".node")));
  if (next !== modules) { modules = next; write({ kind: "native_modules", modules: JSON.parse(next) }); }
}, 500).unref();

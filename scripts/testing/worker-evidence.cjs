/* eslint-disable @typescript-eslint/no-require-imports -- Node preload before Vitest forks. */
// Test-only evidence, not an error handler: uncaught failures still terminate the process.
const fs=require("node:fs"),path=require("node:path"),cp=require("node:child_process"),modules=require("node:module");
const directory=path.resolve(process.env.ROASTDUCK_WORKER_EVIDENCE_DIR||"");
const relative=path.relative(path.resolve("test-results"),directory);
if(!relative||relative.startsWith("..")||path.isAbsolute(relative))throw new Error("Worker evidence must be inside test-results");
fs.mkdirSync(directory,{recursive:true});
const output=path.join(directory,`worker-${process.pid}.jsonl`);
const write=event=>fs.appendFileSync(output,JSON.stringify({at:new Date().toISOString(),pid:process.pid,ppid:process.ppid,...event})+"\n");
write({kind:"runtime",node:process.version,workerId:process.env.TINYPOOL_WORKER_ID??null});
for(const event of ["beforeExit","exit","disconnect"])process.on(event,code=>write({kind:event,code:typeof code==="number"?code:null}));
process.on("uncaughtExceptionMonitor",error=>write({kind:"uncaught",code:error.code??null,name:error.name}));
const load=modules._extensions[".node"];
modules._extensions[".node"]=function(module,filename){write({kind:"native_load_started",filename});const result=load.apply(this,arguments);write({kind:"native_load_finished",filename});return result;};
const fork=cp.fork;
cp.fork=function(entry,args,options){
  const execArgv=options?.execArgv??[];
  const child=fork.call(this,entry,args,{...options,execArgv:execArgv.includes(__filename)?execArgv:[...execArgv,"--require",__filename]});
  write({kind:"fork",childPid:child.pid});
  for(const event of ["spawn","disconnect","error","exit","close"])child.on(event,(code,signal)=>write({kind:`child_${event}`,childPid:child.pid,
    code:event==="error"?code?.code??null:typeof code==="number"?code:null,signal:typeof signal==="string"?signal:null,
    statusHex:typeof code==="number"?`0x${(code>>>0).toString(16).padStart(8,"0")}`:null}));
  const kill=child.kill;
  child.kill=function(signal){write({kind:"child_kill_requested",childPid:child.pid,signal:signal??"SIGTERM"});return kill.apply(this,arguments);};
  return child;
};
modules.syncBuiltinESMExports();

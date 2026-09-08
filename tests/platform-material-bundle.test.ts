import { build } from "vite";
import path from "node:path";
import { isBuiltin } from "node:module";
import { expect,it } from "vitest";
it("material audit and V2 round bundle for a browser without Node, Provider, filesystem or database bootstrap",async()=>{
  const result=await build({configFile:false,envFile:false,logLevel:"silent",resolve:{alias:{"@":path.resolve("src")}},
    plugins:[{name:"reject-server-runtime",resolveId(id){if(isBuiltin(id))throw new Error(`Node runtime in mobile audit: ${id}`);}}],
    build:{write:false,minify:false,lib:{entry:{audit:"src/lib/four-step/audit.ts",round:"src/lib/light-study/round.ts",learning:"src/lib/light-study/core-service.ts"},formats:["es"]}}});
  const outputs=(Array.isArray(result)?result:[result]).flatMap(output=>"output" in output?output.output:[]);
  const chunks=outputs.filter(output=>output.type==="chunk");
  const inputs=chunks.flatMap(chunk=>Object.keys(chunk.modules));
  expect(inputs.some(file=>file.endsWith("db/client.ts")||file.endsWith("provider-factory.ts")||file.endsWith("job-service.ts")||file.endsWith("diagnostic-pipeline.ts"))).toBe(false);
  expect(chunks.filter(chunk=>chunk.isEntry)).toHaveLength(3);
  expect(chunks.some(chunk=>chunk.code.includes("process.env"))).toBe(false);
});

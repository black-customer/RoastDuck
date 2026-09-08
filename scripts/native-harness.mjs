import { build } from "vite";
import path from "node:path";
import fs from "node:fs";
const fixture=path.resolve("test-results/native-fixture.json");
if(!fs.existsSync(fixture))throw new Error("先运行 npx tsx scripts/native-fixture.ts，生成隔离合成材料。");
await build({root:path.resolve("tests/native"),configFile:false,envFile:false,base:"./",resolve:{alias:{"@":path.resolve("src"),"@native-fixture":fixture}},
  esbuild:{jsx:"automatic"},
  build:{outDir:path.resolve("test-results/native-harness"),emptyOutDir:false,minify:false}});

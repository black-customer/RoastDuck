import fs from "node:fs";
import path from "node:path";
import {build} from "vite";
if(!fs.existsSync("data/generated/mobile-question-bank.json"))throw new Error("先运行 npx tsx scripts/mobile-question-bank.ts，准备公共题库（不包含私人回答）。");
await build({configFile:path.resolve("mobile/vite.config.ts"),envFile:false});
fs.writeFileSync("mobile/dist/native-build.json",JSON.stringify({profile:"production",privateAnswers:0}));

import {defineConfig} from "vite";
import path from "node:path";
export default defineConfig({root:path.resolve("mobile"),base:"./",esbuild:{jsx:"automatic"},
  resolve:{alias:{"@":path.resolve("src"),"@db":path.resolve("db"),"@public-question-bank":path.resolve("data/generated/mobile-question-bank.json")}},
  build:{outDir:path.resolve("mobile/dist"),emptyOutDir:true,target:"es2022"},
});

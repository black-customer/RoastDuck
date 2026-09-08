import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = process.cwd();
const failures = [];
const repositoryFiles = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
const textFiles = [...new Set(repositoryFiles)].filter((file) => {
  const absolute = path.join(ROOT, file);
  return fs.existsSync(absolute) && fs.statSync(absolute).isFile() && !/\.(?:gz|pdf|docx|png|ico|jpg|jpeg|webp|woff2?|ttf|mp3|wav|opus|zip)$/i.test(file);
});

function check(name, fn) {
  try {
    const error = fn();
    if (error) failures.push({ name, error });
    else console.log(`✓ ${name}`);
  } catch (e) {
    failures.push({ name, error: e.message || String(e) });
  }
}

// 1. 必需文档全部存在
const REQUIRED_DOCS = [
  "AGENTS.md",
  "docs/README.md",
  "docs/PRODUCT.md",
  "docs/LEARNING_EXPERIENCE.md",
  "docs/SPEAKING_STUDIO.md",
  "docs/CONTENT_SPEC.md",
  "docs/HISTORICAL_ANSWER_IMPORT.md",
  "docs/SPEECH_SERVICE.md",
  "docs/DATA_MODEL.md",
  "docs/ARCHITECTURE.md",
  "docs/AI_PROVIDER.md",
  "docs/TESTING.md",
  "docs/DECISIONS.md",
  "docs/PROJECT_STATUS.md",
  "docs/ROADMAP.md",
  "docs/DESIGN.md",
  "docs/VIBE_CODING_WORKFLOW.md",
];

check("1. 必需文档存在性", () => {
  const missing = REQUIRED_DOCS.filter((doc) => !fs.existsSync(path.join(ROOT, doc)));
  if (missing.length > 0) return `缺少文档：${missing.join(", ")}`;
  return null;
});

// 2. PRODUCT.md 包含 impeccable:product-schema 1
check("2. PRODUCT.md Schema 声明", () => {
  const content = fs.readFileSync(path.join(ROOT, "docs/PRODUCT.md"), "utf8");
  if (!content.includes("<!-- impeccable:product-schema 1 -->")) {
    return "docs/PRODUCT.md 缺少 <!-- impeccable:product-schema 1 --> 声明";
  }
  return null;
});

// 3. PROJECT_STATUS.md 记录分支、最后验证 Commit、命令与结果
check("3. PROJECT_STATUS.md 状态记录完整性", () => {
  const content = fs.readFileSync(path.join(ROOT, "docs/PROJECT_STATUS.md"), "utf8");
  if (!content.includes("分支") || !/Commit/i.test(content) || !/\bnpm\s+(?:run|test|ci)\b/.test(content) || !/退出(?:码)?\s*[:：]?\s*\d/.test(content)) {
    return "docs/PROJECT_STATUS.md 缺少分支、最后验证 Commit、命令或退出码记录";
  }
  return null;
});

// 4. ROADMAP.md 与证据
check("4. 文档索引覆盖和本地引用", () => {
  const index = fs.readFileSync(path.join(ROOT, "docs/README.md"), "utf8");
  const links = [...index.matchAll(/\]\(([^)]+\.md)\)/g)].map(m => m[1]);
  const missing = fs.readdirSync(path.join(ROOT, "docs")).filter(f => f.endsWith(".md") && !links.includes(f));
  if (missing.length) return "未登记文档：" + missing.join(", ");
  for (const link of links) if (!fs.existsSync(path.resolve(ROOT, "docs", link))) return "索引链接失效：" + link;
  for (const line of index.split("\n").filter(line => line.startsWith("| ["))) {
    if (!/\| (现行|兼容|历史|日志|冻结) \|/.test(line)) return "文档缺少权威状态";
  }
  return null;
});

// 5. Prompt 位于 pipeline/prompts/ 且带版本号或标准阶段 Prompt
check("5. Prompt 版本化管理", () => {
  const promptDir = path.join(ROOT, "pipeline/prompts");
  if (!fs.existsSync(promptDir)) return "pipeline/prompts 目录不存在";
  const files = fs.readdirSync(promptDir).filter((f) => f.endsWith(".md"));
  if (files.length === 0) return "pipeline/prompts 中没有 Prompt 文件";
  const pipeline = fs.readFileSync(path.join(ROOT, "src/lib/four-step/stage-contracts.ts"), "utf8");
  const requiredPersonalPrompts = [...pipeline.matchAll(/prompt:\s*["']([^"']+\.md)["']/g)].map(m => m[1]);
  if (requiredPersonalPrompts.length < 4 || requiredPersonalPrompts.length % 4 !== 0) return "材料版本缺少完整四阶段Prompt声明";
  const missing = requiredPersonalPrompts.filter((file) => !files.includes(file));
  if (missing.length > 0) return `缺少个人内容 Prompt：${missing.join(", ")}`;
  return null;
});

// 6. 数据库迁移使用连续编号
check("6. 数据库迁移版本连续性", () => {
  const migrateFile = fs.readFileSync(path.join(ROOT, "db/migrate.ts"), "utf8");
  const versions = [...migrateFile.matchAll(/args:\s*\[\s*(\d+)\s*,\s*["']/g)].map((m) => Number(m[1]));
  const unique = [...new Set(versions)].sort((a, b) => a - b);
  if (!unique.length || unique.some((v, i) => v !== i + 1)) return "数据库迁移编号不连续";
  return null;
});

// 7. .env.example 只有占位符，不含真实值
check("7. .env.example 无真实密钥", () => {
  const envExPath = path.join(ROOT, ".env.example");
  if (!fs.existsSync(envExPath)) return ".env.example 不存在";
  const content = fs.readFileSync(envExPath, "utf8");
  if (/sk-[a-zA-Z0-9]{20,}/.test(content)) return ".env.example 包含真实 API Key 格式";
  return null;
});

// 8. 仓库不含疑似 API Key
check("8. 仓库密钥泄漏扫描", () => {
  // Check git tracked files
  const bannedPatterns = [/sk-[a-zA-Z0-9]{32,}/, /AIza[0-9A-Za-z-_]{35}/];
  const filesToCheck = textFiles;
  for (const f of filesToCheck) {
    const p = path.join(ROOT, f);
    if (fs.existsSync(p)) {
      const text = fs.readFileSync(p, "utf8");
      for (const pattern of bannedPatterns) {
        if (pattern.test(text)) return `${f} 中包含疑似真实 API Key！`;
      }
    }
  }
  return null;
});

check("9. 学习契约与兼容边界存在", () => {
  const product = fs.readFileSync(path.join(ROOT, "docs/PRODUCT.md"), "utf8");
  const learning = fs.readFileSync(path.join(ROOT, "docs/LEARNING_EXPERIENCE.md"), "utf8");
  if (!product.includes("WEB_USABILITY") || !learning.includes("light_study_v2")) return "现行网页执行依据缺失";
  if (!learning.includes("light_study_v1") || !learning.includes("four_step_v1")) return "旧会话兼容版本说明缺失";
  return null;
});

// 10. E2E 使用隔离数据库
check("10. E2E 隔离数据库配置", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  if (!pkg.scripts["build:e2e"]?.includes("test-results") || !pkg.scripts["e2e:run"]?.includes("test-results")) {
    return "E2E 脚本未配置 test-results 隔离数据库！";
  }
  return null;
});

// 11. Reviewer 证据链
check("11. Reviewer 独立证据链配置", () => {
  const evidenceFile = path.join(ROOT, "pipeline/src/agent/evidence.ts");
  const contractsFile = path.join(ROOT, "pipeline/src/agent/contracts.ts");
  if (!fs.existsSync(evidenceFile) || !fs.existsSync(contractsFile)) return "Agent 证据链契约文件不存在";
  const evidence = fs.readFileSync(evidenceFile, "utf8");
  const contracts = fs.readFileSync(contractsFile, "utf8");
  if (!evidence.includes("verifyAgentReviewerEvidence") || !contracts.includes("independentContext")) {
    return "Reviewer 独立证据校验不完整";
  }
  return null;
});

// 12. 私人材料目录必须被 Git 忽略
check("12. 私人回答目录隔离", () => {
  const ignore = fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8");
  if (!ignore.includes("data/imports/private/")) {
    return ".gitignore 未明确隔离 data/imports/private/";
  }
  return null;
});

// 13. CI 必须运行完整质量门
check("13. CI 执行完整质量门", () => {
  const workflow = fs.readFileSync(path.join(ROOT, ".github/workflows/quality.yml"), "utf8");
  if (!workflow.includes("run: npm run check") || workflow.includes("run: npm run check:app")) {
    return "CI 未唯一执行完整 npm run check";
  }
  return null;
});

// 14. V0.2 数据迁移与初始化入口
check("14. V0.2 初始化与迁移入口", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  if (!pkg.scripts.init || !pkg.scripts["agent:personal-import"]) {
    return "缺少 init 或 agent:personal-import 命令";
  }
  const migrateFile = fs.readFileSync(path.join(ROOT, "db/migrate.ts"), "utf8");
  if (!migrateFile.includes("answer_imports") || !migrateFile.includes("learning_scenarios")) {
    return "v8 缺少历史导入或学习语境表";
  }
  return null;
});

check("15. 源码和文档不得残留合并冲突", () => {
  for (const file of textFiles) {
    const content = fs.readFileSync(path.join(ROOT, file), "utf8");
    if (/^(?:<{7} |>{7} |\|{7} )/m.test(content)) return `未解决的合并冲突：${file}`;
  }
  return null;
});

console.log("\n===== 治理检查结果 =====");
if (failures.length > 0) {
  for (const f of failures) {
    console.error(`FAIL: ${f.name} -> ${f.error}`);
  }
  process.exit(1);
} else {
  console.log("PASS：15 项治理检查全部通过");
  process.exit(0);
}

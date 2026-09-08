import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/integration/**", "tests/e2e/**", "node_modules/**"],
    environment: "node",
    // 多个测试文件都要读写 SQLite 与 test-results 临时目录，并行会产生锁竞争与随机失败。
    fileParallelism: false,
    // Windows + Node 24 下预创建多个空闲 fork 偶发触发 ERR_IPC_CHANNEL_CLOSED；单 worker 也符合串行数据库契约。
    maxWorkers: 1,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@db": path.resolve(__dirname, "./db"),
      "@pipeline": path.resolve(__dirname, "./pipeline"),
    },
  },
});

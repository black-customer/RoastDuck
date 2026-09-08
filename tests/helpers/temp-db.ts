/**
 * 为测试准备一个全新的隔离数据库。
 *
 * 背景：本机工具链会把 `fs.rmSync` 与 `fs.unlinkSync` 重定向到回收站，
 * 在 `test-results/` 下会抛错。因此测试**不能依赖删除旧库**，改为：
 *   1. 每次运行使用带进程号与时间戳的新文件名，天然是空库；
 *   2. 对同名旧文件做尽力清理，清理失败不影响本次运行（目录已被 git 忽略）。
 */
import fs from "node:fs";
import path from "node:path";

export const TEST_RESULTS_DIRECTORY = path.resolve("test-results");

export interface PreparedDatabase {
  /** 绝对路径，用于存在性判断和路径断言。 */
  file: string;
  /** 传给 libSQL 的项目相对路径 URL。 */
  url: string;
  directory: string;
}

export function prepareTestDatabase(name: string): PreparedDatabase {
  const directory = TEST_RESULTS_DIRECTORY;
  fs.mkdirSync(directory, { recursive: true });

  const prefix = `${name}.`;
  for (const entry of fs.readdirSync(directory)) {
    if (!entry.startsWith(prefix) || !entry.endsWith(".db")) continue;
    try {
      fs.unlinkSync(path.join(directory, entry));
    } catch {
      // 清理失败可忽略：本次运行使用全新文件名，不会读到旧数据。
    }
  }

  const file = path.join(directory, `${name}.${process.pid}.${Date.now()}.db`);
  const relative = path.relative(process.cwd(), file).split(path.sep).join("/");
  return { file, url: `file:./${relative}`, directory };
}

/** 断言数据库路径没有越出 test-results，防止误写真实进度库。 */
export function assertInsideTestResults(file: string): void {
  if (path.dirname(path.resolve(file)) !== TEST_RESULTS_DIRECTORY) {
    throw new Error(`测试数据库越出 test-results：${file}`);
  }
}

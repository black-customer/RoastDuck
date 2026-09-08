/**
 * 已退役：旧脚本会消耗 Runtime 余额、按最长回答丢弃版本，并误用题目中文作用户意图。
 * 历史材料必须走离线 Agent + 独立 Reviewer。禁止通过 --force / --all 恢复此路径。
 * 保留文件以便旧命令明确失败，既不调用 API，也不修改任何回答。
 */
console.error("此历史批处理入口已退役。请依据 docs/FOUR_STEP_RECOVERY.md 使用离线材料批次；不得调用用户 Runtime 余额。");
process.exitCode = 1;
export {};

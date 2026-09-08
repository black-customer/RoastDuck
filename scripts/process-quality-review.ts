// 已退役：规则预筛不得签发独立 Reviewer 裁决，也不得删除历史审核包。
console.error("此入口已禁用。请运行 npm run agent:content -- prepare --stage quality_review，由独立 Reviewer 逐项审核后导入；历史证据必须保留。");
process.exitCode = 1;

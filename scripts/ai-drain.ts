// 公共内容编译只能走离线 Agent；保留命令名以便旧自动化明确失败。
console.error("ai:drain 已退役，禁止公共内容消耗 Runtime API。请使用 npm run agent:content；用户 Runtime 功能通过应用服务执行。");
process.exitCode = 1;

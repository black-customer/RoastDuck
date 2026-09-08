# 测试与验收
状态：现行；2026-09-07。行为由测试证明，不以文档关键词或模型自评代替。
## 命令
npm run governance:check；npm run lint；npm run typecheck；npm test；npm run test:integration；npm run pipeline:golden；npm run build:e2e；npm run e2e:run；npm run check。
完整check＝治理/lint/type/unit/integration/当前Golden/隔离构建/E2E/当前材料审计；失败仍汇总但最终非零。审查runner复用同一命令。准确数量只写PROJECT_STATUS。
本机可用data/desktop/runtime.json选择Node，check与桌面共用，CI无配置时仍用CI提供的Node；check.json记录实际版本和来源。Node24.13原生退出与24.19对照证据保留，不用重复重启或删测试掩盖。具体本机路径不提交Git，不更改全局PATH。
npm run audit:readiness只读真实当前材料；Mock结构通过不等于真实材料存在。旧词书Golden执行0，旧V2/V3是兼容测试。
## 隔离
测试进程启动前设置Mock、清空Key、指定test-results数据库。静态import前配置环境，db/client拒绝VITEST误连真实库。集成逐文件独立进程，逐项收集退出码，崩溃也失败，不跳过。
.next-e2e、临时e2e.db与.next-desktop分开；测试服务3100端口占用时报错，不杀用户进程。测试服务器不自动重启掩盖崩溃。
集成runner逐文件保存stdout/stderr和worker生命周期（含native加载、父进程kill请求、Windows退出码）。证据位于integration-*/文件名/；监视器不吞异常、不重试、不跳过失败。父进程退出1与native异常不是同一证据，需结合日志定位。
安卓构建/仪器测试冻结，不是本轮网页验收门；旧隔离共享核心单测保留，不启动模拟器或签名。
## 轻学习矩阵（V2及V1兼容分别验证）
当前 /learn 旧URL统一重定向轻松学V2。旧“语境盲听整轮”和旧“Gap V3整轮”两个UI用例已退出活跃E2E，完整原文件保存在archive/pre-web-usability-2026-09-08/*-e2e.txt；对应历史服务/数据兼容单测保留，不伪报这两项仍执行。新增草稿、收藏、恢复等当前路线用例。
- 审核投影、源版本、失效/损坏、零材料、all/question/material范围、同项共享。
- V2新学/复习中文先行、揭晓后三档自评；初次diagnostic_exposure/due24h/无成功评分，正式复习→FSRS。
- V2每组5个不同表达，最多3项各一次巩固且隔3其他表达；consolidation不改变调度，不强制重做。V1历史批次10保留，仅补记原事件并建立继任；不再返回旧直接教学界面。
- 暂停/刷新/丢响应/双击/多窗口过期版本不重复结算；真实v24列形状升级后旧review继续。
- 不调用文本Provider，不请求麦克风、不出现英文输入框；旧成绩/题目掌握/四步/旧FSRS计数不变。
- 默认手动/可选5秒/暂停/切后台/提前揭晓/计时不翻页；音频缓存/单并发/失败/自动播放被阻止/迟到响应/离页停止。
- 桌面1440/1280、移动320/390、200%缩放、键盘焦点与Axe；真实截图集中审查，不只看矩形无溢出。
最终独立代码Review；真实材料、真实语音、视觉、7天效果分开留证。仅代码通过不宣布提效。

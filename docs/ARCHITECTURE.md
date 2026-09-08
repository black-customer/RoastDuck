# 网页系统架构
状态：现行，2026-09-08。执行范围WEB_USABILITY；原生代码冻结保留。
## 现行层次
Next.js页面 → Web薄接口/适配器 → 已有业务服务 → 本机SQLite。
app-services/web仅装配网页需要的回答、材料、Chloe/记忆与比较，不创建device identity或打开DeviceSync。
evidence_v2材料链保持Generator、独立Reviewer及原文/版本证据。light_study_v2共用稳定learning_item_id；四步、轻学习与独立输出分账。
## 可靠性
- 草稿先落库，稳定提交编号，刷新使用本机救援副本；跨窗口冲突禁止自动覆盖。独立英文先封存，再可选补中文。
- V1仅历史读取和待确认事件核对。明确继续才创建继任映射，所有实际教学V2。GET无业务写入。
- Runtime请求账本保留已完成结果、独立runId和未知结果；不得以请求失败作为错误答案或自动成功。
- 语音采用单库合成租约＋单实例优先队列，缓存键依据实际请求；查询健康不触发合成。
- 非覆盖加密业务恢复只补缺失记录，不启动AI任务；现有冲突、隐藏和撤销优先。
## 数据与平台
数据库变更连续编号并先备份。真实data/app.db与test-results严格隔离；.next/.next-desktop/.next-e2e不互相覆盖。
既有Android/Vite/SQLite与DeviceSync实现属于冻结历史，不作为网页质量门任务，不产生APK/联机服务。
Key只在服务端.env.local；网页设置为只写配置，不能读回完整Key，备份不含凭据。
间歇原生退出根因仍独立追踪；不能把一次运行成功称为稳定性验收。

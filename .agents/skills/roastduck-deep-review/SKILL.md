---
name: roastduck-deep-review
description: 对RoastDuck的重大工程交付、数据/状态机改动或用户要求的深度Review执行证据化审查。以现行文档索引为准，不将历史词书或学习流程当作永久约束。
---
# RoastDuck深度审查
先读AGENTS、docs/README.md、PROJECT_STATUS及本次相关契约；旧型号能力假设和退役规则不参与现行验收。
## 自动化
运行 `node .agents/skills/roastduck-deep-review/scripts/run-review-checks.mjs`，它复用完整npm run check（含E2E和当前材料审计），不维护缩水矩阵。失败、未执行和警告如实说明。
## 专项
数据/学习/Provider/界面变更时读[审查维度](references/dimensions.md)，沿实际代码追踪输入、状态、事务、输出与恢复。轻学习自评不能写旧四步或客观掌握；静态关键词不代表功能实现。
只读Review不授权修复、迁移或真实学习写入；需要复跑时使用Mock和隔离库。私人数据只看任务必要片段，不复制到Git或日志。
## 报告
记录基准/实际检查范围/退出码/测试证据、可操作发现（优先级、路径、行号、触发条件）、未验证项和裁决。
Critical：隐私泄露、数据损坏、绕过授权或错误证据；Major：业务错误、并发不安全、不可恢复；Minor：局部质量问题。
代码Review独立于内容Reviewer。只有实际执行过才报告通过；未验证的语义、服务或学习效果不得用Mock补齐。

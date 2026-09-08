# 新四步恢复实施清单

> 状态：历史计划。四步作为兼容强化保留；现行学习权威见LEARNING_EXPERIENCE。

2026-09-06 PO 确认。基准 d057dbf，分支 codex/v02-complete-recovery。

## 依次实施（不是完成声明）

- P0：契约／治理、题库去 books 依赖、遗留进度归档、阻止假通过。
- P1：Attempt 先保存、幂等恢复、独立材料审核、FreeTalk 来源快照、离线历史。
- P2：服务端 four_step_v1、错误补练、语义 Judge、缓存、事件幂等、真实结算。
- P3：按题／对话复习、共享学习项调度、独立重答、题库状态统一、自评／验证分离。
- P4：Chloe 记忆／消息恢复、UI、播放器／口音、Android 与桌面交付。
- 综合：有效 Golden、当前材料审计、完整 check、隔离 E2E、实机与 7 天体验。

具体实现进度只记 PROJECT_STATUS。新系统不强制回写旧词书；历史备份不用于复活已删除公共 Chunk。数据契约和四步行为以 PRODUCT、LEARNING_EXPERIENCE 为准。

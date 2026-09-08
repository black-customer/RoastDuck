# 个人内容流水线：回答、Gap 与学习材料

> 状态：历史，个人词书流程已退役；当前材料归属真实回答/对话，见MATERIAL_SELECTION。

> 2026-09-06：以下为历史实现／兼容说明，不再约束新建学习。当前按回答／对话四步强化，权威为 PRODUCT.md、LEARNING_EXPERIENCE.md、FOUR_STEP_RECOVERY.md；不恢复词书或逐项双语境发布依赖。

本文定义历史导入和未来 Runtime 回答共用的个人内容编译契约。两条执行路径共享 Schema，但绝不共享调用来源：

- 当前历史材料：离线 Agent 批次，网络调用数为 0，不消耗 Runtime API，不写 ai_runs 冒充 DeepSeek。
- 未来网页输入：服务端 deepseek-v4-flash Runtime 流水线。

## 唯一个人词书

只存在一本个人词书“我的雅思答案”。题目学习包是 Question、Gap、Chunk 的筛选与关联视图，不能为每道题复制词书或学习进度。

## 四层回答数据

每次 attempt 至少保留：

1. raw_transcript：不可覆盖的原始转写；
2. normalized_transcript：只修复高置信 ASR、断句和标点，不提升英语水平；
3. diagnosis：逐项证据化问题；
4. recommended_expression：保留用户事实、观点和表达意图的自然表达。

不得用泛化 Band 9 范文覆盖用户原意。无原始音频时不得推断发音、重音、语速或流利度。

## Gap 账本

所有可确认问题进入 answer_gaps：

- lexical_gap
- grammar_construction
- discourse_gap
- question_understanding
- content_gap
- asr_uncertain
- pronunciation_unknown

每项必须保存原句证据、中文意图、推荐表达、解释、置信度、影响等级、Reviewer 结果和解决状态。

gap_clusters 聚合跨题重复问题；重复出现、阻碍表达、可跨 Topic 复用、用户确实尝试但没有表达出来的内容优先。

## Gap 账本与学习项分离

- Gap 账本追求完整证据。
- 学习项追求高价值和可训练性。
- 纯拼写、单次口误和低价值修饰不单独制造卡片。
- 篇章与内容组织问题进入 AI 老师的追问或结构练习。
- asr_uncertain 默认不进入词书。
- 与公共 Chunk 重复时只建立个人关联，不复制 Chunk。

## 自动审核流水线

Gap Generator → Gap Reviewer → Deduplicator → Scenario Generator → Scenario Reviewer → Coverage Auditor

要求：

- Generator 与 Reviewer 使用不同 Prompt、不同上下文、不同请求和不同 runId。
- Reviewer 必须引用当前候选证据和作出具体理由。
- 高度同质化理由、全量零修改、未引用当前证据或缺少运行标识时，审计失败。
- 审核通过后自动加入“我的雅思答案”，无需人工逐条批准；用户保留隐藏、修改、撤销和报告能力。

## 个人 Chunk 的双语境

每个正式学习项至少有：

### common_usage

- 2–4 句最常见日常对话、monologue 或 speech；
- 具体人物关系、地点和使用目的；
- 脱离原 IELTS 题仍能理解和使用。

### question_repair

- 回到原题和用户原始意图；
- 展示该表达如何修复原回答；
- 作为学完后重答的桥梁。

语境保存英文、中文、目标行、说话人、语域、口音、生成标记和独立审核结果。用户的错误原句只作为证据，不作为正确音频反复强化。

## 可恢复与幂等

### P2 离线诊断批次（personal-gap-batch-v1）

现有三份历史材料只使用 v12 修订后的有效回答，不重新跑旧 Parser。新增 `agent:personal-gap` 的 prepare / validate / apply / status：每批最多 10 个回答，准备阶段固定题目、原文、当前版本及源偏移的快照。原文与版本哈希、Prompt 哈希、Generator 和 Reviewer 产物哈希都在应用时复核；已归档回答或快照漂移立即停止。

Gap 的七类定义及是否适合制卡由 Runtime 与离线共用的 Schema 约束：只有 lexical_gap / grammar_construction 可设 learningFit；asr_uncertain / pronunciation_unknown 不得附会确定的正确表达。诊断逐项保存相对于 raw_transcript 的精确 UTF-16 半开区间，不能拿润色后的句子当原句证据。跨题聚类使用可复用的问题键（例如比较级修饰、否定完成时），不是整句答案。

Generator 和独立 Reviewer 均提交连续、无重叠、覆盖全部原文的分类区间；每项具体 Gap 必须被覆盖区间引用。Reviewer 逐项引用原句裁决，另行检查遗漏。未分类、漏审、重复套话、同上下文、输入或 Prompt 哈希漂移均阻止应用；整批全量零修改也停止并要求校准，不机械制造修改来凑数。

诊断应用是单个数据库事务，新增只追加的 `personal_diagnosis_batches` 与 `personal_gap_evidence`；不写 ai_runs，不覆盖旧回答/版本，不更改学习进度。相同批次重跑复用原结果，不复活已隐藏或已解决的问题。旧隔离 Gap 保留；本批记录与其分离，后续通过显式审核做归并。

**诊断账本入库不等于学习材料发布。** 这里只产生问题账本和待编译候选；不创建 Chunk、学习包必学项或可学状态。后续仍须逐项去重、独立双语境审核、注解覆盖及发布审计。不能因为诊断完整就把“材料待处理”改成“可以重答”。

每次批次保存：

- 输入文件哈希、文本偏移和解析版本；
- Prompt、Schema 版本；
- runId、幂等键、阶段检查点；
- 未识别片段和失败清单；
- Generator 与 Reviewer 的独立证据；
- apply 前后计数和 Coverage Audit。

相同输入、版本和幂等键重跑不得重复创建 Answer、Gap、Chunk 或题目关联。

## 发布闸门

发布到学习系统前必须同时满足：

- 源文本字符全部有分类或明确未识别记录；
- 题目匹配路径可解释；
- Gap 有原句证据；
- Reviewer 有独立具体结论；
- 学习项通过去重；
- common_usage 与 question_repair 都已通过语境 Reviewer；
- 可见英文注解、中文、IPA 和音频状态完整；
- Coverage Auditor 无未解释缺口。

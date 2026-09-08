# Gap 提取 V3：7 天受控实验契约

> 2026-09-06：以下为历史实现／兼容说明，不再约束新建学习。当前按回答／对话四步强化，权威为 PRODUCT.md、LEARNING_EXPERIENCE.md、FOUR_STEP_RECOVERY.md；不恢复词书或逐项双语境发布依赖。

状态：实验中。本文只授权个人学习包中的 10 个试验学习项使用 `gap_retrieval_v3`。在 Product Owner 完成 7 天体验并明确接受前，`docs/LEARNING_EXPERIENCE.md` 的语境盲听 V2 仍是既有会话与公共语境探索的正式契约。

## 产品假设

用户的核心困难不是没有见过正确表达，而是在真实表达时无法从意图自动提取。V3 因此把任务与提取放在讲解之前：

`真实 Gap → 中文意图与场景 → 英文提取 → 判定 → 针对性教学 → 再次提取 → 换场景迁移 → 同题批量重答 → 遗忘曲线复习`

首页将学习与复习分开：学习入口按最近题目继续新的个人 Gap；复习入口只处理 FSRS 到期项。用户自行决定连续学习数量，不设置每日强制额度。

## 新 Gap 状态机

`retrieval_prompt → retrieval_judgement → comparison → adaptive_instruction → active_recall → transfer_recall → outcome → scheduled`

1. `retrieval_prompt` 只显示中文意图、人物关系和具体场景；不显示错误英文、推荐表达或答案。用户在输入框填写英文，可使用系统输入法语音转文字，也可明确选择“不会”。应用不申请麦克风权限。
2. `retrieval_judgement` 先做严格规范化匹配，再匹配已独立审核的个人变体；其他非空输入自动交给 `deepseek-v4-flash` 判定。API 失败不得判错或丢失输入。
3. `comparison` 展示用户表达、推荐表达、简短差异和自然美式音频。正确同义表达本次立即通过；语域或场景不同必须解释差异。
4. `adaptive_instruction` 对不会、错误或场景不符者展示 Chunk、中文、Pattern、槽位、常见错误、`common_usage` 与 `question_repair`。已会者默认折叠。跟读完全可选。
5. `active_recall` 再次隐藏英文，根据原意提取；错误时按用途提示、结构槽位、部分表达、完整答案逐级辅助并重做。
6. `transfer_recall` 使用不同 `common_usage` 场景测试相同表达功能。单 Gap 不完整重答雅思题。
7. `outcome` 记录首次表现、辅助和迁移结果后统一结算；`scheduled` 交给 FSRS。点击不会、首次错误或迁移失败者即使当场改对，也进入较近复习。

同题当前批次全部完成后只提供一次完整重答，进入现有消息式雅思会话。

## 到期复习状态机

`review_prompt → review_judgement → fast_outcome | repair_instruction → repair_recall → transfer_retry → scheduled`

- 每次先根据中文意图和场景输入英文，不能先看答案。
- 无辅助正确者快速结算；表达不稳者看差异后修复；不会或错误者进入微型教学、原场景重做和一次迁移。
- 同日重试、看过答案后的复述和有提示提取不算跨日独立掌握证据。

## 判定与个人变体

- 本地规范化只处理大小写、空白、句末标点和弯直引号，不做语义推断。
- 未命中目标或已审核变体的非空输入自动调用 `gap_retrieval_judge_v1`，结果为 `natural_equivalent / context_difference / incorrect / uncertain`。
- 自然表达本次立即算正确，并创建待审核个人变体；独立 `expression_variant_reviewer_v1` 决定其等价关系、语域、场景和频率。
- 个人变体可以成为用户首选展示，但不得替换稳定 Chunk ID、删除原推荐表达或破坏来源与进度。

## Chloe 与统一记忆

- Chloe 是使用自然美式英语的 AI 学习搭子；身份、MiMo Chloe 声线与记忆在 Gap 学习和雅思聊天中一致，但不冒充真人。
- 对话按 Question、Gap 或 General 任务分组，长期记忆统一。学习页使用默认收起的桌面右侧栏或移动端抽屉。
- 学习事件确定性记忆；稳定的目标、偏好、兴趣、经历和观点每四个用户回合或线程结束后由独立 Memory Extractor 批量提取。
- 不保存密钥、密码、验证码、支付信息、原始录音或模型推测。新增记忆轻提示并可撤销；记忆中心支持搜索、编辑、删除和清空。
- Gap 问答最多自然带入 1 个相关旧项，完整雅思会话最多 2 个，不为覆盖率强塞。

## 实验范围与升级门

- 先离线发布 10 个具备独立 Gap 审核、双语境、注解和音频条件的个人学习项；不足时继续处理下一批历史回答。离线处理网络调用数为 0。
- 真实使用 7 天。效果不设置数字阈值，只由 Product Owner 的总体体验决定 `accepted / revise / rejected`。
- 实验期不新增“消灭 Gap 数”或“掌握 Chunk 数”可视化；提取证据必须保留，且不得把首次成功宣传为稳定掌握。
- `accepted` 后才把 V3 提升为默认并替换产品、学习、路线与设计正式契约。`revise/rejected` 时停止新建 V3 会话，既有会话和证据仍可恢复。

## 当前实现与证据（2026-09-04）

- v15 已应用真实库；提取证据、个人变体、Chloe 线程、消息与长期记忆均使用编号迁移，旧 V2 和旧口语记录保留。
- 10 个真实个人 Gap 已通过离线 Generator、材料 Reviewer 和语境 Reviewer 三个独立会话，并已幂等发布到唯一词书“我的雅思答案”。每项都有两类双语境、IPA 和逐词查询注解；离线编译网络调用数和 Runtime API 调用数均为 0。
- V3 新学与到期复习状态机、Judge 缓存、自然变体异步审核、失败恢复、跨日输出掌握和按题批量重答入口已经实现。
- Chloe 已统一 Question、Gap、General 三类线程；新雅思会话使用同一消息服务。长期记忆支持来源、置信度、替代、撤销、编辑、删除和清空，敏感凭据拒绝写入。
- 专项浏览器测试验证 390px 和 1280px：首屏答案计数为 0，系统语音提示不申请麦克风权限，完整提取与迁移可结算并进入同题重答。2026-09-04 全套 E2E 15/15 通过。

仍未完成：Product Owner 的连续 7 天体验与 `accepted / revise / rejected` 决策。因此本文状态继续是“实验中”，不能据此改写正式 V2 契约或宣称稳定掌握效果已经得到验证。

# 数据模型
状态：现行；2026-09-07。数据库实现以db/schema.ts及连续编号迁移为准，旧结构保留兼容，不执行db:push替代生产迁移。
## 当前实体
- v35：sentence_teaching_editions保存绑定句子文本/来源的独立作者与Reviewer、教学及可追溯修订；加入业务备份，不写第二套学习成绩。会话JSON增加guided-reveal-v1阶段/草稿/游标，评分与advance独立。新增sentence-teaching-revision-v1记录父版与预期活动快照；exact-targets-v2只保留新句确实存在的用法，旧编译记录保留重放。明确部分批准可隔离待确认句，不改false成true。
- v34：sentence_highlights保存稳定句子ID、语言、文本版本/hash、UTF-16准确范围与quote/prefix/suffix锚点；新增请求唯一，取消为软删除。仅可靠唯一锚点映射可迁移，无法对应保留旧版；业务备份包含高亮，不含Key。ai_runs追加response_model/error_details_json，保留失败运行与安全诊断，不保存隐私报错正文。
- 当前失败材料的runtimeRevision引用parentMaterialId/parentInputHash/策略版本；追加practice_materials版本，不覆盖原Attempt、旧分析或成绩。已发布材料不能通过该失败恢复路径重写。
- 审核错误记忆复用Companion记录，保留原表达、建议、原因、源版本、审核run、提示状态和修正证据。准备/风格/转写不确定不计确认错误；同源幂等及删除generation保护迟到写入，不另建错题表。
- v33：sentence_learning_units与sentence_material_editions保存完整句子及追加审核版本；sentence_study_sessions/events/progress独立于旧语块和四步。material_validation_cache绑定已审材料指纹与规则版本，避免每次点击重审。更正评分保留before快照、原评分时刻与更正事件，不重复累加次数。
- v32：answer_drafts.raw_input/input_format保留单框原文；expression_preferences.self_known独立停推；light_study_progress.scheduler_version记录日级策略。不覆盖旧字段、due或历史记录。
- v29：light_study_successions/batches保存旧会话继任、原切换版本与未学队列；speech_requests保存真实请求/未知结果，不写假ai_runs。
- v30：speech_lane为同库多Web进程的全局合成租约；v31：expression_preferences与material_feedback保存个人偏好、原材料哈希和反馈证据。隐藏不更新学习成绩。
- answer_drafts与runtime_requests复用v26记录。网页普通双语作答与独立英文封存/新版本编辑共用稳定提交链，不创建同步身份。重答比较存ai_jobs＋runtime_requests，引用新旧原句，不写掌握状态。
- questions/topic/source与个人原回答保持稳定ID；speaking_question_attempts保存实际作答，practice_answer_sources映射历史回答而不重复计数。
- practice_materials/stages/revisions保存evidence_v2输入、审核和版本；practice_material_items关联learning_items；practice_offline_runs保存开发离线证据。
- practice_source_revisions追加修订切分，不覆盖父原文。
- four_step_sessions/events/settlements及learning_item_schedule属于兼容强化，不能被轻学习更新。
## v24轻学习
light_study_sessions：唯一创建请求、scope/mode、材料快照队列、游标、揭晓、状态与版本。
light_study_events：会话＋客户端事件ID唯一，输入哈希/类型/自评/结果类型/时间；重试返回最新会话，不重复结算。
light_study_progress：learning_item_id唯一，首次接触/最后接触/到期、FSRS、自评次数/版本。旧首见24h记录保留；v32后首见自评初始化独立日级FSRS，不冒充跨日复习或客观正确。
范围只是投影，不复制学习项。会话快照携带版本哈希和来源；过期/撤销不能发布。更新三个轻学习表时短事务原子提交，复习并发检查进度版本。
## 冻结的V2/安卓/同步历史说明
v25已实现experience_version默认V1保留旧记录、round_json与事件phase，V2队列独立表达/巩固阶段分离。初次诊断、接触、组内巩固与正式自评分别存证，不重复结算FSRS。真实库是否应用以PROJECT_STATUS只读核查为准。
安卓全新库结构由隔离空库导出为版本25快照（177条DDL），校验固定哈希后事务初始化，独立_native_schema_bootstrap记录；不写入虚假的桌面历史迁移回执。未知非空库拒绝覆盖，后续原生编号升级仍需实施。
共享平台存储端口、设备/数据集ID、事件同步来源/序号/回执与任务所有权按实现逐步登记；安卓本地SQLite不靠整体覆盖桌面数据库同步。未实现不填写虚假DDL。
## 迁移与隐私
v24先在临时库验证，再通过已有init备份应用；不导入旧完成标签、不静默删除历史。测试必须启动前指定test-results数据库。私人原文不入Git。
历史模型说明：archive/pre-light-study-2026-09-07/DATA_MODEL.md。

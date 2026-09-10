# 网页系统架构
状态：2026-09-10句子主线。
## 服务
Next.js页面→Web薄接口→句子业务服务→本机SQLite。句子契约/目录/服务/客户端事件队列独立于旧实验引擎，复用材料证据、FSRS、声音和Companion。
material_validation_cache绑定已审核材料指纹与规则版本；sentence_learning_units和sentence_material_editions保存投影及追加版本。原practice_materials和回答不覆盖。发布或版本变化审核，日常点击只做有效性/版本检查。
## 状态
sentence_study_sessions/events/progress与旧light_study/four_step分账。客户端以独立事件键持久保存，再顺序提交；事件ID、版本和内容哈希防重。恢复先提交合法原事件，再处理真实冲突。
GET、重复回执和resume均验证资料有效性。评分更正使用原before快照和原时刻，不增加次数。
## 老师与声音
coaching适配既有Companion消息、Memory和Runtime，区分辅助/独立及局部修正；独立审核后确认问题可记忆，反馈不隐式制卡。
LightAudioPlayer支持natural/quick；播放所有权与代次防迟到插播，共用MiMo缓存与合成队列，快捷声线使用本机服务。
## 运行
桌面使用预构建release，dev/E2E隔离。release绑定源码指纹和Prompt副本，ROASTDUCK_PROMPT_ROOT读取对应版本；成功后激活，保留上一版本并复用健康实例，不关闭其他程序。
Key仅服务端，业务备份包含句子记录与版本、排除凭据。编号迁移先备份。开发只用Mock和隔离库，安卓/同步仍冻结。

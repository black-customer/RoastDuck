# 网页系统架构
状态：2026-09-15整题工作区；交付证据见PROJECT_STATUS。
## 服务
Next.js页面→Web薄接口→句子业务服务→本机SQLite。句子契约/目录/服务/客户端事件队列独立于旧实验引擎，复用材料证据、FSRS、声音和Companion。
material_validation_cache绑定已审核材料指纹与规则版本；sentence_learning_units和sentence_material_editions保存投影及追加版本。原practice_materials和回答不覆盖。发布或版本变化审核，日常点击只做有效性/版本检查。
## 状态
context-workspace-v1完整cards与targetIds、focusId、practiceByUnit分开；只在目标上结算FSRS。sentence_exposures单独记首次接触与首次到期，不补造旧评分。句子偏好/反馈面向稳定句子身份，不误套旧语块。
sentence_study_sessions/events/progress与旧light_study/four_step分账。客户端以独立事件键持久保存，再顺序提交；事件ID、版本和内容哈希防重。恢复先提交合法原事件，再处理真实冲突。
GET、重复回执和resume均验证资料有效性。评分更正使用原before快照和原时刻，不增加次数。
## 老师与声音
coaching适配既有Companion消息、Memory和Runtime，区分辅助/独立及局部修正；独立审核后确认问题可记忆，反馈不隐式制卡。
LightAudioPlayer支持natural/quick；播放所有权与代次防迟到插播，共用MiMo缓存与合成队列，快捷声线使用本机服务。
## 运行
完整回答统一full_answer_attempts引用旧来源ID。answer_audio_uploads保存分片/发布检查点；answer_audio_assets保存校验后的私有原件元数据，按ID同源Range回放。MediaRecorder/上传在浏览器IndexedDB暂存，正式保存与AI无关；历史按来源条件回听。music-metadata验证实际容器和音频元数据。
backup/stream-archive提供v2 AES-256-GCM流式二进制备份，先认证/校验再恢复，原声按哈希保留，删除标记优先；旧v1兼容。user_settings.speech_preferences_json保存双角色偏好，不含Key。
桌面使用预构建release，dev/E2E隔离。release绑定源码指纹和Prompt副本，ROASTDUCK_PROMPT_ROOT读取对应版本；成功后激活，保留上一版本并复用健康实例，不关闭其他程序。
Key仅服务端，业务备份包含句子记录与版本、排除凭据。编号迁移先备份。开发只用Mock和隔离库，安卓/同步仍冻结。

# 原意、自然回答与句子教材
状态：2026-09-10现行；SENTENCE_STUDY优先，旧四列合同归档archive/pre-sentence-study-2026-09-10/MATERIAL_SELECTION.md。
## 来源
单框中文/英文/混合输入按原文引用覆盖；非回答指令、原意、局部修正和疑似转写分开。明确意思即使没有英文成功证据也要覆盖为准备意图；自然成功有实际引用，不因个人措辞偏好制造错误。
中文提示是想表达的内容，不是题目译文或诊断说明。根据英文整理的中文与用户中文分开标记；疑似prepared/preparing等保留待确认，不推断原音。个人事实、态度、数量、频率和语气程度不擅自改变。
## 生成与审核
新任务绑定sentence-material-v1，并使用sentence_intention.generator.v1、独立选材Reviewer、sentence_material.generator.v1、sentence_material.reviewer.v1；旧任务按原Prompt/Schema恢复。
每个明确意思组成完整、自然的句子；同句多个用法共享同一句，不因零Gap省掉正确句。用法需要唯一、准确的句内范围；注意点有本次真实错误证据，准备项不冒充错误。自然全文与句子版本相同。
完整自然句、中文对齐、原意、指代与话语功能都由独立Reviewer检查，结构和覆盖校验不直接批准语义。不确定段保留但不作为正确示范。
## 历史材料
读取已审核原句与意图，保持合格内容，针对多句卡、含元话语的提示和残余不自然表达修订。作者候选、独立Reviewer与覆盖审计分开。
sentence_material_editions追加保存候选、审核、哈希与可学句子；原回答、practice_materials和旧审核不覆盖。相同意思/英文稳定ID可保留，展示字段变化更新句子版本，旧会话不能复活旧指导。
开发期历史处理Runtime为0，产物仅留本机private目录；新用户网页生成才使用其API。

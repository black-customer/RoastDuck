# AI Provider与开发模型
状态：现行；2026-09-10。当前只开发Web，安卓冻结，实际完成见PROJECT_STATUS。
## 路径分离
应用Runtime使用DeepSeek V4.1 Flash，官方API名`deepseek-flash`。旧Flash配置归一为新名字，历史run的模型名不改写；记录请求模型与实际返回模型。开发Agent不绑定型号；开发历史内容离线、网络0，practice_offline_runs不冒充ai_runs。
轻学习展示、揭晓、自评、调度不调用文本AI。旧回答分析/纠错继续Runtime。模型增强不取消独立审核。
## 契约与恢复
pipeline/prompts中的Prompt版本化；输入/输出Zod校验；ai_jobs/ai_runs和材料阶段保存哈希、版本、幂等、状态、错误/runId。失败保留输入，不将拒绝当通过。
材料角色由stage-contracts声明；新句子任务绑定`young-us-v1`与新版诊断、选材、材料、审核Prompt。旧快照仍按创建版本恢复。明确重试未发布的旧失败材料时，可追加当前合同继任版本，保留同一Attempt、原文、旧阶段和运行证据；GET只读已有继任关系。
Responses走流式传输，必须收到completed终态才解析；思考增量不作为正文。严格JSON Schema在传输层将可选字段表达为可空，恢复后仍经原Zod验证，不放宽发布门。诊断/审核预算32768、选材/编译24576输出token（包含思考），low思考档、180秒上限；不能把未输出当成功。
选材和最终审核使用closed-ids-v1 Schema，把意思、表达和句子ID限制为当前闭集。无效Reviewer编号属于审核结构错误，不作废有效诊断；合法的approved:false仍是独立拒绝。唯一精确引用可以归一出现序号，显式省略引用必须由完整已定位的源片段组成；不修改原AI输出。
句子材料允许保留原意的自然改写，最终逐句/全文审核仍必需；纯中文准备项不能因为同单元有英文就推为错误。repairNeeded/minimalRepair的false对准备项有效。混合actualAnswer就是原始全文，不等同于只有英语。
已有四份positive回执可通过无Provider/无网络的finalizeCachedMaterial事务恢复；核验source/Prompt/hash/Run/原始缓存、最新审核和完整发布审计，缺证据或最新negative立即拒绝。只有最终审核明确支持的confirmed→preparation派生标签/计数/伪纠错可归一，教学文本与AI布尔值不改。
HTTP状态、参数名、请求ID、真实模型及已知usage可追溯，不保留上游原样报错正文。参数/鉴权/余额/限流/网络/超时/结构和审核失败分别呈现。网络及超时结果未知，不自动付费重试；修正传输版本后，旧参数错误允许明确重试。
离线需真实上下文、Prompt、输入/输出/候选哈希；底层型号未知就记录未知，不编造身份。
## 声音与隐私
桌面MiMo服务端；mimo-v2.5-tts、默认en-US/Milo男声，哈希缓存不全量预生成。安卓原生HTTPS适配器冻结保留，不冒充当前目标。
桌面Key仅.env.local；安卓只允许用户配置自己的Key，Keystore保护且仅原生网络层读取，固定Provider地址。禁止共享Key写APK/JS配置/Git/日志/备份/同步，公开Key须轮换。开发Mock，真实服务验收独立授权和留证，不自动购买额度。
旧角色说明：archive/pre-light-study-2026-09-07/AI_PROVIDER.md。

官方依据：[V4.1更新](https://api-docs.deepseek.com/updates/)、[Responses协议](https://api-docs.deepseek.com/api/create-response/)。授权验证按私有请求账本计数，失败同样占用额度，不能由普通自动化入口绕过。

# AI Provider与开发模型
状态：现行；2026-09-07。新增独立安卓目标，实际完成见PROJECT_STATUS。
## 路径分离
应用Runtime文本只从DEEPSEEK_MODEL读取deepseek-v4-flash。开发Agent不绑定型号；开发历史内容离线、网络0，practice_offline_runs不冒充ai_runs。
轻学习展示、揭晓、自评、调度不调用文本AI。旧回答分析/纠错继续Runtime。模型增强不取消独立审核。
## 契约与恢复
pipeline/prompts中的Prompt版本化；输入/输出Zod校验；ai_jobs/ai_runs和材料阶段保存哈希、版本、幂等、状态、错误/runId。失败保留输入，不将拒绝当通过。
现行材料角色由diagnostic-pipeline的STAGE_CONTRACTS唯一声明。引用覆盖错误有单独修复版本、一次有界尝试，下游仍独立审核。
离线需真实上下文、Prompt、输入/输出/候选哈希；底层型号未知就记录未知，不编造身份。
## 声音与隐私
桌面MiMo服务端，安卓通过原生HTTPS适配器调用；mimo-v2.5-tts、默认en-US/Chloe，哈希缓存不全量预生成。安卓目标不冒充已实现。
桌面Key仅.env.local；安卓只允许用户配置自己的Key，Keystore保护且仅原生网络层读取，固定Provider地址。禁止共享Key写APK/JS配置/Git/日志/备份/同步，公开Key须轮换。开发Mock，真实服务验收独立授权和留证，不自动购买额度。
旧角色说明：archive/pre-light-study-2026-09-07/AI_PROVIDER.md。

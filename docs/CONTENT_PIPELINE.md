# CONTENT_PIPELINE.md — Content Compiler 流水线

> 状态：历史，公共词书编译已退役；现行材料见MATERIAL_SELECTION，不作为轻学习发布门。

> 2026-09-06：以下为历史实现／兼容说明，不再约束新建学习。当前按回答／对话四步强化，权威为 PRODUCT.md、LEARNING_EXPERIENCE.md、FOUR_STEP_RECOVERY.md；不恢复词书或逐项双语境发布依赖。

> 这是整个 MVP 最关键的系统（主开发文档 §13-14）。目标：材料 → 结构化词书，且**可重复运行、可增量运行、可暂停恢复、可版本化、可审计、可重新生成、可检查覆盖率与来源、可去重、可质检**。

## 双轨制

- **确定性阶段**（普通 TypeScript 脚本，幂等可重跑）：Source Import、Normalize、Question Parsing、Canonicalize、去重匹配、Coverage Audit、Report、Book Compilation、DB Import。
- **AI 内容阶段**（开发期离线 Agent 批次）：Blueprint、Topic Domains、Chunk Candidate、语义裁决（Dedup 仲裁）、Content Enrichment、Pronunciation Enrichment、Quality Review。公共内容网络调用恒为 0，不写入 Runtime `ai_runs`；真实 Runtime 用户功能另走应用服务。

### 批次循环（可恢复离线模式）

```text
1. `npm run pipeline:run`
   → 脚本推进所有确定性阶段
   → 扫描 LLM 阶段的待处理单元，生成 pipeline/queue/<stage>/pending/batch-<n>.input.json
   → 打印队列状态
2. `npm run agent:content -- prepare --stage <阶段>`
   → 生成不可变输入 / Prompt 快照、manifest 和提交模板
   → Agent 执行；Reviewer 必须使用独立上下文逐项裁决
   → `validate --file <提交文件>`、`import --file <提交文件>` 校验并应用
3. `npm run pipeline:run`
   → 校验 output（zod + 交叉检查）→ 通过则入库并移入 done/，
     失败则写 rejected/<batch>.reason.txt 并重新生成批次
4. 循环直到 pending 为空；job 状态在 compile_jobs 表，随 git 提交
```

`ai:drain` 和 `process-quality-review.ts` 均已退役，调用会以退出码 1 明确失败，不删除历史证据。Agent 包适配器目前覆盖 dedup / content_enrichment / pronunciation_enrichment / quality_review；更早的内容阶段保留版本化离线队列，不得借旧入口调用 Runtime。

自动测试只能使用 Mock Provider、临时数据库和 `ROASTDUCK_QUEUE_DIR` 隔离队列；禁止在 CI 中调用真实 DeepSeek。将仓库内容发送给外部 API 与产生付费必须得到 Product Owner 明确授权，dry-run 不会发送内容。

## 阶段清单

| # | 阶段 | 类型 | 输入 → 输出 |
| --- | --- | --- | --- |
| 1 | `import_sources` | 确定性 | materials PDF → `pipeline/sources/raw/<book>/page-xxx`（文本或页图清单） |
| 2 | `extract_content` | 确定性+视觉 | 文本层直提；图片页渲染 PNG 由 Agent 视觉转录 → `sources/<book>.json`（questions + demo answers，带 file/page 溯源） |
| 3 | `parse_questions` | 确定性 | 题干清洗、Part/Topic 归组、norm_text 跨 PDF 去重 → questions 表 + `sources/questions.json` |
| 4 | `blueprint` | LLM 批次 | 每题 → Answer Dimensions；每 Topic → Domains（prompt: blueprint.md） |
| 5 | `chunk_candidate` | LLM 批次 | 每题 × 每维度 / 每句 → Chunk 候选（prompt: chunk-candidate.md） |
| 6 | `canonicalize` | 确定性 | 形态归一、canonical/display 生成、Pattern+variants 识别规则 |
| 7 | `dedup` | 确定性+LLM 批次 | canonical/归一匹配合并；近似候选 → 语义裁决批次（合并/独立 + 理由） |
| 8 | `content_enrichment` | LLM 批次 | 在不改英文原句与来源的前提下，补齐英文简释和全部例句中译；本阶段无批准权 |
| 9 | `pronunciation_enrichment` | LLM 批次 | 仅为缺失项生成指定口音的完整 Chunk IPA；新生成题库材料默认 en-US，真实来源保留原口音且不得猜测；既有 en-GB 数据不伪装成 en-US，后续按证据迁移 |
| 10 | `quality_review` | 独立 LLM Reviewer 批次 | 仅接收释义、例句中译、IPA 与来源均已补全的内容；八维质检 → approved / edited / rejected，输出 provider/model/runId 证据 |
| 11 | `coverage_audit` | 确定性 | 题 100%、每 Dimension 有覆盖、每句有状态；产出覆盖报告；**Uncovered=0 才允许 compile_book** |
| 12 | `compile_book` | 确定性 | 书编译 + Compilation Report（§58 全字段）+ `pipeline/books/<book>.json` 导出 + DB 导入 |

## 增量与恢复

- 每个阶段只处理 `status` 落后于该阶段的单元（questions/sentences/chunks 都带状态机），新增材料只影响增量。
- 批次 ≤ 8 单元/批（题级）或 ≤ 20 单元/批（句级），失败不连坐。
- `compile_jobs` 记录阶段状态与错误日志；队列文件 + job 状态随 git 提交，跨会话续跑零丢失。
- 队列幂等键包含阶段、Prompt 版本、单元 ID 和完整输入哈希；内容改变后允许新批次，旧批次不覆盖。
- 公共 `quality_review` 只接受离线独立 Reviewer。apply 必须等待证据校验，然后核验每个裁决归属、重复、遗漏、编辑字段及当前内容快照；校验与入库在同一短事务内。
- 发布审计反查原始提交、输入、Prompt、manifest、checkpoint、上游哈希及编辑后内容。历史状态字符串不能替代证据，失效条目阻断发布；修代码不会自动补造语义审核。

## 版本化

- `pipeline/prompts/<stage>.md` 顶部 YAML：version、applies_to、notes；`prompt_versions` 表记录文件 hash。
- chunk 行存 content_version（= compiler_version + 相关 prompt 版本摘要）。
- 报告含 source_version（materials 文件 SHA-256 清单）。

## 报告

每次 `compile_book` 自动生成 `pipeline/reports/<book>-<date>.md` + `.json`：

- Source count / Questions processed / Sentences processed
- Generated candidate units / Final units / Merged duplicates / Rejected units
- No-new-unit sentences（含理由分布）
- Coverage status / Uncovered questions（必须 0）/ Uncovered dimensions
- Failed records / Quality review failures
- Topic 级明细：Topic、Questions、Dimensions、Covered、Chunk Count、Uncovered

## Golden Test Set（`pipeline/golden/`）

- `golden/questions.json`：约 10 道代表题 + 人工期望（期望的维度与关键 Chunk，宽松匹配）。
- `golden/sentences.json`：约 30 句（简单句 / collocation / phrasal verb / idiom / sentence frame / grammar pattern / filler / 专有名词 / 长句），人工标注期望产出或 no_new_unit。
- `npm run pipeline:golden`：只跑 golden 集，输出 diff 报告；**改 Prompt / 改规则 / 改归一化后必须回归**，严重退化禁止合入。
- 纯逻辑阶段（normalize/dedup/segment）另有确定性单测，与 golden 回归互补。

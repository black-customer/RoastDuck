---
stage: chunk_candidate
version: v2
applies_to: 三类单元（question / topic / sentence）→ Chunk 候选
notes: v2 改为题级/话题级整单元产出，chunk 用 dimIds 标注覆盖关系。编码 docs/CONTENT_SPEC.md 铁律。
---

# 任务：把输入单元拆解为值得学习的 Chunk（语块）候选

三类单元，处理方式不同：

## kind=question（一道题 + 其全部语义维度）
为**每个维度**生成能表达它的核心 Chunk 集合。不是从某篇答案摘抄，而是覆盖"该维度下常用说法"；简单表达也必须收（如 be a student）。
每条 chunk 的 `dimIds` 填它覆盖的 dimId（可多个，如 reason 与 likes-dislikes 共用一条时填两个）。
**所有 dimId 都必须被至少一条 chunk 覆盖**（除非该维度确实无可学语言点，此时在 noNewUnitReason 说明）。

## kind=topic（话题 + 其语义域 domains）
做话题级**超额覆盖**：为每个 domain 生成该话题下值得积累的 Chunk（含通用域与特有域，如 Hometown 的 location/weather/food/transport/changes…）。
`dimIds` 填 domainId。**每个 domainId 至少一条**。

## kind=sentence（一句真实语料）
**只从原句提取**实际出现的 Chunk（忠于原文）。每条 chunk 的 `dimIds` 留空 `[]`。
若整句只是 filler / 寒暄 / 应答 / 无独立学习价值 → `chunks: []` 且写 `noNewUnitReason`（如 "纯应答词"）。

## Chunk 合格标准（铁律）

1. 小到容易学习，大到有直接理解或表达价值。
2. `unitType`：collocation / lexical_chunk / phrasal_verb / sentence_frame / construction / functional_expression / idiom。
3. 重要单词必须进入 Chunk：学 `do an internship`，不孤立的 `internship`。
4. **严禁机械 N-gram**：不要 "currently a"、"third-year computer" 这类碎片。
5. Pattern 与实例：仅宾语同类互换（stick to a plan/routine/schedule）→ 一张 Pattern 卡，实例放 `variants`；含义偏移则分开。
6. 自然口语优先；不为 Band 8 换书面词。
7. 完整覆盖：简单表达也收，不许因"太简单"跳过。

## 字段要求

- `displayChunk`：展示形态（保留自然缩写，可含 ... 占位，如 I'm currently a ... student）
- `meaningZh` ≤15 字；`englishGloss` 一句口语化英文
- `exampleEn`/`exampleZh`：自然例句+翻译（sentence 单元优先基于原句）
- `difficulty`：basic/intermediate/advanced（仅元数据）
- `variants` ≤8；`pattern` 可选；`tags` ≤6
- 同一单元内不要自我重复（先去重再输出）

## 数量

- question 单元：通常 8-16 条（= 维度数 × 每维度 1-3 条，按需，不凑数）
- topic 单元：通常 14-24 条（= 域数 × 1-2 条）
- sentence 单元：通常 0-5 条

## 输出

只输出 JSON：`{ "items": [{ "unitKey": string, "chunks": [...], "noNewUnitReason"?: string }] }`，unitKey 与输入一一对应。

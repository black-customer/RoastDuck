---
stage: quality_review
version: v3
applies_to: chunk 终审（八维质检）
notes: 恢复版。Reviewer 独立于 Generator；每条输入必须且只能给一个裁决，规则预筛不得替代本阶段。
---

# 任务：质检语块候选（Reviewer）

你会收到若干 chunk 候选（display、释义、例句、类型、来源）。对每条独立给出裁决：**approved / edited / rejected**。

## 必检八维（docs/CONTENT_SPEC.md §5）

1. **Naturalness**：母语者是否自然使用？
2. **Spoken English**：是否适合口语？（语法对但像论文 → edited 或 rejected）
3. **Meaning Accuracy**：中文释义是否准确、是否符合口语语境？
4. **Reusability**：是否真有学习价值？（过于琐碎或过于空泛 → rejected）
5. **Granularity**：切太碎（碎片）或太大（整段）→ edited 拆合
6. **Duplication**：是否与其他条同义重复？（疑似重复 → rejected 并注明）
7. **Source Faithfulness**：例句是否忠于来源语境？
8. **Example Quality**：例句是否自然口语、中文翻译是否准确？
9. **Pronunciation Accuracy**：完整 Chunk 的 IPA 与 accent 是否准确？

## 裁决规则

- 轻微问题（拼写、翻译可改进）→ `edited`，在 `edited` 对象里给出修正字段。
- 严重问题（不自然、无价值、误导、机械碎片）→ `rejected`，`reason` 必填。
- 预期通过率约 70-90%；如果你几乎全 approved，说明审查不够严格。
- 拿不准 → rejected（宁缺毋滥，但注意不要因"太简单"拒绝——完整覆盖是铁律）。
- 必须覆盖本批全部 `chunkId`，不得漏项、重复或添加批次外 ID。
- `rejected` 必须写具体原因；Reviewer 不得沿用 Generator 的自评结论。
- 只有在英文简释、全部例句中译、IPA 和来源都已补齐时才能审查；缺任一项就拒绝执行该批，而不是替 Generator 补齐。
- 修改例句时使用 `exampleEdits` 并携带原 `exampleId`；不得伪造来源或上下文。
- 修改 IPA 时使用 `pronunciationEdits` 并携带原 `pronunciationId`，不得改变来源口音。
- 输出必须记录本次独立审查的 provider、model 与唯一 runId，供发布审计追溯。

## 输出

只输出 JSON：
`{ "reviewer": { "role": "independent_reviewer", "provider": string, "model": string, "runId": string }, "verdicts": [{ "chunkId": string, "verdict": "approved"|"edited"|"rejected", "edited": {可选 Chunk 修正字段}, "exampleEdits": [{ "exampleId": string, "textEn"?: string, "textZh"?: string }], "pronunciationEdits": [{ "pronunciationId": string, "ipa": string }], "reason": string }] }`

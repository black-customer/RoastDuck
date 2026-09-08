---
stage: content_enrichment
version: v1
applies_to: Chunk 英文简释与例句中文补全
notes: 本阶段是 Generator，不拥有质量批准权；不得修改英文原文、来源或上下文。
---

# 任务：补齐 Chunk 英文简释与例句中文

你会收到一批 Chunk、例句、真实来源以及 IELTS 题目关联。只补齐输入中留空的字段：

1. `englishGloss`：用自然、简短、易懂的英文解释 Chunk 在给定语境中的含义，不得只是机械重复 Chunk。
2. `exampleTranslations[].textZh`：准确翻译对应的 `textEn`，保留语气、时态、否定和专有名词。

## 真实性边界

- 不得改写 `textEn`。
- 不得添加、删除或猜测来源、题目、前后文。
- `source_neighbors` 代表真实来源句；翻译只能忠于原句。
- `generated_ielts` 代表生成例句；可以参考关联 Topic / Question 理解语境，但不得声称它有真实前后文。
- 本阶段不得给出 approved / rejected，也不得填写 Reviewer 结论。
- 每个输入 Chunk 必须且只能返回一次；只返回原本缺失的字段。

## 输出

只输出 JSON：

```json
{
  "items": [
    {
      "chunkId": "c_xxx",
      "englishGloss": "仅当输入为空时填写",
      "exampleTranslations": [
        { "exampleId": "ce_xxx", "textZh": "仅为缺失翻译的例句填写" }
      ]
    }
  ]
}
```

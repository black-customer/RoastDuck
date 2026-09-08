# Correction Gap Generator v1

model: deepseek-v4-flash
role: generator
promptVersion: correction-gap-generator-v1

只从结构化纠错中的 Gap Expression 提取个人 Chunk 候选。

- 每个候选必须是推荐完整句中的原样连续子串，并关联正确 sentenceIndex。
- 补齐中文、英文释义、Pattern、美式 IPA、完整推荐例句中译和逐词中文注解。
- 不提取纠错之外的额外表达，不做批准决定。
- 输出必须符合 Personal Chunk Generator Schema。

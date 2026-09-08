---
stage: topic_domains
version: v1
applies_to: 每个 Topic 的语义域（超额覆盖）生成
notes: 首版。Topic 级语义域独立于逐题维度，用于兜住逐题蓝图遗漏的表达面。
---

# 任务：为雅思口语话题生成 Topic Domains（超额覆盖）

你会收到一个雅思口语话题（Topic）及其部分题目。请列出**这个话题下值得积累语言素材的全部语义域（Domains）**。

## 规则

1. 先列通用语义域（几乎所有话题都适用，但只在缺省时补）：
   `identity / behaviour / experience / attitude / preference / reason / change / past / present / future / comparison / frequency / degree / evaluation / examples`
2. 再列该话题**特有**的语义域，例如 Hometown：location、size、weather、transport、food、architecture、tourist-attractions、local-culture、changes、advantages、disadvantages、childhood-memories、future-development。
3. 通用域 + 特有域合计通常 10-18 个。
4. domainId 小写 kebab-case；nameZh ≤10 字；nameEn ≤6 词。
5. 只输出 JSON：
   `{ "topicId": string, "domains": [{ "domainId": string, "nameZh": string, "nameEn": string }] }`

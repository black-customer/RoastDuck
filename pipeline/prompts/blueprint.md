---
stage: blueprint
version: v1
applies_to: 每道 IELTS Speaking 题目的 Answer Dimensions 生成
notes: 首版。维度必须覆盖该题"任何合理回答"可能涉及的语义面；参考 docs/CONTENT_SPEC.md §2.1。
---

# 任务：为雅思口语题目生成 Answer Coverage Blueprint

你会收到一道雅思口语题目（Part 1/2/3）。请列出**回答这道题时可能涉及的全部语义维度（Answer Dimensions）**。

## 规则

1. **穷尽维度**，不是穷尽答案。维度是"任何合理回答都可能涉及的面"，例如：
   - Do you work or are you a student? → 身份、专业/工作领域、年级/工龄、学校/公司、喜欢与不喜欢、原因、未来规划、实习/兼职、变化（转专业/换工作）等
2. Part 1/3 的题目维度通常 4-10 个；Part 2 cue card 的维度通常 4-8 个（常对应 You should say 的要点 + 感受/原因/变化）。
3. dimId 用小写 kebab-case 英文（如 `year-of-study`、`likes-dislikes`、`future-plan`）。
4. dimZh 是简短中文（≤10 字），dimEn 是简短英文（≤8 词）。
5. 不要生成"答案示例"，只生成维度。
6. 题目跨话题通用维度（如 未来规划、原因、比较、频率、程度、评价、变化、过去/现在/未来）同样要列出。
7. 只输出 JSON，结构必须严格符合 Schema：
   `{ "questionId": string, "dimensions": [{ "dimId": string, "dimZh": string, "dimEn": string }] }`

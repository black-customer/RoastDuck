---
stage: dedup
version: v1
applies_to: 近似 chunk 对的语义裁决
notes: 首版。确定性规则（canonical 相等）先合并；只把近似对送来仲裁。
---

# 任务：裁决两个语块是否为同一学习单位

你会收到若干 pair（两个 chunk 的 canonical 形态 +释义+来源话题）。请判断每对是 **merge（同一学习单位）** 还是 **separate（不同学习单位）**。

## 判定标准

### merge（合并）
- 仅形态不同：did an internship / doing an internship / do an internship → 同一单位
- 同一 Pattern、仅宾语同类互换且含义不偏移：stick to a plan / stick to a schedule

### separate（保留两条）
- **动词不同且含义有实质差异**：get an internship（获得实习机会）≠ do an internship（进行实习）
- **中文译名相近但语用不同**：I'm planning to... / I'm hoping to... / I'm thinking of... 三者都保留
- 程度/对象/感情色彩不同：a big fan of ≠ be interested in

拿不准时倾向 separate（漏合的代价小于错合）。

## 输出

只输出 JSON：
`{ "verdicts": [{ "pairKey": string, "verdict": "merge"|"separate", "keepId": string, "dropId": string, "reason": string }] }`

verdict=merge 时 keepId/dropId 必填（keep 保留语义更核心/更通用的一条）；separate 时省略 keepId/dropId。

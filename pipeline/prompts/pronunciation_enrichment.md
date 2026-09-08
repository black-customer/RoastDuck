---
stage: pronunciation_enrichment
version: v1
applies_to: 缺发音数据的 Chunk
notes: 只生成指定口音的完整 Chunk IPA；结果仍须独立 Reviewer 审查。
---

# 任务：补齐 Chunk IPA

为每个输入 Chunk 返回完整 `displayChunk` 的 IPA：

- `targetAccent=en-GB` 时使用自然的现代英式英语发音。
- 如果 targetAccent 指向来源口音，只能依据输入中可验证的来源信息；信息不足时不要猜测，应让该批失败并等待人工补充来源。
- IPA 必须覆盖整个 Chunk，而不是只写其中一个词。
- 不得改写 Chunk、意义、例句或来源。
- 本阶段没有 approved 权限，结果仍需独立 Reviewer 审查。
- 必须覆盖本批全部 `chunkId`，不得新增批外 ID。

只输出 JSON：

```json
{
  "items": [
    { "chunkId": "c_xxx", "ipa": "/.../", "accent": "en-GB" }
  ]
}
```

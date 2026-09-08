# 第三方数据声明

> 状态：现行第三方声明。产品入口变化不删除授权与来源记录。

## 安卓与共享核心新增依赖（2026-09-07）

- `@capacitor-community/sqlite` 8.1.1：MIT，Copyright 2020–2024 Quéau Jean Pierre；应用私有SQLite连接。完整许可证保留于分发依赖，原生SQLCipher传递依赖的许可证须随正式APK许可清单一并交付。
- `@noble/hashes` 2.4.0：MIT，Copyright 2022 Paul Miller；浏览器/安卓与桌面一致的SHA-256，不改变既有输入编码。
- Vite 7.3.6：MIT，构建工具，固定当前已用版本；没有因为更换开发模型整体升级依赖。
- Java21仅为本机Android构建工具，不打入APK。正式APK尚未发布，完整传递依赖许可页仍需在发行前核查。

## ECDICT

- 用途：离线生成英文可点击小卡的基础中文释义、词形回退与英式音标候选；不在应用运行时联网。
- 上游项目：https://github.com/skywind3000/ECDICT
- 上游提交：`bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b`
- 输入文件：`ecdict.csv`
- 输入 SHA-256：`1A6947E04785DB63613A92E14903CDAE7954F7E84860B10E68E5C7CBB3F9C3CF`
- 许可证：MIT，见上游 `LICENSE`。
- 仓库策略：完整 62.9MB CSV 只放在被 Git 忽略的 `data/vendor/`；仓库只提交按本项目实际词汇抽取的可审计子集及构建报告。

ECDICT 的 `phonetic` 字段以上游所称“英语英标为主”。多词 Chunk 若没有整条词典音标，本项目只会把逐词音标标为 `ECDICT-composed`，不会把它冒充为连读或发音评分依据。

# 鱼块学英语（RoastDuck）

把自己想说的意思变成自然英文，逐句学习并按时复习。

当前是本机网页版：题目 → 中文/英文/混合想法 → 经独立审核的自然回答与教学 → 中文回想、按需拖动揭晓英文 → 看讲解 → 三档自评 → 可选再练／下一句。可以写下自己的尝试，输入可空；整题连续学习，随时暂停，不要求录音、打字或答对才能继续。本地再练不调用AI，主动请老师反馈才使用API。旧语块、四步和表格方式仅在“拓展功能”。

安装依赖使用 `npm ci`，初始化与备份使用 `npm run init`。日常版本先由开发者执行 `node scripts/desktop/build-release.mjs`，再通过桌面快捷方式或 `node scripts/desktop/start.mjs` 打开；成功构建后才切换版本，不在点击时编译。开发使用独立的 `npm run dev`。

新回答分析使用自己的 DeepSeek V4.1 Flash API（`deepseek-flash`）。自然跟练默认 MiMo Milo 美式年轻男声，支持独立声线、口音和播放倍速；未就绪时可以主动选择快捷声音。快捷试听优先缓存，否则立即使用本机声音，并明确音源。Key 在网页设置中填写，仅保存到本机服务端，不放入仓库。已有材料直接复用，不全量生成；公开安装不包含作者的私人学习材料。

句子中的中文或英文可以选中高亮，下次学习仍保留。审核确认的问题供老师在相关交流中参考，不把高亮、自评或一次错误当作永久能力标签。中文原意推荐填写但可以跳过；服务失败保留原回答并明确恢复方式。

安卓、同步和签名暂停。GitHub发布采用独立公开快照，不推送本地旧历史、私人资料或未经确认授权的教材及衍生内容。本项目尚未选定开源许可证；第三方依赖的许可证仍适用。

当前事实见 [项目状态](docs/PROJECT_STATUS.md)，产品范围见 [句子学习契约](docs/SENTENCE_STUDY.md)。历史词书和旧学习流程不再指导默认体验。

代码可运行不等于学习提效已被证实；真实声音、隔日回想和使用意愿由实际体验判断。


## Public development snapshot

This repository is a work in progress, not a finished release. No project-wide open-source license has been selected or granted. Third-party licenses remain applicable.

Private answers, conversations, databases, API keys, recordings, local evidence, and unlicensed teaching materials (including extracted/derived datasets) are not distributed. The owner’s original files and Git history remain local. Supply your own data and API keys; existing private learning materials are not included. Synthetic tests/demos are not real user answers.

A fresh installation starts with an empty personal database, not the owner’s IELTS question bank. Use your own legally obtained materials and credentials; FreeTalk can generate materials from your own conversations. Historical content-pipeline datasets are intentionally not distributed. See docs/PROJECT_STATUS.md for the actual implemented and verified scope. CI remains enabled; an upload is not a claim of verified learning effectiveness.

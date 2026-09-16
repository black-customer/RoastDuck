# 鱼块学英语（RoastDuck）

把自己想说的意思变成自然英文，在完整语境里学习，留下每一次回答的声音。

当前是本机网页版：选题／继续 → 中文、英文或混合表达 → 经独立审核的自然回答与教学 → 整题中英对照、按需拖动揭晓 → 可选再练或重答 → 间隔复习。整份回答按原句序显示，学过的句子不消失；可以随时换题，不以评分、录音、打字或答对作为继续的门槛。教学、草稿、高亮和老师帮助就地使用。旧语块、四步和表格方式仅在“拓展功能”。

每次完整回答可点击录音或上传 MP3、M4A、WAV、WebM、Ogg 原声。只保存音频也可以，不自动转写、不发送给 AI、不评分发音。可从题目查看历史、任选两次原速回听并写下自己的观察。录音最多10分钟、单文件50 MiB；设置中的加密备份可包含原声，需自行保管备份密码。麦克风只在主动点击后请求，拒绝权限仍可上传或使用文字。

安装依赖使用 `npm ci`，初始化与备份使用 `npm run init`。日常版本先由开发者执行 `node scripts/desktop/build-release.mjs`，再通过桌面快捷方式或 `node scripts/desktop/start.mjs` 打开；成功构建后才切换版本，不在点击时编译。开发使用独立的 `npm run dev`。

新回答分析使用自己的 DeepSeek V4.1 Flash API（`deepseek-flash`）。自然跟练默认 MiMo Milo 美式年轻男声，老师默认 Chloe 美式女声，两组偏好独立；倍速不重新合成。未就绪时可以主动选择快捷声音，并明确音源。Key 在网页设置中填写，仅保存到本机服务端，不放入仓库。已有材料直接复用，不全量生成；公开安装不包含作者的私人学习材料。保存原声、本地回想与再练不产生模型费用，主动生成材料、请求老师反馈或示范声音才使用相应 API。

句子中的中文或英文可以选中高亮，下次学习仍保留。审核确认的问题供老师在相关交流中参考，不把高亮、自评或一次错误当作永久能力标签。中文原意推荐填写但可以跳过；服务失败保留原回答并明确恢复方式。

安卓、同步和签名暂停。GitHub发布采用独立公开快照，不推送本地旧历史、私人资料或未经确认授权的教材及衍生内容。本项目尚未选定开源许可证；第三方依赖的许可证仍适用。

当前版本为 v0.4.0，实际交付与验证见 [项目状态](docs/PROJECT_STATUS.md)，产品范围见 [整题工作区契约](docs/CONTEXT_WORKSPACE.md)。历史词书和旧学习流程不再指导默认体验。

代码可运行不等于学习提效已被证实；真实声音、隔日回想和使用意愿由实际体验判断。


## Public development snapshot

This repository is a work in progress, not a finished release. No project-wide open-source license has been selected or granted. Third-party licenses remain applicable.

Private answers, conversations, databases, API keys, recordings, local evidence, and unlicensed teaching materials (including extracted/derived datasets) are not distributed. The owner’s original files and Git history remain local. Supply your own data and API keys; existing private learning materials are not included. Synthetic tests/demos are not real user answers.

A fresh installation starts with an empty personal database, not the owner’s IELTS question bank. Use your own legally obtained materials and credentials; FreeTalk can generate materials from your own conversations. Historical content-pipeline datasets are intentionally not distributed. See docs/PROJECT_STATUS.md for the actual implemented and verified scope. CI remains enabled; an upload is not a claim of verified learning effectiveness.

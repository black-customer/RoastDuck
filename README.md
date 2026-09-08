# 鱼块学英语（RoastDuck）

从自己的雅思回答中找到值得学习的英文表达，轻松学习并按时复习。

当前是本机网页版：题目 → 中文/英文/混合想法 → 独立检查的个人材料 → 轻松学 → 到期复习 → 可选无提示重答。轻松学只需点击，不要求录音、打字或答对才能继续；四步强化可选。快速回顾仅遮挡/揭晓/播放，不记录学习成绩。

桌面已有快捷方式可直接打开。开发启动：`npm run dev`；初始化与备份：`npm run init`。安装依赖使用 `npm ci`。

新回答分析使用自己的 DeepSeek API；示范声音使用 MiMo，失败时显示并使用系统备用声音。Key 在网页设置中填写，仅保存到本机服务端，不放入仓库。已有材料可直接学习，不重新全量生成。

安卓、同步和签名暂停。GitHub发布采用独立公开快照，不推送本地旧历史、私人资料或未经确认授权的教材及衍生内容。本项目尚未选定开源许可证；第三方依赖的许可证仍适用。

当前事实见 [项目状态](docs/PROJECT_STATUS.md)，产品范围见 [网页版计划](docs/WEB_USABILITY.md)。历史词书和旧学习流程不再指导默认体验。

代码可运行不等于学习提效已被证实；真实声音、隔日回想和使用意愿由实际体验判断。


## Public development snapshot

This repository is a work in progress, not a finished release. No project-wide open-source license has been selected or granted. Third-party licenses remain applicable.

Private answers, conversations, databases, API keys, recordings, local evidence, and unlicensed teaching materials (including extracted/derived datasets) are not distributed. The owner’s original files and Git history remain local. Supply your own data and API keys; existing private learning materials are not included. Synthetic tests/demos are not real user answers.

A fresh installation starts with an empty personal database, not the owner’s IELTS question bank. Use your own legally obtained materials and credentials; FreeTalk can generate materials from your own conversations. Historical content-pipeline datasets are intentionally not distributed. See docs/PROJECT_STATUS.md for the actual implemented and verified scope. CI remains enabled; an upload is not a claim of verified learning effectiveness.

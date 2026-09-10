# 测试与交付
可用 ROASTDUCK_TEST_DESKTOP_RELEASE 指定已验证的桌面 release，让浏览器回归直接验证即将交付的构建。测试服务仍强制 Mock、test-results/e2e.db 和空 Key；该变量不改变真实桌面应用。
状态：2026-09-10。按实际风险选择定向测试；完整质量门仍为npm run check。
## 当前测试
本轮PERSONAL_FOCUS：真实wire strict-schema/SSE终态与未知结果、实际模型、预算硬上限；旧失败合同显式继任与原文保留；高亮范围/重复词/换版/待提交/跨窗口与备份；Milo声线口音分离/即时倍率/缓存；审核错误记忆去重、地域风格排除及删除generation。专项Mock与授权真实请求分别记账。
句子主线：整题中文先行、揭晓无网络等待、三档自评、FSRS独立、最近评分更正、暂停/刷新、响应丢失、多窗口、失效材料与重复回执。
浏览器持久事件不能被另一窗口覆盖；恢复必须先确认原事件，而非仅归档后清空。辅助/独立输出无提示泄漏，失败不丢原文；确认错误由独立Reviewer入可撤销记忆。
旧light_study_v1/v2、四步和表格为拓展兼容测试，入口须明确extension；不把旧Chunk存在当当前句子可学。
## 命令与隔离
governance:check / lint / typecheck / test / test:integration / pipeline:golden / build:e2e / e2e:run / check。
完整门包含治理、Lint、类型、单测、集成、Golden、隔离构建、E2E和材料审计。审查runner复用同一完整门，未执行如实说明。
测试只用Mock与test-results隔离数据库，db/client的VITEST硬闸门保留。开发、E2E和桌面release构建隔离，端口占用不杀其他程序。
本机check/桌面使用data/desktop/runtime.json已配置Node；结果记录版本。遇到已知Windows原生退出仅记录，不扩大调查、不用一次通过宣称根因修复。
## 性能与视觉
scripts/benchmark-sentence-study.ts复制本机资料到隔离副本；--scale=10生成标记的放大性能夹具，不作为教学内容审核证据。浏览器连续30句记录实际揭晓/切句时间。
目标：可见点击反馈100ms内，已准备的揭晓/切句p95≤200ms，热态范围/开始/继续p95≤1秒；真实AI/冷音频单独记录。
桌面1280/1440、390/320、放大、键盘和真实长短内容集中检查后确认。机械检测、内容审核、截图、真实声音及学习效果不互相替代。

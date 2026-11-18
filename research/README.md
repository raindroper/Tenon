# 社区方案研究与架构修订

2026-11-02。目的：把个人代理从单轮工具演示推进到持续感知、多事项记忆、真实执行与交接的完整系统设计。现有应用仍是实验件，不能用其单场景成功代替整套架构验证。

先读 [架构修订](architecture-v2.md)，再按模块检查证据：

- [本人记忆与工作场景可靠性修复方案](owner-context-reliability-2026-11-10.md)：2026-11-10 针对身份遗忘、群聊关注误判和时间错误的根因、替换设计、迁移与验收。
- [本地 Harness 集成比较](harness-integration-evaluation-2026-11-12.md)：Codex 与 OpenCode 的同模型项目任务、持续执行、浏览器、取消及 Electron 内置验证。
- [持续接入与唤醒](ingestion-research.md)：11个候选、8类事件，provider游标、补账和模型唤醒分离。
- [Agent WeChat](agent-wechat-research.md) 核对个人微信历史、新消息、账号边界和只读接入的可行性。
- [记忆与事项隔离](memory-research.md)：thread/case、长期事实、经验、跨事项检索与版本冲突。
- [感知与个人理解](perception-and-user-model.md)：ActivityWatch、Screenpipe、Honcho、Memobase等实际接口与边界。
- [执行与成果交接](execution-research.md)：9个执行候选、本地companion、权限/隔离、代码与生活任务验收。
- [仓库元数据快照](repository-snapshot.json)：37个公开仓库初筛、10个核心HEAD；不是37个仓库都已安装或深度验证。
- [快照采集脚本](collect-repositories.mjs)：匿名GitHub API，仅收集公开信息；不会读取私人账户。

## 证据分级

| 级别 | 本轮含义 |
| --- | --- |
| 元数据 | 确认仓库、默认分支、更新时间、许可标识；不证明成熟度 |
| 官方声明 | README/产品文档写明能力；不视为实测 |
| 源码核查 | 找到具体接口、实现及局限，尽量提供锁定提交 |
| 本机或外部实测 | 必须另记录环境、版本、输入、结果和失败，不用README代替 |
| 持续试用 | 跨天稳定性、个人适配和真实收益，当前尚未完成 |

本轮主要达到源码/文档核查，不安装或启动候选，也未调用用户付费模型。之前的[真实模型闭环](../docs/validation-2026-11-02.md)只属于现有实验件，不能记为新底座验证通过。

## 选型约束

优先现成底座和模块，按缺口引入；不为每个框框安装一个框架。只保留一个主要事项/任务所有权和调度来源；短期状态、长期记忆和真实权限的边界要明确。当前Node版本可以升级，Windows可结合WSL2或独立服务，环境适配不能成为排除完整方案的首要理由。

上游main变化快，HEAD快照用于溯源，实际采用时锁支持的发布版本。GitHub的`NOASSERTION`是机器未识别许可证，不代表无许可；逐仓读取原文。研究文档记录了Screenpipe自定义许可、Honcho/OpenRecall的AGPL、MCP许可迁移、n8n/部分企业目录的区别，不将“可读源码”与“可任意复制或生产可用”混为一谈。

# 社区参考与复用决策

研究核查日期：2026-11-02；当前接入清单更新于2026-11-03。候选表保留选型时的研究记录，不等于当前已安装或运行。现已选定Mastra主运行时，下面其他完整代理仅为历史备选，不同时常驻。

## 本版直接使用

| 项目 | 本版复用 | 范围 |
| --- | --- | --- |
| [Mastra](https://github.com/mastra-ai/mastra) | 原生Agent、thread/resource记忆及存储适配 | 当前唯一主循环；OM及向量检索尚未启用 |
| [Vercel AI SDK](https://github.com/vercel/ai) | DeepSeek provider与Mastra的模型接口 | 旧独立ToolLoopAgent循环已删除 |
| [p-queue](https://github.com/sindresorhus/p-queue) | 事项串行与跨事项并发 | 持久事件另存SQLite，内存队列不冒充耐久队列 |
| [react-markdown](https://github.com/remarkjs/react-markdown) | 成果和消息渲染 | 直接依赖；不启用任意原始 HTML 执行 |
| [chokidar](https://github.com/paulmillr/chokidar) / [fast-glob](https://github.com/mrmlnc/fast-glob) | 明确范围的文件监听与遍历 | 当前只观察用户选定的项目白名单 |
| [proper-lockfile](https://github.com/moxystudio/node-proper-lockfile) | 数据目录独占与工作区提交租约 | 复用成熟锁实现，并核对持有者身份 |

精确版本由package-lock.json固定。html-to-text/ipaddr.js随旧搜索实现移除。领域代码负责自主目标、证据范围、个人理解和权限；当前未接第三方托管记忆服务。

## 个人代理与执行底座

| 仓库 | 值得复用的部分 | 本轮决定 |
| --- | --- | --- |
| [DeepSeek dsh-superagent](https://github.com/deepseek-ai/dsh-superagent-prototype) | Trigger、任务授权、隔离任务、outbox、少打扰原则 | 参考任务领域设计。主动接单要求已有实施方向，需另外建设目标发现；不直接运行其默认高权限执行器 |
| [OpenClaw](https://github.com/openclaw/openclaw) | Gateway、Control UI、渠道、插件、自动化历史 | 完整底座候选。当前 main 要求比本机 Node 22.19 更高的版本；新版 heartbeat 已迁移为 automation jobs，不能照旧教程实现 |
| [Hermes Agent](https://github.com/NousResearch/hermes-agent) | 技能积累、个人记忆、跨会话检索、cron | 完整 runtime 候选，优先用于后续对照试验。当前已有原生 Windows 路线，代价是增加 Python 运行环境和另一套生命周期 |
| [nanobot](https://github.com/HKUDS/nanobot) | 紧凑个人 bot、WebUI、Dream 记忆、goal、heartbeat | 可 fork 的轻量候选；默认 heartbeat 从活跃任务文件执行，仍需验证如何自主发现目标，以及重启恢复边界 |
| [NanoClaw](https://github.com/nanocoai/nanoclaw) | 容器隔离、定时与渠道技能 | 研究隔离设计。默认 SDK 与 Docker/WSL2 路径增加本轮成本；当前也有经 OpenCode 接 DeepSeek 的路线，不能称为不支持 |
| [Pi](https://github.com/earendil-works/pi) | SDK、会话、模型适配、通用工具与 RPC | 强替换候选，Node >=22.19 与本机匹配。若扩展为编程执行器，优先嵌入 SDK；默认 Shell 工具需置于选定隔离边界 |
| [AionUi](https://github.com/iOfficeAI/AionUi) | Windows 桌面、多引擎、WebUI、成果预览 | 成熟入口候选；个人目标与反馈层仍需定制，整包界面迁移成本高于本轮薄页面 |
| [Letta Code](https://github.com/letta-ai/letta-code) | 有状态身份、记忆块、MemFS、App Server、SDK、channels | 强候选。旧 letta 仓库已指向此处，V1 server 在 archive；当前包的 Node 要求高于本机22.19，不能按旧 Python server 教程直接安装 |
| [Mastra](https://github.com/mastra-ai/mastra) | TypeScript Agent、持久 workflow、挂起恢复、Observational Memory | 若需要跨日审批和复杂流程，优先评估替换当前执行层；首轮避免同时装两个工具循环 |
| [LangGraph](https://github.com/langchain-ai/langgraph) / [LangGraph.js](https://github.com/langchain-ai/langgraphjs) | 检查点、持久执行、interrupt、长期 store | 稳定编排候选。复杂工作流出现后评估，不自行造完整检查点平台 |

关键源码入口：[OpenClaw heartbeat migration](https://github.com/openclaw/openclaw/blob/main/docs/gateway/heartbeat.md)、[Pi SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)、[Letta 当前入口](https://github.com/letta-ai/letta)、[DeepSeek admission](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/prompts/admission.md)。

## 长期记忆候选

| 仓库 | 可以借鉴或接入什么 | 选型约束 |
| --- | --- | --- |
| [Mem0](https://github.com/mem0ai/mem0) | 偏好提取、分层记忆、多信号检索 | 开源与平台能力需区分；当前 README 的高分来自含私有优化的平台，不能直接当开源效果。模型生成的事实与用户事实仍须区分 |
| [Graphiti](https://github.com/getzep/graphiti) | 时间有效性、事实关系、来源 episode、历史查询 | Python 图构建框架，需另外提供图数据库、模型和 embedding；不是装上就完整可用的个人画像产品 |
| [Hindsight](https://github.com/vectorize-io/hindsight) | retain/recall/reflect、经验与世界事实、mental models | 优先研究‘从经历学到策略’；服务部署和推理成本需实测，不能仅凭宣传分数选型 |
| [Cognee](https://github.com/topoteretes/cognee) | 文档到知识图谱、结构化长期知识 | 多存储和服务成本需评估；本轮不为少量资料先引入完整图谱基础设施 |
| [MemOS](https://github.com/MemTensor/MemOS) | 长期记忆与跨任务经验复用 | 保留为学习层候选；需要针对本人的事实更新、冲突、纠正和删除案例测试 |

首版 SQLite 只保存原始证据、可纠正的条目、议程和反馈，是事实底账；关键词 recall 是初版检索，不称为已具备成熟语义长期记忆。需要语义检索、关系推理或长期 consolidation 时，先实测上述模块再替换，避免从零实现向量库和图谱。

## 界面与浏览器执行候选

| 仓库 | 借鉴或复用方向 | 当前状态 |
| --- | --- | --- |
| [Open WebUI](https://github.com/open-webui/open-webui) | 设置、资料和对话入口、模型配置 | 产品模式参考；不是本版代码来源，若复制代码需另核当前许可证 |
| [LibreChat](https://github.com/LibreChat-AI/LibreChat) | 工具结果、Artifacts、多模型与 MCP | 产品模式参考；整包更适合需要完整多用户聊天平台时评估 |
| [LobeHub](https://github.com/lobehub/lobehub) | Agent 操作界面、资料与任务呈现 | 当前旧 lobe-chat 地址已重定向；评估实际自治与调度能力，不按旧聊天 UI 印象判断 |
| [Stagehand](https://github.com/browserbase/stagehand) | TypeScript 浏览器操作、结构化提取、会话持久化 | 首选浏览器执行候选；接入时按当前 SDK 文档实现，不自写 DOM 规划器 |
| [browser-use](https://github.com/browser-use/browser-use) | Python 浏览器 Agent 与浏览器运行服务 | 备选执行器，需额外 Python 或远程服务 |
| [OpenHands](https://github.com/OpenHands/OpenHands) | 通用开发任务、隔离执行和成果验证 | 后续编程工作执行器候选；不作为个人目标发现的替代品 |
| [Playwright](https://github.com/microsoft/playwright) | 确定性浏览器自动化与端到端验证 | 浏览器基础层候选；它本身不决定个人目标 |

## 接下来按证据决定替换

当前先在已选Mastra底座上验证“自主发现→结果→反馈→后续行为改变”。新增浏览器或编程能力时，先评估现成SDK/MCP适配，按实际任务接入一个执行器；不自行实现通用浏览器规划器、向量库或另一套长期代理。需要更换底座时，使用同一组任务比较完成率、恢复和维护成本，完成替换后淘汰旧路径。

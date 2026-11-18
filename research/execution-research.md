# Tenon 执行面与真实工作交接研究

核查日期：2026-11-02。本轮只读核查官方文档、公开源码入口、许可证与远端 HEAD；未安装候选、未运行它们、未登录第三方账户、未调用付费模型。文中的“官方已有”表示有公开接口或实现资料支持；“建议”是本项目的设计判断，不表示当前 Tenon 已实现。

## 1. 结论：人格需要通过真实执行环境发挥作用

人格、偏好和习惯影响目标选择、优先级、沟通与取舍。它们不能代替访问真实文件、运行项目、管理日历、发送通知的工具，更不能自行赋予权限。数字分身应同时有一个长期存在的个人上下文，以及一个能被检查、暂停、接管和撤销的执行面。

建议优先复用现成底座，比较三条路线后再决定：

| 路线 | 主代理与执行面 | 适用与主要代价 |
| --- | --- | --- |
| A：OpenClaw 为主 | OpenClaw 承担长期会话、节点、工作树、权限与凭证体系；专业代码任务可分派 OpenHands；浏览器接 Playwright 或 Stagehand | 现成覆盖面最广，优先进入验证。需核实锁定版本在 Windows/WSL2 的节点、沙箱、凭证代理组合，避免把大量默认配置直接带入个人主机。 |
| B：Hermes 为主 | Hermes 承担个人记忆、技能学习、cron、消息网关；Docker/SSH 后端工作；通过 MCP 接业务工具，浏览器任务用专门执行器 | 学习与长期关系方向契合。需要处理持久容器在任务间的共享、外部副作用的细粒度授权，以及进程重启后的工作交接。 |
| C：Pi 为嵌入式核心 | Pi SDK/RPC 管会话、工具循环和中断；OpenHands 管代码工作空间；MCP/Stagehand/Playwright 管业务工具及浏览器 | 与 TypeScript 产品集成直接，边界容易按本项目定义；需要自己做薄层调度、授权、交接和恢复，不应重新实现底层工具循环、终端、浏览器和测试框架。 |

这三条路线都允许升级到候选支持的 Node.js LTS、采用 WSL2/Linux、Python 服务或 Docker。当前工作区的 Node 22 版本不是长期选型约束。最终取舍应由真实任务完成率、可恢复性与维护成本决定，而不是让已有最小原型的技术栈反过来限制方案。

## 2. 证据与版本记录

以下是本次用 `git ls-remote <官方仓库> HEAD` 读取的远端快照，便于后续锁版。不是发布版本推荐，也不代表这些提交已逐行审计；官网文档与远端 HEAD 可能不同步。实际采用时应选择通过验证的 release/tag 或提交，记录包锁、容器镜像 digest、迁移文档和插件清单。

| 候选 | 官方源码仓库 | 本次 HEAD |
| --- | --- | --- |
| OpenClaw | [openclaw/openclaw](https://github.com/openclaw/openclaw) | `9727efbc1bb6bc4f7c09ea04b20112820ff7e552` |
| Pi | [earendil-works/pi](https://github.com/earendil-works/pi) | `072e413bf3f8ee0cf8d9f2862fd1dbfc5d337afa` |
| Hermes Agent | [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) | `ea0cfc524e5ffff11aa49854e5269f86b96da26a` |
| OpenHands SDK / Agent Server | [OpenHands/software-agent-sdk](https://github.com/OpenHands/software-agent-sdk) | `f60b6828d27ced9e1363e32a424d851e5aa4f0c9` |
| OpenHands Sandbox Server | [OpenHands/sandbox-server](https://github.com/OpenHands/sandbox-server) | `43e91604ccd0a9960c8d5c52faadd60b30f10e63` |
| Stagehand | [browserbase/stagehand](https://github.com/browserbase/stagehand) | `b7a4b899079f198a0ee78a6dcb62ad02f545cf49` |
| Playwright | [microsoft/playwright](https://github.com/microsoft/playwright) | `02d29ad22035f26722227d68cff86f0905f56865` |
| Playwright MCP | [microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp) | `ec572ee8354015293bed67145db21eed386e876d` |
| MCP TypeScript SDK | [modelcontextprotocol/typescript-sdk](https://github.com/modelcontextprotocol/typescript-sdk) | `1e608caeb5130b2ad0fa067c84b26a038c1c6e36` |

## 3. 九个候选的具体复用接口与边界

### 3.1 OpenClaw：长期主代理、本地 companion、权限与凭证的优先候选

- **官方已有**：companion/headless node 可在真实宿主机执行 `system.run`，执行宿主应用自身策略；存在命令 allowlist、审批与审批上下文绑定。managed worktrees 提供工作树创建、状态与清理生命周期，不能只在自研代码里散落 `git worktree` 命令。protected secret / SecretRef 和适用出站路径上的凭证替换可作为 credential broker 起点。
- **源码与接口入口**：[执行审批文档源码](https://github.com/openclaw/openclaw/blob/main/docs/tools/exec-approvals.md)、[本地节点执行与策略](https://docs.openclaw.ai/tools/exec-approvals)、[managed worktrees](https://docs.openclaw.ai/concepts/managed-worktrees)、[protected secrets 与 egress](https://docs.openclaw.ai/start/why-openclaw/secrets)。可复用的操作面包括 `system.run`、`openclaw approvals get/set --node`、`openclaw exec-policy show`、文档中的 `worktrees.*` RPC；具体方法结构以锁定版本为准。
- **权限边界**：官方明确审批不是文件系统只读策略或多用户隔离边界；批准的命令按宿主 OS 权限工作。工作树隔离 Git 修改，不隔离文件读取、进程或网络。凭证句柄也不能阻止滥用已授权服务。需额外配置 OS/容器限制及网络边界，核实实际默认值，不能假定节点默认拒绝全部执行。
- **成熟边界与未验证点**：资料覆盖完整，适合先验证；未实测 Windows headless node、WSL2/Windows 路径映射、休眠断线、撤销正在执行任务、受保护凭证的具体代理覆盖范围。版本兼容与权限迁移是维护成本。
- **许可证**：仓库 [MIT](https://github.com/openclaw/openclaw/blob/main/LICENSE)；插件与外部服务逐一核查。

### 3.2 Pi：复用会话与 agent harness，避免重写工具循环

- **官方已有**：TypeScript SDK 与 RPC/子进程接入；`createAgentSession()`、显式 `cwd`、持久化 `SessionManager`、`session.subscribe()`、`steer()` / `followUp()`、`abort()`、`waitForIdle()` 与 `dispose()`。事件能区分消息、工具和运行生命周期，主产品不用靠扫描聊天文字判断任务状态。[SDK 文档](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)
- **源码入口**：[coding-agent 包](https://github.com/earendil-works/pi/tree/main/packages/coding-agent)、[扩展系统](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)。当前文档包名为 `@earendil-works/pi-coding-agent`；历史链接 `badlogic/pi-mono` 会指向迁移后的内容，集成前必须核对实际发布包及 API，不能混用旧示例。
- **权限边界**：扩展与 Pi 进程同 OS 权限，可以读取文件、凭证和历史。工具钩子可以做规则，但不构成强隔离。建议 Pi 在受限 worker 内，只注册任务需要的工具；将宿主机能力通过外部 broker 暴露。
- **成熟边界与未验证点**：适合作为可嵌入核心；长期生活调度、任务成果协议和权限体系不应假定由 Pi 自动提供。未验证其当前版本与现有 Tenon 的模型、事件、断点恢复、包名迁移兼容性。
- **许可证**：[MIT](https://github.com/earendil-works/pi/blob/main/LICENSE)。

### 3.3 Hermes：个人学习、消息与多种终端后端

- **官方已有**：个人记忆与技能、消息网关、cron、MCP；终端支持 local、Docker、SSH、Modal、Daytona、Vercel Sandbox，并可管理后台进程、读取退出状态。现成后端比自写跨平台 shell/进程生命周期更值得复用。[功能总览](https://hermes-agent.nousresearch.com/docs)、[终端后端与进程工具](https://hermes-agent.nousresearch.com/docs/user-guide/features/tools)
- **源码与接口入口**：[tools](https://github.com/NousResearch/hermes-agent/tree/main/tools)、[Docker backend](https://github.com/NousResearch/hermes-agent/blob/main/tools/environments/docker.py)、[安全文档](https://hermes-agent.nousresearch.com/docs/user-guide/security)、[MCP 配置](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp)。复用 `terminal` / `process` 能力及后端选择，避免自行维护命令拼装和轮询。
- **权限边界**：local 后端拥有宿主权限；SSH 只是把执行移到远程账户，不自动形成最小权限。官方 Docker 后端为进程期间的长寿命容器，多个工具调用及部分子任务共享环境；不是每个子代理天然独立。容器转发的环境变量对其中代码可见，不能把 env 注入称作不可见凭证托管。应使用独立 profile/worker/挂载与任务级权限，另核查技能声明的凭证转发。
- **成熟边界与未验证点**：一体化个人代理方向有较多现成功能；未验证当前 Windows/WSL2 安装、消息渠道对审批和附件的支持差异、后台进程在崩溃后的恢复、共享容器的并发冲突。文档中的命令风险检查不能替代 OS 隔离或业务动作授权。
- **许可证**：[仓库 MIT](https://github.com/NousResearch/hermes-agent/blob/main/LICENSE)；外部托管 sandbox 与消息服务另计。

### 3.4 OpenHands Software Agent SDK / Agent Server：真实代码任务的专业执行器

- **官方已有**：`Conversation`、可替换工具、LocalWorkspace / RemoteWorkspace；Agent Server 通过 REST / WebSocket 暴露执行、对话、工具与工作空间。工作空间的命令结果包含 stdout、stderr、exit code 等，不必根据模型总结猜测成功。存在 Git diff、文件下载与动作确认 API。[当前组件架构](https://docs.openhands.dev/overview/introduction)、[Workspace](https://docs.openhands.dev/sdk/arch/workspace)、[Git diff API](https://docs.openhands.dev/sdk/guides/agent-server/api-reference/git/git-diff)
- **源码入口**：[SDK 工作空间导出](https://github.com/OpenHands/software-agent-sdk/blob/main/openhands-sdk/openhands/sdk/workspace/__init__.py)、[Agent Server 包](https://github.com/OpenHands/software-agent-sdk/tree/main/openhands-agent-server)。可复用 `RemoteWorkspace`、运行/暂停对话、事件读取、confirmation 响应与文件/Git API，产品只保留任务与交接适配层。
- **权限边界**：LocalWorkspace 是本地子进程，有宿主访问能力；RemoteWorkspace 的隔离程度取决于后端容器/VM配置。`AlwaysConfirm` / `ConfirmRisky` 属于动作授权，不能代替 sandbox；风险分析器也是辅助判断。[确认策略](https://docs.openhands.dev/sdk/guides/security)
- **成熟边界与未验证点**：适合代码执行，不应自动承担生活人格和所有长期代理职责。当前官方已拆分 SDK、Agent Server、Sandbox Server、Agent Canvas；旧 `openhands serve`/旧 CLI 已标记弃用。未验证 DeepSeek 在复杂代码任务上的完成率、预览端口转发、实时接管和本地仓库映射。
- **许可证**：[SDK MIT](https://github.com/OpenHands/software-agent-sdk/blob/main/LICENSE)；不能据此推断整个生态、企业功能及云服务同一许可。

### 3.5 OpenHands Sandbox Server：复用 sandbox 控制面，审慎评估新拆分仓库

- **官方已有**：独立 FastAPI / sandbox 控制面，是从旧仓库保留历史抽取的模块，管理承载 Agent Server 的环境；提供已有打包、测试、Docker/Compose 入口。[README](https://github.com/OpenHands/sandbox-server)、[FastAPI 应用入口](https://github.com/OpenHands/sandbox-server/blob/main/openhands/app_server/app.py)
- **具体复用**：采用受支持 API 创建/管理 sandbox、连接 Agent Server、获取生命周期状态；Python服务通过 HTTP 与当前 Node 主产品协作，避免重写容器生命周期。若单人阶段直接复用 SDK 的 Docker workspace 已满足需求，可以暂不引入完整控制面。
- **权限边界**：控制面可管理容器，不应和不可信 agent 共用权限。官方 Compose 挂载 Docker socket；不能把此 socket 交给工作容器或模型 shell，否则容器边界可能被绕过。是否挂载用户目录、如何转发网络和端口，仍需部署方配置。
- **成熟边界与未验证点**：基础模块有历史，不代表新仓库打包路径和每种部署都经过本项目验证；尚未测试跨平台、版本联动、重启回收、资源泄漏及升级。优先对照 SDK 直接 Docker 路线，避免为了“全套”引入不必要服务。
- **许可证**：[LICENSE](https://github.com/OpenHands/sandbox-server/blob/main/LICENSE)明确普通部分 MIT，`enterprise/` 另行许可；采用时核对实际目录及镜像组成。

### 3.6 Stagehand：自然语言浏览器工具与人工提交关口

- **官方已有**：`Stagehand.create()` 接 Browserbase、`localBrowser.launch()` 或 `localBrowser.connect({cdpUrl})`；`act` / `extract` / `observe` 可与确定性操作混合。不是只能购买云浏览器才能使用。[浏览器配置](https://docs.stagehand.dev/v4/configuration/browser)、[源码仓库](https://github.com/browserbase/stagehand)
- **具体复用**：业务 API 不足时，用于寻找入口、提取候选、填表、准备购物车；将读取/准备和最终提交拆成不同工具。官方提交审批 recipe 展示应用冻结表单内容、确认后单次提交；该示例不是完整的跨重启审批服务。[审批 cookbook 与源码入口](https://docs.stagehand.dev/v4/cookbooks/approve-form-submission)
- **权限边界**：Stagehand/CDP 本身不会把用户的全部登录状态变成最小权限；专用浏览器账户、网络限制、credential broker、可变字段复核仍需外层实现。审批回执也不是可无限重放的恢复凭证。
- **成熟边界与未验证点**：适合作为浏览器组件，不是个人代理底座的全部。当前 V4 与旧版本 API不同；未实测 DeepSeek适配、国内站点风控、验证码、浏览器接管、长时间等待后的session有效性。下单超时属于可能已提交，必须先核账，不能直接重试。
- **许可证**：[Stagehand MIT](https://github.com/browserbase/stagehand/blob/main/LICENSE)；Browserbase/模型调用有独立服务条件和费用。

### 3.7 Playwright：可重复执行与验收的优先工具

- **官方已有**：跨浏览器自动化、测试运行器、自动等待、断言、截图、trace与HTML报告。优先用于已明确流程和可验证条件，减少每一步都交给模型判断。[安装与能力](https://playwright.dev/docs/intro)、[断言](https://playwright.dev/docs/test-assertions)、[Trace Viewer](https://playwright.dev/docs/trace-viewer)
- **源码与具体接口**：[microsoft/playwright](https://github.com/microsoft/playwright)。复用 `chromium.launch()`、`browser.newContext()`、`page.goto()`、定位器及 `expect(locator)`；`context.tracing.start/stop()` 留下可检查证据。开发任务交付真实报告与trace，用户可用 `playwright show-trace` 检查失败步骤。
- **权限边界**：browser context 隔离 cookie/storage，不是 OS sandbox；测试脚本仍可拥有 Node文件/网络权限。trace、截图、storageState可能包含私人数据，不应默认上传公开站点。允许的测试脚本在隔离执行器中跑。
- **成熟边界与未验证点**：成熟的确定性执行/验证组件；不负责个人记忆、目标分解或账号授权。测试断言覆盖了什么、是否只用mock、测试是否绕过真实路径，必须在交接时说明。未运行实际浏览器兼容或安装依赖。
- **许可证**：[Apache-2.0](https://github.com/microsoft/playwright/blob/main/LICENSE)。

### 3.8 Playwright MCP：复用浏览器工具接口，避免自造截图/点击协议

- **官方已有**：将 Playwright 页面交互和 accessibility snapshot 暴露给 MCP client，可作为现成浏览器工具服务；CLI+Skills 也是官方提供给代码代理的接入方式。[官方 README 与接口](https://github.com/microsoft/playwright-mcp)
- **具体复用**：使用其浏览器导航、快照、点击、输入、截图等工具，在独立profile或容器中连接主代理；根据任务筛选可见工具。MCP适合保持浏览器状态的探索流程，固定验收仍交给测试脚本。
- **权限边界**：官方明确 MCP server本身不是安全边界；`allowedOrigins`、`blockedOrigins`、workspace roots与secret结果替换都是有限护栏，不提供完整网络/文件隔离。尤其不能把secret redaction称作模型无法读取凭证的保证。需要外部进程、文件、网络和动作权限控制。
- **成熟边界与未验证点**：工具协议现成，能少写代码；未验证按任务隔离profile、工具白名单、持久连接及本地用户接管效果。对有全盘权限的MCP进程，单纯限制提示词或参数不够。
- **许可证**：[Apache-2.0](https://github.com/microsoft/playwright-mcp/blob/main/LICENSE)。

### 3.9 MCP TypeScript SDK：业务连接器与本地 broker 的标准接口

- **官方已有**：stdio / Streamable HTTP、tools/resources/prompts、client transport与OAuth辅助。当前V2主线拆为 `@modelcontextprotocol/client` / `@modelcontextprotocol/server`，历史V1单包API不能照搬。[源码与包结构](https://github.com/modelcontextprotocol/typescript-sdk)、[V2 client入口](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/packages/client/README.md)
- **具体复用**：用现成client进行工具发现/调用与传输；用 `McpServer.registerTool()` 暴露窄能力，如日历查询、创建事件、通知发送、购物车准备。优先寻找服务商维护的连接器，并核对实际权限、回执、幂等与版本；只为缺失的领域语义写适配。
- **权限边界**：MCP定义通信，不替调用方批准业务动作。HTTP token必须按audience与scope校验；不能把上游用户token原样接受后透传当授权方案。stdio子进程继承的环境、可读文件和网络同样需要限制。[安全规范](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices)
- **成熟边界与未验证点**：SDK/协议值得复用，但具体日历、通知、购物连接器尚未确定。官方 [reference servers](https://github.com/modelcontextprotocol/servers) README明确为教学参考、不是生产就绪保证；“官方仓库”不能替代本项目安全与业务验收。
- **许可证**：当前 [SDK LICENSE](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/LICENSE)与[reference servers LICENSE](https://github.com/modelcontextprotocol/servers/blob/main/LICENSE)处于MIT→Apache-2.0过渡；旧贡献中未同意重许可的部分保留MIT，普通文档涉及CC-BY-4.0。采用和分发时按锁定快照保留相应声明，不能统称所有MCP代码MIT。

## 4. 以 Muse 为参照的执行面设计建议

Muse官方描述的关键不只是后台大模型，而是持久的个人机器、分离的运行容器、凭证服务与授权控制。其Sentinel不受主代理支配。它提供设计参照，并未公开一个可直接自托管的完整Muse运行时。[Muse技术说明](https://research.meta.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse)

建议采用以下逻辑分工；可以由同一现成底座提供多个部分，不要求为每一部分新建微服务：

1. **个人上下文与目标层**：形成偏好、原则、阶段目标和证据，决定值得做什么。只向任务worker发送必要切片，避免把全部个人历史交给每个插件。
2. **任务编排层**：把自主想法转换为TaskSpec，分配真实执行器，管理排队、预算、取消、等待、重试与任务所有权。机器离线时保持waiting状态，不能写成已执行。
3. **权限与凭证层**：持有授权事实、目标服务和credential，形成不可由模型自己批准的动作许可。初始按项目/任务批量授予可逆工作权限，不把每条命令都变成人工流程。
4. **执行器层**：代码worker、浏览器worker、日历/通知等业务连接器。容器/VM执行代码；需要本地设备、应用或文件时由配对companion提供窄能力。
5. **验证与交接层**：读取执行器、目标系统和测试结果，形成可继续接手的工作包；决定done、prepared、awaiting_approval、failed或uncertain，不由模型一句“完成了”决定。

### 4.1 本地 companion 怎样获得权限

- 由用户首次明确授予一个工作根目录、执行环境及工具范围。记录目录真实路径、Git仓库身份、可写子目录、网络目标、预算与有效期；处理junction/symlink和Windows/WSL映射，不能仅检查字符串前缀。
- 代码任务默认在独立worktree和容器/VM执行，真实项目仍是交付目标。工作树是便于并行与回滚的编辑单元，操作系统隔离才限制文件、进程与网络。
- companion只执行匹配当前权限的任务；通过已配对通道取任务，使用现成框架的节点身份和认证，不暴露公网任意shell接口。撤销后拒绝新操作，并报告已开始的不可撤回请求。
- 宿主工具与不可信worker分开。不要向worker挂载全部用户目录、SSH目录、Docker socket或浏览器主profile；确需访问时以明确能力扩展，不靠模糊“完全信任”开关替代可审计范围。
- user takeover暂停相同浏览器/文件资源上的agent，避免与用户同时输入；恢复前重新读取页面、仓库基线和授权，不能沿用过时快照继续点击。

### 4.2 授权应允许持续工作，同时限制外部副作用

建议把日常代码编辑、受限依赖安装、构建、截图和本地预览作为一次项目授权的范围，代理可连续推进。邀请他人、发信、付费、发布、部署、合并到受保护分支等动作，按用户明确的长期或单次许可执行。许可需绑定对象、金额/上限、目的和时效；模型不能用“人格很像你”推导额外权限。

凭证应位于worker外的broker，模型拿句柄，broker按服务与允许请求使用真实secret；日志脱敏。若现成工具只能把token注入worker环境，必须如实视为worker可读取的凭证，选择短期、最小范围凭证，不能对外声称密码不可见。接管登录与验证码由用户在受信任界面完成。

### 4.3 最小任务与工作交接契约（设计草案，非现成上游API）

```text
TaskSpec:
  task_id / objective / acceptance_checks
  workspace_ref / repository_ref / baseline_revision
  executor_kind / allowed_capabilities / network_scope
  approval_scope / budget / deadline / parent_task

ExecutionReceipt:
  task_id / attempt_id / executor_identity / timestamps
  actual_workspace / revision_before / revision_after
  commands_and_exit_codes / external_resource_ids
  approval_receipts / changed_files / result_refs / errors

Handoff:
  actual_state: prepared | verified | awaiting_approval | uncertain | failed
  review_url_or_path / preview_lease / diff_or_commit
  verification_results / external_readback
  open_questions / next_action / resume_handle / rollback_options
```

这些记录本身是索引和证据容器，不是任务完成的证明。每个acceptance_check必须连接实际测试、仓库或第三方系统状态。工具返回超时、进程丢失或提交后断线时，应保留uncertain并核对目标系统，不用自动重放证明“勤奋”。

## 5. 两个真实任务的交接与验收

### 5.1 工作案例：替我优化真实项目的界面

人格输入可以是“喜欢克制排版、阅读优先、不喜欢工作台式面板”。代理将偏好用于方案选择，但必须检查真实项目、现有规范和用户目标。

| 阶段 | 真正要操作的对象 | 可核验交接 | 不能据此宣称完成 |
| --- | --- | --- | --- |
| 领任务 | 用户指定repo、基准revision、当前dirty状态与授权目录 | 仓库身份、基准提交、需保护的现有修改 | 创建了一个同名空目录 |
| 开工 | 独立worktree、实际锁文件/依赖、项目原有dev命令 | worktree路径、环境版本、安装/启动结果 | 只生成一段示例HTML |
| 修改 | 真实组件、样式、资源，必要时更新项目原有测试 | diff、实际文件、提交或可应用patch | 只有设计说明Markdown |
| 验证 | 真正运行的dev/preview、关键交互、响应式与适当测试 | 测试命令和退出码、浏览器断言、截图、trace与失败项 | 截图存在或HTTP200就代表功能正确 |
| 交接 | 可打开的工作树、带有效期的预览、diff/commit与后续操作 | 用户能打开、运行、继续改；给出启动与恢复方式 | 预览已过期却仍报告可用 |
| 发布 | 合并/部署作为独立且已授权的动作 | commit与部署版本对应、真实URL及关键流程核验 | 有build产物就算已上线 |

测试必须说明mock范围。功能要求涉及后台数据时，仅前端mock通过不能证明真实业务路径完成。验收器应在当前revision运行，禁止复用修改前的测试结果。回滚也不能抹除用户在基线之后的新修改。

### 5.2 生活案例：安排明天吃什么并提前准备

偏好输入包括明确的饮食喜好、预算、可用时间和用户主动提供的忌口。习惯推断影响候选排序，不应把猜测的健康状态或过敏事实当成已确认资料。

| 输出或动作 | 真正完成标准 | 状态与交接 |
| --- | --- | --- |
| 餐食方案 | 和明确条件、日历空档、可获得食材匹配；标注未知项 | 方案可用属于prepared；不等于买到或做完 |
| 日历安排 | 对授权日历创建真实event，回读ID、日期、时间、时区和提醒设置 | 返回目标日历链接/资源ID；冲突或写入失败不报告完成 |
| 主动提醒 | 调度任务实际触发，通知提供者接受/投递有回执 | queued / accepted / delivered / read分开；只有提供者支持读回执时才报告read |
| 购物准备 | 在目标商家形成真实清单/购物车，记录库存、配送时间、总价、有效期 | 给购物车/商品入口和待确认项；不把待支付写成已购买 |
| 下单 | 在批准对象、金额、地址范围内提交，并核对订单号及订单状态 | 提交超时先查订单；不盲目重试造成重复购买 |
| 事后学习 | 根据用户是否采用、具体评价及真实结果更新偏好 | 一次拒绝不能永久改写人格；保留形成依据和纠正入口 |

没有服务商连接器时，浏览器可以补位，但需承认登录、风控和验证码导致的用户接管。没有真实日历/通知/购物权限时，应明确给出prepared或blocked，不能因为写了一个JSON或Markdown就标记全部完成。中国生活服务的个人账户开放范围、渠道合规和真实可操作性目前尚未核实。

## 6. 首轮验证与未决事项

先验证执行与交接，不继续扩展界面。按同一套任务测A/B/C路线，避免为某底座另设宽松标准：

1. **项目任务**：对授权的真实repo创建工作空间，完成一个小改动，运行原有检查，提供能打开的预览与diff；中途停止/恢复，确认不覆盖用户修改。
2. **日历与通知**：使用测试日历写入并回读一条事件，实际投递一条通知，保留资源ID和投递状态；没有真实授权时等待接入，不以mock验收。
3. **权限故障**：访问授权外目录、凭证目标错配、授权过期、用户接管、离线companion、重复提交、执行器崩溃、预算耗尽；分别验证真实拒绝、排队、取消及uncertain处理。
4. **可持续性**：机器睡眠后恢复、代理重启、浏览器session到期、预览端口回收、依赖升级；记录恢复成功率、人工干预次数和实际成本。

重要未决项：

- 尚未实机安装或比较候选，不能宣称任何路线已跑通；不能用仓库star数替代可靠性证据。
- 需确定本地执行常驻在Windows原生、WSL2还是独立Linux主机，及电脑关机时哪些任务仍可在服务端完成。
- 需确定首批真实工作repo、日历提供者、通知渠道和购物服务，逐一审核服务商/社区连接器。MCP协议接通不等于业务账户已获授权。
- 需锁定OpenClaw/Pi/Hermes/OpenHands等版本，验证新旧API与迁移；尤其Pi包名、MCP SDK V2、Stagehand V4、OpenHands拆分后的组件。
- 需测试DeepSeek在工具调用、长轨迹代码修改、浏览器与中文个人场景的质量，并记录失败；本轮未付费测试，不给出未经测试的成功率。
- 需验证预授权粒度与真实隔离，避免把approve按钮、路径校验、Git工作树或浏览器context包装成绝对安全边界。
- 需定义每类任务的done条件、工作保留期、预览有效期、外部状态核对、接管方式和取消后的责任状态。
- 模型、云sandbox、消息渠道与商业connector成本另计；许可证依据锁定提交逐组件保留，不从单个主仓库推导整个生态许可。

优先建议：先以OpenClaw完整路线做执行/凭证/节点验证，Hermes作个人学习型一体路线对照，Pi+OpenHands作可控嵌入路线对照。最终只保留一套主要任务所有权与调度，其他组件作为专业执行器；不要让多个主代理同时自主管理同一浏览器、工作树或日历。

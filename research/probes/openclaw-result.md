# OpenClaw 完整底座隔离实机 probe

核查日期：2026-11-02。核心CLI/Gateway运行记录为23:44:53—23:48:51。本报告来自实际安装和无模型运行；不是仅阅读README，也不是对真实业务任务完成率的验证。

## 结论

**基础接入通过，业务代理能力未验证。** Windows原生环境下，OpenClaw `2026.10.9 (8b18b55)` 能在独立Node24.22.1上启动隔离Gateway、读写session元数据、持久化automation定义与运行回执、加载本地tool plugin并经HTTP返回结构化结果。禁止的`exec`工具返回404。Gateway停启后，case元数据、disabled schedule及先前确定性执行回执仍可读取。

此次没有运行agent/model turn，没有使用付费API Key，没有验证DeepSeek的工具循环、真实工作交付、日历/消息投递、node companion或OS sandbox。安装成功不等于业务验证通过；HTTP拒绝一个工具也不等于完整隔离。

本轮主runtime已由根代理选择Mastra；本probe支持将OpenClaw保留为未来完整替代底座或渠道/节点候选。**不建议在当前最小产品中同时叠加两套长期会话、调度与agent loop。**

## 隔离与安装范围

- 所有安装、runtime、配置、状态、workspace、日志与临时文件均在 `../.local\openclaw-probe` 内。
- 无全局npm安装，未改变系统PATH或默认Node，未安装Gateway系统服务。测试结束后普通`node --version`仍为`v22.19.0`。
- OpenClaw child进程采用环境变量白名单，不继承provider Key、NODE_OPTIONS或用户的应用配置变量；USERPROFILE / APPDATA / LOCALAPPDATA指向probe内的空home，显式设置OPENCLAW_STATE_DIR与OPENCLAW_CONFIG_PATH；同时使用`--profile another-rae-probe`。
- 未读取用户真实OpenClaw目录、生产配置、当前模型密钥、Codex/Claude登录文件或浏览器profile。
- config禁用heartbeat、自动cron、浏览器与Control UI。渠道未配置，Gateway health实际返回`channels: {}`。未额外安装channels、sensors或模型。
- 只启用自建无网络echo plugin；核心memory模块出现在Gateway加载列表，未配置embedding provider，未触发记忆推理。
- Gateway仅监听loopback的19391端口，使用本次生成的测试专用本地token；该token不是用户凭证。测试后进程已停止，端口连接检查为ECONNREFUSED。

安装来源与runtime：

| 项目 | 实际结果 |
| --- | --- |
| npm包 | `openclaw@2026.10.9`，官方公共registry，未使用用户npm配置 |
| 引擎要求 | npm元数据：`>=24.22.1 <25 || >=26.12.1` |
| 原机器 | Node22.19.0 / npm10.9.3；不满足OpenClaw runtime要求 |
| 隔离runtime | `../.local\openclaw-probe\node.exe`，实际版本`v24.22.1` |
| Node来源 | [nodejs.org独立Windows x64 exe](https://nodejs.org/dist/v24.22.1/win-x64/node.exe) |
| 校验 | 与[官方SHASUMS256.txt](https://nodejs.org/dist/v24.22.1/SHASUMS256.txt)中的`win-x64/node.exe`匹配 |
| SHA-256 | `d702daa815eabbff763c7d3808e235cf031cf2ca70211b56847bc72f51e240e5` |
| 控制面大小 | npm元数据OpenClaw解压约250MB；主包安装增加336个package，约1分钟 |

初装采用`--ignore-scripts --omit=optional --no-audit --no-fund`，避免无关可选依赖及任意安装脚本。安装由原有npm完成，因此产生EBADENGINE警告；实际运行始终显式调用probe内Node24。

## 实际命令与结果

下表中`OC`为：

```text
../.local\openclaw-probe\node.exe
../.local\openclaw-probe\node_modules\openclaw\openclaw.mjs
--profile another-rae-probe
```

它不是全局命令。环境与cwd由probe.mjs限定，不能直接去掉这些设置在用户真实profile上照抄。

| 实际操作 | 退出码/HTTP | 实际证据与解释 |
| --- | --- | --- |
| `npm view openclaw version engines dist.unpackedSize --json`，独立user/global npmrc与cache | 0 | 返回2026.10.9、Node引擎要求、250055860 bytes |
| `npm install --prefix <probe> --ignore-scripts --omit=optional --no-audit --no-fund --save-exact openclaw@2026.10.9` | 0 | 增加336 packages；安装日志保留，不能据此判定运行成功 |
| `node.exe --version` | 0 | v24.22.1 |
| `OC --version` | 0 | OpenClaw2026.10.9，首次出现fs-safe native缺失警告 |
| `OC setup --help` / `gateway run --help` | 0 / 0 | 核实baseline、skip、foreground及loopback等实际CLI选项；未启动交互onboarding |
| `OC config file` | 0 | 确实指向probe/state/openclaw.json |
| `OC config validate --json` | 0 | valid:true，warnings:[] |
| `OC sessions --json` | 0 | 隔离SQLite路径，初始sessions为空 |
| 初次`OC gateway run --port 19391 --bind loopback` | 1 | 缺少native Koffi模块，Gateway未启动；不是把失败隐藏成成功 |
| 安装明确的平台依赖`@koromix/koffi-win32-x64@3.3.2`、`@openclaw/fs-safe-win32-x64-msvc@0.26.0`，仍ignore-scripts/omit-optional | 0 | 只增加2包，约3秒；未盲目开启全部可选依赖 |
| 再次foreground Gateway | 健康探测200 | `/healthz`返回`{"ok":true,"status":"live"}`；结束由harness主动终止，不安装服务 |
| `OC gateway health --json --port 19391` | 0 | ok:true、channels空、heartbeatSeconds:0、childRuntime为probe内Node24 |
| `OC gateway call sessions.list --json --params '{}' --port 19391` | 0 | 返回原生session结构，初始无记录 |
| `OC automations status --json --port 19391` | 0 | SQLite持久存储，scheduler disabled，无自动wake |
| `OC gateway call config.schema.lookup --json --params '{"path":"plugins"}' --port 19391` | 0 | 返回真实config schema，确认plugins.allow/load/entries等接口 |
| `OC plugins inspect rae-probe --runtime --json` | 0 | plugin status:loaded，toolNames包含rae_probe_echo，无channels/provider/service |
| `POST /tools/invoke`调用`rae_probe_echo` | 200 | ok:true，content及details包含输入caseId、中文echo、sideEffects:false |
| `POST /tools/invoke`调用被deny的`exec` | 404 | `Tool not available: exec`；实际命令未执行 |
| `OC gateway call sessions.patch --json --params '{"key":"agent:main:rae-probe-case","label":"No-model probe case"}' --port 19391` | 0 | 返回sessionId及lifecycleRevision；只创建元数据，没有模型回复 |
| `OC automations add --name rae-probe-persist --every 24h --disabled --command-argv <纯Node JSON输出命令> --command-cwd <probe/workspace> --no-deliver --json --port 19391` | 0 | disabled:true的真实持久job；明确警告自动scheduler关闭 |
| `OC automations run <jobId> --wait --wait-timeout 20s --json --port 19391` | 0 | enqueued:true且completed:true，completionStatus:succeeded；diagnostics含子进程exitCode:0 |
| 完全停止Gateway后重新启动，再次`sessions.list` | 0 | 回读同一case key、label、sessionId及lifecycleRevision |
| 重启后`automations list --all --json`与`automations runs <jobId> --json` | 0 / 0 | 回读同一disabled job及上一次succeeded回执，未重跑该任务 |
| 结束后连接127.0.0.1:19391 | ECONNREFUSED | probe Gateway已退出；安装与证据保留 |

`setup --baseline`在本轮只核实help与官方语义，没有实际执行。为避免onboarding主动发现外部CLI/账户，本轮直接写入隔离的最小config并用CLI验证。该区别必须保留。

持久资源的实际ID：

```text
session key: agent:main:rae-probe-case
sessionId: <session-id>
lifecycleRevision: <session-id>
jobId: <session-id>
runId: manual:<session-id>:1793634495201:1
```

command job仅运行probe内Node，输出一个固定JSON，用于检验运行回执和退出码。输出中的`llmCalled:false`是脚本字段，不单独作为无模型调用的证明；无推理结论依据本轮没有发agent turn、无继承provider credentials、heartbeat与自动scheduler关闭、执行payload为确定性command。

## 可复用的实际适配入口

### 1. 使用Gateway作为完整底座时

产品通过受信任的loopback适配器调用原生Gateway RPC：session metadata、session生命周期、调度与run状态由OpenClaw拥有；领域工具作为插件返回结构化details及输出schema。当前已实测sessions.patch/list、config.schema.lookup、automations add/run/runs与HTTP tools/invoke，能避免重建整套会话、持久调度和工具分发基础设施。

真正的模型运行入口与长任务事件订阅尚未测试，不得把本轮metadata probe写成“模型会话跑通”。下一次若选择该完整路线，应单独验证本地mock provider或获准的模型后端、取消与恢复，再做真实repo工作交接。

### 2. 当前已选Mastra主runtime时

保留Mastra作为唯一的会话与agent loop所有者。现阶段无需引入OpenClaw Gateway做第二套日常调度。将来若确需它的渠道或headless node生态，先定义窄adapter与单一任务所有权；必要时整套切换，而不是让两个主代理同时推进同一任务。

本轮最有用的实测信息是：OpenClaw不是“只能通过聊天窗口使用”的黑盒，已有原生会话RPC、持久automation回执和无需推理的直接工具桥接。复用这些接口可以保留未来迁移可能性。

### 3. 工具权限与真实隔离的区别

本轮plugin只做确定性echo，`tools.allow`只授予该能力，并deny exec/process/browser/web/message等；HTTP的exec拒绝是有效的工具可见性/调用策略测试，不是容器、网络或文件系统隔离测试。

plugin本身是受信任宿主代码，拥有Gateway进程的OS权限。必须只加载审查并锁版的插件。`POST /tools/invoke`使用共享token时属于整个Gateway的operator接口，不能把token发给浏览器前端或不受信任worker，也不能靠伪造更窄scope header把它变成多租户最小权限API。

automation的command payload由Gateway直接执行，与模型可见的exec工具策略是不同层面。即使`exec`工具被禁，获准的operator仍能创建command job；本轮正是显式授权的测试脚本。不能据此宣传“禁止exec就禁止了所有宿主执行”。

## 平台问题与未验证范围

- 初始裁剪optional dependencies导致Koffi native缺失；补装平台包后恢复。这是安装形态问题，不是Node22能直接兼容，也不说明完整可选功能全部可用。
- 第一次`OC --version`触发fs-safe native诊断；没有运行未审查的任意postinstall脚本。后续明确补齐平台二进制。
- 一次plugin配置验证虽然exit0，但stderr出现`CLI cleanup timed out: shared-state after 5000ms`。后续命令和Gateway可继续使用；该warning需保留，尚未归因，不算“没有任何问题”。
- 启动期health响应中eventLoop报告CPU degraded，modelRuntime未degraded。本轮非性能基准，不能将ok:true解释为延迟、资源消耗或长期稳定性已验收。
- 重启后的首次sessions.list曾短暂为空，随后再次读取返回持久case。状态加载/发布可能有短暂窗口，适配器不能把一次空列表当成已删除；应等待对应元数据ready并按revision核对。
- plugin API官方标为experimental，必须锁定host版本并测试升级兼容。echo仅验证注册、策略和JSON返回，不证明复杂业务连接器、网络权限与凭证broker已跑通。
- 尚未验证实际定时自动触发：schedule保留disabled，自动scheduler关闭；本轮验证持久定义、手动确定性执行与回执恢复。
- 尚未验证DeepSeek、真实LLM、native coding runtime、并发agent、headless node、工作树、安全沙箱、桌面/浏览器控制、远程凭证代理或用户工作交付。
- 尚未验证中文长期记忆、人格与习惯学习，也未触碰真实日历/通知/购物账户。

## 证据与复现

本轮新增/变更仅probe目录与本报告。未修改生产代码、全局Node或用户账号配置。主要证据：

- `.local/validation/`：实际运行harness，环境白名单、隔离路径、CLI执行和Gateway收尾。
- `.local/validation/`：逐条命令、开始/结束时间、退出码、stdout/stderr；包括失败Gateway及成功运行。
- `.local/validation/`、`native-install.log`、`package-lock.json`：实际安装形态。
- `.local/validation/`：本地tool plugin包、manifest与实现。
- `.local/validation/`：本轮独立config与SQLite持久数据。
- `.local/validation/`、`gateway.stderr.log`：Gateway运行日志。
- `.local/validation/`：官方Node校验结果。
- `.local/validation/`：测试结束时端口无监听。

harness实际运行方式，需在probe目录中使用其独立Node：

```powershell
& '../.local\openclaw-probe\node.exe' `
  '../.local\openclaw-probe\probe.mjs' initial
& '../.local\openclaw-probe\node.exe' `
  '../.local\openclaw-probe\probe.mjs' gateway --verify-persistence
```

`prepare`会重新写本probe的最小config；`--extended`会另建一个disabled job。已有证据不需要反复重跑。不要在真实用户profile上使用该测试脚本。

项目本地启动器可显式使用此Node绝对路径。若根代理希望统一runtime目录，可复制已校验的exe到`.local/runtime/node.exe`；本probe没有越界执行复制，也不需要更改系统Node或再安装npm的node分发包。

## 本次先读的官方文档

- [CLI/profile与JSON输出](https://docs.openclaw.ai/cli)
- [Gateway foreground运行](https://docs.openclaw.ai/cli/gateway/running)
- [配置路径与schema](https://docs.openclaw.ai/gateway/configuration)
- [Sessions](https://docs.openclaw.ai/cli/sessions)
- [Automation CLI](https://docs.openclaw.ai/cli/cron)
- [构建plugin及SDK接入](https://docs.openclaw.ai/plugins/building-plugins)
- [Tool plugins](https://docs.openclaw.ai/plugins/tool-plugins)
- [无需agent turn的Tools invoke API及operator边界](https://docs.openclaw.ai/gateway/tools-invoke-http-api)

这些文档支持接口与边界说明；是否通过由本地commands.jsonl中的真实返回决定，不由文档宣称决定。

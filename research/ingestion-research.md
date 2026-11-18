# 持续数据接入与唤醒调研

调研日期：2026-11-02。范围：官方文档与维护者仓库、部分触发器源码；未安装候选、连接私人账号或调用付费模型。下文区分已经核实的上游能力、建议的适配方式与尚未实测的部分，不能据此宣称 Tenon 已经接入这些来源。

## 结论

持续理解一个人，需要持续接入其真实信息流。手动上传只能补充资料，不能作为长期主入口。应优先复用现有连接器的 OAuth、增量游标、订阅续期、补账及投递机制，再把标准事件交给代理。**接收到事件、刷新个人世界状态、调用模型、打扰用户，是四个独立决定。** 定时唤醒用来检查尚未解决的目标、补偿漏报、回访试验和整理记忆，并不等于定时制造建议。

最贴近“避免全部自研同步底座”的候选是 Nango；最便捷的广泛触发入口是已有 n8n/Activepieces 或托管 Composio；OpenClaw 更适合承担渠道与常驻代理运行时。它们有重叠，不能把所有候选同时装入同一个个人系统。

## 11 个候选及实际复用边界

| 候选与主源 | 可用接口/真实实现 | 适配价值、边界与未验证点 |
|---|---|---|
| [OpenClaw](https://github.com/openclaw/openclaw)：[Gmail](https://docs.openclaw.ai/automation/cron-jobs/gmail)、[WeChat](https://docs.openclaw.ai/channels/wechat)、[Automations](https://docs.openclaw.ai/automation/cron-jobs) | `gog gmail watch serve` 将 Pub/Sub 的变更转成 Gateway hook；微信由腾讯团队的 `@tencent-weixin/openclaw-weixin` 外部插件实现 QR 登录、monitor、渠道标准化和回复；持久 Automations 负责定时运行。 | 可复用渠道和唤醒运行时。微信文档只声明直聊和媒体，不声明群聊，更不代表获得用户全部私人聊天。邮件正文是外部数据，应交给受限 reader；文档明确单独 session 不会自动限制工具。插件当前文档标出的 2.4.8 配对兼容问题需锁版本检查。 |
| [Hermes Agent](https://github.com/NousResearch/hermes-agent)：[Cron 源码说明](https://github.com/NousResearch/hermes-agent/blob/ea0cfc524e5ffff11aa49854e5269f86b96da26a/website/docs/developer-guide/cron-internals.md) | `cronjob_manage` 管理任务；`cron/jobs.py` 存储，`cron/scheduler.py` 判断 `next_run_at`，gateway 默认 ticker 执行；执行结果和最终投递状态分别记录。 | 复用已有调度、隔离运行和投递账本。时区、过期任务宽限、后台 provider 与本地 gateway 生命周期需按部署验证。Cron 能运行不意味着已有 Gmail/手机全量数据同步。 |
| [nanobot](https://github.com/HKUDS/nanobot)：[Concepts](https://github.com/HKUDS/nanobot/blob/384b7638307e5c9279286df78ace5759311ea603/docs/concepts.md)、[bus](https://github.com/HKUDS/nanobot/blob/384b7638307e5c9279286df78ace5759311ea603/nanobot/bus/queue.py) | `/trigger <name>` 创建会话入口，`nanobot trigger <id> "message"` 投递；local trigger 保存到工作区直至对应 agent turn 成功，忙时等待；有 heartbeat 与 Dream。 | 外部连接器可用它提交事件；认证、webhook server、格式转换仍由外部负责。文档明确 at-least-once；普通 bus 是 `asyncio.Queue`，不能把内存 bus 当耐久 inbox。未完成 subagent 重启后标 interrupted，不自动续跑。 |
| [Letta](https://github.com/letta-ai/letta-code)：[Schedules](https://docs.letta.com/configuration/schedules)、[Memory & dreaming](https://docs.letta.com/configuration/memory)、[Custom channels](https://docs.letta.com/self-hosting/channels/custom) | `letta cron add` 创建一次或周期 prompt；channel 接入外部会话；Dream 在完成一定 agent steps 或 context compact 后整理记忆。 | 适合持久身份/跨会话记忆和反思。官方明确 local schedule 只在 CLI/server 活跃时运行，云端另有服务端计时；不能将本地关闭后的“24 小时在线”当已解决。Dream 是消费已有经历，不自动产生邮箱/手机数据。 |
| [Nango](https://github.com/NangoHQ/nango)：[Checkpoints](https://nango.dev/docs/guides/functions/syncs/checkpoints)、[Records cache](https://nango.dev/docs/guides/functions/syncs/records-cache)、[Realtime syncs](https://nango.dev/docs/guides/functions/syncs/realtime-syncs) | `createSync()`；`getCheckpoint()/saveCheckpoint()`；`batchSave()/batchDelete()`；应用用 `listRecords()`/`GET /records` 按 opaque cursor 消费新增、更新、删除；`onWebhook` 与周期 `exec` 可共存。 | 优先验证的同步底座：有断点续跑、缓存增量、reset/emptyCache、删除表达和 webhook+poll reconciliation。checkpoint 不会凭空替你实现 provider 的正确增量查询；需检查具体预置 sync。默认晚写覆盖可导致旧 poll 覆盖新 webhook，官方推荐评估 `ignore_if_modified_after` 合并策略。云/自托管功能、许可、数据缓存位置与成本需另核。 |
| [Composio](https://github.com/ComposioHQ/composio)：[Triggers](https://docs.composio.dev/docs/triggers) | 对 connected account 激活 trigger instance；开发时 `subscribe()`，生产向应用 webhook POST 标准 payload；平台处理连接、重试和签名。 | 适合减少认证和多应用适配成本。当前官方表明确 Gmail/Google Calendar 属 polling，托管 OAuth 的最短间隔为 2 分钟；不能称为所有应用实时 push。公开 SDK 仓库不等于整个托管同步后端可免费自建。任意历史重放、删除补账和 cursor 可见性需实测，不能从“有重试”推导“永不漏报”。 |
| [n8n](https://github.com/n8n-io/n8n)：[GmailTrigger 源码](https://github.com/n8n-io/n8n/blob/a60e58c9ec8e3c832c8f94a7eaa25d3a594f0b4a/packages/nodes-base/nodes/Google/Gmail/GmailTrigger.node.ts) | `IPollFunctions.poll()`、workflow static data 保存时间边界、pending IDs、分页/backlog；接 Gmail 后用 HTTP Request node 投递 Rae 接口。 | 已有实例时最容易做第一批连接。源码明确 cursor 为 best-effort、下游按 message ID 幂等；有扫描页数、待处理数量及重试上限/放弃阀，因此仍需补账验证。用独立处理账本，避免为了去重而擅自标邮件已读。其[主许可证](https://github.com/n8n-io/n8n/blob/master/LICENSE.md)为 Sustainable Use License，企业部分另计，不能按 MIT 对待。 |
| [Activepieces](https://github.com/activepieces/activepieces)：[Gmail new-email 源码](https://github.com/activepieces/activepieces/blob/0e0eccc56015e5f46cf6dd8b594dfccf43556fd7/packages/pieces/community/gmail/src/lib/triggers/new-email.ts) | `createTrigger({ type: TriggerStrategy.POLLING })`，`context.store.get/put('lastPoll')` 保存时间边界，输出解析后的邮件与 thread。 | 可借成熟 pieces、OAuth 和流程编辑器。但已读的这个 Gmail 函数单次最多 20 封（初始化路径 5 封），没有消费 `nextPageToken` 的循环；不能假定大积压完整补取。同毫秒边界、历史窗口和停机恢复需要故障测试。[核心 MIT、EE 例外](https://github.com/activepieces/activepieces/blob/main/LICENSE)需区分。 |
| [ImapFlow](https://github.com/postalsys/imapflow)：[维护者 README](https://github.com/postalsys/imapflow/blob/7d797b988aba3ae7daec1079d650e72df3292815/README.md)、[RFC IDLE](https://www.rfc-editor.org/rfc/rfc2177) | Node IMAP 客户端；`getMailboxLock()`、`fetch()`/`fetchOne()`；自动处理 IDLE、CONDSTORE、QRESYNC 等能力协商。 | 非 Gmail/Outlook 邮箱的直接适配候选。持久 `(account, mailbox, UIDVALIDITY, lastUID/modseq)`，断线后用新 client 实例重连并补取；IDLE 只通知变化，不替代耐久日志。OAuth/应用密码、邮箱是否开放 IMAP 要分别核实。 |
| [ActivityWatch](https://github.com/ActivityWatch/activitywatch)：[API](https://docs.activitywatch.net/en/latest/api.html)、[window watcher](https://github.com/ActivityWatch/aw-watcher-window)、[AFK watcher](https://github.com/ActivityWatch/aw-watcher-afk) | 本机 bucket/event API；`get_events()`/`query()` 按时间窗读取；已有活动窗口和离开键鼠采集器。 | 适合“作息/专注/工具使用”低侵入信号，先本机按小时聚合再上传。AFK watcher 根据键鼠活动判断是否离开，不等于采集每次按键内容。事件 duration 可能续长，游标应时间窗重叠+ID/version upsert，不能只记最大 ID。窗口标题也可能含私人内容，应有 app/domain 排除。 |
| [screenpipe](https://github.com/screenpipe/screenpipe)：[Search API](https://docs.screenpipe.com/api-reference/search/search-screen-and-audio-content) | 本机 screen/audio history 查询 API，按时间、内容类别、分页读取 OCR/转写等记录；可作为已有采集端的检索来源。 | 能减少自行开发屏幕/音频观察器，但语义相关性、OCR 完整性和敏感信息范围需验证。持续捕获必须单独显式开启、有排除名单和暂停；不能默认开启全屏/麦克风，也不能把搜索记录视为所有点击/真实意图的完整日志。只读 search 适配，不向 agent 暴露其 raw SQL 能力。 |

注：上表比较的是接入/唤醒与数据可靠性，不是整体产品排名。主分支和产品文档变化快；上述 5 个源码快照已锁到调研时 commit，其余在选型后也应锁发布版本再验收。

## 8 类持续事件：能自动得到什么

| 事件类与例子 | 建议来源/游标 | 授权与能力边界 |
|---|---|---|
| 1. 邮箱：新信、取消、已处理、附件变化 | Gmail `watch`+`history.list` / Graph notification+folder delta / IMAP IDLE+UID | OAuth 最小只读 scope 或邮箱应用密码后可持续接入；正文访问权限和元数据权限不同。写邮件/发送另给权限。 |
| 2. 即时沟通：对代理说的话、允许的工作频道消息 | OpenClaw/nanobot channel，provider message ID 与 session/thread ID | bot 可以接收到的对话可自动进来。微信现有腾讯插件声明直聊；此能力不等于获取所有好友私聊、历史会话、朋友圈或群聊。 |
| 3. 日历/待办：会议改期、截止时间改变 | Google Calendar watch+syncToken；Graph event notification/delta | 授权访问的日历可持续同步。变更通知和实际“提前一小时”属于两个事件：后者应登记本地持久 deadline，而非等云日历再次变化。 |
| 4. 文件/工作材料：笔记保存、下载完成、仓库变化 | Nango 云端文件 sync；本机目录 watcher+文件hash/修改时间；git webhook | 只观察授权目录/库；watcher 提醒后 debounce 并读取稳定文件；不自动扫描整个主目录。删除也必须同步，不能只追加。 |
| 5. 电脑上下文：登录/解锁、休眠恢复、窗口与AFK | Windows EventLogWatcher+Bookmark、ActivityWatch bucket，恢复后补读 | 系统日志不是完整操作流水，内容依赖日志源及访问权限。文件 watcher 缓冲可溢出，必须定期补扫；Security 日志可能需更高权限。 |
| 6. Android：收到通知、app前后台/使用时段、授权健康信号 | 陪伴 app 的 NotificationListenerService、UsageStatsManager，本机 eventId+时间窗口 | 用户需开启通知访问/使用情况访问等独立授权；通知可能被折叠/隐藏，敏感通知另有系统限制；不能直接读取别的 app 私有 DB，更不能承诺所有操作或聊天全文。 |
| 7. iPhone：打开指定app、到达地点、邮件/信息、充电/睡眠 | 用户设置 Shortcuts personal automation→签名 webhook；支持的数据再走系统框架 | 这些特定自动化可持续上报，但先由用户在设备配置；不等于后台任意读取其他 app。Screen Time/HealthKit 各有独立权限和数据边界。 |
| 8. 内生事件：自主选定回访时间、目标无进展、工具结束、错误恢复 | runtime 持久 schedule、worker result、retry/reconcile/Dream | 无需新私人账号；agent 可以自己安排下次核查。区分执行/重试/反思时钟；没有新证据时允许不调用模型或不通知。 |

官方能力依据：[Gmail push](https://developers.google.com/workspace/gmail/api/guides/push)、[Graph Outlook permissions](https://learn.microsoft.com/en-us/graph/outlook-change-notifications-overview)、[Calendar push](https://developers.google.com/workspace/calendar/api/guides/push)、[Windows EventLogWatcher](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.eventing.reader.eventlogwatcher)、[FileSystemWatcher 溢出](https://learn.microsoft.com/en-us/dotnet/api/system.io.filesystemwatcher.internalbuffersize)、[Android 通知监听](https://developer.android.com/reference/android/service/notification/NotificationListenerService)、[UsageStats](https://developer.android.com/reference/android/app/usage/UsageStatsManager)、[敏感通知限制](https://developer.android.com/reference/android/Manifest.permission#RECEIVE_SENSITIVE_NOTIFICATIONS)、[Apple 自动化类型](https://support.apple.com/guide/shortcuts/enable-or-disable-a-personal-automation-apd602971e63/ios)、[Apple 通信触发条件](https://support.apple.com/en-ae/guide/shortcuts/apdd711f9dff/ios)、[iOS 容器边界](https://developer.apple.com/library/archive/documentation/FileManagement/Conceptual/FileSystemProgrammingGuide/FileSystemOverview/FileSystemOverview.html)。

## 推荐接入合同：来源 → 游标 → 耐久 inbox → 标准化 → 唤醒

以下是待实现的薄适配合同，不是当前代码已具备的 API。

```ts
interface SourceAdapter {
  capabilities: { push: boolean; incremental: boolean; backfill: boolean; deletions: boolean };
  poll(checkpoint: unknown): Promise<{
    events: RawEvent[]; nextCheckpoint: unknown; more: boolean;
  }>;
  verifyWebhook?(body: Uint8Array, headers: Headers): Promise<VerifiedNotice>;
  reconcile(checkpoint: unknown): Promise<ReconciliationResult>;
  renewSubscription?(): Promise<{ expiresAt: string }>;
}

interface NormalizedEvent {
  id: string; connectionId: string; source: string;
  externalId: string; objectId: string; objectVersion?: string;
  kind: string; operation: 'create' | 'update' | 'delete';
  occurredAt: string; receivedAt: string; threadId?: string;
  actor: string; payloadRef: string; trust: 'owner' | 'external' | 'system';
  provenance: string[]; policyVersion: string;
}
```

1. **Connector** 复用上游的 OAuth/token refresh、分页、错误分类、订阅与 reconnect；每个账户/文件夹/频道独立 checkpoint。优先 Nango 现有 sync 或现有自动化平台，不再写一整套连接器框架。
2. **Ingress** 验签、账户归属与配额检查；原始通知先可靠写入 inbox，再 ACK。provider 的“观察到更大游标”和“已消费游标”分开存。推送可能只是提示，worker 按已提交游标拉真正变更。
3. **Commit** 一页变更与该页 checkpoint 在消费端同一事务提交；事件用 `(connectionId, source, externalId, version/operation)` 去重。若适配器已保存 checkpoint，不再另造一套互相冲突的 provider 游标；本地仅维护自己的 cache 消费 cursor。
4. **Normalize** 保留正文引用、证据来源和删除墓碑；外部文本永远是输入资料。更新已有世界状态，而不是把邮件每次重读都当一条新事实。
5. **Wake planner** 按紧急性、关联未完成目标、信息增量和预算选择 `wakeNow / coalesceUntil / storeOnly / discard`。窗口切换、连续保存、群消息先合并；直接用户请求和关键 deadline 可以优先。执行队列按 agent/session 串行或受控并发，不能所有邮箱各自无限启动模型。
6. **Reliability** retry/backoff、in-flight lease、dead letter、replay、subscription renewal、周期 reconciliation；状态至少显示 `lastReceivedAt / lastSyncedAt / cursorAge / expiresAt / backlog / error / consentScope`。离线后补入先存事件再决定是否还有行动价值；错过的提醒不应逐个轰炸。

### 必须落地的 provider 恢复行为

- **Gmail**：通知只有邮箱与 `historyId`，需要 `history.list`；watch 最迟每 7 天续订，官方建议每天。通知可能延迟或被丢弃，因此定期 history 补查；游标过期会 404，需受控 full sync，保留旧去重账本并标注补取事件。参见 [push](https://developers.google.com/workspace/gmail/api/guides/push)、[sync](https://developers.google.com/workspace/gmail/api/guides/sync)。本机也可用 Pub/Sub pull，而不是为了 webhook 暴露整个个人控制 API。
- **Graph**：change notification 提速，folder delta 补账；完整消费 `nextLink` 后持久 `deltaLink`，它是 opaque URL，不自行拼 token。邮件增量以 folder 为单位。处理 `reauthorizationRequired / subscriptionRemoved / missed`，订阅中断后恢复同步。参见 [folder delta](https://learn.microsoft.com/en-us/graph/delta-query-messages)、[lifecycle](https://learn.microsoft.com/en-us/graph/change-notifications-lifecycle-events)。
- **IMAP**：IDLE 不可用时降级轮询；IDLE 长连接需要重发/重连，RFC 建议至少每 29 分钟更新。UIDVALIDITY 变化意味着原 UID 游标失效；重新建 mailbox 基线，再由独立事件账本去重。仅看未读邮件会漏掉已被其他客户端读过的邮件。参见 [RFC 2177](https://www.rfc-editor.org/rfc/rfc2177) 与上表 ImapFlow。
- **Nango**：官方已提供 checkpoint、cursor stream 和 reset；采用它时重点验证具体 sync 的历史范围、删除检测、缓存 TTL、重复更新、reset 是否清缓存及变更重放，而非重新实现它已有的同步引擎。Webhook+poll 的并发写入要用合适 merging strategy。参见 [checkpoints](https://nango.dev/docs/guides/functions/syncs/checkpoints)、[realtime](https://nango.dev/docs/guides/functions/syncs/realtime-syncs)。

## 选型与验收顺序

建议先用一个现成平台建立“邮箱 + 一条真实聊天渠道 + 一个授权目录/ActivityWatch”的连续观察，再考虑 phone companion。若用户已经运行 n8n/Activepieces，先复用已有部署；若要做产品化多账户同步，优先试 Nango 的预置 sync；若接受托管服务和数据处理范围，评估 Composio。代理运行时仅选一个，连接器统一向它的受控入口交付。screenpipe 是更高敏感度的可选增强，不作为启动前提。

选定后先用测试账号/脱敏 fixture 做故障注入：重复/乱序推送、同毫秒多事件、超分页积压、事件入库后崩溃、模型运行时服务重启、token 撤回、订阅过期、cursor reset、provider 删除、本机长时间离线。验收应证明“事件可找回、不会重复外部动作、来源被撤销后不再使用”，而不只是证明收到一封邮件就能启动 agent。上述候选本轮只读检查，尚未完成这些实测。

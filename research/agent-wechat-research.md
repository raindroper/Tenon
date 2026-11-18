# Agent WeChat 调研

2026 年 11 月 6 日核查。Agent WeChat 是社区维护的 MIT 开源个人微信客户端。现行 Rust 守护进程 `wx serve` 直接连接微信服务，桌面、CLI、OpenClaw 插件及自定义客户端共用带鉴权的 HTTP API。作者早期用 Frida 控制 Linux 官方客户端的方案属于旧实现。GitHub 最新正式版和 npm CLI 均为 v1.5.1，发布包含 Linux、macOS Apple Silicon、Windows 原生 CLI 和桌面安装包。 [项目仓库](https://github.com/thisnick/agent-wechat) · [v1.5.1](https://github.com/thisnick/agent-wechat/releases/tag/v1.5.1) · [早期实现](https://thisnick.me/blog/agent-wechat/)

## 能拿到哪些消息

手机扫码并确认后，守护进程作为该账号的一个登录设备，可同步普通私聊与群聊新消息，查询本地已保存历史、群成员与联系人。文本、图像、视频、文件和语音有对应读写路径。合并转发可解析为文本，内嵌附件仍是占位；撤回会产生独立事件。历史搜索范围取决于当前配置中已有的数据。新配置只从接入后逐步积累，微信不会把全部旧历史补发过来。 [项目功能](https://github.com/thisnick/agent-wechat#wechat-features) · [登录与历史](https://thisnick.github.io/agent-wechat/setup/connect/)

只有受支持的 **Linux 官方微信配置** 能用 `--official` 就地接管历史。接管会继续写入对应文件，要求先退出官方客户端、备份配置，并维持单写者。现有 Windows 或 macOS 官方配置的历史接管未获支持，即使平台已有原生程序。离线查看 Linux 配置的独立命令需可用的密钥和受支持的快照，无法监听新消息。同步未识别的控制记录可能卡住部分配置投影，已支持的新消息仍可入库。 [平台范围](https://github.com/thisnick/agent-wechat/blob/v1.5.1/PLATFORM-ACCEPTANCE.md) · [同步机制](https://thisnick.github.io/agent-wechat/how-it-works/wechat/)

上游记录了受控 Linux x64 真实账户的来信、推送触发、代表性媒体和若干群操作，也测试了离线模拟、断线重放及凭据隔离。发引用和链接卡片仍待真实收件人验收，长语音完整播放、多账号同时在线、Windows 或 macOS 安装包的真实账号验收也未建立。本次仅核查发布、源码及上游记录，未安装客户端、登录微信或试发。 [按能力验证清单](https://github.com/thisnick/agent-wechat/blob/v1.5.1/packages/native-client-rust/FEATURES.md)

## 持续观察和范围

守护进程收到微信变更提示后按同步键补拉，先持久化再发布 `message.committed`。推送断开时降级为网络轮询，重连有补拉。Rae 可订阅 `/v1/accounts/{id}/events/stream`，在事件成功落库后保存游标，断线用 `after` 或 `Last-Event-ID` 恢复。事件确认与微信已读是不同操作。游标过期需显式补账。手机本人发出的消息也可能入流，方向标为 `outgoing`。 [HTTP API](https://thisnick.github.io/agent-wechat/use/api/) · [v1.5.1 事件路由](https://github.com/thisnick/agent-wechat/blob/v1.5.1/packages/native-client-rust/crates/wechat-api/src/lib.rs#L1038-L1115)

上游 `read` Token 只细到账号，该账号的消息、联系人、群和事件都可读。SSE 接口没有群或会话过滤参数。另一端应先按账号和会话 ID 过滤事件，再读取授权正文并复核返回记录归属。只关联主人选定的会话和事项，按源消息 ID 去重，撤销后停止使用相应证据。首轮只需 `read`，省去 `send`、`read-state`、`login`、`media` 和 `admin`，按现有策略合并变化后再安排有限回顾。即使 Rae 只接指定会话，守护进程本身仍会同步更广的数据。 [Token 权限](https://thisnick.github.io/agent-wechat/reference/tokens/)

## 与 ClawBot 的区别

腾讯官方 ClawBot/iLink 连接的是用户与机器人的专门私聊，公开协议提供机器人消息长轮询，官方插件只声明一对一会话。它适合本人主动发给 Rae 的内容。Agent WeChat 能进入普通私聊、群聊，并以登录的个人账号发言。它通过非官方客户端路径连接。腾讯微信协议限制未经授权的第三方工具接入，因此即使 Rae 只取只读 Token，登录和同步仍有被拒绝或账号功能受限的风险。公开资料不足以判断该项目的封禁发生率。 [官方 iLink](https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol_zh_CN.md) · [官方插件能力](https://github.com/Tencent/openclaw-weixin/blob/main/src/channel.ts) · 腾讯微信协议

Tenon 可通过项目 HTTP API 复用只读能力，由现有运行时负责授权、事项和证据。若后续验证，先用上游离线模拟器覆盖游标恢复、去重、范围撤销和跨会话拒绝，再考虑独立测试账号与单个指定会话的接收测试。账号登录、已有配置接管及发信各需单独决定。 [离线模拟器说明](https://thisnick.github.io/agent-wechat/reference/build/)

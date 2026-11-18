# 原生鸿蒙客户端调研

日期：2026-11-08。需求为本人 HarmonyOS 7 设备上的自用 HAP，不上架、不用 WebView 套壳。本轮仅调研，尚未创建鸿蒙项目、安装 SDK、申请证书或生成 HAP。

## 结论

可行。应增加 ArkTS + ArkUI 的原生客户端，继续连接 服务端 上唯一的 Mastra 运行时和 RuntimeApi。需要重做客户端 UI 和平台适配，不需要重写服务端、任务执行器、记忆、授权或迁移聊天数据。HAP 是安装与运行单元，不等于 Web 套壳，也不要求先发布应用市场；官方支持 DevEco Studio 或 `hdc install` 安装调试 HAP。[官方 HAP 说明](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/hap-package/)

自用真机包仍需有效调试签名、证书和包含目标设备 UDID 的 Profile。单台设备优先使用 DevEco Studio 自动签名；无签名文件不能当作可安装成品交付。开发者账号登录及必要认证、设备开启开发者模式/USB 调试和信任连接，需由本人完成。调试签名有有效期，不能承诺一次安装永久有效。当前官方申请页写实名认证证书有效期为一年、未实名为十四天，但部分 FAQ 仍写一百八十天，实际以账号签发证书/Profile 到期日为准。[调试证书](https://developer.huawei.com/consumer/cn/doc/app/agc-help-add-debugcert-0000001914263178/)、[设备绑定及签名 FAQ](https://developer.huawei.com/consumer/cn/doc/app/agc-help-releasefaq-0000001110342644/)

## 开发环境准备

准备官方支持的 DevEco Studio、HarmonyOS SDK 和 hdc。使用开发者自己的测试设备或模拟器，核对目标系统、API 版本与签名配置，按官方兼容要求选择 SDK。不要在仓库记录设备 UDID、个人证书、登录账号或实际调试地址。

## 复用与重写范围

| 部分 | 处理方式 |
| --- | --- |
| 服务端 模型、任务、记忆、许可、Hub、数据 | 完整复用现有服务；不搬进手机 |
| RuntimeApi、HTTP 路径、JSON 数据、请求幂等 ID | 复用协议；为 ArkTS 写明确的数据模型与传输适配 |
| React 组件、DOM、CSS、浏览器事件与存储 | 用 ArkUI 原生页面、状态管理和平台存储重写 |
| SSE 流式状态 | 复用服务端协议；实现增量 UTF-8/帧解析、重连、版本断层全量重同步、退出登录取消 |
| 登录、图片选择、文件下载、媒体播放、复制 | 用系统 API 适配；会话保存在应用安全存储，服务端密钥不下发 |
| Windows MXC、微信本机数据库、托盘 | 不移植；鸿蒙可通过既有业务接口查看/选择已授权 Windows 设备 |
| 新通知摘要 | 可复用这次添加的 RuntimeView 投影；原生系统通知另行实现 |

ArkTS 保留许多 TypeScript 语法，但对动态类型、结构类型及工具类型有限制，不能把现有 React/TypeScript 和 npm 依赖直接复制成鸿蒙工程。共享类型优先复用其契约和字段，不建立第二套业务真相。[ArkTS 迁移规则](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/typescript-to-arkts-migration-guide/)

HTTP 可以用官方 Network Kit，`requestInStream` 提供增量数据接收；当前客户端的浏览器 EventSource、Cookie 管理和恢复逻辑需要平台适配。原生客户端发送 POST 时沿用服务端允许的 Origin 和 Cookie 会话，不关闭现有源校验或引入万能客户端令牌。[HTTP 流式请求](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/http-request/)

## 建议首版与验收顺序

1. 核对真机 API/签名，建立单 entry HAP、一个 UIAbility、多页 ArkUI 原生工程。先验证签名包安装与覆盖升级能保留数据。
2. 登录、场景列表、聊天历史分页、文本发送、流式回复、断线重连、退出登录。服务端真实推理维持本人设置；开发验收使用隔离模拟响应。
3. 任务卡、待确认操作、交付物、图片/视频展示、文件下载与基本设置。仍经同一任务准入，不从原生客户端另建执行通道。
4. 前台/允许运行期间的本地通知及点击跳转。锁屏、进程被回收仍能可靠送达的通知需要另接官方 Push Kit 和服务端设备 token，不能靠常驻 SSE 保证。Push Kit 的通知消息可在通知中心/锁屏展示；普通后台消息并不显示通知。[Push Kit](https://developer.huawei.com/consumer/cn/doc/HarmonyOS-Guides/push-kit-introduction/)

首个可用包重点是完整的登录→发送→收取→重连→查看任务链路；全面功能对齐应逐项移植。具体工作量取决于 Markdown/媒体组件、文件处理和真机兼容结果，当前没有构建或真机测试依据，暂不承诺精确工期。开发启动时仍需确认具体设备型号以及是否希望首版包括进程退出后的鸿蒙推送；本次 Windows 通知不自动扩大为该推送项目。

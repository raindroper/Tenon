# 持续感知与个人理解研究

核查日期：2026-11-02。本文件是设计研究，不代表已开启设备采集。公开仓库初筛元数据及部分HEAD见 [repository-snapshot.json](repository-snapshot.json)。元数据仅辅助识别迁移、许可证和更新状态，不能证明稳定性。

## 感知器与认知器分开

采集层应使用可授权、可暂停、可查询时间范围的独立服务。原始观察先落本地或常驻服务的证据存储；聚合后的事件决定是否唤醒模型。每个窗口变化、鼠标输入或OCR帧都直接调用大模型，会造成费用、噪声与错误归因。

“正在使用某软件”是观察，“正在进行某事项”是推断，“这个事项需要帮助”又是下一层判断。保存这三个层次及各自来源，不能在一次摘要中混成事实。

## 采集候选与实际接口

| 仓库 | 已核实能力和接口 | 可用位置 | 边界与未验证项 |
| --- | --- | --- | --- |
| [ActivityWatch](https://github.com/ActivityWatch/activitywatch) | window/AFK watchers写入bucket；aw-server提供REST存取；watcher与server分离 | 优先试验应用、窗口与活跃/离开状态 | 不能据此读出聊天正文，也不能把“窗口前台”当成用户意图；MPL-2.0。尚未在本机安装 |
| [aw-watcher-web](https://github.com/ActivityWatch/aw-watcher-web) | 浏览器扩展观察活跃tab标题、URL等 | 选定浏览器的上下文来源 | 浏览器扩展需用户配置；标题/URL可能含私人数据，不默认全域采集。它没有自动事项识别能力 |
| [aw-client-js](https://github.com/ActivityWatch/aw-client-js) | `AWClient.getBuckets/getEvents/query`，可按时间段拉取 | TypeScript薄适配器直接读取事件 | 下游仍需游标、重叠窗口去重和设备归属，不能把拉取时间当实际发生时间 |
| [Screenpipe](https://github.com/screenpipe/screenpipe) | 本地屏幕/音频历史、检索与MCP/agent上下文 | 需要具体可见内容时，作为可选深度感知源 | 当前源码采用自定义商业许可证，不是可笼统视为MIT的底座；官方构建另有条款。功能依平台/方案变化，Windows性能与过滤需要实测 |
| [OpenRecall](https://github.com/openrecall/openrecall) | 周期截图、OCR和历史搜索 | 轻量视觉历史参考 | 不是完整主动助手；API快照显示更新较慢，不能凭README认定长期维护充分；AGPL-3.0，运行可靠性未测 |
| 操作系统/编辑器专门事件 | 文件变更、Git提交、测试退出、设备联机、日历变更 | 有清晰业务语义时优先于截图 | Windows事件日志不是通用“用户操作记录”；文件watch可能丢通知，须补扫；手机见 [接入研究](ingestion-research.md) |

以上能力来自 [ActivityWatch架构](https://docs.activitywatch.net/en/latest/architecture.html)、[aw-client接口](https://github.com/ActivityWatch/aw-client-js/blob/master/README.md)、[Screenpipe说明](https://github.com/screenpipe/screenpipe/blob/main/README.md)、[当前许可证](https://github.com/screenpipe/screenpipe/blob/main/LICENSE.md)、[OpenRecall说明](https://github.com/openrecall/openrecall/blob/main/README.md)。本项目不复制或部署这些采集服务，仅完成选型。

## 从记录到个人理解

用户模型与代理身份应分别维护。用户模型描述“这个人目前怎样选择、在什么情境下在意什么”；代理身份定义“我怎样为这个人负责、怎样沟通与承担事务”。代理不应从“用户常熬夜”直接推导“我的目标是让他持续熬夜”，也不应自动替他设立减重、效率最大化等价值目标。

| 候选 | 可直接研究/接入的机制 | 与本项目的关系 |
| --- | --- | --- |
| [Honcho](https://github.com/plastic-labs/honcho) | Workspace/Peer/Session/Message；异步形成表征；查询`peer.chat`/context；可自托管 | 比平面偏好列表更贴合动态理解用户。应区分本人、其他联系人、代理自身与项目实体，并限定允许召回的session范围；不是单独接入就能决定所有生活价值 |
| [Memobase](https://github.com/memodb-io/memobase) | 用户profile、事件时间线、buffer/flush、`profile/event/context` | 可作为较简单个人画像候选。默认处理后清除原blob的行为需核对，不能替代自己的证据底账；当前仓库活跃度和后续项目Acontext需结合评估 |
| [Hermes Honcho provider](https://github.com/NousResearch/hermes-plugin-honcho) | session summary、user representation、peer card与按查询补充；有scope/调用代次失效处理 | 可借鉴已有适配。README已明确是移交仓库、非当前官方Nous插件，不能把它宣传为已验证内置集成；自托管/托管的配置和费用不同 |
| [Letta Code](https://github.com/letta-ai/letta-code) | 有状态身份、MemFS版本、经验与技能演化 | 适合作为代理自身身份/经验参考；用户理解与每事项工作记忆仍需分层 |
| [Hindsight](https://github.com/vectorize-io/hindsight) | retain/recall/reflect、经验和mental models | 对照“经历怎样影响未来行动”，与单纯检索片段区别开；需另测冲突、范围与费用 |

Honcho的具体数据模型与后台处理见[官方架构](https://github.com/plastic-labs/honcho/blob/main/docs/v3/documentation/core-concepts/architecture.mdx)。其当前仓库许可证为AGPL-3.0；Memobase为Apache-2.0。许可证和托管选项是选型输入，不在此作分发或商业使用结论。

## 观察与推断的最小记录契约

```ts
type Observation = {
  id: string;
  sourceAccountId: string;
  sourceObjectId: string;
  actorId: string;          // 本人、第三方、agent、系统
  observedAt: string;
  receivedAt: string;
  evidenceRef: string;
  contentKind: string;
  captureScope: string[];
  causationId?: string;    // 识别代理自己的写入，避免自激循环
};

type PersonalConclusion = {
  id: string;
  subjectId: string;
  statement: string;
  scope: string[];         // 某事项、某领域、或明确的个人全局
  evidenceIds: string[];
  assertion: 'explicit' | 'observed' | 'inferred';
  status: 'tentative' | 'supported' | 'disputed' | 'superseded';
  validFrom?: string;
  validTo?: string;
  learnedAt: string;
  supersedes?: string;
};
```

这是项目接口设计，不冒充任何候选库的原生schema。置信度需要通过反馈和回放校准；先保留明确/观察/推断等级，避免任意写0.98使其看起来科学。

## 不预设生活功能的学习策略

1. 先获取少量持续更新的真实来源，观察事实覆盖和缺失，允许代理自主了解关键缺口。
2. 将本人的明确表达、第三方描述、代理建议、实际执行结果分别归因；只有行动被执行和观察到结果，才记录为经历。
3. 偏好先落在最窄适用范围。例如“这个UI别做工作台”默认属于本次界面工作；跨情境重复证据或明确普遍表达才晋升为全局交互偏好。
4. 更新个人理解时保留证据、适用时间和历史，临时状态到期后重新检验，不能靠新摘要反复确认旧猜测。
5. 后台整理记忆和面向用户的主动行动采用不同预算与节奏；整理不会自动触发打扰。

首个感知试验优先对照ActivityWatch事件接口与邮箱增量同步。屏幕/音频与手机深度采集延后到用途、过滤、存储和操作系统能力明确之后；目前没有开启任何这类采集。

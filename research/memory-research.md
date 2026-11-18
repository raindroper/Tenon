# 个人分身的记忆与上下文：模块级社区研究

调研日期：2026-11-02。本轮只阅读本地源码、官方文档、公开 GitHub 源码与包元数据；未调用付费模型、未安装候选依赖、未修改生产代码。

## 结论与证据等级

需要同时解决“每件事自己的连续状态”和“整个人的长期连续性”。不能以一份不断增长的用户摘要同时替代二者，也不能把所有历史投入一个向量库后取消事项边界。

当前最值得比较的是 **Mastra 的 thread memory / OM / filtered recall**、**LangGraph 的 thread checkpoint / namespace Store**、**Letta 的 agent identity / conversation / versioned MemFS**。Graphiti、Mem0、Honcho分别是时态实体、事实检索、个人理解的可插拔候选，不是另外三个必须同时运行的 Agent。

本文区分：

- **源码核实**：在指定源码快照中看到接口、数据字段或测试。
- **文档核实**：维护者明确记录的行为与限制。
- **元数据核实**：公开 registry / GitHub release / HEAD 信息；不证明正确性或成熟度。
- **待验证**：本项目尚未安装运行的组合、DeepSeek 实际输出质量、中文记忆准确率、隔离与恢复效果。不得把 README 的自称或托管服务的评测分数当成本地实现已通过的验证。

## 当前原型的真实缺口

本地 `shared/types.ts` 的 Message、Source、Memory 没有 owner/case/thread/entity/scope 字段；Memory 只有内容、类型、状态、证据ID与创建/修改时间。`server/prompts.ts` 每轮拼入全局最新反馈、全局未否定记忆、全部议程、全局近期聊天与资料片段。`server/agent.ts` 的 recall 是简单关键词计分后取前八条，没有事项过滤、语义检索、实体关联或有效时间判断。

因此：

1. UI 优化会话里的“这段太密”可能污染午餐或其他工作中的回答；近期的午餐消息也会挤占 UI 的工作上下文。
2. initiative 只是议程记录，不等于一件事的完整工作区；run 是一次有预算上限的执行，没有独立保留当前事项的工具调用链、局部假设、暂停位置与待消费结果。
3. 全局 processedUserMessageId 不能表达每个事项各自处理到哪条消息。暂停后“重新观察再做”也不等于在原工具步骤安全续跑。
4. 所有 proposed / confirmed 记忆均可能进入下轮；确认是防自动覆盖，不是读取隔离。没有范围的“用户喜欢简洁”容易被无限泛化。
5. 修改会覆盖旧内容；updatedAt 不能表示“何时发生”“何时才知道”“现在是否仍成立”。缺少版本、supersedes、有效时间、失效原因与稳定实体ID。
6. 删除资料已有部分级联与墓碑，但如果以后增加观察摘要、向量、实体图、外部记忆服务，现有删除路径不会自动清除这些派生物。

## 应先确定的数据与上下文边界

| 层 | 权威内容 | 默认读取范围 | 写入资格 |
|---|---|---|---|
| 身份、个人价值、长期目标 | 用户明确表达的优先级、长期承诺、代理使命；代理自身角色与用户人格分开 | 各事项共享一个小型有效视图 | 用户表达/纠正为最高权威；代理不能凭一次行为重写核心价值 |
| 长期语义记忆 | 用户事实、偏好、关系、资源、条件化规律 | owner + 领域/事项 + 有效时间过滤后按需读取 | 明确陈述可保留为有来源的陈述；推断作为假设，不能自动升格为确定人格 |
| 情节记忆 | 某次对话、选择、纠正、真实行动与结果 | 原事项；跨事项只取有关片段 | 原始事件追加保存，区分用户/代理/外部来源；生成成果不能证明用户采用 |
| 程序经验 | 在何种条件下什么方法有效、失败原因、适用范围、工具版本 | 按任务与工具能力检索 | 需要可核查过程/结果；作为技能或经验，不混入用户事实 |
| 事项工作记忆 | 当前目标、局部约束、计划、候选方案、未决问题、资料/成果引用 | 当前 case | 当前事项执行者可更新；事项结束可归档，不直接写全局人格 |
| 会话与运行检查点 | 多轮消息、分支、工具调用与返回、等待/取消/恢复位置 | case 下各 session / run | 运行时持久化；重放仍须副作用幂等 |

`caseId` 表示“正在经营的事”，不是预置“生活/工作”功能菜单。一个 case 可跨多个会话、唤醒和模型运行；一条消息也可能关联多个 case。需要显式的关联记录，不能只依靠标题分类。

一次模型上下文应由 **稳定个人核心 + 当前case工作记忆 + 当前会话短期历史 + 有关长期记忆 + 必要的关联事项片段** 组成。全局代理先浏览各case的索引/状态，决定经营哪件事；选中后再打开该case上下文，不把所有工作现场同时塞入执行者。

例：UI 事项保留页面、约束和审美反馈；午餐事项保留当天时间、地点、预算与忌口。经证据确认的忌口可跨餐饮事项共享；“UI喜留白”默认限定在设计情境。若今天加班影响午饭，可借日程/时间实体共享“今天空闲窗口”，无需读取 UI 源码或整段设计讨论。

## 八个候选：具体可复用模块与缺口

### 1. Mastra：分事项记忆、观察压缩、按需跨会话检索

已核实 npm 元数据：`@mastra/core@1.81.0`、`@mastra/memory@1.40.0`、`@mastra/pg@1.34.0`，Node >=22.13。三个包元数据为 Apache-2.0；GitHub 仓库级许可识别为 NOASSERTION，不能据此认定仓库所有内容许可一致。源码快照为 `30046969ad18cb644a826fd7c44116caa04f3edd`。

**可复用接口**：`Memory` 的 `recall`、`listThreads`、`saveMessages`、`getWorkingMemory`、`updateWorkingMemory`、`deleteMessages`；Thread 有 `resourceId` 和 metadata。`PostgresStore` 提供 `memory`、`workflows`、`backgroundTasks`、`schedules`、`threadState` 等不同 storage domain；PgVector 与普通 storage 不是同一职责。

最有价值的已核实设计是：**OM 默认 thread scope；resource scope 已弃用**。官方说明把所有事项观察混在一起会降低理解与缓存效果，甚至让新会话继续别的会话未完成的工作。建议用 thread OM，再通过按需 recall 与小型 resource working memory保持跨事项连续性。这里的 resource 通常是用户，不是每件事。

**DeepSeek**：当前模型类型接受 AI SDK LanguageModel V2/V3/V4；model config 也接受自定义 `id/url/apiKey/api`。源码有 `router-deepseek.test.ts` 专门测试 reasoning_content 历史重放与 thinking 参数转换。因此具备直接 provider 或路由接入的依据，尚未在本项目做安装/真实调用验证。Observer、Reflector 和 embedder 是另外的配置/开销，不能默认继承主模型或免费。

**仍需自定义**：case 与 thread 的映射、共享记忆晋升、来源等级、版本冲突、用户纠正、删除级联、授权过滤。可配置 `workingMemory.agentManaged:false`，把共享写入交给受控晋升路径。消息 metadata 的检索过滤也不是完整授权；官方说明线程metadata变化不会自动更新旧向量metadata，需要重索引。

**检查点区别**：Thread/OM 保存的是对话和观察，不等于工具执行检查点。`createDurableAgent` 属 beta；运行中检查点/自动恢复默认不是全面开启，恢复可能重发模型或重做工具，仍需幂等。不能因启用 Memory 就宣称可无损恢复多步骤工作。

来源：[Memory源码](https://github.com/mastra-ai/mastra/blob/30046969ad18cb644a826fd7c44116caa04f3edd/packages/memory/src/index.ts)、[scope/types](https://github.com/mastra-ai/mastra/blob/30046969ad18cb644a826fd7c44116caa04f3edd/packages/core/src/memory/types.ts)、[PostgresStore](https://github.com/mastra-ai/mastra/blob/30046969ad18cb644a826fd7c44116caa04f3edd/stores/pg/src/storage/index.ts)、[OM scopes](https://mastra.ai/docs/memory/observational-memory#scopes)、[working memory](https://mastra.ai/docs/memory/working-memory)、[semantic recall/filter](https://mastra.ai/docs/memory/semantic-recall)、[model types](https://github.com/mastra-ai/mastra/blob/30046969ad18cb644a826fd7c44116caa04f3edd/packages/core/src/llm/model/shared.types.ts)、[DeepSeek测试](https://github.com/mastra-ai/mastra/blob/30046969ad18cb644a826fd7c44116caa04f3edd/packages/core/src/llm/model/router-deepseek.test.ts)、[durable agents限制](https://mastra.ai/docs/harness/durable-agents)。

### 2. LangGraph：线程状态与长期命名空间明确分开

已核实 JS npm：`@langchain/langgraph@1.6.0`、`@langchain/langgraph-checkpoint-postgres@1.1.2`，MIT，Node >=18。JS源码快照 `81a043b506f90c3b674eb49964a8e9cee3ddebb3`；Python仓库 release 1.2.19 是另一个发行序列，不能混用版本号与示例。

**可复用接口**：`StateGraph.compile({checkpointer,store})`；`PostgresSaver.fromConnString()`、`setup()`；`PostgresStore.fromConnString()`、`setup()`；`store.put(namespace,key,value)` 与 `store.search(namespace,{query,...})`。`thread_id` 关联运行状态，长期 Store 使用独立 namespace，可表示 `[ownerId,'case',caseId]`、`[ownerId,'shared','preference']`。

**可复用层**：每事项状态图、检查点、暂停恢复、子图状态、长期可检索集合。不要求把所有事项共享为一条聊天历史。**仍需自定义**：记忆提取/晋升/冲突规则和个人代理目标；namespace 需要服务端根据调用身份构造，不能允许模型任意指定其他 namespace。流程检查点也不保证外部付款/发送等只执行一次。

来源：[JS memory与Postgres API](https://docs.langchain.com/oss/javascript/langgraph/add-memory)、[记忆类型与写入权衡](https://docs.langchain.com/oss/python/concepts/memory)、[JS仓库快照](https://github.com/langchain-ai/langgraphjs/tree/81a043b506f90c3b674eb49964a8e9cee3ddebb3)、[Python PostgresSaver源码](https://github.com/langchain-ai/langgraph/blob/ee3c043bddcc514012885167dd5916b15d6e4731/libs/checkpoint-postgres/langgraph/checkpoint/postgres/__init__.py)。

### 3. Letta：长期身份与版本化记忆，注意新旧产品代际

当前 npm `@letta-ai/letta-agent-sdk@0.8.67`，Apache-2.0，Node >=22.19；`@letta-ai/letta-client@1.12.1` 是 API client。旧名 `letta-code-sdk`、旧 server release 0.16.8 与 legacy V1 blocks 文档不能直接当作当前 Agent SDK 的接口。Code runtime 快照 `6155d9f562f13eb1f352240a7fd07a87933ac76a`。

**可复用接口**：`LettaAgentClient.createAgent()`、`createSession(agentId)`、`resumeSession(conversationId)`、`session.send/stream/abort/close`；当前文档的 MemFS 用 Markdown 文件、git版本与 dreaming 管理长期记忆。Agent身份/记忆与conversation分离，适合长期个人核心与各事项会话。

**仍需自定义/验证**：同一个agent的不同conversation共享agent memory，不能只创建conversation就认定长期记忆也隔离。当前SDK明确不重放断线期间事件，重连要listMessages/bootstrapState；客户端工具、权限回调等是会话级配置，并非自动持久化的业务授权。Git版本不是事实冲突裁决；删除历史和备份需另定义。API类型有DeepSeek provider，但新SDK、runtime、MemFS、DeepSeek多步工具组合尚未在本项目验证。

来源：[Agent SDK源码](https://github.com/letta-ai/letta-agent-sdk)、[当前memory/MemFS/dreaming](https://docs.letta.com/agent-sdk/memory)、[sessions与non-guarantees](https://docs.letta.com/agent-sdk/sessions)、[API provider列表](https://docs.letta.com/api/typescript/resources/models/methods/list)、[legacy只读block，供设计对照](https://docs.letta.com/v1-sdk/memory/memory-blocks)。

### 4. Hermes：小型核心记忆、真实历史检索与记忆provider钩子

release v0.22.5；阅读HEAD `ea0cfc524e5ffff11aa49854e5269f86b96da26a`，MIT。原生Windows安装器可管理Python，当前部署约束并非只能用Node。

**可复用层**：profile级 `USER.md/MEMORY.md`、会话检索、skills；`MemoryProvider` 有 `sync_turn`、`on_turn_start`、`on_session_end`、`on_session_switch`、`on_pre_compress`、`on_memory_write` 等钩子。预压缩checkpoint API v2可要求证据先可靠交接再压缩。

**实际边界**：profile级核心记忆在会话开始时形成冻结快照；多个事项共享profile仍可能混杂。同home不应由多个agent进程同时写。这里的“pre-compress checkpoint”是记忆保存交接，不能等同工作流工具执行checkpoint。Honcho已拆至独立handoff仓库，README明确“非官方Nous插件”；不可当成当前内置且稳定的集成保证。

来源：[Persistent Memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory)、[MemoryProvider源码](https://github.com/NousResearch/hermes-agent/blob/ea0cfc524e5ffff11aa49854e5269f86b96da26a/agent/memory_provider.py)、[MemoryManager源码](https://github.com/NousResearch/hermes-agent/blob/ea0cfc524e5ffff11aa49854e5269f86b96da26a/agent/memory_manager.py)、[Honcho handoff声明](https://github.com/NousResearch/hermes-plugin-honcho)。

### 5. Pi：会话/分支与上下文拼装，不是完整个人记忆层

release/npm 1.5.0，MIT，Node >=22.19；源码快照 `072e413bf3f8ee0cf8d9f2862fd1dbfc5d337afa`。可用完整 `pi-coding-agent` SDK 或较薄的agent-core，不宜两套loop一起运行。

**可复用接口/层**：`createAgentSession`、sessions/branch/context压缩、模型适配与工具执行；适合每case独立session，再由应用按scope注入长期记忆。**仍需自定义**：个人事实、跨case关联、有效时间与共享晋升。`pi-durable`提供另一种持久任务/工具状态，但官方标Experimental，不能把普通session保存等同完整durable harness保证。

来源：[SDK](https://github.com/earendil-works/pi/blob/072e413bf3f8ee0cf8d9f2862fd1dbfc5d337afa/packages/coding-agent/docs/sdk.md)、[sessions](https://github.com/earendil-works/pi/blob/072e413bf3f8ee0cf8d9f2862fd1dbfc5d337afa/packages/coding-agent/docs/sessions.md)、[durable实验状态](https://github.com/earendil-works/pi/blob/072e413bf3f8ee0cf8d9f2862fd1dbfc5d337afa/packages/durable/README.md)。

### 6. Graphiti：实体交叉引用、时态事实与证据链索引

release v0.31.2，Apache-2.0；源码快照 `16bf514380de4e44884aed6779bece220e6fe470`。

**可复用接口**：`add_episode(name,episode_body,source_description,reference_time,group_id,...)`、`search(query,group_ids,search_filter,...)`、`remove_episode`；EntityEdge明确有 `episodes`、`created_at`、`valid_at`、`invalid_at`、`expired_at`、`reference_time`。适合关联“同一个人/项目/地点/时间约束”及查询事实变化，不必靠整段对话相似度。

**仍需自定义**：权威事实ledger、领域scope与ACL、抽取批准、派生删除、运行与成本。Graphiti官方明确是图框架而不是完整agent memory产品；reference MCP/REST没有认证/授权，`group_id`是分区而不是权限保证。不能让低置信度图抽取直接覆盖用户确认的事实。模型、embedder和图数据库要另外提供。

来源：[README定位与reference servers限制](https://github.com/getzep/graphiti/blob/16bf514380de4e44884aed6779bece220e6fe470/README.md)、[实际接口](https://github.com/getzep/graphiti/blob/16bf514380de4e44884aed6779bece220e6fe470/graphiti_core/graphiti.py)、[时态字段](https://github.com/getzep/graphiti/blob/16bf514380de4e44884aed6779bece220e6fe470/graphiti_core/edges.py)。

### 7. Mem0：可外挂的事实提取与过滤检索

TS npm/release 3.3.1，Apache-2.0；源码快照 `753496cf1435d76c3a711f3af51303f7fdcb6420`。Python与TS/托管服务版本和能力应分别验证。

**可复用接口**：已读Python实现的 `add(messages,user_id,agent_id,run_id,metadata,timestamp,expiration_date,infer,...)`、`search(query,filters,top_k,...)`；可把case/domain作为metadata，并由服务端注入身份过滤。源码阻止用普通metadata改写身份字段。属于记忆服务，不提供工具步骤恢复。

**重要边界**：当前README描述ADD-only抽取、代理陈述也作为可存事件；对本项目必须保留来源角色，不把“代理说做过”升为“用户实际采用”。其README明确高评测分数包含托管服务独有优化；不应拿该分数证明OSS或中文个人记忆已可靠。V3查询身份字段在filters中，别照抄旧版search(user_id=...)教程。

来源：[README，含OSS/managed区别](https://github.com/mem0ai/mem0/blob/753496cf1435d76c3a711f3af51303f7fdcb6420/README.md)、[Python实际add/search与身份过滤](https://github.com/mem0ai/mem0/blob/753496cf1435d76c3a711f3af51303f7fdcb6420/mem0/memory/main.py)。

### 8. Honcho：跨事件理解人的独立记忆服务

server release v3.5.0、TS SDK npm 2.8.0；服务源码快照 `d11a764b4ee6fc3837c1a85676ceab6b12d3e622`。Server LICENSE为AGPL-3.0，SDK包元数据为Apache-2.0；两者不可混称一个许可。

**可复用接口**：`honcho.peer()`、`session()`、`session.addMessages()`、`session.context({tokens,...})`、`peer.chat()`；当前TS源码还有 `scope()`、`Scope.addSessions/removeSessions/status`，Session context参数有scope/sessions/limit_to_session。适合个人模型与跨事件推断，可独立外挂现有runtime；后台reasoning异步产生表示，不能把写入成功当推断已更新。

**隔离边界**：scope是会话集合的可见视图；peer仍有跨所有参与内容的统一表示。成员增删及结论回填/移除是异步的，必须考虑尚未收敛时的检索与应用层授权。它不提供本项目事项执行checkpoint，推断仍需来源与反例管理。用户建模机制的进一步研究由并行研究文档展开。

来源：[README与SDK入口](https://github.com/plastic-labs/honcho/blob/d11a764b4ee6fc3837c1a85676ceab6b12d3e622/README.md)、[Session具体参数](https://github.com/plastic-labs/honcho/blob/d11a764b4ee6fc3837c1a85676ceab6b12d3e622/sdks/typescript/src/session.ts)、[Scope语义](https://github.com/plastic-labs/honcho/blob/d11a764b4ee6fc3837c1a85676ceab6b12d3e622/sdks/typescript/src/scope.ts)、[Server LICENSE](https://github.com/plastic-labs/honcho/blob/d11a764b4ee6fc3837c1a85676ceab6b12d3e622/LICENSE)。

## 无论选谁，个人分身仍须明确的治理规则

1. **共享晋升**：默认从case内记忆开始。用户明确说“以后都如此”或有跨事件一致证据，才提出领域/全局晋升；证据数量不是唯一标准，还要检查反例和具体情境。不要要求每条普通观察都手动点确认，但核心价值、重大推断及冲突需要更强证据/核对。
2. **版本与时间**：每个断言保留 `subject/predicate/value/qualifiers/scope/sourceEventIds/assertedBy/confidence/status/version/supersedes/validFrom/validTo/recordedAt/expiry`。旧值失效不等于抹去历史。“这周先不吃辣”不能永久覆盖口味；未来事件时间与“现在表达了计划”的时间不同。
3. **查询先过滤**：服务端先限定owner、允许case/domain、来源等级与时间，再做语义/关键词/实体排序；不能先全库取topK再让模型自行保密。跨case拿最小有关事实与引用，不自动搬整个对话或文件。
4. **实体链接**：给人、项目、地点、资源稳定ID与别名；关系带来源与时间。实体同名/合并有不确定性。Graphiti可承担此索引，但SQL事实ledger或原始事件仍保留权威来源，索引应可重建。
5. **consolidation**：case关闭、明确纠正、累计足够新事件时，压缩工作上下文、提炼有范围的经验、检查矛盾。区分摘要与事实；一份摘要不能删除原始证据，推理产物不得变成自己的新证据。
6. **忘记与删除**：区分归档、降权、到期与真正删除。用户删除需要墓碑、反向来源依赖、摘要/向量/图/缓存/外部服务的删除或重建；git历史、备份保留政策须单独说明。
7. **并发与成本**：case内序列化写入或乐观版本检查；跨case共享写入由单一受控入口执行。后台Observer、图抽取、个人建模与重试费用都进入同一预算账本，不能只统计主Agent的LLM账单。

## 接入原型的最小边界与下一步比较

先定义可替换的领域契约，而不是先锁某个完整框架：`ingestEvent`、`openCase/getCaseState`、`retrieveContext`、`proposeMemory`、`promoteMemory`、`applyCorrection`、`forgetSource`。这些是本项目计划接口，不是声称各库都有同名方法。

可按模块比较三条组合，保留现有UI、API与业务工具，切换时只保留一套Agent loop：

| 组合 | 优先验证的复用价值 | 尚未获得的保证 |
|---|---|---|
| 现AI SDK运行时 + Mastra Memory/PG，或迁移为Mastra Agent+Memory | thread历史/OM与resource核心、带过滤检索；最贴近现TS代码 | 独立使用Memory需要核对processor集成；durable agent beta不能自动当成全面可靠续跑 |
| LangGraph + PostgresSaver/PostgresStore | case状态与共享namespace最明确，可显式安排检索/晋升/检查点节点 | 个人记忆抽取、身份/范围/冲突仍是领域逻辑；不能以store存在替代整体验证 |
| Letta Agent SDK + conversation/MemFS | 长期身份、多个会话、可版本化记忆及dreaming | 多conversation不等于共享记忆隔离；新runtime与DeepSeek及权限/重连语义需实测 |

如果先保留现loop，Mem0/Honcho可作为独立memory backend比较；Graphiti仅在实体/时间关系测试暴露真实需要时接入，避免先同时运维多个自动写记忆的系统。Pi/Hermes的session与skills可按需替换运行层，不是再叠一层loop。

验证应使用同一份真实但脱敏的固定事件集，而不是各家演示：

- UI与午餐交错输入，检查各自工作上下文不串；需要共享的预算/忌口/时间窗口能正确跨case使用。
- 临时偏好、反例、明确永久偏好、迟到事件与用户纠正，检查事实有效期与版本。
- “代理生成了方案”与“用户实际采用”分开，不能错误晋升。
- 删除一份来源后，case摘要、共享事实、语义索引、实体关系、外部记忆都不再提供被删除内容。
- 一事项运行中断后只恢复它的检查点，不能继续另一事项的计划；检查工具副作用去重。
- 记录每种背景记忆调用的费用、延迟、检索命中与错误晋升，不把生成摘要条数当学习成效。

本轮到此为研究与设计，不代表上述任意组合已在 Tenon 集成或通过这些验证。

# Mastra 原生记忆与事项隔离：实际 probe 结果

验证日期：2026-11-02。未读取用户 API Key，未调用远程模型，付费模型调用数为 **0**。

## 已实际安装与执行

独立目录 `.local/validation/` 固定安装：

| 包 | 版本 |
|---|---|
| `@mastra/core` | 1.81.0 |
| `@mastra/memory` | 1.40.0 |
| `@mastra/libsql` | 1.28.0 |

独立安装新增171个依赖，没有修改主项目依赖。本轮随后按主代理选型授权，将薄适配迁移到 `server/v2/memory.ts`，测试为 `tests/v2-memory.test.ts`；主项目三个依赖由主代理安装。

独立 probe 使用 Node 22.19.0、真实 libSQL 文件、真实 Mastra `Agent.generate()`、本地 `MockLanguageModelV4`。模拟模型的输入请求被捕获并作断言；模拟输出仅用于证明框架的历史/状态拼装，不证明语言模型理解或偏好学习。

独立 probe 的机器可读结果保存在 `.local/validation/`，实际DB是 `.local/validation/`。不要将合成fixture中的忌口、目标等当作用户资料。

## 独立 probe：6项全部通过

1. **Thread工作状态隔离**：UI保存 `UI_ONLY_GOAL`，午餐保存 `LUNCH_ONLY_GOAL`，读取各自工作记忆没有另一事项目标。
2. **少量resource核心共享**：同一owner两事项读到相同共享核心；写resource核心没有覆盖thread局部工作状态。
3. **实际runtime上下文隔离**：顺序运行UI→午餐→UI，共3次本地模型调用。午餐请求没有UI消息/工作目标；第二次UI请求保留第一次UI消息、没有午餐消息/目标；两者可获得显式共享核心。
4. **普通recall的metadata scope过滤**：同thread写入scope为case与shared的两条消息，`recall({filter:{metadata:{scope:'shared',caseId:'ui'}}})`仅返回指定消息；未启用向量检索。
5. **resource归属校验**：用错误owner读取已存在thread，被库拒绝。
6. **关闭并重开DB**：重新构造storage/Memory后，历史、两个局部工作状态、resource核心及metadata过滤结果均恢复；UI与午餐历史仍隔离。

执行方式必须从probe目录运行，以保证相对DB写入该目录：

```powershell
Set-Location ../.local\mastra-probe
& ../node_modules\.bin\tsx.cmd probe.ts
```

独立薄适配 `runtime.ts` 与probe脚本的严格类型检查已通过（TS7需要`--ignoreConfig`）：

```powershell
& ../node_modules\.bin\tsc.cmd --ignoreConfig --noEmit --skipLibCheck --strict --types node --target ES2022 --module ESNext --moduleResolution Bundler runtime.ts probe.ts
```

## 迁移后的生产模块：3项测试通过

`server/v2/memory.ts` 导出 `CaseMemory`、`CaseRecord`、`SharedFact`、`CaseRunOptions`、`CaseRunResult`。

| 测试 | 实际覆盖 |
|---|---|
| catalog、工作状态、领域共享、history及重开 | 原生thread metadata存事项catalog；UI/午餐局部状态与历史不混；全局中文事实可共享；food忌口不进入design；design审美不进入food；更新catalog不覆盖工作记忆；重开恢复 |
| owner隔离与取消 | 另一owner不能读取或写工作记忆；其case列表为空；已取消case不能发起模型调用 |
| 并发共享写入 | 同CaseMemory实例6次并发写入不丢字段；同key修订保留创建时间并更新证据；空domains被拒绝 |

另外验证 `providerOptions.deepseek` 确实透传到本地provider调用，`onStepFinish` 每轮触发；token汇总取 `totalUsage`，不会只算最后一步。

- Node 22.19.0：3/3通过。
- 主代理提供的本地Node **24.22.1**：3/3通过，约10.3秒。
- 最新 `npm run check`：通过。

Node24复现命令：

```powershell
Set-Location <项目目录>
& .\.local\runtime\node.exe --import tsx --test tests/v2-memory.test.ts
```

## 已核实的API漂移与平台问题

1. 官方旧示例里的 `options.threads.generateTitle:false` 在本次实际包组合中直接抛错：标题设置已移到 **`options.generateTitle:false`**。修正后执行通过；不能只照搬文档示例。
2. 顶层包声明Node>=22.13，但实际transitive `posthog-node@5.61.2`声明Node `^20.20.0 || >=22.22.0`。Node22.19安装产生EBADENGINE warning，probe仍跑通；已在Node24.22.1复测通过。
3. Mastra同时兼容多代AI SDK。独立安装根层的`@ai-sdk/provider`可能是V3，不能据包名假定它导出V4类型。薄适配使用Mastra公开的 `MastraModelConfig`；probe从Mock方法推导V4类型，避免依赖内部alias。
4. Windows关闭多个libSQL连接后，临时DB删除可能短暂EBUSY。测试使用有上限的异步重试删除；实际测试出现约8秒等待后释放。重开数据库与数据恢复本身成功，不将清理等待误称为数据隔离失败。

## 生产接入边界

`CaseMemory` 不自写Agent循环：`runCase`直接创建原生Mastra `Agent`，使用同一Memory对象和当前case的 `memory.thread/resource`。如果选用此runtime，原有AI SDK `ToolLoopAgent`须退出该执行路径；不能一层套另一层。

事项catalog存原生thread metadata，局部工作记忆使用thread scope，`agentManaged:false`。内部resource核心thread不出现在事项列表。共享事实以受校验的小型JSON存resource working memory，**调用模型前先按`domains:['*']`或当前domain过滤；绝不原样注入整个resource JSON**。底层禁用semantic recall、OM和自动标题生成，因此存取与实例化不会额外触发LLM。

可对接现有调度器的最小调用形状：

```typescript
const result = await caseMemory.runCase({
  caseId,
  message,
  model, // 已配置的DeepSeek V4 provider，或本地测试模型
  instructions,
  tools, // Mastra公开ToolsInput
  signal,
  maxSteps,
  maxOutputTokens,
  providerOptions: { deepseek: { thinking: { type: 'enabled' }, reasoningEffort: 'low' } },
  onStepFinish,
});
```

该模块设 `maxRetries:0`，各case的run在进程内串行，shared写入在进程内串行。它不是分布式锁；多进程共享写入需要native事务合并或外部版本控制。接口只校验evidenceIds的结构，**来源是否真实、共享晋升是否有资格由领域工具/协调器校验**，没有悄悄引入第二套用户画像学习器。

## 明确未验证的能力

- 未验证真实DeepSeek的理解、工具选择或自主发现需求；本轮模型是本地夹具。
- 未启用OM/Observer/Reflector、embedding或语义检索，不能声称已验证语义学习、自动巩固、人格推断。
- 未验证执行到一半的工具checkpoint/崩溃续跑。这里重开恢复的是历史与工作状态；普通Agent的记忆持久化不等于durable workflow。副作用幂等与恢复位置仍由协调器/执行底座另行验证。
- metadata过滤和resource归属检查不是完整用户登录/授权；调用owner/case ID必须来自可信服务端身份。
- history返回原生Mastra消息parts，前端展示应提取文本/工具摘要，而非直接展示所有底层provider字段。

官方依据：[recall与metadata过滤](https://mastra.ai/reference/memory/recall)、[working-memory scope](https://mastra.ai/docs/memory/working-memory)、[libSQL初始化/关闭](https://mastra.ai/integrations/databases/libsql)、[OM thread scope及global弃用](https://mastra.ai/docs/memory/observational-memory#scopes)、[durable agents与恢复限制](https://mastra.ai/docs/harness/durable-agents)。实际执行以锁定版本包及上述测试结果为准。

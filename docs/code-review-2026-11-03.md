# 代码质量与可维护性审查

> 本文保留修复前的审查快照。12项整改、模块边界、正式回归和第二轮复审见[稳定化记录](stabilization-2026-11-03.md)。

日期：2026-11-03。范围为当前完整实现，重点是V2协调器、原生记忆适配、事件接入、工作空间、HTTP边界、V1/V2兼容和运行生命周期。本轮没有修改生产源码或运行配置，没有连接真实模型、读取付费凭证、修改示例工作区或真实data。

## 审查结论

发现 **4项P1、8项P2**，均已有隔离临时数据库、文件/Git夹具或本地Mock复现。当前代码完成了功能验证，但还没有达到适合扩大资料接入与长期无人值守的质量门槛。类型检查和构建本轮通过；这些不能覆盖下面的状态一致性、进程中断和跨层问题。

P1表示应先于继续扩大运行范围修复；P2表示应进入本轮稳定化整改。没有把已修复的旧缺陷重复计入，也没有把尚未安装的社区方案当作已验证功能。

## 高优先级问题

### R01 P1 来源重绑会把旧私有事件送入另一事项

定位：[coordinator.ts:352](../server/v2/coordinator.ts)，关联[来源注册](../server/v2/coordinator.ts)及[sourceRoutes写入](../server/v2/coordinator.ts)。

事件未在采集时固定来源代次与事项归属，处理时会回查当前sourceRoutes。来源删除后允许复用sourceId绑定另一个case，原来的pending事件于是跟着新映射迁移。

严格复现：A只允许a.md并产生未处理事件；删除来源后实际删掉a.md，新建b.md；B仅允许b.md，以同sourceId重新注册。旧a.md文字仍进入B的原生Mastra历史，A反而没有它。不是当前文件仍含旧数据造成的。

建议：事件固定connection/generation与采集时授权归属；重连或重绑创建新来源代次，旧待办保持旧归属并隔离处理。不可用可变的当前配置回写历史事件的身份。将这条跨HTTP、inbox、native thread的路径加入正式回归。

### R02 P1 缩小来源筛选后，活跃watcher仍采集旧范围

定位：[coordinator.ts:193](../server/v2/coordinator.ts)，关联[配置更新](../server/v2/coordinator.ts)。

registerWorkspaceSource允许同sourceId/root/case修改include并保存新配置，但startWatcher发现已有实例就直接return。真实观察器保留最初的include。

复现：配置已变为仅b.md，后续a.md变化仍进入收件箱。用户看到的白名单与实际生效范围不一致，旧范围的数据可能继续进入模型。

建议：来源配置有版本；include等影响观察范围的变更通过统一生命周期操作停旧、建新并校验生效。失败时保持明确旧版本/错误状态，不能只先写元数据。与R01一起设计来源身份和配置切换，但分别保留回归。

### R03 P1 更新事项目标或状态可能覆盖新工作记忆

定位：[memory.ts:113](../server/v2/memory.ts)。

updateCase先读完整thread metadata，再连同旧metadata写回。Mastra将thread工作记忆也保存在该metadata中，setWorking与updateCase没有共同的写入锁。

用延迟原生updateThread构造可达交错：旧metadata读取→setWorking写入NEW_WORKING→旧metadata提交，最终读回OLD_WORKING。收到带caseId的输入会更新active状态，恰可与后台工具保存工作状态重叠。

建议：对所有事项metadata/working写入使用同一条原子局部更新或带版本的每事项写路径。不要简单套整个run队列锁，否则worker工具再次写记忆可能死锁。测试需要覆盖HTTP更新与worker写入，而非只测两个方法顺序调用。

### R04 P1 跨执行器并发可把已撤销许可覆盖回有效状态

定位：[workspace.ts:236](../server/v2/workspace.ts)，关联[整行JSON保存](../server/v2/workspace.ts)。

触发前提是两个WorkspaceExecutor使用同一个数据库。当前锁仅存在于单个对象：A.write读取旧grant后等待Git/I/O；B.revoke写入revokedAt；A最后用旧对象save整行，撤销字段消失。

实测：revokedBeforeWriteFinished=true，write结束后revokedAfterWriteFinished=false，再次read成功。现有测试仅覆盖单实例内的顺序撤销。

建议：撤销状态独立持久或更新带授权版本CAS，实际动作与回执提交前复核最新授权。若某层要求单实例，必须通过数据目录独占机制执行该约束，不能只写注释；即使有进程锁，也不应让普通状态保存覆盖撤销字段。

## 一般优先级问题

### R05 P2 缺失token总量会被记成零费用

定位：[metering.ts:24](../server/v2/metering.ts)。

LanguageModelV4允许usage total缺失，目前使用`?? 0`并设置recorded=true，end不再走uncertain。合法缺用量的Mock返回后，预留¥0.008946，最终记录¥0且unknown次数0。兼容提供方漏报用量时，预算可以失效；不表示之前具备用量字段的真实测试统计都错了。

建议：使用可确定的分项推导；仍未知的部分保留预留估算与unknown标记。费用账本区分实际token估算、未知请求预留和后续核账，不用一个零抹掉未知。

### R06 P2 创建子事项与幂等映射跨库提交，故障后会重复创建

定位：[coordinator.ts:397](../server/v2/coordinator.ts)。

原生createCase先提交libSQL，幂等映射随后才写另一个SQLite。注入一次setMeta提交失败后重试同一工具，出现两个同名child，但映射和派生事件均只有一个。孤儿case也未计入每事件两个的上限。

建议：原生thread使用可重试的确定case ID或唯一幂等键，并用admission/outbox状态恢复跨库步骤。当前“创建后保存一个map”只能防正常重复调用，不能覆盖提交窗口中断。

### R07 P2 重新激活事项后，HTTP消息仍不被处理

定位：[http.ts:44](../server/v2/http.ts)，关联[消息入口](../server/index.ts)。

cancelCase同时写native status和v2.cancelledCases；PATCH active却只改native status，HTTP消息入口也没有走负责移除取消标记的ingestOwnerMessage。

复现：取消200→重新active 200→提交消息202；native active、取消标记仍在，事件永久pending且attempts=0。没有请求模型。

建议：HTTP层不直接写运行状态，全部经CaseService/协调器的activate、cancel、updateGoal等领域操作；使用单一状态来源或事务性维护派生索引。

### R08 P2 暂时无法访问根目录被当作全量删除

定位：[events.ts:419](../server/v2/events.ts)，关联[删除事件和checkpoint提交](../server/v2/events.ts)。

授权根暂时移走或挂载不可用时，ENOENT被吞掉，空扫描被当成完整快照。单文件来源实测产生create→delete，checkpoint文件数归零。不会删除原文件，但会产生错误删除事件并丢失同步基线。

建议：区别根不可达、扫描不完整和确认文件删除；不完整扫描不替换上次成功快照，来源状态标失败并重试补账。

### R09 P2 非递归或排除glob仍遍历不匹配子树

定位：[events.ts:407](../server/v2/events.ts)。

task base已收窄，但base里的目录仍全递归，文件到inspectFile才判断匹配。实测include为docs/*.md、目标仅docs/top.md，docs/archive里的20010个不匹配TXT仍触发上限。

建议：让遍历器和watcher遵守glob深度及排除目录，采用成熟glob任务的遍历语义，而非只借base后再自写全递归。保留base外剪枝测试，同时覆盖base内无关大树。

### R10 P2 worktree创建后崩溃，无法恢复同一事项准备

定位：[workspace.ts:149](../server/v2/workspace.ts)。

Git外部副作用先发生，grant后持久；窗口中进程退出会留下真实worktree但无grant。重开后prepare又直接拒绝已存在目录。已注入保存前退出复现，不能正常重试。

建议：准备过程先持久化preparing状态，保存目标身份和基准，再完成外部动作与finalize；重试核对已存在worktree身份并恢复。不能自动删除身份未知的目录来“修复”。

### R11 P2 第二次启动会先改写仍在运行的实例

定位：[index.ts:219](../server/index.ts)，关联[恢复逻辑](../server/v2/coordinator.ts)。

取得端口或数据目录独占权之前就创建V2并恢复所有running。两个实例打开同一临时目录，首实例仍打开的运行记录已被第二实例改成interrupted。端口最终拒绝第二实例已经太迟。

建议：先取得数据目录独占权，记录runtime身份；只恢复明确属于已退出实例的run和租约。初始化失败应完整释放已打开的存储、watcher和锁。

### R12 P2 V1路由的cancel契约会意外暂停整个V2

定位：[index.ts:144](../server/index.ts)，旧议程搁置路径也有相同模式。

DELETE旧memory调用全局cancel后直接返回，但V2 cancel会设置持久cancellation hold。实测返回200、enabled仍true，运行状态却idle→paused，其他事项自动行动停止。之后直接请求可能清除hold，但目录事件本身只kick，不会恢复它。

建议：迁移兼容路由经有范围的变更操作，不把“中断当前请求”“暂停全局”“取消事项”混用为同一个可选接口。变更结束后的运行状态应有明确契约和测试。

## 可维护性根因

这些问题不是再加几个if就能长期解决的。当前风险集中在几个边界：

1. **同一状态有多个可写来源**：native metadata、Store任意meta字符串、内存map和HTTP直接写入同时生效。取消/恢复、来源配置、工作记忆与许可因此出现不一致。
2. **事务范围未覆盖副作用**：libSQL事项、SQLite映射、事件和Git工作树分开提交，缺少可恢复的中间状态。函数内顺序await不等于故障原子性。
3. **协调器承担过多职责**：连接器生命周期、调度、计费、状态迁移、工具定义、授权及通知集中在一个类。常见修复需要改多个彼此隐含依赖的flag。
4. **Repository只提供全量list**：status、pump、read_event与bridgeStore频繁全量解析历史payload。持续数据积累后，主线程同步SQLite扫描和JSON解析会成为维护与性能风险；应改为按状态/ID/source的查询及分页，不在每个调用点自写过滤。
5. **边界类型过宽**：V2Api很多Promise<unknown>、Artifact用cast补status、元数据无版本化schema；编译通过仍不能检查状态契约。建议引入共享DTO、显式结果联合和持久schema版本。
6. **测试证明的范围偏窄**：已有happy-path和单对象测试较多；上面失败发生于重配置、跨实例、跨库提交或HTTP/运行时接缝。部分Windows清理允许cleanupDeferred，另有单项清理达约170秒的记录，需要独立资源释放验收，不能只用测试总数衡量质量。

V1/V2共存需要明确adapter或清退计划；V2计费还从V1 Agent模块导入价格函数，是应拆出的基础依赖。测试/真实付费脚本也应统一显式入口与网络隔离规则，避免日后维护时误触真实调用。

## 整改顺序与质量门槛

1. 先将上述复现转成正式回归测试，使用临时数据、Mock provider、故障注入和确定性调度；默认禁止测试访问付费provider。
2. 优先修复来源代次/配置生效、每事项写一致性、授权版本不被覆盖，再处理预算未知量和取消恢复。
3. 建立CaseService、SourceRegistry、BudgetLedger、Admission/Outbox等明确边界。它们是现有领域逻辑的归位，不是再引入四个外部框架。先消除重复状态，再做不改变行为的模块拆分。
4. 加数据目录单实例、存储schema迁移及可恢复prepare/admission；补真实重启/失败路径的测试。
5. 建立Git基线、CI里的typecheck/build/不付费tests、格式与静态检查。通过稳定化门槛后再扩连接器和后台自治范围，不以新增功能掩盖P1。

本次检查与构建通过；未在审查中运行真实付费脚本，也未宣称已修复这些发现。

## 复现证据

- [架构与计费结果](../.local/review-architecture-results.json)：include更新、working竞争、跨库幂等窗口、缺usage。
- [事件/工作空间probe脚本](../.local/probe-review-event-workspace.ts)：根不可用、glob递归、撤权竞争与worktree窗口。
- [HTTP/生命周期结果](../.local/review-boundaries/result.json)：取消恢复、旧memory删除、双实例初始化。
- [严格来源重绑结果](../.local/review-boundaries/rebind-result.json)：删除旧文件并缩小新include后，旧事件仍进入另一case。

这些.local文件是隔离审查证据，不是生产功能或用户真实资料；进入整改时应整理进正式测试，而不是依赖临时脚本作为质量门槛。

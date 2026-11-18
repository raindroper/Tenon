# 稳定化整改与复审

> 本文保留第一轮验收快照。后续旧引擎退役、个人理解闭环及当前界面见[第二轮实现记录](round2-2026-11-03.md)。

本轮只修复[原审查的12项问题](code-review-2026-11-03.md)，整理状态所有权并补回归；没有新增连接器、界面或业务能力。模型仍由原生Mastra驱动，没有再套一层自制推理循环。正式资料在停服后备份至 `.local/validation/`；测试只用临时数据库、文件/Git夹具、Mock或本机脚本化HTTP提供方。

## 状态与模块边界

| 模块 | 唯一职责与持久权威 | 关键约束 |
| --- | --- | --- |
| `CaseMemory` | 原生thread、事项metadata、事项工作记忆与历史 | metadata与working共用每事项写队列；整轮推理队列与写队列分开，工具写记忆不会重入死锁 |
| `CaseService` | 事项领域操作；native status是唯一持久状态 | HTTP不再直接修改记忆；取消/激活走统一路径；内存状态投影有单调revision，迟到的get/list不能覆盖新提交 |
| `EventInbox` | SQLite事件、不可变归属、租约、去重与检查点 | 按ID查询、按可领取状态迭代；调度不再解析全部已处理payload；租约token防止旧确认覆盖新领取 |
| `SourceRegistry` | 来源配置、generation、观察器生命周期与健康状态 | 每代事件采集时固定case；替换include会关闭旧watcher；当前alias不能重写旧事件归属 |
| `CaseAdmission` | 同一inbox库内的创建intent与outbox | 先记固定case ID，再幂等ensure原生thread，再提交事件绑定；任一窗口中断可继续原操作，不重新找模型分流 |
| `BudgetLedger` / `meterModel` | 预留、用量结算、未知费用估算、重启恢复 | 请求前持久预留；用量与释放对应预留一次提交；unknown保守保留费用，不冒充供应商账单 |
| `WorkspaceExecutor` | 授权、准备intent、工作树进度、验证与交接 | 授权与进度分表，版本/CAS防覆盖撤权；Git副作用前留intent；文件提交需跨实例临界区保护 |
| `RuntimeLease` | 规范化数据目录的进程独占权 | 使用proper-lockfile；在Store打开和恢复运行记录前取得；失去身份后停止派发；旧实例不能释放替代实例的锁 |
| `RuntimeLifecycle` | 启停意图、关闭阶段与共享取消屏障 | stopped/running/held与open/draining/closed分开；多个cancel共用排空Promise；排空过程中start/request不能重新开推理 |
| `LegacyRecordService` | 旧表兼容操作 | 仅旧引擎消费这些状态时才排空旧运行；V2下改旧记录不会暂停整个代理 |
| `V2Coordinator` | 生命周期、调度、事件分流、能力范围 | 不再维护可写来源路由表、取消墓碑或费用算术；取消/停机还须排空已经开始的原生工具 |

执行中状态变更先停止受影响的任务，再等待任务和底层工具结束，最后提交变更。Mastra停止循环并不表示一个已经开始的本地工具也停止了；worker与intake统一通过工具作用域跟踪，取消返回后不允许仍有此轮工具提交。关闭是终态，不能在HTTP排空期间被新请求重新启动。

## 12项修复与正式回归

| 编号 | 修复 | 主要回归 |
| --- | --- | --- |
| R01 P1 | 来源generation与事件case不可变；旧alias不参与历史重路由 | `v2-sources.test.ts`；`stabilization-source-boundary.test.ts`真实HTTP→inbox→原生历史，删除A文件后重绑B仍不串资料 |
| R02 P1 | include变更替换整个观察器及代次，失败配置可见且可重试 | `v2-sources.test.ts` include replacement / failed replacement |
| R03 P1 | 每事项metadata与working共用写队列，原生状态统一经CaseService | `v2-memory-race.test.ts`；`v2-case-service.test.ts`迟到get/list竞争 |
| R04 P1 | 授权与进度分离、revision/CAS，并保护物理文件提交临界区 | `v2-workspace-recovery.test.ts`跨执行器撤销、写入、验证与物理提交竞争 |
| R05 P2 | 完整分项可推导用量；缺失部分保守估计；预留原子结算 | `stabilization-metering.test.ts`；`stabilization-budget-crash.test.ts`子进程在实际落盘点退出 |
| R06 P2 | 固定ID的创建journal/outbox与恢复；intake绑定先于ready | `v2-admission.test.ts`原生提交/事件提交/绑定提交各故障窗口 |
| R07 P2 | HTTP消息、激活与取消共用CaseService，移除双写取消状态 | `stabilization-boundaries.test.ts`取消→激活→HTTP输入；`v2-http.test.ts`取消与标题/目标复合PATCH |
| R08 P2 | 根不可用或部分扫描失败不替换成功检查点 | `v2-events.test.ts` unavailable root / enumerated file read failure |
| R09 P2 | fast-glob真实遍历语义约束深度和排除树；watcher同范围 | `v2-events.test.ts`非递归/negative glob和超过扫描上限的无关子树 |
| R10 P2 | worktree创建前持久准备intent；重试核对身份后恢复 | `v2-workspace-recovery.test.ts`真实Git、提交失败、未知目录保护、SIGKILL后重开 |
| R11 P2 | 主入口先取得目录租约；失败释放资源；关闭后才释放租约 | `runtime-lease.test.ts`跨进程/过期锁/替代持有者；`stabilization-boundaries.test.ts`第二实例不得改首实例running |
| R12 P2 | V1兼容变更不调用V2全局cancel | `stabilization-boundaries.test.ts`改旧记忆/议程后等待正常后台tick继续；`legacy-records.test.ts`旧模式编辑先排空 |

第二轮交叉复审重新检查了真实HTTP、原生Mastra存储、Git物理副作用和崩溃提交点。追加发现并修复：迟到查询回滚取消投影、intake创建后漏绑、复合取消PATCH丢字段、旧模式人工修改被在途模型覆盖、模型降价后预算阻塞不解除、已结算预留崩溃后重复计费、worker/intake取消时未排空原生操作，以及并发request在取消未结束时重开推理。均有确定的门控/故障注入或子进程回归，不以增加sleep规避竞争。

## 验证入口与边界

```powershell
npm run check
npm test
npm run build
```

`npm test`不加载项目`.env`，移除测试进程继承的DeepSeek凭证环境变量，预加载Node fetch/socket的对外网络阻断，只允许本机fixture。回归本身还用第二层假传输验证阻断器，防测试失效时产生真实外部请求。这是测试防误调用措施，不是执行不可信程序的OS沙箱。真实付费脚本仍是单独手动入口，本轮未运行。

每次测试有独立临时根。Windows原生libSQL在部分close后仍持有文件至worker退出，测试只允许已知Windows占用错误延后清理；父进程在所有worker退出后检查路径并清理整次测试目录，失败会使命令失败。删掉了会按多个文件累乘的长时间rm重试，没有宣称已从上游解决native句柄延迟。工作区与运行租约的实际释放另有正式测试。

新增Windows/Linux的GitHub Actions质量门禁定义。当前本机验证Windows；远程CI是否通过须以仓库实际运行结果为准。

## 数据升级

旧来源配置只作为一次性导入输入。旧事件只有明确的逐事件case证据才迁入对应历史代次；不从可变`sourceRoutes`猜归属。无法证明归属的旧文件事件保留并隔离，不交给另一个事项。当前授权来源建立独立代次和检查点，重新读取原白名单内的当前文件。

旧取消墓碑一次性迁入native status，成功后标记迁移完成；旧事项映射只作幂等导入证据。旧工作许可/回执迁入分离表时保留撤销状态。新表升级失败会停止初始化，不伪装成正常启动。

本轮没有扩大示例工作区只读范围、授予写权限或启用付费自主运行。仍未完成长期无人值守稳定性验收、远程身份验证、完整遗忘及人格学习；它们不属于这12项修复，也不因测试通过而自动宣称实现。

## 最终验收结果

- `npm run check`、`npm run build`通过。
- 最终全量`npm test`：**124/124通过，0失败、0跳过**，约29.77秒；测试父进程成功清理该轮临时根。
- 第二轮交叉复审已修复上述确认问题；本轮覆盖范围内没有已知未修复P1/P2。这里不作“所有缺陷均已证明不存在”的保证。
- 真实数据启动迁移完成，本机服务恢复至`http://127.0.0.1:4317/`。迁移后服务保持暂停，原预算设置已保留，核对期间没有模型调用。
- 原7条文件事件保留在停用的历史代次；当前授权代次重新采集7条，未把旧事件重新指派给当前事项，待办总数14、领取中0。这个数量增加是保留历史并重建可信检查点，不是复制后送模型执行。

本地验收日志为`.local/validation/`，不含付费凭证；运行状态仅保存白名单统计字段于`.local/validation/`，没有复制文件正文或聊天历史。

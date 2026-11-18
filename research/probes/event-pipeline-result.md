# 目录事件接入探针结果

日期：2026-11-02。实现范围仅为 `server/v2/events.ts`、`tests/v2-events.test.ts` 及本报告；未修改主 Store、共享类型、主服务或模型执行器。本模块不读取邮箱、账户、手机或系统传感器，不调用模型，不直接通知用户。

## 使用的现成基础

- SQLite 使用 Node 内置 [`node:sqlite` DatabaseSync](https://nodejs.org/docs/latest-v22.x/api/sqlite.html)，本模块只提供事件仓储、事务和租约的薄封装。
- 持续文件观察使用 [`chokidar`](https://github.com/paulmillr/chokidar) 5.0.0，复用 `awaitWriteFinish`、atomic 通知处理、ready 生命周期和符号链接开关。依赖由主代理安装。
- include glob 使用 Node `path.matchesGlob`，没有自研 glob parser；文本解码使用 UTF-8 fatal `TextDecoder`，哈希使用 `node:crypto` SHA-256。

验证环境：Windows，Node 22.19.0；使用真实本机 SQLite 与真实文件系统通知。全部目录是临时测试 fixture，不是用户资料，不会灌入产品的个人记忆或议程。

## 已实现接口

```ts
new EventInbox(file)
inbox.ingest(input) // { event: StoredEvent, duplicate: boolean }
inbox.ingestBatch(events, { sourceId, value: nextCheckpoint })
inbox.ingestBatch(sourceId, events, nextCheckpoint) // 等价重载
inbox.getCheckpoint<T>(sourceId, fallback?)
inbox.list(status?)
inbox.claim(limit = 20, leaseMs = 60000)
inbox.ack(id, leaseToken?)
inbox.retry(id, error, leaseToken?) // 释放为 pending，保留 lastError
inbox.fail(id, error, leaseToken?) // 释放为 failed，自动 claim 不再取
inbox.close()

new WorkspaceWatcher(inbox, { sourceId, root, include?, onEvents? })
await watcher.start()
await watcher.reconcile() // { created, updated, deleted }
await watcher.stop()
watcher.lastError
```

事件字段为需求中约定的 `id/sourceId/externalId/kind/operation/occurredAt/receivedAt/payloadRef/payload/actor/causationId/caseId/version`；`id/receivedAt` 未提供时自动生成。返回的 `StoredEvent` 增加 `status/attempts/leaseUntil/leaseToken/lastError`，不把这些运行状态混入原始事件 JSON。

事件幂等约束为 `(sourceId, externalId, version, operation)`。一次批量最多一个来源；事件与 checkpoint 同一事务提交，空批也可提交 checkpoint。相同幂等键重投返回原事件，不修改原 payload；不同事件误用同一 id 会报错并回滚批量。

真实消费者应始终传 `claim()` 返回的 `leaseToken`：

```ts
for (const event of inbox.claim(10, 60000)) {
  try {
    await consumeIdempotently(event); // 由上层实现，外部动作也要有幂等键
    inbox.ack(event.id, event.leaseToken!);
  } catch {
    inbox.retry(event.id, 'consumer failed', event.leaseToken!);
  }
}
```

过期租约可由另一消费者重领。带 token 的确认/重试会拒绝过期旧 worker；保留不带 token 的签名只为兼容原约定，不应在并发消费者中省略 token。失败重试的次数、退避和最终转 failed 由上层控制，仓储不启动隐式重试计时器。

## 目录观察行为

1. root 必须是显式提供的绝对真实目录；不接受符号链接根目录，同一 sourceId 已存 checkpoint 后不能静默换到另一根目录。
2. 启动顺序为第一次 reconcile 建真实基线 → 启动 chokidar → 等 ready → 再 reconcile，补偿两次启动阶段之间的变化。已有合格文件生成 create 事件，不生成预置个人事实。
3. 默认只读取常用文本扩展名及 README/LICENSE。始终排除 `.git/node_modules/data/.local/dist` 与 `.env/.env.*`；不跟随符号链接，并在实际读取时检查 realpath、文件描述符 inode 和 UTF-8 有效性。单文件最多 200 KiB。
4. 稳定性检查比较读取前后 size/mtime/ctime，变化中的文件保留旧 checkpoint，等待下次通知或补扫；不将暂时不稳定读取当成删除。读取长度有硬上限，避免文件读到一半突然增长而无限读入。
5. checkpoint 仅保存相对路径、hash、size、mtime 与单调 generation，不重复存正文；事件 payload 保存相对路径、正文和 SHA-256。删除事件保留旧 hash。相同内容的文件删除后重新创建会得到新 generation，不会因旧 hash 曾出现而被错误去重。
6. `onEvents` 仅是无参唤醒信号。回调失败不回滚事件；下一次 reconcile 会重试信号。文件观察无法证明写入者身份，所以 actor 为 external，不伪称 owner。

## 实测

运行：`npx tsx --test tests/v2-events.test.ts`；9 项全部通过。另运行 `npm run check` 通过。

| 测试 | 结果及证据范围 |
|---|---|
| 重复、版本、主键冲突、DB 重开 | 重投仍为原事件；重开后幂等约束仍有效；id 冲突拒绝覆盖。 |
| batch 与 checkpoint 故障 | 批中后一个事件校验失败时，先前事件和新 checkpoint 一起回滚；单来源校验有效。 |
| lease 崩溃恢复 | 关 DB 后等待租约过期再重开，事件可重领，attempts 增长，旧 token 不可确认新租约。 |
| 双 SQLite client 消费 | 活跃租约不会被第二连接重复领取；retry/fail 状态和错误原因可读。 |
| 真文件实时通知 | 在临时授权目录实际 create、write、unlink、重建；观察到 create→update→delete→create，正文匹配磁盘写入。 |
| 离线补账 | 停 watcher、关 DB 后实际新增/改动/删除文件；重开 reconcile 得到各 1 个变更；再启动不重复投递。 |
| 授权范围 | 实际创建 Windows junction 指向授权根外，外部文件未读取；忽略目录、非法 UTF-8、超限文件和 `.env` 不入 inbox。 |
| include 与来源绑定 | 原生 `**/*.md` 生效；同 sourceId 换目录被拒绝。 |
| 唤醒失败 | 回调抛错时事件仍 pending；后续 reconcile 可再次尝试回调且不复制事件。 |

## 尚未证明及集成约束

- 仅完成目录连接器。未证明邮箱/微信、手机采集或任意操作日志已接入。
- 这验证的是耐久 at-least-once 事件投递，不保证任意外部动作 exactly-once。消费端必须用 event id/case id 幂等执行，并在副作用与 ack 之间崩溃时检查外部结果。
- `reconcile()` 是显式能力，模块没有自启周期全扫描。主运行时应安排周期补扫、watch 错误后的恢复、重启后消费 pending/过期 leased，以及对失败事件的人工可见状态。
- 一个 sourceId 应由一个活动目录观察器维护 checkpoint。SQLite 支持并发消费者，但本轮没有实现多个观察器对同一 source 的分布式 leader 选举。
- 当前每次 reconcile 会对授权树做完整 hash 扫描，有 20,000 个访问条目的保护上限；应授权小而明确的资料目录。大目录的增量索引优化与资源压测尚未进行。
- 文件系统不能提供完整作者/因果身份。若 agent 也写此目录，上层需要记录自身输出 hash 与 causationId，防止无限“自己改文件→自己唤醒”。目录源不得直接授予工具权限。
- 事件正文存于本机 SQLite，属于敏感资料；本文未实现全文加密或历史 payload 清除。取消来源授权、删除资料后的事件留存/清理，应由集成层明确处理。
- 消失、转为二进制/超限、或不再匹配 include 的旧文件都会从来源快照移除，产生 delete。这表示“此来源不再提供它”，不一定意味着文件被物理删除。
- 测试覆盖了静态符号链接/真实 Windows junction 与稳定读取检查，没有声称在恶意本机进程持续竞态攻击下形成操作系统级沙箱。

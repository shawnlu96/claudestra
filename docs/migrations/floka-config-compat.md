# 配置混版本兼容与维护启动闸

## 配置读写和调用方

`readConfig` / `readConfigSync` 遇到 `autoUpdate.claudestra` 与 `autoUpdate.floka`
冲突时按旧字段返回，`configConflicts` 提供仅含键名和说明的报告，并输出一行
`[floka-config]` 日志。报告不枚举、不写回配置，不包含字段值或凭据。
正常读取不带报告。`writeConfig` / `writeCompatibleConfig` 继续严格校验磁盘及待写对象，
拒绝品牌冲突；底层拒绝 stale，不自动重试。

所有 setter 在 `ConfigChangedError` 后重新读取，重新执行本次字段修改，再写一次。
第二次仍过期会打印一行日志并抛同类型错误，提示 `配置刚被别处改过,请重试`。
重试没有循环；品牌冲突、维护屏障、损坏文件及 I/O 错误不触发重试。
`adoptWebSettings` 重试时重新判断哪些字段尚未配置，避免覆盖别人刚设置的值。

下表来自对 `src/` 的 `writeConfig` 及全部 setter 名称检索：

| 调用方 | 写入口 | 两次冲突后的边界 |
| --- | --- | --- |
| `src/bridge/api-routes.ts` | `setArchiveRetention` | `serveApiRequest` → `apiErrorResponse`，HTTP 409 |
| `src/bridge/update-routes.ts` | `setUpdateChannel`、`setAutoUpdate` | 同上 |
| `src/bridge/auto-compact-routes.ts` | `setAutoCompact` | 同上 |
| `src/bridge/peer-relay-strict.ts` | `setPeerRelayJoinStrict` | 同上 |
| `src/bridge/local-api/settings.ts` | `setLang`、`setGroqApiKey`、`setJevApiKey`、`setPushNoContent`、`setPushAllAsks`、`setTalkEnabled` | 同上 |
| `src/bridge/local-api/guard.ts` | `setChatGuard` | 同上 |
| `src/bridge/quota-service.ts`（由 `local-api/quota.ts` 调用） | `setQuotaLive` | setter 先日志；HTTP 入口同上，失败不改变配额服务内存开关 |
| `src/bridge/stats-dashboard.ts` | `setStatsDashboard`（频道 / 消息两处） | `ensureChannel` 返回 null 并日志；`doUpdate` 日志并复位 running |
| `src/manager/auto-update.ts` | `setUpdateChannel`、`setAutoUpdate` | `manager.ts` 顶层返回 `{ok:false,error}` 并非零退出 |
| `src/manager/codex-sub-archive.ts` | `setAutoArchiveCodexSubs` | 同上 |
| `src/manager/peer-relay-strict.ts` | `setPeerRelayJoinStrict` | 同上 |
| `src/manager/ctx-boundary.ts` | `setAutoCompact` | 同上 |
| `src/manager/state-maintenance.ts` | `setRenameStateMode` | `stateMaintenance` 返回 `{ok:false,error}` |
| `src/lib/web-state-migrate.ts`（manager migrate-web-state） | `adoptWebSettings` | 传播到 manager 顶层，返回失败 |
| `src/setup.ts` | `setLang` | 现有 catch 输出保存失败警告；语言内存更新只在写成功后发生 |
| `src/manager/pm-switch.ts` → `lib/pm-role-switch.ts` | `writeConfig` | 使用独立锁及原始配置对象，未持 configView 快照，不触发本次 stale 检测；现有切换流程接住写失败 |

`setAutoCompactIdleHours` 当前没有 `src/` 外部调用方，也使用相同的一次重试。
`launcher` 轮询只读配置；bridge 设置页及用量看板读取不会因品牌字段冲突失败。
HTTP 失败 body 为 `{ok:false,error:"配置刚被别处改过,请重试"}`，供按钮直接显示。

## 屏障与 STATE2 顺序

| `manager state-maintenance` 子命令 | 屏障期间启动 | 后续要求 |
| --- | --- | --- |
| `status` | 放行 | 只读查看 |
| `recover` | 放行 | 仍核单次授权和 runId，由独立执行器恢复 |
| `note-retry` | 放行 | 仍核单次授权，只补记维护结果 |
| `mode` | 拒绝 | 维护完成后才能切档 |
| 其他子命令 | 拒绝 | 不在恢复入口名单中 |

操作顺序与 `state-maintenance/services.ts`、`executor.ts` 一致：
先在无屏障时切档并预演、批准维护窗口，建立独立维护页及根外屏障；
先停 launcher / scheduler / cron 自动拉起与任务入口，再停会话，最后停 bridge；
停写探针确认后才迁移并验证，失败时按记录恢复或回滚。
中断后通过维护页或带授权的 `recover` 继续，用 `status` 检查，待补记用 `note-retry`。
根验证及恢复收尾后解除屏障，再切 `mode`；不能靠切档绕过未结束的维护。

## 启动真实路径与残余风险

实体 `Bun.main` 和入口名单双方均先 `realpathSync`，所以经 symlink 启动仍会命中。
任一边 realpath 失败即提示「状态迁移维护未完成，请到维护页恢复」并非零退出。
闸只作用于默认新旧状态根且屏障存在的情形，自定义根保留既有行为。
名单保持 bridge、launcher、cron、scheduler、manager、channel-server 六项。

PM 批准的虚拟入口例外：只有 `Bun.main` 精确等于 `cwd + /[eval]` 时保留库导入语义，
由 identity / config writer 的屏障自行拒写。名字相似或位置不同的 `[eval]` 不享受例外。
正常解析且不在名单中的库入口也沿用既有语义。

`acp-host`、`src/cli/*`、setup、hooks 不在名单内，维护流程必须先停止这些写者；
本卡没有扩大名单。这是维护期间手工重启这些入口仍可能写状态的残余风险。

## 精准例外清单

- `src/bridge/api-respond.ts`：仅新增错误类型 import 与 HTTP 409 映射，共 2 行。
- 本文 `docs/migrations/floka-config-compat.md`：PM 批准新增；不修改已有文档。
- 其余实现和测试均在本单原有 fileGlobs 内。

后合并的一方需 merge main，并保留两边修改。

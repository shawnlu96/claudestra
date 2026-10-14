# bridge 存活探测（bridge watchdog）

launchd 托管 `com.claudestra.bridge`（KeepAlive），只在进程**退出**时拉起。进程活着但不干活——本机接口不应答、
中继一直连不上且重连不前进——没有任何东西去探测。launcher 每轮体检（`CHECK_INTERVAL_MS` = 15 秒）顺带探测一次，
判为卡住时按开关重启 / 只记录。探测放在 launcher 而不是 bridge 里：卡住的进程查不了自己。

代码：`src/lib/bridge-watchdog.ts`（判定是纯函数 `observeRound` / `decideRound`，探测、重启、记录、通知经 `WatchdogDeps` 注入），
测试 `tests/bridge-watchdog.test.ts`。判卡住时的抓现场在 `src/lib/bridge-watchdog-diag.ts`，不经 bridge 的通知在 `src/lib/bridge-watchdog-oob.ts`，
两者同样经注入的 io 测（`tests/bridge-watchdog-diag.test.ts`、`-oob.test.ts`、`-episode.test.ts`）。launcher 主循环里一处调用 `tickBridgeWatchdog`（不 await；上一轮没跑完就跳过本轮）。

## 开关

`~/.claude-orchestrator/config.json` 的 `bridgeWatchdog` 键，每轮现读，改完不用重启：

| 值 | 行为 |
| --- | --- |
| `"observe"`（缺省；不写 / 坏值 / config.json 坏了都按它） | 照常探测和判定，不重启。每次判定写一条日志（launcher 日志里 `🩺 bridge 卡住[…] 本该重启（observe）`），每种原因每小时最多通知 master 一次「本该重启」 |
| `"on"` | 判为卡住 → `launchctl kickstart -k gui/<uid>/com.claudestra.bridge`，写日志并通知 master「bridge 卡住，已自动重启」，带原因与最后一次正常的时间 |
| `"off"` | 不探测 |

部署时缺省 observe；PM 观察 24 小时没有误判再切 on。

> `config-store.ts` 的读写是白名单式的，`bridgeWatchdog` 已加进 `merge()` 的白名单：网页设置等任何 `set*`（读→改→写）都会原样保留它。

## 探测

每轮一次，向 `http://127.0.0.1:<BRIDGE_PORT>/relay/status` 发回环只读请求（免鉴权，`relayStatusResponse`），超时 5 秒。
同一个响应里取 `enabled`、`connected`、`state`、`retryAt` 判中继。bridge 的 PID 用 `launchctl list com.claudestra.bridge` 读。

## 判据

- **(a) 本机接口**：连续 4 次无响应或非 2xx 判卡住。中间任何一次成功就清零。按 15 秒一轮、每次最多 5 秒超时，约 1～1.5 分钟。
- **(b) 中继**：`enabled` 为真、`connected` 为假满 10 分钟，并且重连状态机**没有在前进**。
  - relay-client（`src/lib/relay-client.ts`）的重连循环：`offline`（`retryAt` = 未来某刻）→ 到点 `open()` 变 `connecting`（`retryAt` = null）
    → 失败回 `offline`（新的 `retryAt`）。退避上限 30 秒，致命错误 5 分钟，正常重连时 `state|retryAt` 签名几分钟内必变。
  - 「没有在前进」= 签名 `state|retryAt` 连续 10 分钟不变，并且当前不是在等一个未来的 `retryAt`。
    典型是 `offline` 且 `retryAt` 早已过期却不再刷新（重连定时器丢了），或 `connecting` 挂了 10 分钟（握手不返回）。
  - `state` 为 null（bridge 没起中继客户端）或 `closed`（主动关闭）不判；宁可漏报，不可误杀。
- **启动宽限**：同一个 PID 第一次被看到后的 2 分钟内不判。
- 判过一次就清掉该原因的计数，下一次要重新攒满（4 次失败 / 10 分钟），不会每轮都报。

## 防重启风暴（on）

- 1 小时内已重启 3 次，第 4 次只报警、不重启（报警每种原因每小时最多通知一次）。这一条先于冷却判：第 3 次重启后的冷却期里再卡住也立即报警。
- 未到上限时，两次重启至少隔 15 分钟，不足则只记日志（`cooldown`）。
- 两条节流都按实际重启时间算：判定用探测结束后的新鲜时钟（探测最多耗 5 秒），重启成功后重启历史改记为重启动作完成时的时钟（只会偏晚不会偏早），不拿探测前的时间。

## 部署

- bridge 的 PID 变了（deploy-full、manager update、手动 kickstart、本模块的重启）：计数清零，重新开始启动宽限。
- 整机部署锁（`pm-deploy.lock`，deploy-full / card-merge 持有）的持有者还活着：跳过本轮，不探测。
- 探测最多等 5 秒，探测完再查一次部署锁和 PID：这期间部署起来了或 PID 变了，本轮结果作废（失败多半是部署断掉的旧连接），新进程重新计数和宽限。
- 重启时持整机部署锁（`acquireDeployLock`，不等）：拿不到 = 部署在跑，不重启；拿到后再核一次 PID，已不是判卡住的那个进程也不重启。
  持锁期间 deploy-full 起不来，重启与部署互斥。这两种情况都不计重启次数、不发「已重启」。
- 查不到 bridge 的 PID（没在跑 / 没装）：不判，交给 launchd。

## 卡住事件

从第一次判卡住到恢复正常算一个**卡住事件**（`WatchdogState.episode`）。抓现场和带外通知按事件做，不按每次判定做：
同一事件里后续的判定（冷却、再次重启、报警、observe 的每次「本该重启」）都不再抓、不再发。

- 开始：事件外的第一次判卡住。先抓现场，再发带外通知并执行原有动作（带外通知与重启并行，不拖重启）。
- 恢复：按事件开始时的原因判。接口卡住的事件，探测成功即恢复；中继卡住的事件，中继连上（或已停用）才算恢复。
  恢复时写一条日志、发一条带外通知，事件清掉；之后再卡住是新事件。
- 重启因部署在跑 / bridge 已换进程被让掉时，现场已经抓过，事件保留，恢复时照发。
- 看门狗（`bridgeWatchdog`）为 `off` 时不探测，也就不抓、不发。看门狗为 `observe` 时照样抓现场、发带外通知，只是不重启。

## 抓现场（`bridgeWatchdogDiag`）

`kickstart -k` 之后旧进程就没了，卡在哪里要在重启之前留下来。`config.json` 的 `bridgeWatchdogDiag` 键，每次现读：

| 值 | 行为 |
| --- | --- |
| `"on"`（缺省；不写 / 坏值都按它） | 每个卡住事件开始时抓一次，on 档在重启之前 |
| `"observe"` | 只写一行日志「本会抓哪些」，不执行任何命令、不建目录 |
| `"off"` | 不抓，也不记 |

抓的内容全部是系统自带的只读命令，不改进程和系统的任何状态：

| 文件 | 命令 | 落盘内容 |
| --- | --- | --- |
| `sample.txt` | `/usr/bin/sample <pid> 3 -file …`（仅 darwin） | macOS 原生调用栈，采 3 秒 |
| `ps.txt` | `ps -o pid,ppid,stat,%cpu,%mem,rss,etime,wchan -p <pid>` | 原样 |
| `lsof-counts.txt` | `lsof -n -P -p <pid>` | 只存条目数和按类型（REG / IPv4 / IPv6 / unix / PIPE / other）的计数，路径和地址不落盘 |
| `swap.txt` | `sysctl vm.swapusage` | 原样 |
| `vm_stat.txt` | `vm_stat` | 页大小、free / active / inactive / wired / compressor、Swapins / Swapouts 几行 |
| `load.txt` | `uptime` | 只留负载那一段 |
| `summary.txt` | — | pid、时间、每条命令 ok / 失败 / 跳过 |

- 目录：日志目录（`src/lib/log-paths.ts` 的 `LOG_DIR`）下的 `bridge-stuck-<UTC 时间>/`，如 `bridge-stuck-20261013T204835Z/`；目录 0700、文件 0600。
- 限时：`sample` 最多 10 秒，其余每条 3 秒；`sample` 与其余几条并行，其余几条按顺序跑。全部命令共用 13 秒总时限，
  到点后没起的命令跳过、在跑的被杀。看门狗这一侧再套一层 15 秒上限，到点不管抓没抓完都继续重启。
- 抓取失败、超时、目录建不出来都只记一行日志，不挡重启；那次带外通知里的现场写「无」。
- 保留最近 5 份。清理只认 `bridge-stuck-<8 位日期>T<6 位时间>Z` 这种名字的**目录**，旧的整份删；日志目录里别的文件和目录不碰。
- 非 darwin 没有 `sample`，跳过这一项；`sysctl vm.swapusage`、`vm_stat` 在没有它们的平台上记为失败，其余照抓。
- `lsof` 多带的 `-n -P` 是不反查主机名和端口名：卡住的机器上反查会把时限耗完。

## 带外通知（`bridgeWatchdogOob`）

原有通知走 `notify()`，经 bridge 投递；bridge 卡住时这条路不通，只会落进未送达日志。带外通知不经 bridge，原有通知照旧保留。
`config.json` 的 `bridgeWatchdogOob` 键，每次现读：

| 值 | 行为 |
| --- | --- |
| `"on"`（缺省；不写 / 坏值都按它） | 每个卡住事件开始发一条、恢复发一条 |
| `"observe"` | 只写一行日志「本会发什么、走哪条路」，不发 |
| `"off"` | 不发，也不记 |

- 路由：launcher 的环境里同时有 `DISCORD_BOT_TOKEN` 和 `CONTROL_CHANNEL_ID` → 直接调 Discord REST（`POST /channels/<id>/messages`，超时 5 秒）发到控制频道。
  缺任何一个 → darwin 上发一条系统通知（`osascript` 的 `display notification`，正文走 argv，只发通知、不操作界面）；别的平台只记日志。
- 文本：机器短名（主机名第一个点之前）、判定原因（固定措辞，不带探测的错误原文）、最后一次正常的时间、看门狗当前档位、现场目录名。
  不带 token、IP、主机全名。
- token 只从环境读，只放进请求头；不进日志、命令参数和错误文本（错误文本外发前再抹一遍）。
- 发送失败只记一行日志（`HTTP <状态码>` / 错误信息），不重试，不影响重启和原有通知。

`config-store.ts` 的 `merge()` 白名单已带这两个键，任何 `set*` 都会原样保留。

不碰中继服务端，不改 bridge 的接口和行为。

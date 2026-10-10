# bridge 存活探测（bridge watchdog）

launchd 托管 `com.claudestra.bridge`（KeepAlive），只在进程**退出**时拉起。进程活着但不干活——本机接口不应答、
中继一直连不上且重连不前进——没有任何东西去探测。launcher 每轮体检（`CHECK_INTERVAL_MS` = 15 秒）顺带探测一次，
判为卡住时按开关重启 / 只记录。探测放在 launcher 而不是 bridge 里：卡住的进程查不了自己。

代码：`src/lib/bridge-watchdog.ts`（判定是纯函数 `observeRound` / `decideRound`，探测、重启、记录、通知经 `WatchdogDeps` 注入），
测试 `tests/bridge-watchdog.test.ts`。launcher 主循环里一处调用 `tickBridgeWatchdog`（不 await；上一轮没跑完就跳过本轮）。

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

不碰中继服务端，不改 bridge 的接口和行为。

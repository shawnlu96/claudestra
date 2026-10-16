# rename.retireCompat：证据满足后分项退出旧名兼容（rename-floka-CLEAN1）

本目录只做**退出门槛**：用观察样本（格式见 [`../rollout-runbook.md`](../rollout-runbook.md) §2）判断每一项旧名兼容能不能收，
出一份分项退出计划；`on` 档也只是把「收掉之后的允许表」与恢复包写进一个空的临时目录。**不删除任何旧入口代码**，
不读写状态目录（只读算哈希），不碰 launchd、生产配置或 GitHub。真正删代码由 PM 按计划逐项另开执行卡。

```bash
bun scripts/rename-floka/retirement/cli.ts --sample <样本.json> [--config <config.json>] [--allowlist <表.json>]
# on 档（PM 核过样本、逐项点名后）：
bun scripts/rename-floka/retirement/cli.ts --sample s.json --config c.json \
  --items legacy-send,install-alias --target "$(mktemp -d)" --state <状态目录>
```

| `rename.retireCompat` | 行为 |
|---|---|
| `off`（缺省；写错也按它） | 什么都不做 |
| `observe` | 计划打到 stdout，零写入；给 `--items` / `--target` 直接报错 |
| `on` | 同 observe，另要求 `--items`（逐项点名）、`--target`（已存在、空、在系统临时目录下、不与仓库 / 状态目录重叠）、`--state`（只读） |

退出码：`0` 计划已出 / on 已写入；`1` on 档拒绝执行（一个文件都不写）；`2` 用法 / 输入错误。

## 退出项与证据

允许表 [`../codemod/compat-allowlist.json`](../codemod/compat-allowlist.json) 里每条还在认旧名的入口归一个项。
每项只被与它相关的退出理由挡住（`src/lib/floka-compat/retirement/items.ts`），所以一项证据齐全就只放行这一项：

| 阶段 | 项 | 除公共条件外还要 |
|---|---|---|
| 1 | `legacy-send` | 所有 `send/*` 格旧计数实测 0、新族计数有实测 |
| 1 | `install-alias` | 旧 MCP 会话 0；`infra.installCopies`、`infra.systemd` 为 done |
| 2 | `receive-<区>` | 该区 `receive/*` 格实测 0；该区存量载荷全过期 / 实测无存活；待处理旧调用 0；relay / ledger 另要中心观察；browser 另要浏览器 / SW 客户端 0 |
| 2 | `browser-storage` | 浏览器 / SW 旧客户端与离线客户端 0；设备凭据过期；`receive/browser` 0；domain、vapid done |
| 2 | `scheme` | 浏览器 / native 旧客户端与离线客户端 0；installCopies done；invite 载荷存活 0 且已过期（含 unknown 都挡）；receive/browser 旧流量 0、无 unknown |
| 2 | `env` | 旧 MCP 会话 0；systemd、nginx、installCopies done |
| 2 | `legacy-read` | **全部**退出理由清零；旧读兼容可以长期保留，不为旧名归零提前收 |

公共条件（挡所有项）：至少三机且节点全认新族、全部切新发送、切新后的完整窗口（max(14 天, 最长有效期) = 90 天）、回滚期已满。
`unknown` 与「有旧流量」同样拒绝；观察模块新增、这里没登记的理由码一律挡全部项。阶段 2 要等阶段 1 的项全部收掉
（或同一次 on 一起点名），否则记 `phase_order`。计划里 `budget.splitRequired = true` 表示可收条目超过 12 条，PM 另拆执行卡。

## 永不退出

允许表的 `retain` 列出受保护文件（实例 id / 密钥、peer、token、pin、撤销记录、历史 transcript / 归档）。
任何可退出条目指到这些文件，整张表解析失败。on 档执行前后对 `--state` 下这些文件逐个算 sha256，不一致即报错。
状态目录里的数据不因清旧名删除。

## 一项失败不越权

- observe 的计划逐项给 `retirable` 与 `reasons`，被挡的项不影响别的项的判定。
- on 只收 `--items` 点名的项；点名里任一项不可收（含 `phase_order`）整次拒绝，一个文件都不写；没点名的项即使可收也不动。

## 紧急恢复（回旧格式）

on 档在目标目录写三份文件，全部新建、不覆盖：

| 文件 | 内容 |
|---|---|
| `compat-allowlist.json` | 收掉后的允许表：被收条目原样搬进 `retired`（带 `retiredAt`），`entries` / `retain` 其余一字不动 |
| `compat-allowlist.recovery.json` | 执行前的原表，逐字节相同 |
| `retirement-plan.json` | 当次计划、点名项、受保护文件哈希摘要 |

回旧格式：把 `retired` 里对应项的条目搬回 `entries`（去掉 `retiredAt`），或直接用 `compat-allowlist.recovery.json` 覆盖。
执行卡删掉的旧入口代码按提交 revert 恢复；协议档位（`rename.signature` 等）退回 observe 即可让旧族重新被接收。

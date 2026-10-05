# relay-direct-RD1 · 同端点直连 vs 中继测量基线工具

这是 RD0 已审设计（r2）的测量节点：只交付**可复用的测量 harness 与它的验证**，不改路线设计，也**不包含任何生产读数**。
owner 的答复（先有直连，再谈 WebRTC）要用数据支撑。生产 matched 对照（RD0 §1.4）由 PM 用同一个 harness 实测，RD0 合并前必须拿到那份结论；本卡 verified 只说明工具可用，不代表测量已完成。

- harness：`tests/relay-direct-baseline.ts`（纯模块 + `loopback` / `summarize` 两个 CLI 子命令）
- 验证：`tests/relay-direct-baseline.test.ts`（合成身份、127.0.0.1 回环，不碰真实 peer）

## 1. 边界

| 做 | 不做 |
|---|---|
| 由注入的**只读请求 port** 驱动采集（接口只有 `get(endpoint)`，没有 method / body） | 读生产 `.env` / `peers.json` / 令牌 / Keychain，连 bridge / tmux / 真实服务 |
| 真实 peer 的 port 由 PM 在本地用**现成的 `peerFetch` / E2E client** 包出来（`fetchPort` 适配） | 手写签名、重放抓到的请求、发副作用业务消息或订单 |
| 每轮最多 20 条外部读样本（`ROUND_MAX`），严格串行 | bulk relay 压测；并发竞速 |
| 记录网络切换所见 | 替 owner 配 Tailscale / 域名 / 端口 / 证书 / 中继部署 |

执行者（包括本卡）只跑隔离回环和纯记录 fixture。回环 CLI 产出的汇总固定标 `source: "loopback-fixture"`，不能当生产读数用。

## 2. 什么算 matched

两条样本只有在下面这些**全部相同**时才放在一起比较（`MatchKey`）：

`responder` · `endpoint` · `principal` · `responseVersion`（缺省取 ETag）· `encoding`（content-encoding，缺省 identity）· `bytes` · `bodyHash`（sha256）

- 某个 key 只有一侧有有效样本 → 这一组 `unavailable`：`no_direct` / `no_relay`。如果同 responder、同端点、同 principal 的另一侧存在但版本 / 压缩 / 正文不同 → `body_mismatch`。不硬凑比较。
- **不同 responder 永远各成一组**，不比较、不归因。
- 握手（`handshake`）与 session 复用（`reused`）分开成组。port 不报的话，本次采集里每个 port 的第一条记为 handshake。

### 不进 RTT、单独计数的样本（`excluded`）

| reason | 含义 |
|---|---|
| `transport` | 超时 / 断连（status 0）。错误原文可能带地址，不写进样本 |
| `status` | 非 2xx |
| `shape` | 不是 JSON，或 probe 的 shape 校验不过 |
| `verify` | 正文读取失败 |
| `phase_order` | 单调时钟上阶段倒序 |
| `bad_sample` | 缺阶段、非有限数、未知时钟单位、未知会话标签 |

## 3. 阶段与统计

单调时钟（`performance.now()`；也可以注入 `us` / `ns` 时钟，统一换算成 ms）上的阶段标记：

`start` → `hello`（可选，port 报出建连完成）→ `send` → `headers` → `verified`（正文读完、JSON 与 shape 校验完）

| 列 | 计算 |
|---|---|
| `connect` | hello − start，只在 handshake 样本里有 |
| `ttfb` | headers − send（port 不报 send 时 send = start，此时 ttfb 包含建连） |
| `body` | verified − headers |
| `total` | verified − start |
| `cliStartup` | 进程 / CLI 启动耗时，**单独一列**，不并入 total |

每列给出 `n / p50 / p95 / unit=ms`，分位数用**最近秩法**（不插值），汇总带 `date` 与 `source`，缺一项就拒绝出汇总。这里量的是小 API 请求的**延迟**，不能写成链路带宽或 goodput。

## 4. desktop / iOS 启动

`StartupRecord` 记录 navigation / api / headers / body / firstUsableRender 五个阶段，按「平台 × 冷/暖 × 前台/后台」分组。

- `source: "device"`：真机实测，进统计。
- `source: "pending"`：这一组只列 `pending_pm_owner`（等 PM/owner 实测），没有数值。
- `source: "simulated"`、标签不认识：拒收，计入 `rejected`，**不能当作通过**。
- `networkSwitch`：只记录看到的网络切换（Wi-Fi↔蜂窝、Tailscale 起落等），打码后进公开汇总。

目前所有组都等 PM/owner 实测：

| 平台 | 冷 / 前台 | 暖 / 前台 | 冷 / 后台→前台 | 暖 / 后台→前台 |
|---|---|---|---|---|
| desktop | 待测 | 待测 | 待测 | 待测 |
| iOS | 待测 | 待测 | 待测 | 待测 |

## 5. 隐私

- 原始样本只写**私密 manifest**：`writePrivateManifest(dir, repoRoot, payload)`。目录在 repo 内就拒绝写；目录权限 0700、文件 0600，文件名带 sha256 前 12 位。`readPrivateManifest` 会核对哈希，内容被改过就拒绝读取。
- 公开汇总（`publicSummary`）：responder / principal 换成 `R1` / `P1` 这样的代号，端点去掉 query 并打码，不带 responseVersion 和 bodyHash（可能用来识别对端），只附 manifest 的 sha256。
- 真实地址、token、peer 身份和原始测量都不进 git、不外发。

## 6. 运行

所有实测都用隔离环境：`env -i`、临时 HOME / STATE / RUNTIME / TMPDIR、完整 PATH、`bun --no-env-file`。

```sh
REPO=/path/to/claudestra          # 可参数化
T=$(mktemp -d)
env -i PATH="$PATH" HOME="$T" TMPDIR="$T" CLAUDESTRA_STATE_DIR="$T/state" CLAUDESTRA_RUNTIME_DIR="$T/run" \
  bun --no-env-file "$REPO/tests/relay-direct-baseline.ts" loopback --out "$T/private" --repo "$REPO"
# stdout：{ manifest: <私密文件路径>, summary: <匿名汇总> }
env -i PATH="$PATH" HOME="$T" TMPDIR="$T" bun --no-env-file "$REPO/tests/relay-direct-baseline.ts" summarize "$T/private/relay-direct-<hash>.json"
```

`tests/relay-direct-baseline.test.ts` 的 CLI 用例按上面的方式（临时 HOME、`--no-env-file`、`--repo`）跑通了这两条命令。

### PM 跑生产 matched 对照（留给 PM，本卡不做）

在仓库外的本地脚本里 `import { collect, fetchPort, summarize, publicSummary, writePrivateManifest } from "<REPO>/tests/relay-direct-baseline.ts"`：

1. 两个 port 指向**同一个 responder**：`path: "direct"` 的 baseUrl 是直连地址，`path: "relay"` 的是 `relay://<指纹>`。`fetchLike` 都传现成的 `peerFetch`，签名头由 `headersFor` 调现成的 `signedFor` / 实例签名产生。凭据和路径候选由 PM 本地提供，harness 不碰。
2. probe 只选只读 GET 端点，并给出 shape 校验；`perRound ≤ 20`。轮数有界，写进记录。
3. 原始数据写私密 manifest，公开只贴 `publicSummary`。凡是 `unavailable` 的组如实列出，不跨 responder 解读因果。

## 7. 测试覆盖

已知分位数、空样本、坏样本、正文不匹配、不同 responder、阶段倒序、时钟单位、握手/复用分组、冷暖与前后台标签、simulated 拒收、secret 不出现在输出里、manifest 写在 repo 内拒绝 / 0600 / 篡改检出、每轮上限、串行、fetchPort 只发 GET、回环 CLI 端到端。

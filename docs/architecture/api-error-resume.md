# 回合以 API 错误结束：自动续跑与网络类退避

代码：`src/lib/api-error-resume.ts`（状态机）、`src/lib/transient-error.ts`（分类）、`src/bridge/quota-wall-wiring.ts`（接线）、
`src/bridge/acp-link.ts`（ACP 回合失败卡）、`src/bridge/turn-failure.ts`（告诉请求方）。单测：`tests/api-error-resume*.test.ts`、`tests/transient-error.test.ts`、
`tests/acp-link-transient.test.ts`、`tests/turn-failure-transient.test.ts`。

## 入口

- **Claude Code**：jsonl-watcher 见到 `isApiErrorMessage:true` 的 assistant 条目，发 `api_error_turn`（带错误码 `error` 和原文 `text`）。
- **ACP（Pi / Codex）**：宿主把失败写成同形的错误条目（`failureEntry`，适配器没说不能重试的才标 API 错误），走同一个事件；
  另发 `acp_failure` 给 `acp-link`，由它决定开不开「<运行时> 回合失败」卡。

两条入口汇到 `quota-wall-wiring` 的 `api_error_turn` 处理：额度闸先接（撞墙原文进闸、出闸续跑），模型额度不续，其余按下面两种规则。

## 分类（`isTransientError`）

错误码和原文拼在一起判。**先排除**：登录失效（`/login`、401/403、OAuth）、额度（`hit/reached your … limit`、quota、billing、spend limit）、
套餐过期 / usage limit（`not your usage limit` 除外）、内容策略（cyber、safeguards / AUP）、上下文耗尽（Prompt is too long）、
模型不可用、请求本身错（4xx、`invalid_request`、`not_found`）、本机钥匙串——它们各走各的路，原文里带网络字样也不改道。
**网络 / 服务端瞬时**：连接失败 / 重置 / 中途断流、DNS（ENOTFOUND / EAI_AGAIN）、TLS / 证书（含 `UNKNOWN_CERTIFICATE_VERIFICATION_ERROR`）、
超时、`terminated`、`This operation was aborted`、断流（Codex `stream disconnected`、Pi `Stream ended without finish_reason`）、
HTTP 500/502/503/504、529 overloaded / high demand、服务端临时限流（429 / rate limited，不含额度原文）。关键词带词边界（`bash_timeout`、`not_found_error` 不算）。
500 也算：CC 的原文明说「server-side issue, usually temporary」。

ACP 失败帧另要求：`kind=error`、适配器没说 `retry:false`、不是投递不明、不是 `newSession`（`isTransientAcpFailure`）。

## 规则与预算

| | 网络类 | 其它 API 错误 |
|---|---|---|
| 续跑 | 第 n 次续跑前等 1、2、4、8 分钟（`TRANSIENT_BACKOFF_MS`），共 4 次、约 15 分钟 | 60 秒后续 1 次 |
| 升级 | 4 次续跑后第 5 次再撞：频道里报一次，正文写「连续 N 次网络类错误（几点起）、最后一次原文」 | 续过、10 分钟内又撞 |
| 期间 | 不开回合失败卡（ACP）、不报频道，日志照记 | 同左（ACP 卡照旧当场开） |
| 清零 | 只认续跑后正常结束一个回合（Stop 且不是 API 错误，`noteTurnOk`）；隔多久再撞都接着数（黑洞式断网每轮 10 分钟以上才失败）。续跑后 1 小时既没撞也没正常结束（`STREAK_IDLE_MS`）才丢 | 10 分钟窗口 |

- 续跑还没发出去又撞 = 同一次：只更新原文、重新计时，不多算次数。错误后它自己动了（有人发消息 / 自己跑）= 取消这次续跑。
- 升级后记录删掉：同一串只报一次；之后有人让它接着做、又撞，是新的一串，从 1 分钟重新退避。
- 监护对象（`agent-supervisor-bridge.ts`）：同一件活的续跑次数照旧最多 3 次（`SUPERVISE_RULES.overload`），与上面的退避先到哪个算哪个。
- ACP 派单会话（`runtime-failure-audience`）：网络类也照旧开卡（不推 owner、交派活方），退避续跑同时进行，与改动前一致。
- ACP 网络类失败照旧记给这一轮的请求方（`noteTurnFailure`，回程槽被一句「收到」消化了也能收到）：说的是「正在自动重试（最多 4 次，约 15 分钟），先别重派」；
  这一串用完（升级 / 等不回来作废）再补一条最终说明，恢复了不打扰（`onStreakEnd` → `turn-failure.ts`）。频道里的升级照旧只发 agent 自己频道。
- 续跑计划落盘（`STATE_DIR/api-error-resume.json`，`loadResumeStates` / `saveResumeStates`）：撞错、取消（有人发消息 / 撞额度 / 模型额度 / 正常结束清零）当场落，15 秒一拍兜底。
  退避中 bridge 重启，读回来到点照续、次数接着数；撞错已过 30 分钟（`STALE_RESUME_MS`）还没续的读回时丢掉，不投陈旧的「继续」；字段坏的单条丢掉记日志。
- 到点要续而 agent 没连着（重启后没连回来 / 窗口没了）：留着等它连回来；撞错满 30 分钟还没连上就作废，频道报一次（`dropOffline`）。

## 已知限制

- 分类只看原文：AIR 的结构化类别（connection / service + retry）到不了 `api_error_turn`（watcher 只带错误码和原文），只用在 acp-link 会让两处判法不一致；
  只认了 AIR 缺省标题里的「（connection）」。
- 监护台账的续跑记录文案仍写「bridge 60 秒后同会话续跑」（`agent-supervisor.ts`，不在本卡范围）。
- 第 4 次续跑后的长回合里再撞一次，按第 5 次升级（一串只靠正常结束清零）。
- 重试成功后请求方拿不拿得到结果，照旧看它的回程槽：槽早被「收到」消化的，只收到过那句「正在自动重试」。
- watcher 照旧把每次「API Error: …」转到频道，一串断网最多 5 行。

## 不归这里

额度闸（`quota-wall.ts`）、登录卡、cyber 截断恢复（监护）、派单会话失败的归属都不变；Pi / Codex 自己的重试配置不碰。

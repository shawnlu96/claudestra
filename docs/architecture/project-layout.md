# Project layout (per-file notes)

> Moved verbatim out of `CLAUDE.md` on 2026-09-23 so the file every session loads stays small (it is size-ratcheted by `scripts/guard`). Version tags and incident notes below are history; the code is the source of truth.

## Project layout

```
src/
  bridge.ts              Main entry: Discord client, WebSocket server, deliver() dispatch, slash commands, Stop hooks
  bridge/
    router.ts            v2.0.0+ Envelope/Endpoint types + parseAddress + threadId helpers; v2.6.0+ parseChatId (unified transport-prefixed chat_id keyspace) + ApiUserEndpoint
    adapters.ts          v2.6.0+ ChatAdapter interface + registry (NeutralMessage contract); Discord is the first adapter, deliverToUser dispatches by transport
    event-bus.ts         v2.6.0+ in-process event bus (seq + per-agent ring buffer) mirroring tool calls / assistant text / status → SSE
    config.ts            Shared runtime constants
    components.ts        Discord UI components + typing indicators
    discord-api.ts       Discord API wrappers: discordReply (chunking / reply_to / files / components), channel CRUD, react, edit
    management.ts        Admin button/select handlers that bypass the LLM
    screenshot.ts        Terminal screenshot pipeline (ANSI → HTML → PNG)
    jsonl-watcher.ts     JSONL session tailer → tool summaries + assistant text stream + drain-on-Stop; v2.23.2+ every
                         tool_start / assistant_text / reply_pending event carries {seq, sid} — the record's full-file
                         line number (same coordinate as session-history's seq) + session id — so the web client can tell
                         "already rendered from history" exactly instead of guessing by timestamp
    slash-catalog.ts     Hardcoded list of CC built-in slash commands (Discord-friendly subset)
    slash-registry.ts    Runtime registry of discovered skills per scope + per-channel resolver
    wedge-watcher.ts     Detects agents stuck >30min with no pane change + not idle → Discord alert; v2.7+ link sentinel (window alive but channel-server offline >5min → repair button); v2.14+ the link alert also emits `session_anomaly(kind=link_down)` so web clients see it too — they used to get no signal at all when the MCP link went down
    sessions-inventory.ts v2.7+ neutral machine-wide session inventory: `claude agents --json` + jobs state + registry reconciliation → doppelganger detection
    session-reconciler.ts v2.7+ 10-min bg reconciler: new doppelganger → Discord alert with cleanup/adopt buttons + session_anomaly event
    bg-activity-watcher.ts v2.8+ bg activity tracker: discovers subagent jsonls + bg shell task outputs per agent session → streams into per-activity threads (ChatAdapter.provisionThread) + bg_task_* SSE events
    archive-sweeper.ts   v2.9+ daily archive sweep: every 24h snapshots all active agents' session jsonls (idempotent copy-if-larger) — covers crash/never-retired gaps that retirement-time archiving misses
  channel-server.ts      Per-session MCP proxy (stdio MCP ↔ Bridge WebSocket)
  pi/
    claudestra-extension.ts  v2.23+ Pi agent 侧通道：与 channel-server 同一套 bridge ws 协议，
                            但靠 Pi 扩展 API 注入消息（pi.sendUserMessage）并在 agent_settled
                            时上报回合结束；仅当 DISCORD_CHANNEL_ID 存在时生效
  manager.ts             Agent lifecycle + cron + version/update CLI (JSON output)
  cron.ts                Cron scheduler daemon (launchd-managed)
  launcher.ts            Master tmux session guardian (launchd-managed)
  setup.ts               Interactive installation wizard
  hooks/
    typing-hook.ts       Claude Code Stop/Notification hook → Bridge HTTP endpoint; v2.22.x Stop 时 bridge 可回 {block, reason}(未回复的频道请求)→ hook 输出 decision=block 让 agent 补 reply
    recall-hook.ts       v2.21.5+ SessionStart hook: injects the project's HANDOFF.md + `~/mem0-mcp/recall.py` output (mem0 top-layer recall) into the opening context; always exits 0, 10s cap
  lib/
    bridge-client.ts     Shared Bridge WebSocket request helper
    tmux-helper.ts       Shared tmux command wrappers (tmuxRaw, isIdle, sendLine, …)
    claude-launch.ts     Unified Claude Code launch-command builder (flags, MCP_NAME, shell escaping)
    pi-launch.ts         v2.23+ Pi agent 的启动命令（--approve / --extension / --session-id open-or-create）
    pi-env.ts            v2.23+ Pi 能力档案：档案→启动参数（含包源必须排路径前的顺序规则）+ 全局/项目/运行时清单读取
    pi-session.ts        v2.23+ Pi 会话文件定位（目录编码/软链/扫目录）+ 行格式翻译成 Claude Code 形状
    session-source.ts    v2.23+ 会话记录统一入口：runtime 感知的「定位 + 逐行翻译」，五个消费者共用
    launch-command.ts    v2.23+ registry runtime → 启动器分发（claude-code / pi），新增 runtime 只改这里
    config-store.ts      Runtime config at ~/.claude-orchestrator/config.json (auto-update toggles)
    skills.ts            SKILL.md discovery — user / plugin / project sources + hardcoded natives
    doctor.ts            v2.14+ read-only install health-check backing `manager.ts doctor` (runtime / config / daemons / bridge / MCP / agents)
    link-policy.ts       v2.14+ what channel-server does when the bridge says it was replaced (reconnect vs exit) — pure, unit-tested
    session-recall.ts    v2.21.5+ recall hook plumbing: Claude Code project slug / HANDOFF.md path / idempotent SessionStart hook merge into ~/.claude/settings.json (registered only when recall.py exists)
    net-addr.ts          v2.14+ detect this host's reachable addresses (Tailscale CGNAT first, then RFC1918) for peer handshake `--url`
    jsonl-cost.ts        Parse ~/.claude/projects JSONL files → per-model token rollup
    jsonl-lines.ts       v2.23.2+ splitChunkLines: appended-chunk → lines with full-file line numbers (watcher's seq source;
                         a partial trailing line does not advance the base, so its continuation lands on the same seq)
    peers.ts             peers.json data model (v2.11+ HTTP peers only) + handshake string encode/parse + atomic writes
    principals.ts        v2.6.0+ transport-scoped identity + API token CRUD/scope/rate-limit (~/.claude-orchestrator/principals.json)
    registry.ts          v2.9+ single reader for ~/.claude-orchestrator/registry.json (field normalization incl. cwd/dir compat); manager.ts stays the sole writer
    projects.ts          v2.21+ project data model (~/.claude-orchestrator/projects.json): dirs[] + resolveProjectForDir + id slugify; manager.ts is the sole writer, bridge reads only
    claude-binary.ts     v2.23.2+ locate the claude binary the way tmux agents do (login-shell PATH → realpath) and probe it by
                         absolute path; plus the quarantine-hang repair recipe (cp to a new name → xattr -c the copy → verify it
                         runs → rm original → mv back; in-place xattr -d never works, the vnode is pinned). The launcher's
                         post-upgrade / periodic health check used a bare `claude` under launchd's PATH, which resolved to the
                         native installer's healthy old copy in ~/.local/bin — so four cask upgrades in a row (2.1.258→274)
                         reported "upgrade did not take effect" while agents hung on the quarantined brew binary (2026-09-18).
    cc-sessions.ts       v2.23.2+ reads Claude Code's own per-process registry (~/.claude/sessions/<pid>.json: sessionId, cwd,
                         tmux pane id) → the real sessionId of an agent window without waiting for its jsonl. `resume --fork` /
                         restart's fork self-heal ask it first (a forked session's jsonl is only created on the first message —
                         2026-09-18 it appeared 32s after ready, past the 20s directory-diff window, so the registry kept the source
                         id and two channels rendered one transcript); the directory diff is now the fallback. The bridge's Stop-hook
                         heal also uses it when a registry sessionId is shared with another active agent (the fork-source symptom).
    bg-jobs.ts           v2.7+ Claude Code bg job cleanup recipe: kill → wait daemon quiescent → quarantine job dir → on respawn, roster root-fix (v2.9.1: daemon's ~/.claude/daemon/roster.json workers list is the respawn authority — kill worker + transient daemon + drop the entry, only when no other worker would be affected)
    baseline-keys.ts     v2.22.x bg-activity-watcher 的重启防重放作用域:按 agent×session 记首次进入监视(进程级单标志会把晚进入的 agent 存量 subagent 全量重播成「运行中」,2026-09-07 peer 报 109 张幽灵卡)
    reply-nudge.ts       v2.22.x Stop hook「补 reply」拦截规则:该 agent ws 上仍挂着未回复的请求 → 回 {block, reason} 让 Claude Code 续跑一次去调 reply(stop_hook_active / 已拦过 / 刚投递 <500ms 不拦)
    session-archive.ts   v2.8+ session jsonl snapshot on retirement (kill / fork rotation / adopt / resume-replace) → ~/.claude-orchestrator/archive/<agent>/ — counters CC cleanupPeriodDays
    session-history.ts   v2.9+ read-only history parsing: live + archived session jsonl → neutral paginated messages, backs GET /api/v1/agents/:name/history
  ansi2html.ts           ANSI escape codes → coloured HTML
  html2png.ts            HTML → PNG via Playwright headless Chromium
  discord-reply.ts       Bash fallback: send a message through the Bridge directly
master/
  CLAUDE.md.template     Master agent instruction template (rendered by setup.ts)
  CLAUDE.md              Rendered local copy (git-ignored)
tests/                     pure-logic suites only (run `bun test` for the live count); bridge.ts itself has no
                           isolated unit tests (Discord client + ws + peers.json coupling), live
                           verification through a sandbox session is the coverage there.
  agent-stats.test.ts      Per-agent usage rollup, compact-aware
  archive-sweeper.test.ts  v2.23+ pruneArchives 只清传入的根（手动归档区）、快照不碰、days=0 不清
  ask-user-question.test.ts AskUserQuestion detection in the TUI + keystroke synthesis
  bg-jobs.test.ts          Claude Code bg job cleanup recipe (roster root-fix)
  claude-binary.test.ts    v2.23.2+ quarantine repair recipe order / rollback + login-shell binary resolution
  cc-sessions.test.ts      v2.23.2+ ~/.claude/sessions registry parsing + window→session pick (child pid first, pane id fallback, fork source excluded)
  baseline-keys.test.ts    v2.22.x bg-activity baseline 作用域:同 agent-session 只 baseline 一次、换 session 重新 baseline、prune 按 agent 名
  reply-nudge.test.ts      v2.22.x Stop hook 补 reply 拦截:只拦 Stop、stop_hook_active 不拦、一次为限、挑最老
  claude-launch.test.ts    Launch-flag builder: permission modes, effort, model aliases
  cron.test.ts             Cron parser + scheduler
  doctor.test.ts           v2.14+ install health-check: daemon exit classification + report formatting
  event-bus.test.ts        v2.6.0+ seq monotonicity, per-agent ring buffer, subscriber isolation
  held-pac.test.ts         v2.23.1+ pendingAgentCalls 失效判定：目标长回合期间消息还押着就不清回程路由簿
  http-peer.test.ts        v2.11+ HTTP peer handshake encode/parse + reply extraction
  jsonl-cost.test.ts       JSONL token-usage rollup
  jsonl-lines.test.ts      v2.23.2+ watcher line-number coordinates: empty lines keep their number, partial lines don't advance
  link-policy.test.ts      v2.14+ what channel-server does when displaced — "stdio alive ⇒ never exit"
  modal-parser.test.ts     Tmux modal detection
  net-addr.test.ts         v2.14+ reachable-address detection: CGNAT/RFC1918 boundaries, no loopback
  permission-watcher.test.ts Permission-modal identity (dedupe key)
  principals.test.ts       v2.6.0+ token issue / scope / rate limit / terminal grant
  principals-snowflake.test.ts v2.14+ Discord ID validation — the only gate stopping a placeholder
                           from becoming a permanent fake owner in principals.json
  registry.test.ts         v2.9+ registry field normalization (cwd/dir compat)
  router.test.ts           v2.0.0+ Envelope / Endpoint / parseAddress / makeResponseEnvelope
  session-archive.test.ts  v2.8+ copy-if-larger snapshot semantics
  session-history.test.ts  v2.9+ jsonl → neutral messages: reply extraction, meta filtering, paging
  session-recall.test.ts   v2.21.5+ project slug, HANDOFF path, SessionStart hook merge/remove idempotency
  session-source.test.ts   v2.23+ runtimeForSessionPath：Pi 根按路径、CC 根零 I/O、归档副本读头行
  sessions-inventory.test.ts v2.7+ doppelganger detection / session reconciliation
  skills.test.ts           SKILL.md discovery
  slash-registry.test.ts   Slash command registry per-channel resolution
  stats-resets.test.ts     Usage-window reset detection
  web-gateway.test.ts      v2.13+ cross-origin verdict for the ws control plane (drive-by RCE guard)
  web-send-dedupe.test.ts  v2.23.2+ web client duplicate-send guard (same agent + same payload within 1.5s)
  web-live-merge.test.ts   v2.23.2+ web client live/history dedup by seq (pruneLiveBubbles / coveredByCursor /
                           mergeContiguousAssistant) — root tsconfig maps "@/*" → web/* so tests/ can import web pure logic
  web-dev-mode.test.ts     web developer mode: `?dev=` vs stored flag resolution, log line → event kind, event ring
                           cap / truncation / versioning, counters + rate sampler, section registry (web/features/devtools)
  web-bench-stats.test.ts  render bench statistics (percentile / summarizeFrames / formatBench) behind the dev panel's scroll bench
  web-dev-sections.test.ts guard: every registerDevSection() outside web/features/devtools must carry a
                           `dev-section: YYYY-MM-DD` comment within 3 lines above (workflow in docs/web-dev-mode.md)
install.sh               One-line installer
SETUP.md                 User-facing installation guide
```

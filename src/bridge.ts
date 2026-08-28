/**
 * Discord Bridge Service — 主入口
 *
 * 共享的 Discord 网关连接。多个 Claude Code channel-server 实例通过 WebSocket
 * 连接到此 bridge，每个注册一个 Discord 频道 ID。Bridge 负责路由消息。
 */

import { enableTimestampLogs } from "./lib/log-timestamp.js";
import { sanitizeAttachmentBase } from "./lib/attachment-name.js";
import { splitInlineButtons, toButtonRows, inlineChipsToText } from "./lib/inline-buttons.js";
import { hasActiveBgActivities } from "./bridge/bg-activity-watcher.js";
import { runCodex, CODEX_SANDBOXES, type CodexSandbox } from "./lib/codex.js";

// ask_codex 并发护栏:配额是 owner 的订阅,别让多个 agent 同时轰
const CODEX_MAX_INFLIGHT = 3;
let codexInflight = 0;
enableTimestampLogs(); // 给所有 console log 加 ISO timestamp 前缀（daemon 专用）

import { initLang, t } from "./lib/i18n.js";
initLang(); // 同步载一次 lang（pm2 fork 模式不支持 top-level await）

import {
  Client,
  GatewayIntentBits,
  TextChannel,
  REST,
  Routes,
  SlashCommandBuilder,
  type Message as DiscordMessage,
  type Interaction,
} from "discord.js";
import type { ServerWebSocket } from "bun";

import { DISCORD_TOKEN, WEB_ONLY, BRIDGE_PORT, ALLOWED_USER_IDS, DISCORD_GUILD_ID, TMP_DIR, TMUX_SOCK, MASTER_DIR, INBOX_DIR } from "./bridge/config.js";
// Web-only: 无 Discord 模式的会话地址供给 + 出站落空 adapter
import { createLocalChatAdapter } from "./bridge/local-adapter.js";
import {
  startTyping,
  stopTyping,
  buildComponents,
} from "./bridge/components.js";
import {
  setBotUserId,
  setAllowlistProvider,
  getBotUserId,
  isBotMessage,
  trackSentMessage,
  discordReply,
  discordFetchMessages,
  discordReact,
  discordEditMessage,
  discordCreateChannel,
  discordDeleteChannel,
  discordMoveChannel,
} from "./bridge/discord-api.js";
import {
  runManager,
  buildStatusPanel,
  handleMgmtButton,
  handleMgmtSelect,
} from "./bridge/management.js";
import { tmuxScreenshot } from "./bridge/screenshot.js";
import { startWatching, stopWatching, stopWatchingByChannel, resetToolTracking, hasRecentScheduleWakeup, agentNameForChannel, formatTool } from "./bridge/jsonl-watcher.js";
import { listAgentSessions, readSessionHistory, isValidSessionId, isValidSubagentId } from "./lib/session-history.js";
import { existsSync, readdirSync, statSync, readFileSync, writeFileSync, renameSync } from "fs";
import * as fs from "fs/promises";
// master 历史 probe 用（master 不在 registry，sessionId 从 projects slug 目录取最新）
import { projectsSlug, projectJsonlPath } from "./lib/jsonl-cost.js";
// v2.6.0+ 多前端事件总线（设计 docs/design-multi-frontend.md §4）
import { emitEvent, forgetAgent, subscribeEvents, replayEventsSince, getAgentStatus, type EventFilter } from "./bridge/event-bus.js";
// v2.7+ Claude Code agents 模式适配：中性会话清单 + bg job 清理 + 分身对账
import { collectSessions } from "./bridge/sessions-inventory.js";
import { cleanupBgJob } from "./lib/bg-jobs.js";
import { startSessionReconciler } from "./bridge/session-reconciler.js";
import { startBgActivityWatcher } from "./bridge/bg-activity-watcher.js";
import { startArchiveSweeper } from "./bridge/archive-sweeper.js";
// Web 远程终端（PTY attach → SSE；见 web-terminal.ts 头注释）
import { handleTerminalApi, sweepStaleTerminalSessions } from "./bridge/web-terminal.js";
import {
  initApiRoutes,
  handleApiRequest,
  sweepApiState,
  pendingApiRequests,
  apiThreadResults,
  apiFiles,
  apiReqKey,
  // clear 轮转的快照 diff 用（定义随 /api/v1 路由块落 api-routes.ts）
  listSessionIdsForCwd,
  latestSessionIdForCwd,
  type PendingApiRequest,
  type ApiReplyResult,
} from "./bridge/api-routes.js";
import {
  corsHeadersFor,
  resolveStaticPath,
  isCrossOrigin,
  isOriginExplicitlyAllowed,
} from "./bridge/web-gateway.js";
// v2.6.0+ HTTP API 身份与授权（设计 §3.4 / §5）
import {
  readPrincipals,
  syncDiscordOwnersFromEnv,
  listDiscordPrincipalIds,
  isDiscordSnowflake,
} from "./lib/principals.js";

// ============================================================
// v2.6.0+ C2-3：Discord 用户鉴权统一走 principals.json（.env 作 seed/fallback）
// 模块级缓存保持全部调用点的同步语义；30s 懒刷新（principals 变化不频繁）。
// ⚠️ v2.14+ 起是 **fail-closed**：列表为空 = 谁都不放行（老语义是空 = 放行所有人，
// 那等于配置一漏就全网可驱动你的 agent）。判定见下面的 handleDiscordMessage。
// ============================================================
let cachedDiscordAllowed: string[] = [...ALLOWED_USER_IDS];
let discordAllowedLoadedAt = 0;
function refreshDiscordAllowed(): void {
  discordAllowedLoadedAt = Date.now();
  readPrincipals()
    .then((file) => {
      const ids = listDiscordPrincipalIds(file);
      // principals 里一个 discord principal 都没有（老安装未 sync）→ 保持 .env
      if (ids.length > 0) cachedDiscordAllowed = ids;
    })
    .catch(() => { /* 保持现值 */ });
}
/** 允许对话的 Discord 用户 id 列表（**空 = 全部拒绝**，不是不限） */
function allowedDiscordIds(): string[] {
  if (Date.now() - discordAllowedLoadedAt > 30_000) refreshDiscordAllowed();
  return cachedDiscordAllowed;
}
/** 主 owner 的 Discord uid（@mention / UserEndpoint 兜底用），可能为 "" */
function primaryOwnerId(): string {
  const ids = allowedDiscordIds();
  return ids[0] || "";
}
// 启动：.env → principals 单向 seed（幂等），然后立即刷新缓存
syncDiscordOwnersFromEnv(ALLOWED_USER_IDS)
  .then(async (changed) => {
    if (changed) console.log("👤 已把 .env ALLOWED_USER_IDS 同步进 principals.json（role:owner）");
    refreshDiscordAllowed();
    // 门禁是 fail-closed 的，空名单 = 一条消息都进不来。而拒绝发生在收到消息时、
    // 只打一行 stdout —— 用户在 Discord 端得到的是**完全的沉默**，最难排查的那种。
    // 所以在启动时就把这个死局喊出来：配了 bot token 却没有合法 owner = 配置没完成。
    // 触发路径：手动装（cp .env.example .env 后忘了填）、先只装 web 后来手工加 token。
    if (!WEB_ONLY) {
      await readPrincipals()
        .then((file) => {
          const ids = listDiscordPrincipalIds(file).filter(isDiscordSnowflake);
          if (ids.length === 0) {
            console.error(
              "\n🚨 Discord 已启用，但没有任何合法的 owner —— 所有 Discord 消息都会被静默拒绝。\n" +
                "   修法：在 .env 里把 ALLOWED_USER_IDS 填成你的 Discord 用户 ID（17-20 位数字，\n" +
                "   开发者模式下右键头像 → 复制用户 ID），然后重启 bridge：\n" +
                "   launchctl kickstart -k gui/$(id -u)/com.claudestra.bridge\n",
            );
          }
        })
        .catch(() => { /* 读不到就算了，别让自检本身成为启动失败点 */ });
    }
  })
  .catch((e) => console.error("principals owner 同步失败（继续用 .env）:", (e as Error).message));
import { startPermissionWatcher, permissionMessages, clearPermissionMessage } from "./bridge/permission-watcher.js";
import { startWedgeWatcher, clearWedgeState } from "./bridge/wedge-watcher.js";
import { startThinkingTelemetry } from "./bridge/thinking-telemetry.js";
import { updateStatsDashboard, initStatsDashboard, handleStatsRequest, forceRefreshStatsDashboard, noteSaveCompactInjected } from "./bridge/stats-dashboard.js";
import { parseAuqPane } from "./lib/auq-pane.js";
import { recordMetric } from "./lib/metrics.js";
import { initHttpPeer, cancelHttpPeerCallsForChannel } from "./bridge/http-peer.js";
import { readRegistryAgents } from "./lib/registry.js";
import { readProjects } from "./lib/projects.js";
import {
  tmuxCapture,
  windowTarget,
  detectRuntimePermissionPrompt,
  detectSessionIdlePrompt,
  tmuxSendLine,
  tmuxRaw,
  tmuxSendEscape,
  paneLooksIdle,
  parseModalOptions,
  detectArrowNavModal,
  detectPermissionMode,
  btabStepsTo,
  probeTuiContract,
  MASTER_SESSION,
  type ArrowNavKind,
} from "./lib/tmux-helper.js";
import {
  scanGlobal as scanGlobalSkills,
  scanProject as scanProjectSkills,
  clearProject as clearProjectSkills,
  allRegistrableCommands,
  resolveInvocation,
  isProjectSkillForOtherAgent,
} from "./bridge/slash-registry.js";

// ============================================================
// 类型定义
// ============================================================

interface ClientInfo {
  ws: ServerWebSocket<unknown>;
  channelId: string;
  userId?: string;
  /** channel-server 所在 Claude Code 进程的 cwd。jsonl-watcher 用它定位
   *  ~/.claude/projects/<cwd-slug>/<sessionId>.jsonl 监听 tool / text。 */
  cwd?: string;
  /** v2.13.1+ 最近一次从这条连接收到消息的时刻（channel-server 每 25s keepalive
   *  ping，所以活着的连接最多 25s 就会刷新一次）。目前仅用于 register 冲突时打印
   *  旧连接的 idle 时长 —— 用来事后判断它当时是活的还是僵尸。 */
  lastSeen: number;
}

// ============================================================
// 状态
// ============================================================

const clients = new Map<string, ClientInfo>();

/**
 * 记 "Discord 入站消息转发到某个 channel-server，turn 结果还没回到 Discord" 的
 * pending。deliverToLocal 在 intent=request 时挂一条；reply handler 成功时清对
 * 应 chatId 的条目；Stop hook 兜底清所有匹配 ws 的残留条目（防止泄漏）。
 *
 * intendedReplyChannel = 回复应该发回的 channel（通常就是消息来源 channel）。
 */
interface PendingReply {
  msgId: string;
  ts: number;
  intendedReplyChannel: string;
  targetWs: ServerWebSocket<unknown>;
  /** v2.0.0+: 跟新 router 里的 threadId 一致。老路径 fallback 用 msgId */
  threadId?: string;
}
const pendingReplies = new Map<string, PendingReply>();

// v2.6.0+ HTTP API 会话状态与 /api/v1 路由：v2.9.2 起拆到 bridge/api-routes.ts。
// deliverToApi（出站回路）读写那边的状态 Map；staleCleanup 调 sweepApiState。

/**
 * thread → 原始请求 envelope 的追踪。deliverToLocal 在 intent=request 时挂一条，
 * deliver 在对应 response 进来（meta.inReplyTo 或 threadId 匹配）时清一条，
 * Stop hook 兜底清掉对应 ws 上残留的。提供 per-thread 可观察性（log 里带
 * threadId 能追出"哪条具体消息结束了"），比单靠按 ws 清要精细一层。
 */
interface PendingThread {
  request: RouterEnvelope;
  /** 请求被投递到的本地 ws（用于 Stop hook 按 ws 反查本次要清哪些 thread） */
  targetWs: ServerWebSocket<unknown>;
  ts: number;
}
const pendingThreads = new Map<string, PendingThread>();

const CONTROL_CHANNEL_ID = process.env.CONTROL_CHANNEL_ID || "";

// ============================================================
// v2.6.0+ C2-1：master 身份判断集中（原先 20 处散落的
// `=== CONTROL_CHANNEL_ID` 比较）。master 的"身份"目前实现为
// 「#control 频道的 agent」。将来引入非 Discord 的 master 标识时只改这几个 helper。
// ============================================================


/** 该 ws 是否 master 的连接 */
function isMasterWs(ws: ServerWebSocket<unknown>): boolean {
  return !!CONTROL_CHANNEL_ID && clients.get(CONTROL_CHANNEL_ID)?.ws === ws;
}

/** 事件流 / 日志用的 agent 标签（master 特判，查不到用 "?"） */
function agentLabelForChannel(channelId: string): string {
  return agentNameForChannel(channelId) || (channelId === CONTROL_CHANNEL_ID ? "master" : "?");
}

/** 同上,但 '?' 时兜底查 registry(watcher 缺位期间事件不能挂错名——agent_status
 *  done 挂到 '?' 名下会让 agentStatuses 卡 thinking,busy 永远「工作中」,
 *  2026-07-24 wechat-bot)。async 场景一律用这个。 */
async function agentLabelForChannelAsync(channelId: string): Promise<string> {
  const label = agentLabelForChannel(channelId);
  if (label !== "?") return label;
  try {
    const reg = (await readRegistryAgents()).find((r) => r.channelId === channelId);
    if (reg) return reg.name;
  } catch { /* 保持 ? */ }
  return "?";
}

/**
 * v1.9.21+ send_to_agent 推回机制：记录一条 outstanding send_to_agent 调用，
 * 当 target agent 下一次 reply 到自己 channel 时，bridge 自动把那段文字也 push
 * 回 caller 的 ws 作为"[agent-X 回复] …"合成消息，caller 不再需要 fetch_messages
 * 轮询。key = target agent 的 channelId。
 */
interface PendingAgentCall {
  callerChannelId: string;   // 谁发起的（master 或某个 agent）
  callerWs: ServerWebSocket<unknown>;
  callerName: string;
  targetName: string;
  /**
   * caller 发起 send_to_agent 时手头正在处理的 inbound 请求的
   * intendedReplyChannel —— 通常是 caller 自己的频道。target 回来之后，push
   * 给 caller 的合成消息 meta.chat_id 用这个值，避免 caller LLM 误用 target
   * 的私频当作回复目标。没有正在处理的请求时是 undefined。
   */
  originalReplyChannel?: string;
  /**
   * v2.0.12+ caller 在 send_to_agent 时填的"答完后我应该做啥"。
   * bridge 在把 target 的 reply push 回 caller ws 时，前缀注入这段文字
   * （[💡 你之前期望：...]），帮 caller LLM 不靠"自己记得"也能续上动作。
   * 修 self-develop 链路里 caller 收到答复后只 relay 不 act 的根因之一。
   */
  expecting?: string;
  ts: number;
}
const pendingAgentCalls = new Map<string, PendingAgentCall>();

/**
 * v2.0.16+ inter-agent 消息看门狗。每当 bridge 把一条来自**另一个 agent / master**
 * 的消息投递到某个 agent 的 ws（send_to_agent / pushback / reply→别agent频道 forward
 * 任一路径都经过 deliverToLocal），记一条 (接收 agent channelId) → { fromLabel, retries }。
 *
 * 清除：那个 agent 下一次调 `reply()`（任意频道）或 `send_to_agent`（= 它在回应/
 * 行动）。
 *
 * Stop hook 兜底：如果一轮结束时这条还在（agent 既没 reply 也没 send_to_agent —
 * 大概率是收到消息后啥也没干或没报告），bridge 注一条 `[⚠️ ...]` nudge 到那 agent 的
 * ws 提醒它处理 + 用 reply() 报告。最多 nudge 2 次（retries 到 2 就放弃，不无限循环）。
 *
 * 修「agent 收到 inter-agent 消息后无动于衷」这个 LLM 行为层的兜底。注意这是兜底，
 * 不是 100% 保证 —— LLM 可能 nudge 之后还是不理，2 次后就不再打扰。
 */
interface PendingInterAgentMsg {
  fromLabel: string;
  retries: number;
  ts: number;
}
const pendingInterAgentMsg = new Map<string, PendingInterAgentMsg>();

// v2.4.16+ 清掉某个 channel 上挂着的所有 inter-agent pending。
// 用户在该 channel 打字（messageCreate）或者 agent 被 kill 时调，避免后续 Stop
// hook 触发的 drain兜底 / watchdog nudge / pushback 把 agent 拉回到无用的
// 互相 ack 链里。返回清掉条数（仅用于日志）。
function clearInterAgentPendingsForChannel(channelId: string): number {
  let n = 0;
  // pendingAgentCalls key=target channel；同时还要扫 caller=channelId 的反向
  if (pendingAgentCalls.delete(channelId)) n++;
  for (const [cid, p] of pendingAgentCalls.entries()) {
    if (p.callerChannelId === channelId) {
      pendingAgentCalls.delete(cid);
      n++;
    }
  }
  if (pendingInterAgentMsg.delete(channelId)) n++;
  // v2.11: 在飞的 HTTP peer 调用一并取消——迟到的 peer 回复不再 pushback
  // (Discord 时代 pendingPeerCalls 的同款保障,review 2026-07-20 #3)
  try {
    n += cancelHttpPeerCallsForChannel(channelId);
  } catch {
    /* http-peer 未初始化等边缘,不影响主清理 */
  }
  return n;
}


// ============================================================
// v2.0.0+ 路由抽象
// ============================================================
import type {
  LocalEndpoint as RouterLocalEndpoint,
  UserEndpoint as RouterUserEndpoint,
  ApiUserEndpoint as RouterApiUserEndpoint,
  Envelope as RouterEnvelope,
  Delivery as RouterDelivery,
} from "./bridge/router.js";
import { endpointLabel, envelopeLabel, newThreadId, parseChatId } from "./bridge/router.js";
// v2.6.0+ C1：出站按 transport 分发（设计 §6）
import { registerAdapter, adapterFor } from "./bridge/adapters.js";
import { installCrashGuard } from "./lib/crash-guard.js";
import { noteSelfMessage, installSelfSendTracker } from "./bridge/self-echo.js";
import { originFooter } from "./lib/instance-tag.js";

// 进程级异常兜底：保证死因一定进 stderr（见 lib/crash-guard.ts）
installCrashGuard("bridge");

// v2.19.0 日志落点从 /tmp 搬到 ~/.claude-orchestrator/logs（见 lib/log-paths.ts）
import { initDaemonLogs } from "./lib/log-paths.js";
initDaemonLogs("bridge");

// v2.19.0 认主守卫：热备机器上的 launchd 自启 + rsync 来的配置 = 双响（见 lib/owner-guard.ts）
import { assertPrimaryOrExit } from "./lib/owner-guard.js";
await assertPrimaryOrExit("bridge");

// v2.6.0+ C2-4：Discord 前端 UI 归属模块（typing / status 消息 / 完成通知 / 按钮）
import {
  createDiscordChatAdapter,
  beginTypingWithSafety,
  clearSafetyTimer,
  trackStatusMessage,
  statusMessageIdFor,
  finishStatusMessage,
  agentActionButtons,
  randomUmaDone,
} from "./bridge/discord-adapter.js";

/**
 * v2.0.0+ 统一消息投递入口。所有 bridge 的出入站消息（messageCreate 路由 /
 * reply / send_to_agent / pushback）都走这一个函数。
 * 内部按 to.kind 派发（local ws inject / user discord send / api resolve），
 * 状态追踪 + @ mention / header 渲染全在一处管。
 */
async function deliver(env: RouterEnvelope): Promise<RouterDelivery> {
  // 0. intent-aware 预处理：response 消息先清对应 pending
  if (env.intent === "response" && env.meta.inReplyTo) {
    for (const [key, p] of pendingReplies.entries()) {
      if (p.msgId === env.meta.inReplyTo || p.threadId === env.meta.threadId) {
        pendingReplies.delete(key);
      }
    }
    // 顺手清 thread map（按 threadId 精确清，不误伤别的 thread）
    pendingThreads.delete(env.meta.threadId);
  }

  // 1. 按目标类型派发
  try {
    switch (env.to.kind) {
      case "local":
        return await deliverToLocal(env, env.to);
      case "user":
        return await deliverToUser(env, env.to);
      case "api":
        return await deliverToApi(env, env.to);
      case "bridge":
        // BridgeEndpoint 按设计只能做 from（见 router.ts 的类型注释）——bridge 自己
        // 不是消息接收者。出现在 to 上说明调用方把 envelope 构造错了；返回 error 让
        // 它显形，而不是静默走到函数末尾返回 undefined。
        return {
          envelope: env,
          outcome: {
            kind: "error",
            error: new Error("bridge endpoint 只能作为 from，不能作为投递目标"),
          },
        };
      default: {
        // 穷尽性保险。少了它，将来给 Endpoint 加第四种 kind 时这里会静默走到函数
        // 末尾返回 undefined，而所有调用方都直接读 delivery.outcome.kind —— 那是
        // 运行期 TypeError。放个 never 断言，编译期就报错。
        const unreachable: never = env.to;
        return {
          envelope: env,
          outcome: {
            kind: "error",
            error: new Error(`未知投递目标 kind: ${JSON.stringify(unreachable)}`),
          },
        };
      }
    }
  } catch (e) {
    console.error(`deliver 失败 ${envelopeLabel(env)}:`, e);
    return { envelope: env, outcome: { kind: "error", error: e as Error } };
  }
}

/**
 * v2.6.0+ 投递到 HTTP API 用户（设计 §5.3）。不碰 Discord（镜像除外）：
 * 1. 按 `${tokenId}|${agent频道}` 出队 pendingApiRequest → resolve 同步 waiter；
 * 2. emit chat_message(out) 事件（带原请求 threadId，SSE 订阅者收到）；
 * 3. 结果写 apiThreadResults（GET /api/v1/threads/:id 轮询兜底）；
 * 4. R2 审计镜像：把回复镜像到该 agent 的 Discord 频道（token mirror!==false 时）。
 */
/**
 * channelId → agent 名，读 registry。
 * 与 `agentNameForChannel`（查 watcher 表）互补：watcher 随连接生灭，registry 常在。
 * 30s 缓存，避免每条出站消息都读盘。
 */
let regChannelNameCache: { ts: number; map: Map<string, string> } | null = null;
function agentNameByChannelFromRegistry(channelId: string): string | null {
  if (!channelId) return null;
  const now = Date.now();
  if (!regChannelNameCache || now - regChannelNameCache.ts > 30_000) {
    const map = new Map<string, string>();
    try {
      const raw = JSON.parse(
        readFileSync(`${process.env.HOME}/.claude-orchestrator/registry.json`, "utf8"),
      ) as { agents?: Record<string, { channelId?: string }> };
      for (const [name, info] of Object.entries(raw.agents || {})) {
        if (info?.channelId) map.set(String(info.channelId), name);
      }
    } catch {
      /* 读不到就空表，下一轮再试 */
    }
    // master 不在 registry，但它有固定频道
    if (CONTROL_CHANNEL_ID) map.set(CONTROL_CHANNEL_ID, "master");
    regChannelNameCache = { ts: now, map };
  }
  return regChannelNameCache.map.get(channelId) ?? null;
}

/** v2.15+ 思考遥测的花名册——复用上面的 registry 频道缓存（含 master） */
function listRegistryChannels(): Array<{ name: string; channelId: string }> {
  agentNameByChannelFromRegistry("__refresh__"); // 只为触发缓存刷新
  const out: Array<{ name: string; channelId: string }> = [];
  for (const [channelId, name] of regChannelNameCache?.map ?? []) out.push({ name, channelId });
  return out;
}

async function deliverToApi(env: RouterEnvelope, to: RouterApiUserEndpoint): Promise<RouterDelivery> {
  const fromChannelId = env.from.kind === "local" ? env.from.channelId : "";
  const key = apiReqKey(to.tokenId, fromChannelId);
  const queue = pendingApiRequests.get(key);
  const pending = queue?.shift();
  if (queue && queue.length === 0) pendingApiRequests.delete(key);

  // 附件登记 → 下载 URL（属主 = 该 token，GET /api/v1/files/:id 校验）
  const files = (env.meta.files || []).map((p) => {
    const id = `f_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const name = p.split("/").pop() || "file";
    apiFiles.set(id, { path: p, tokenId: to.tokenId, name });
    return { name, url: `/api/v1/files/${id}` };
  });
  // 出站附件持久化（owner 2026-07-14:「你也可以给我发图片」）：agent reply 的
  // files 常在临时目录（scratchpad/截图），拷进 inbox（web 附件取回白名单）——
  // SSE 事件带 inbox 文件名，web 前端走 /api/chat/attachment/<name> 内联显示，
  // 时间戳前缀防碰撞 + 与 Discord 下载附件同一套展示名清洗（去 ^\d+_）。
  const eventFiles: { name: string; attachment: string }[] = [];
  for (const p of env.meta.files || []) {
    try {
      const base = sanitizeAttachmentBase(p); // 保 Unicode;与 web attachment 路由同一套(peer 2026-08-25)
      const dest = `${Date.now()}_${base}`;
      await fs.mkdir(INBOX_DIR, { recursive: true });
      await fs.copyFile(p, `${INBOX_DIR}/${dest}`);
      eventFiles.push({ name: base, attachment: dest });
    } catch (e) {
      console.error(`API 出站附件拷贝失败 ${p}:`, (e as Error).message);
    }
  }

  const threadId = pending?.threadId || env.meta.threadId;
  const agentName = pending?.agentName ||
    (env.from.kind === "local" ? env.from.agentName : undefined) ||
    agentNameForChannel(fromChannelId) ||
    // registry 兜底：上面那个查的是 **watcher 注册表**，而 watcher 会随连接一起
    // 被清掉 —— 于是恰恰在「MCP 断了、agent 靠兜底通道说话」这个最需要认出它的
    // 时刻，名字解析失败、落到字面 "?"。前端按 agent 归类，消息就被塞进一个叫
    // "?" 的幽灵会话，用户在正确的会话里什么也看不到（owner 两次实报「问号频道」，
    // 推送通知标题就是一个问号）。registry 是持久的，不受连接状态影响。
    agentNameByChannelFromRegistry(fromChannelId) || "?";
  const result: ApiReplyResult = {
    reply: env.content,
    components: env.meta.components,
    files: files.length ? files : undefined,
    threadId,
    agent: agentName,
  };
  apiThreadResults.set(threadId, { result, ts: Date.now(), tokenId: pending?.tokenId ?? (env.to.kind === "api" ? env.to.tokenId : undefined) });
  pending?.resolve?.(result);

  emitEvent({
    agent: agentName,
    chatId: `api:${to.tokenId}`,
    type: "chat_message",
    data: { direction: "out", from: agentName, text: env.content, threadId, api: true, ...(env.meta.components ? { components: env.meta.components } : {}), ...(eventFiles.length ? { files: eventFiles } : {}) },
  });

  // R2 审计镜像（fire-and-forget，走 bridge→user 的 UI 类通道）
  mirrorApiExchange(to, fromChannelId, `[🌐 API→${to.name}] ${env.content}`).catch(() => {});

  return { envelope: env, outcome: { kind: "sent" } };
}

/** R2：API 对话镜像到 agent 的 Discord 频道（principal.mirror === false 时不发） */
async function mirrorApiExchange(to: RouterApiUserEndpoint, agentChannelId: string, text: string): Promise<void> {
  if (!agentChannelId) return;
  try {
    const file = await readPrincipals();
    const p = file.principals.find((x) => x.id === `token:${to.tokenId}`);
    if (p?.mirror === false) return;
    await deliver({
      from: { kind: "bridge", label: "api-mirror" },
      to: { kind: "user", userId: "", channelId: agentChannelId },
      intent: "notification",
      content: text,
      meta: {
        messageId: `api_mirror_${Date.now()}`,
        triggerKind: "system",
        ts: new Date().toISOString(),
        threadId: newThreadId(),
      },
    });
  } catch (e) {
    console.error("API 镜像失败:", (e as Error).message);
  }
}

/** 投递到本地 Claude Code session —— 通过 ws 注入一条 "message" 事件 */
/** 人类连发抢占的每频道冷却：C-c 后短窗内不再重复打断（防打断叠加 + 双 C-c 风险）。 */
const lastPreemptAt = new Map<string, number>();
const PREEMPT_COOLDOWN_MS = 4_000;

// ── 大总管的 jsonl watcher（v2.14+）──────────────────────────────────────
// master 不在 registry（它是 tmux window 0，没有 create/resume 那套注册流程），
// 于是 register 分支长期用 `channelId !== CONTROL_CHANNEL_ID` 把它排除在 watcher
// 之外。代价不是「少看点工具流」，而是 **Stop 兜底彻底失效**：agent 忘了调 reply
// 时，bridge 本来能从 jsonl 里把 assistant 文本抠出来替它发出去，而那条路径依赖
// watcher。2026-07-25 owner 实报「大总管的消息收不到」正是如此 —— 它答了、但那一
// 轮没调 reply（reply 现在是 deferred tool，得先 ToolSearch 加载，很容易漏掉），
// 兜底又抽不到文本，回答就烂在终端里。worker 有两道防线，master 只有一道。
let masterWatchedSession = "";
function syncMasterWatcher(discord: Client): void {
  if (WEB_ONLY || !CONTROL_CHANNEL_ID) return;
  const sid = latestSessionIdForCwd(MASTER_DIR);
  if (!sid) return;
  // 只在 sessionId 真的变了才重挂 —— startWatching 会重置读取位点，无谓重挂等于
  // 把整个 jsonl 重播一遍。master 的会话会因 /clear 轮转，所以也不能只挂一次。
  if (sid === masterWatchedSession) return;
  const prev = masterWatchedSession;
  masterWatchedSession = sid;
  console.log(`👁 大总管 watcher ${prev ? `轮转 ${prev.slice(0, 8)} →` : "挂载"} ${sid.slice(0, 8)}`);
  void startWatching("master", MASTER_DIR, sid, CONTROL_CHANNEL_ID, discord).catch((e) => {
    masterWatchedSession = prev; // 挂失败就退回，下一轮还会再试
    console.error("大总管 watcher 启动失败:", (e as Error).message);
  });
}

async function deliverToLocal(env: RouterEnvelope, to: RouterLocalEndpoint): Promise<RouterDelivery> {
  const content = await renderContentForLocal(env);
  // v2.10+「谁发的谁回」:Web/API 触发的回合,Stop 时不发 Discord @ 推送
  if (env.from.kind === "api") lastMessageSource.set(to.channelId, "api");
  // v2.11: HTTP peer pushback 送达 caller 后,caller 接下来的回合是「处理 peer
  // 回复」——Stop 不该 @ 用户(与 Discord peer pushback 的 set "agent" 对齐,
  // review 2026-07-19 #2)
  if (env.meta.triggerKind === "peer_http") lastMessageSource.set(to.channelId, "agent");
  // chat_id 是 agent reply() 时要传回的 id：消息从哪个会话来，回复就发回那里。
  const replyBackChannel = resolveReplyBackChannel(env);
  const meta: Record<string, string> = {
    chat_id: replyBackChannel,
    message_id: env.meta.messageId,
    ts: env.meta.ts,
    trigger: env.meta.triggerKind,
    intent: env.intent,
    thread_id: env.meta.threadId,
  };
  if (env.from.kind === "user") {
    meta.user = env.from.username ?? "";
    meta.user_id = env.from.userId;
  } else if (env.from.kind === "local") {
    meta.user = env.from.agentName ?? "agent";
    meta.user_id = "agent";
    meta.is_agent = "true";
    meta.from_channel_id = env.from.channelId;
  } else if (env.from.kind === "bridge") {
    meta.user = `bridge${env.from.label ? `:${env.from.label}` : ""}`;
    meta.user_id = "bridge";
    meta.is_bridge = "true";
  } else if (env.from.kind === "api") {
    meta.user = env.from.name;
    meta.user_id = `api:${env.from.tokenId}`;
    meta.api = "true";
  }
  if (env.meta.attachments && env.meta.attachments.length > 0) {
    meta.attachment_count = String(env.meta.attachments.length);
    meta.attachments = env.meta.attachments.join(";");
  }
  const evAgent = to.agentName || agentLabelForChannel(to.channelId);
  // ── 人类连发抢占（owner 2026-07-14:「后一条消息应该直接打断前一条,优先处理
  // 后面的,这样用户可以随时补充」）──目标正在回合中时,先 C-c 掐掉当前回合再投递:
  // 上下文都在,agent 带着前一条的进度优先响应补充,而不是把补充压到回复之后。
  // 只对人类的 request 生效(Discord user / API user);agent↔agent、peer、bridge
  // 系统消息、response 回执不抢占目标的工作。
  // 「工作中」三信号 OR(2026-07-14 深夜实锤:CC 2.1.209 的 spinner 行轮换显示
  // tips,"esc to interrupt" 大部分时间不在——只认它会静默漏掉抢占):
  //   ① pane 有 "esc to interrupt"(老版文案,轮换恰好在时最准);
  //   ② pane 有 spinner 时间模式「✶ Xxx… (2m 7s · ↓ 4.6k tokens)」;
  //   ③ event-bus 最近状态 = thinking(投递时自 emit,同进程可靠;bridge 重启后
  //      第一回合内为空,由①②补)。
  // 误伤面:空闲被误判时单发一次 C-c 只清输入行不退出 CC(退出需短窗内连按两次,
  // 4s 冷却隔开了);paneLooksIdle 不用——工作中的空 ❯ 输入行会假阳性。
  // 同频道 4s 冷却,三连发不叠加打断。
  if (
    // v2.11: peer 标记的 api 入站不算「人类抢占」——那是对方实例的 agent 请求,
    // C-c 掐断本机正跑的回合等于让外机打断本机用户的活(review 2026-07-19 #1)
    (env.from.kind === "user" || (env.from.kind === "api" && !env.from.peer)) &&
    env.intent === "request" &&
    Date.now() - (lastPreemptAt.get(to.channelId) ?? 0) > PREEMPT_COOLDOWN_MS
  ) {
    try {
      let win: string | null = null;
      if (to.channelId === CONTROL_CHANNEL_ID) win = `${MASTER_SESSION}:0`;
      else {
        const reg = (await readRegistryAgents()).find((a) => a.channelId === to.channelId);
        if (reg) win = windowTarget(reg.name);
      }
      const tail10 = win
        ? (await tmuxRaw(["capture-pane", "-t", win, "-p"])).split("\n").slice(-10).join("\n")
        : "";
      const working =
        /esc to interrupt/i.test(tail10) ||
        /…\s*\(\d+m?\s*\d*s\b/.test(tail10) ||
        getAgentStatus(evAgent) === "thinking";
      if (win && working) {
        lastPreemptAt.set(to.channelId, Date.now());
        await tmuxRaw(["send-keys", "-t", win, "C-c"]);
        recordMetric("agent_interrupt", { channelId: to.channelId, agent: evAgent, meta: { trigger: "preempt" } });
        // 让前端给被掐的回合标「已打断」(与手动停止同一事件形状)
        emitEvent({ agent: evAgent, chatId: to.channelId, type: "agent_status", data: { status: "done", trigger: "interrupt" } });
        console.log(`⚡ 抢占打断 ${evAgent}（人类补充消息优先处理）`);
        // CC 中断收尾需要一拍;立刻投递会混进垂死回合的尾流
        await new Promise((r) => setTimeout(r, 1200));
      }
    } catch (e) {
      console.log(`⚠️ 抢占打断失败,按常规投递: ${(e as Error).message}`);
    }
  }
  try {
    to.ws.send(JSON.stringify({ type: "message", content, meta }));
    // v2.6.0+ 事件埋点：入站消息镜像 + agent 进入思考态（旁路，不影响主流程）
    // srcKind:入站来源类型(user=Discord 人类/api=Web 用户/local=agent/bridge)。
    // web 前端据此把「他端用户发言」实时画成用户气泡(跨端同步),并排除 agent/
    // bridge 注入(那些不是用户消息,2026-07-24 owner 报跨端同步慢)。
    emitEvent({ agent: evAgent, chatId: to.channelId, type: "chat_message", data: { direction: "in", from: meta.user || "?", srcKind: env.from.kind, text: env.content, threadId: env.meta.threadId } });
    // watcher 入站自愈(2026-07-24 wechat-bot:创建后 >60s 才来首条消息,
    // pending-start 已放弃 → watcher 永久缺位——工具/文本从不直播、Stop done
    // 挂 '?' 名下 busy 卡「工作中」)。每条入站消息核对该频道 watcher 在位,
    // 缺位按 registry 重建;jsonl 还没出现会重新进 pending-wait,回合开始后
    // 几秒内落盘即绑上。同步 map 查询,常态零开销。
    if (!agentNameForChannel(to.channelId) && to.channelId !== CONTROL_CHANNEL_ID) {
      void (async () => {
        try {
          const reg = (await readRegistryAgents()).find(
            (r) => r.channelId === to.channelId && r.status === "active",
          );
          if (reg?.cwd && reg.sessionId) {
            const cwd = reg.cwd.replace(/^~/, process.env.HOME || "~");
            console.log(`🩹 watcher 缺位,按 registry 重建: ${reg.name} (${reg.sessionId.slice(0, 8)})`);
            startWatching(reg.name, cwd, reg.sessionId, to.channelId, discord);
          }
        } catch { /* 自愈失败不影响消息投递 */ }
      })();
    }
    emitEvent({ agent: evAgent, chatId: to.channelId, type: "agent_status", data: { status: "thinking" } });
    // intent=request 挂 pending + thread 追踪。response 端到端，不挂新 pending。
    if (env.intent === "request") {
      pendingReplies.set(replyBackChannel, {
        msgId: env.meta.messageId,
        ts: Date.now(),
        intendedReplyChannel: replyBackChannel,
        targetWs: to.ws,
        threadId: env.meta.threadId,
      });
      pendingThreads.set(env.meta.threadId, {
        request: env,
        targetWs: to.ws,
        ts: Date.now(),
      });
    }
    // v2.0.16+: 来自另一个 agent / master 的消息（send_to_agent / pushback /
    // reply→别agent forward 都经这里），记看门狗 pending。
    // v2.4.16+: meta.skipInterAgentWatchdog=true 时不挂 watchdog（oneShot 的 fire
    // -and-forget 场景，caller 不期待回应，watchdog 没必要打扰 target）。
    if (
      env.from.kind === "local" &&
      env.from.ws !== to.ws &&
      !env.meta.skipInterAgentWatchdog
    ) {
      pendingInterAgentMsg.set(to.channelId, {
        fromLabel: env.from.agentName || "另一个 agent",
        retries: 0,
        ts: Date.now(),
      });
    }
    return { envelope: env, outcome: { kind: "sent" } };
  } catch (e) {
    return { envelope: env, outcome: { kind: "error", error: e as Error } };
  }
}

/** 从 envelope 推断 "response 应该发回哪个 channel" —— 用于 pending 的
 *  intendedReplyChannel + 生成给 agent 的 meta.chat_id。from=bridge 的系统
 *  消息没有"发回哪里"的语义，返回空串，调用方如果需要 chat_id 自己兜底。*/
function resolveReplyBackChannel(env: RouterEnvelope): string {
  if (env.from.kind === "user") return env.from.channelId;
  if (env.from.kind === "local") return env.from.channelId;
  // v2.6.0+ API 用户：虚拟 chat_id（统一 keyspace D7），agent reply 原样回传
  if (env.from.kind === "api") return `api:${env.from.tokenId}`;
  return "";
}

/**
 * 投递到 Discord 人类用户 —— 发到他看得到的 channel。
 * 支持 chunking / reply_to / files / components（通过 meta 透传 discordReply）。
 * content 不自动 @ 用户 —— Stop hook 有独立的完成通知负责 @，这里 body 里的
 * mention 留给调用方自己控制（比如 reply handler 直接发 agent 写的 text）。
 *
 * v2.0.15+ 额外职责：如果 to.channelId 其实是**某个 agent 的频道**（注册在
 * clients 里），而且发消息的是**另一个** local agent（不是 master、不是这个频道
 * 自己的 agent），那除了贴 Discord，还会 forward 一份给那个 agent 的 claude ws ——
 * 否则它根本收不到。修 `reply(chat_id=别agent频道)` 通知对方但对方完全看不见的
 * 架构漏洞：把「agent 间通信」收敛到 deliverToLocal 一处，不管 agent 用
 * send_to_agent 还是误用 reply(chat_id=对方频道)，对方都会通过 deliverToLocal 收到。
 */
async function deliverToUser(env: RouterEnvelope, to: RouterUserEndpoint): Promise<RouterDelivery> {
  try {
    // v2.6.0+ C1：按 transport 分发（设计 §6）。to.channelId 是统一 keyspace
    // 地址（裸 id = discord）。当前只注册了 discord adapter；Telegram 等未来
    // transport 只需 registerAdapter，一行不改这里。
    const dest = parseChatId(to.channelId);
    const adapter = adapterFor(dest.transport);
    if (!adapter) {
      return { envelope: env, outcome: { kind: "dropped", reason: `no adapter for transport "${dest.transport}"` } };
    }
    // v2.20+ 行内按钮 `[[{#id .style}label]]`:web 端 DOMD 渲染成真按钮(正文原样
    // 过去);Discord 正文塞不了原生按钮 → 出站时解析拆分:从正文剥离,转成块级
    // components 按钮行追加(方案 A,docs/design-domd-inline-buttons.md §6)。
    // 容量守恒:Discord 上限 5 行 × 5 钮,已有 components 行先占;超容量的按钮
    // 保留字面量(看得见语法,好过静默消失)。
    let text = env.content;
    let components = env.meta.components as unknown[] | undefined;
    if (dest.transport === "discord" && text.includes("[[")) {
      const existingRows = Array.isArray(components) ? components.length : 0;
      const split = splitInlineButtons(text, Math.max(0, 5 - existingRows) * 5);
      if (split.buttons.length) {
        // 正文被剥空(整条消息只有按钮)→ Discord 不收空 content,给个指示符
        text = split.text || "👇";
        components = [...(components ?? []), ...toButtonRows(split.buttons)];
      }
      // chip(.copy/.agent/.badge)是 web 专属交互 → Discord 降级成纯文本
      text = inlineChipsToText(text);
    }
    const { messageIds: ids } = await adapter.send(dest.id, {
      text,
      replyTo: env.meta.replyTo,
      components,
      files: env.meta.files,
    });
    // v2.0.15+ cross-agent forward —— 见函数注释（Discord 专属：clients 的 key
    // 是 Discord channel id，别的 transport 没有"用户频道=agent 频道"的重合）
    if (env.from.kind === "local" && dest.transport === "discord") {
      const fromLocal = env.from;
      const isFromMaster = isMasterWs(fromLocal.ws);
      const targetClient = clients.get(to.channelId);
      // v2.5.5: fromLocal.channelId 为空 = 发送方不是任何已注册的 agent，而是
      // manager/cron 的临时 bridge-client 连接（restart 完成通知、cron 播报这类
      // **给用户看的管理消息**）。这类只发 Discord，不 forward 进目标 agent 的
      // 上下文 —— 否则 agent 收到"你自己已重启"的通知，判断一轮不用回应（内心戏
      // 被 jsonl-watcher 以 💬 播到频道），ia-watchdog 又 nudge 一轮，一条通知
      // 变三条噪音 + 两轮 LLM 消耗（owner 2026-07-08 报的"重启后一堆乱七八糟
      // bridge 消息"）。真 agent reply 到别的 agent 频道时 channelId 非空，不受影响。
      if (!isFromMaster && fromLocal.channelId && targetClient && targetClient.ws !== fromLocal.ws) {
        forwardReplyToAgentClaude(fromLocal, env.content, to.channelId, targetClient)
          .catch((e) => console.error("reply→别agent频道 forward 异常:", e));
      }
    }
    return { envelope: env, outcome: { kind: "sent", discordMessageIds: ids } };
  } catch (e) {
    return { envelope: env, outcome: { kind: "error", error: e as Error } };
  }
}

/**
 * v2.0.15+: 把一条 agent reply 到「别的 agent 的频道」的消息，额外 forward 一份给
 * 那个 agent 的 claude ws（除了已经贴了的 Discord）。走 deliverToLocal → 自动加
 * `[🤖 来自 X]` 前缀，跟 send_to_agent 等价。fire-and-forget，best-effort。
 */
async function forwardReplyToAgentClaude(
  fromEndpoint: RouterLocalEndpoint,
  content: string,
  targetChannelId: string,
  targetClient: ClientInfo,
): Promise<void> {
  let fromAgentName = fromEndpoint.agentName;
  let targetAgentName: string | undefined;
  // reply handler 构造 fromEndpoint 时通常没填 agentName，这里查 registry 补上让
  // renderContentForLocal 的 "[🤖 来自 X]" 准确；查不到就 fallback "agent"。
  try {
    const list = await runManager("list");
    const agents = (list.agents || []) as any[];
    if (!fromAgentName) fromAgentName = agents.find((a) => a.channelId === fromEndpoint.channelId)?.name;
    targetAgentName = agents.find((a) => a.channelId === targetChannelId)?.name;
  } catch { /* non-critical */ }
  const fwdEnv: RouterEnvelope = {
    from: { kind: "local", agentName: fromAgentName, channelId: fromEndpoint.channelId, ws: fromEndpoint.ws },
    to: { kind: "local", agentName: targetAgentName, channelId: targetChannelId, ws: targetClient.ws, cwd: targetClient.cwd },
    intent: "notification",
    content: content.replace(/<@!?\d+>\s*/g, "").trim(),
    meta: {
      messageId: `reply_fwd_${Date.now()}`,
      triggerKind: "agent_tool",
      ts: new Date().toISOString(),
      threadId: newThreadId(),
    },
  };
  const fwd = await deliver(fwdEnv);
  if (fwd.outcome.kind === "sent") {
    lastMessageSource.set(targetChannelId, "agent");
    console.log(`📨 reply→别agent频道: ${fromAgentName || "?"} 的消息同时 forward 给 ${targetAgentName || targetChannelId} 的 claude`);
    recordMetric("reply_cross_agent_forward", { channelId: targetChannelId, meta: { from: fromAgentName || "" } });
  } else if (fwd.outcome.kind === "error") {
    console.error("reply→别agent频道 forward 失败:", fwd.outcome.error);
  }
}

/**
 * 给本地 agent ws 注入的消息渲染 content。根据 envelope 的 from 类型自动选
 * 对应的 header 模板。这一处统一做，messageCreate 不再就地拼 header。
 */
async function renderContentForLocal(env: RouterEnvelope): Promise<string> {
  const from = env.from;

  // bridge 系统消息（notifyMaster 广播 / hook 事件文字 等）：原样投递，不加
  // header；agent 看到的是 bridge 写的通知正文本身。
  if (from.kind === "bridge") {
    return env.content;
  }

  // v2.6.0+ HTTP API 用户（设计 §5.2）：header 明示对话方经 Web/API 接入 ——
  // 没有 @mention/push 语义，且这是外部 principal（R1 纵深防御：agent 可据此
  // 对上下文里的敏感内容保持沉默）。reply 直接回 meta.chat_id（api:<tokenId>）。
  // v2.10+ 措辞修正(owner 2026-07-16):旧文案「对方看不到本频道历史」在 Web
  // 客户端出现后已失真——Web 有完整聊天记录(history API),agent 被误导后会
  // 重复复述用户已看到的上下文。
  if (from.kind === "api") {
    // v2.11+ HTTP peer 入站:token 带 peer 标记 → 这是另一个 Claudestra 实例的
    // 跨机请求(通常由对方 agent 的 send_to_agent 发起),不是本机 Web 用户
    if (from.peer) {
      return [
        `[🤝 来自 peer 实例「${from.peer}」的跨机请求（HTTP API，对方是另一个 Claudestra 的 agent/用户）。`,
        `用 reply() 回答——回复会自动转交对方的调用方。回答实质内容,保持精简;超出你职责范围的请求可以礼貌说明并拒绝。]`,
        ``,
        env.content,
      ].join("\n");
    }
    return [
      `[🌐 来自 Web 端用户「${from.name}」（HTTP API 接入，非 Discord）。`,
      `用 reply() 回答到本 chat_id。对方界面完整渲染 Markdown（表格可用），且能看到本频道完整聊天记录——不要复述上下文；也不要引用与本请求无关的内容。]`,
      ``,
      env.content,
    ].join("\n");
  }

  // 本地 agent → agent 转发（send_to_agent / pushback / reply→别agent forward）。
  // v2.0.17 引入了 imperative framing 强迫 agent 处理；v2.4.16 又往回收了一段 ——
  // 实测 "必须 reply() 报告、就算只是知会也 reply() 收到" 这种强约束跟 drain兜底
  // no-text push、ia-watchdog nudge 三者叠加，是 agent 之间永无止境互相 ack 的根因
  // （A 发 status，B 收到必须 reply 收到，A 收到 B 的 reply 又必须 reply 收到，...）。
  // 现在改成：明确这是要看的 inbound，但**没有干货就允许直接 end_turn**，不必为
  // 应付 framing 而编"收到"。真问到你的就答；否则该静默就静默。
  if (from.kind === "local") {
    const fromName = from.agentName ?? "agent";
    return [
      `[🤖 来自 ${fromName} 的 inbound 消息（非 FYI）。`,
      `判断一下：是问你/要你动手 → 用 reply()/send_to_agent 处理；是纯状态同步/答完没下文 → end_turn 静默 OK，**别为了走形式编"收到"**。`,
      `规则：有干货才说话；没干货别说话。]`,
      ``,
      env.content,
    ].join("\n");
  }

  // 其他情况（user 在 agent 自己的频道）原样投递
  return env.content;
}


/** 开始 typing + 30min 安全超时（实现在 discord-adapter，这里注入 owner mention） */
function startTypingWithSafety(channelId: string) {
  beginTypingWithSafety(discord, channelId, () => (primaryOwnerId() ? `<@${primaryOwnerId()}>` : ""));
}

// ============================================================
// Discord Client
// ============================================================

const discord = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
});

// v2.6.0+ C1：Discord 作为第一个 ChatAdapter（设计 §6）。内部就是 discordReply
// —— 挪壳不挪逻辑：分块 / reply_to / components 渲染 / files 都在 discordReply
// 里，本来就是 Discord 专属职责。send 时 discord client 已 ready（消息只会在
// ready 后流动）。
registerAdapter(createDiscordChatAdapter(discord));
// Web-only: local adapter 常驻注册：Discord 模式下没有 local-* 地址流通，
// 不会被命中；Web-only 模式下承接会话地址供给（create_channel）与出站落空。
registerAdapter(createLocalChatAdapter());

discord.once("ready", async () => {
  setBotUserId(discord.user?.id || "");
  // 建 agent 频道时用它写权限覆盖（默认对 @everyone 隐藏）
  setAllowlistProvider(allowedDiscordIds);
  console.log(`✅ Discord 已连接: ${discord.user?.tag}`);
  console.log(`📡 Bridge WebSocket: ws://localhost:${BRIDGE_PORT}`);
  console.log(`🔗 已注册频道: ${clients.size}`);

  // v1.9.28+: bridge 重启时会丢失 activeStatusMessages 内存，重启前还在跑的
  // 任务的"💭 思考中..."按钮消息就卡那儿了，Stop hook 触发时查不到 message id
  // 没法编辑。启动后扫所有 registered channel 的近期消息，把遗留的思考中消息
  // 编辑成"bridge 已重启"。
  cleanupStaleThinkingMessages().catch((e) => console.error("清理遗留思考中消息失败:", e));

  // v2.4.25+ 用量看板：启动后确保只读频道 + 常驻消息存在，并刷一次。延迟几秒等
  // channel-server 重连、master TUI 稳定，再抓 /status。
  setTimeout(() => void initStatsDashboard(discord), 6000);

  // 扫 skill + 为已有 active agent 扫项目级
  await scanGlobalSkills();
  try {
    const listResult = await runManager("list");
    for (const a of listResult.agents || []) {
      if (a.status === "active" && a.cwd) {
        await scanProjectSkills(a.name, a.cwd);
      }
    }
  } catch { /* non-critical */ }

  // 注册 Slash Commands
  await registerSlashCommands();

  // 启动权限弹窗 watcher
  startPermissionWatcher(allowedDiscordIds(), discord);

  // 启动 wedge watcher — 检测长时间没动静但又不 idle 的 agent；
  // v2.7+ 注入链路查询做「窗口活着但 channel-server 掉线」哨兵
  startWedgeWatcher(discord, (channelId) => clients.has(channelId));

  // v2.16+ 模型漂移告警——CC 用量保护静默降级不再无感（2026-07-30 外部用户
  // 报「莫名其妙被切到 Sonnet 4.6」）。Discord 告警 + session_anomaly SSE。
  {
    const { startModelDriftWatcher } = await import("./bridge/model-drift.js");
    startModelDriftWatcher((channelId, text) => {
      discordReply(discord, channelId, text).catch(() => {});
    });
  }

  // v2.7+ bg 对账定时器 — 检测正式 agent 的 bg 分身（agents 视图误触产物）
  startSessionReconciler(discord);

  // v2.8+ bg 活动追踪 — subagent / 后台 shell 任务 → 子区流式呈现 + bg_task_* 事件
  // 注入来源判定：Web/API 回合不建 Discord 子区（那边有 bg_task_* SSE 渲染同样的进度）
  startBgActivityWatcher({ sourceProvider: (cid) => lastMessageSource.lastHuman(cid) });

  // v2.14+ 大总管的 watcher：register 时挂一次，再每 2 分钟对一次 sessionId
  // （master 会因 /clear 轮转会话，而它不在 registry，没有别的地方会告诉我们）。
  syncMasterWatcher(discord);
  setInterval(() => syncMasterWatcher(discord), 120_000);

  // v2.15+ 思考遥测 — 回合中每 3s 采样 TUI 状态行（耗时/↓token/effort）→
  // transient SSE；输出 token 冻结 ≥8min → 卡死告警（文本 + session_anomaly）
  startThinkingTelemetry({
    roster: listRegistryChannels,
    notify: (channelId, text) => {
      try {
        const ch = discord.channels.cache.get(channelId);
        if (ch && "send" in ch) void (ch as { send: (t: string) => Promise<unknown> }).send(text).catch(() => {});
      } catch { /* web-only 模式无 Discord:SSE 事件仍在发 */ }
    },
  });

  // v2.9+ 归档每日兜底 — 退役归档之外，每 24h 对 active agent 补快照（幂等）
  startArchiveSweeper();
  recordMetric("bridge_start", { meta: { channels: clients.size } });

  // v2.13.1+ TUI 契约自检 — 见 probeTuiContract 的注释：CC 改一句底部文案不会报错，
  // 而是让判活/判忙语义静默反转（今年已发生三次）。这里在启动后采样两次 master pane，
  // 两次都可疑才告警一次，避免瞬时状态（弹窗、全屏 diff）造成误报。
  void checkTuiContractOnce();

  // 每 30 分钟自动重扫 skill（新装 plugin / 新建 user skill 不需要 restart bridge 就能出现在 /）
  setInterval(async () => {
    try {
      await scanGlobalSkills();
      const listResult = await runManager("list");
      for (const a of listResult.agents || []) {
        if (a.status === "active" && a.cwd) {
          await scanProjectSkills(a.name, a.cwd);
        }
      }
      await registerSlashCommands();
    } catch (e) {
      console.error("定时 skill 重扫失败:", e);
    }
  }, 30 * 60_000);

  // v2.4.6+: Discord gateway WS 健康看门狗。
  // 现象：discord.js gateway WebSocket 偶尔静默断开（discord.js 内部 zombie state），
  // client 不触发 reconnect、bridge 进程主循环还活着、HTTP /hook + outbound REST API
  // 还能用，但收不到任何 messageCreate / interactionCreate event。用户看到 worker
  // / master 对 Discord 消息无响应，但 agent reply() 出来的还能看到。
  // 兜底：连续 5 次（5min）ws.status 不是 READY 就 process.exit(1)，launchd KeepAlive
  // 自动拉起 bridge，走全新 ready setup 全部恢复。
  let unhealthyTicks = 0;
  setInterval(() => {
    const status = (discord as any).ws?.status;
    if (status === 0) {
      unhealthyTicks = 0;
    } else {
      unhealthyTicks++;
      console.warn(`⚠️ Discord gateway WS status=${status} (≠READY) — unhealthy ${unhealthyTicks}/5`);
      if (unhealthyTicks >= 5) {
        console.error(`💀 Discord gateway WS 持续 5 分钟非 READY — exit 让 launchd KeepAlive 重启 bridge`);
        process.exit(1);
      }
    }
  }, 60_000);
});

// v2.4.6+: shard 事件监听 — discord.js gateway 异常的诊断信号。
// 这些事件本身不一定意味着真死了；触发 KeepAlive 重启交给上面的 5 分钟看门狗判定。
// v2.4.12+: 加 disconnect 频率看门狗 —— 5min ws.status 看门狗漏掉了"反复 disconnect
// + 每次都立刻 resume"的情况（单次断连几秒钟，下次 tick 时 ws.status 已回 READY，
// unhealthyTicks 清零）。但每次 disconnect 都会让 Discord 丢失短 TTL 事件，尤其
// interaction event（3s 内必须 ack 否则 user 看到"交互失败"）。24h 内 10 次 disconnect
// 累积起来 = 几十个 interaction 漏 dispatch = user 报"所有按钮都点不了"。
// 阈值：30min 滑窗内累计 ≥3 次 disconnect 就 process.exit 让 launchd 重建全新连接。
// 单次 disconnect→resume 是 Discord gateway 正常行为（区域迁移 / 网络抖动），不该触发。
const reconnectTimestamps: number[] = [];
const RECONNECT_WINDOW_MS = 30 * 60_000;
const RECONNECT_THRESHOLD = 3;
discord.on("shardDisconnect" as any, (event: any, shardId: number) => {
  console.warn(`⚠️ shard ${shardId} disconnect: code=${event?.code} reason="${event?.reason || ""}"`);
  const now = Date.now();
  reconnectTimestamps.push(now);
  const cutoff = now - RECONNECT_WINDOW_MS;
  while (reconnectTimestamps.length > 0 && reconnectTimestamps[0] < cutoff) {
    reconnectTimestamps.shift();
  }
  if (reconnectTimestamps.length >= RECONNECT_THRESHOLD) {
    console.error(`💀 30min 内 shard disconnect ${reconnectTimestamps.length} 次，interaction event 漏 dispatch 风险高 — exit 让 launchd KeepAlive 重建 gateway 连接`);
    process.exit(1);
  }
});
discord.on("shardError" as any, (error: Error, shardId: number) => {
  console.error(`⚠️ shard ${shardId} error: ${error?.message}`);
});
discord.on("shardReconnecting" as any, (shardId: number) => {
  console.log(`🔄 shard ${shardId} reconnecting…`);
});
discord.on("shardResume" as any, (shardId: number, replayed: number) => {
  console.log(`✅ shard ${shardId} resumed (replayed ${replayed} events)`);
});
discord.on("shardReady" as any, (shardId: number) => {
  console.log(`✅ shard ${shardId} ready`);
});

// ────────────────────────────────────────────────
// Slash command 构建 + 注册（可重入）
// ────────────────────────────────────────────────
let lastRegisteredHash = "";

function truncateDesc(desc: string, fallback: string): string {
  const s = (desc || fallback || "").replace(/\s+/g, " ").trim();
  return s ? s.slice(0, 100) : fallback.slice(0, 100);
}

/**
 * 构建完整的 Discord slash command 列表（内置 bridge 命令 + CC built-in + 所有 skill）。
 */
function buildAllSlashCommands(): any[] {
  const commands: any[] = [
    // bridge 自己的 5 个
    new SlashCommandBuilder().setName("screenshot").setDescription("截取当前 agent 的终端画面").toJSON(),
    new SlashCommandBuilder().setName("interrupt").setDescription("打断当前 agent 的操作 (Ctrl+C)").toJSON(),
    new SlashCommandBuilder().setName("status").setDescription("查看所有 agent 的状态").toJSON(),
    new SlashCommandBuilder().setName("cron").setDescription("查看和管理定时任务").toJSON(),
    new SlashCommandBuilder().setName("focus").setDescription("把 Mac 上的 iTerm 切到本频道 agent 的 tab").toJSON(),
    // v2.7+ Claude Code agents 模式：全机器会话总览（bg 分身检测/清理/收编）
    new SlashCommandBuilder().setName("agents").setDescription("Claude 会话总览：前台/后台/分身检测").toJSON(),
  ];
  const bridgeNames = new Set(["screenshot", "interrupt", "status", "cron", "agents"]);

  for (const item of allRegistrableCommands()) {
    if (item.kind === "builtin") {
      const c = item.cmd;
      if (bridgeNames.has(c.name)) continue; // 优先 bridge 自己的
      const b = new SlashCommandBuilder()
        .setName(c.name)
        .setDescription(truncateDesc(c.description, `Claude Code ${c.name}`));
      for (const opt of c.options) {
        if (opt.type === "choices") {
          b.addStringOption((o) => {
            o.setName(opt.name).setDescription(truncateDesc(opt.description, opt.name)).setRequired(!!opt.required);
            for (const ch of opt.choices || []) o.addChoices({ name: ch, value: ch });
            return o;
          });
        } else {
          b.addStringOption((o) =>
            o.setName(opt.name).setDescription(truncateDesc(opt.description, opt.name)).setRequired(!!opt.required)
          );
        }
      }
      commands.push(b.toJSON());
    } else {
      const s = item.skill;
      if (bridgeNames.has(s.discordName)) continue;
      const b = new SlashCommandBuilder()
        .setName(s.discordName)
        .setDescription(truncateDesc(s.description, `skill: ${s.invokeName}`))
        .addStringOption((o) =>
          o.setName("args").setDescription(truncateDesc(`参数（可选）会原样附加到 /${s.invokeName} 后面`, "参数"))
        );
      commands.push(b.toJSON());
    }
  }
  return commands;
}

async function registerSlashCommands(): Promise<void> {
  try {
    const commands = buildAllSlashCommands();
    // 用 hash 去重 — 命令列表没变就不 REST PUT，省 Discord 配额
    const hash = JSON.stringify(commands);
    if (hash === lastRegisteredHash) {
      console.log(`📝 Slash Commands 未变 (${commands.length} 条)，跳过重注册`);
      return;
    }
    const rest = new REST().setToken(DISCORD_TOKEN);
    if (DISCORD_GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(discord.user!.id, DISCORD_GUILD_ID), { body: commands });
      await rest.put(Routes.applicationCommands(discord.user!.id), { body: [] });
      console.log(`📝 Slash Commands 已注册 (guild, ${commands.length} 条) + 清除全局`);
    } else {
      await rest.put(Routes.applicationCommands(discord.user!.id), { body: commands });
      console.log(`📝 Slash Commands 已注册 (global, ${commands.length} 条)`);
    }
    lastRegisteredHash = hash;
  } catch (err) {
    console.error("Slash Commands 注册失败:", err);
  }
}

// ────────────────────────────────────────────────
// Slash 结果呈现（支持 TUI modal 适配 → Discord 按钮/菜单）
// ────────────────────────────────────────────────

/**
 * 发完 slash 命令 + 等 2.5s 之后调。
 * 截一张图；如果 pane 上有数字选项 modal，就把选项以 Discord 按钮/select 的形式暴露给用户。
 * 否则就只发截图。
 */
async function presentSlashResult(
  interaction: any,
  targetWindow: string,
  targetLabel: string,
  ccText: string
): Promise<void> {
  const pane = await tmuxCapture(targetWindow, 40);
  const options = parseModalOptions(pane);
  const arrowNav = options ? null : detectArrowNavModal(pane);
  const pngPath = await tmuxScreenshot(targetLabel);
  const baseContent = `⚡ **${targetLabel}** ← \`${ccText}\``;

  // 无 modal → 截图 + Esc 兜底按钮（防止偶发 modal 没被检测到导致 session 卡住）
  // 兜底按钮（没有 modal 时）：Esc + 🤖 让大总管处理
  if (!options && !arrowNav) {
    const payload: any = {
      content: baseContent,
      components: buildComponents([
        {
          type: "buttons",
          buttons: [
            { id: `modal:${targetWindow}:esc`, label: "Esc (兜底)", emoji: "❌", style: "secondary" },
            { id: `escalate:${targetWindow}:${encodeURIComponent(ccText)}`, label: "让大总管处理", emoji: "🤖", style: "primary" },
          ],
        },
      ]),
    };
    if (pngPath) payload.files = [{ attachment: pngPath }];
    else payload.content = `${baseContent}（截图失败）`;
    await interaction.editReply(payload).catch(() => {});
    return;
  }

  // 有 modal → 截图 + 按钮（按钮组里已含 🤖 升级按钮）
  const header = options
    ? `🎛 **${targetLabel}** 的 TUI 选项（\`${ccText}\`）：`
    : `🎛 **${targetLabel}** 的 ${arrowNav} 箭头 modal（\`${ccText}\`），用按钮导航 + 点 ✅ 确认：`;
  const modalRows = options
    ? buildModalComponents(targetWindow, options, ccText)
    : buildArrowModalComponents(targetWindow, arrowNav!, ccText);
  const payload: any = { content: header, components: modalRows };
  if (pngPath) payload.files = [{ attachment: pngPath }];
  await interaction.editReply(payload).catch(() => {});
}

/**
 * 把 modal 选项渲染成 Discord components。
 * ≤5 项 → 按钮行；>5 项 → string select menu。
 * 再追加一个 "❌ 取消 (Esc)" + 🤖 升级按钮。
 */
function buildModalComponents(targetWindow: string, options: { key: string; label: string; selected: boolean }[], ccText = "") {
  const rows: any[] = [];
  const escId = `modal:${targetWindow}:esc`;
  const escalateId = `escalate:${targetWindow}:${encodeURIComponent(ccText)}`;

  if (options.length <= 5) {
    const buttons = options.map((o) => ({
      id: `modal:${targetWindow}:${o.key}`,
      label: `${o.key}. ${o.label}`.slice(0, 80),
      style: o.selected ? "success" : "primary",
    }));
    rows.push({ type: "buttons" as const, buttons });
  } else {
    rows.push({
      type: "select" as const,
      id: `modal:${targetWindow}:select`,
      placeholder: "选一个选项",
      options: options.map((o) => ({
        label: `${o.key}. ${o.label}`.slice(0, 100),
        value: o.key,
        description: o.selected ? "当前选中" : undefined,
      })),
    });
  }
  rows.push({
    type: "buttons" as const,
    buttons: [
      { id: escId, label: "取消 (Esc)", style: "secondary", emoji: "❌" },
      { id: escalateId, label: "让大总管处理", style: "primary", emoji: "🤖" },
    ],
  });
  return buildComponents(rows);
}

/**
 * 把箭头导航 modal 渲染成上下左右 + Enter + Esc + 🤖 升级按钮。
 */
function buildArrowModalComponents(targetWindow: string, kind: ArrowNavKind, ccText = "") {
  const rows: any[] = [];
  const navButtons: any[] = [];
  if (kind === "vertical" || kind === "both") {
    navButtons.push({ id: `modal:${targetWindow}:up`, label: "Up", emoji: "⬆️", style: "primary" });
    navButtons.push({ id: `modal:${targetWindow}:down`, label: "Down", emoji: "⬇️", style: "primary" });
  }
  if (kind === "horizontal" || kind === "both") {
    navButtons.push({ id: `modal:${targetWindow}:left`, label: "Left", emoji: "⬅️", style: "primary" });
    navButtons.push({ id: `modal:${targetWindow}:right`, label: "Right", emoji: "➡️", style: "primary" });
  }
  rows.push({ type: "buttons" as const, buttons: navButtons });
  rows.push({
    type: "buttons" as const,
    buttons: [
      { id: `modal:${targetWindow}:enter`, label: "确认 (Enter)", emoji: "✅", style: "success" },
      { id: `modal:${targetWindow}:esc`, label: "取消 (Esc)", emoji: "❌", style: "secondary" },
      { id: `escalate:${targetWindow}:${encodeURIComponent(ccText)}`, label: "让大总管处理", emoji: "🤖", style: "primary" },
    ],
  });
  return buildComponents(rows);
}

/**
 * 按钮 / select 点击后，把按键发给 tmux，等 1.5s，再次截图 + 可能再出 modal。
 */
async function handleModalInteraction(
  interaction: any,
  targetWindow: string,
  key: string
): Promise<void> {
  await interaction.deferUpdate().catch(() => {});
  recordMetric("modal_button", { agent: targetWindow.replace(/^master:/, ""), meta: { key } });
  try {
    const keyMap: Record<string, string> = {
      esc: "Escape",
      enter: "Enter",
      left: "Left",
      right: "Right",
      up: "Up",
      down: "Down",
    };
    const tmuxKey = keyMap[key] ?? key; // 数字键保持原样
    await tmuxRaw(["send-keys", "-t", targetWindow, tmuxKey]);
    await Bun.sleep(1500);
    const pane = await tmuxCapture(targetWindow, 40);
    const options = parseModalOptions(pane);
    const arrowNav = options ? null : detectArrowNavModal(pane);
    const pngPath = await tmuxScreenshot(targetWindow.replace(/^master:/, ""));
    const label = targetWindow.replace(/^master:/, "");

    const payload: any = {};
    if (options) {
      payload.content = `🎛 **${label}** 的 TUI 选项（继续）：`;
      payload.components = buildModalComponents(targetWindow, options);
    } else if (arrowNav) {
      payload.content = `🎛 **${label}** 的 ${arrowNav} 箭头 modal（继续，用 ✅ 确认）：`;
      payload.components = buildArrowModalComponents(targetWindow, arrowNav);
    } else {
      payload.content = `✅ **${label}** 已执行（key=${key}）`;
      payload.components = [];
    }
    if (pngPath) payload.files = [{ attachment: pngPath }];
    await interaction.editReply(payload).catch(() => {});
  } catch (e) {
    await interaction.editReply({
      content: `❌ Modal 交互失败：${(e as Error).message}`,
      components: [],
    }).catch(() => {});
  }
}

// ============================================================
// 入站消息处理
// ============================================================

discord.on("messageCreate", async (msg: DiscordMessage) => {
  // 跳过自己 bot 的消息（echo）+ 跳过 bridge 自己发出去的（见 trackSentMessage）
  if (msg.author.id === getBotUserId()) {
    // v2.19.0 自我消息对账：author 是我、但 id 不在「我刚发出去的」里 →
    // 有另一个进程拿着同一个 token 在发消息（2026-08-15 事故，查了两小时）
    const alert = await noteSelfMessage(msg);
    if (alert && CONTROL_CHANNEL_ID) {
      recordMetric("second_instance_detected", { meta: { count: String(alert.count) } });
      discordReply(
        discord,
        CONTROL_CHANNEL_ID,
        [
          `👻 **疑似存在第二个 Claudestra 实例**${allowedDiscordIds().map((id) => ` <@${id}>`).join("")}`,
          `${alert.windowMin} 分钟内收到 ${alert.count} 条「本 bot 发出、但不是本实例发的」消息 —— 说明有别的进程拿着同一个 DISCORD_BOT_TOKEN 在往这些频道发东西。`,
          `常见成因：备份/迁移出来的副本上守护进程自启（它拿着同一份 registry 和 channelId）。`,
          ``,
          ...alert.samples.map((s) => `• <#${s.channelId}>：${s.preview}`),
          ``,
          `👉 排查：另一台机器上 \`launchctl list | grep claudestra\`；确认后停掉它，或轮换 bot token。`,
          originFooter(),
        ].join("\n"),
      ).catch(() => {});
    }
    return;
  }
  if (isBotMessage(msg.id)) return;

  // getBotUserId() 在 discord client ready 之前是 null（启动竞态）。has(null) 会
  // 直接抛，且语义上"没就绪"就等于"没被 @"。
  const botUserId = getBotUserId();
  const mentionedMe = botUserId ? msg.mentions.users.has(botUserId) : false;
  const channelId = msg.channelId;

  // v2.11: Discord peer 机制已移除(owner 2026-07-19「不用兼容,纯做新设计」,
  // peer 协作走 HTTP transport)。外部 bot 消息一律忽略——防 bot 互触发。
  if (msg.author.bot) return;
  // v2.13.1+ allowlist 一律 fail-closed。
  //
  // 原来是「不在 allowlist 的人，只要 @ 了机器人就照常处理」（"跨服有人找我们"），
  // 外加「allowlist 为空则跳过检查」。两条叠起来的实际含义是：任何能看到 agent
  // 频道的人，@ 一下就能驱动一个跑着 --dangerously-skip-permissions 的 shell。
  // 在自己一个人的服务器上无所谓，多一个人就不成立了 —— 而"给别人用"正是要推广
  // 的场景。给 agent 发消息 == 在这台机器上执行命令，门禁不能有例外通道。
  const allowIds = allowedDiscordIds();
  if (allowIds.length === 0) {
    // 空名单不再等于"放行所有"。setup 向导会强制填，走到这里通常是手改 .env 改空了。
    console.warn(
      `🚫 ALLOWED_USER_IDS 为空，已拒绝 ${msg.author.id} 的消息。` +
        `请在 .env 里填上你的 Discord user id 后重载 bridge。`
    );
    return;
  }
  if (!allowIds.includes(msg.author.id)) {
    console.log(`🚫 用户 ${msg.author.id} 不在 allowlist，已忽略（mentioned=${mentionedMe}）`);
    return;
  }

  const client = clients.get(channelId);
  if (!client) return;

  let content = msg.content
    .replace(new RegExp(`<@!?${getBotUserId()}>`, "g"), "")
    .trim();

  // 处理附件
  const attachmentPaths: string[] = [];
  if (msg.attachments.size > 0) {
    const inboxDir = INBOX_DIR;
    await Bun.spawn(["mkdir", "-p", inboxDir]).exited;
    for (const [, att] of msg.attachments) {
      try {
        // 这是全仓库唯一一个没有超时的 fetch，而它就坐在 messageCreate 处理路径上：
        // Discord CDN 半开连接会让这个用户的这条消息永远卡住（无超时 = 无限等待）。
        // 同时限一下体积——Discord 单附件上限 500MB（Nitro），无脑 arrayBuffer 会
        // 把它整个读进 bridge 内存。
        const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
        if (typeof att.size === "number" && att.size > MAX_ATTACHMENT_BYTES) {
          console.warn(`⚠️ 附件 ${att.name} 超过 25MB（${att.size}），跳过下载`);
          continue;
        }
        const resp = await fetch(att.url, { signal: AbortSignal.timeout(30_000) });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const buf = await resp.arrayBuffer();
        if (buf.byteLength > MAX_ATTACHMENT_BYTES) {
          console.warn(`⚠️ 附件 ${att.name} 实际大小超限，丢弃`);
          continue;
        }
        const filePath = `${inboxDir}/${att.id}_${att.name}`;
        await Bun.write(filePath, buf);
        attachmentPaths.push(filePath);
      } catch (err) {
        console.error(`下载附件失败: ${att.name}`, err);
      }
    }
  }

  if (attachmentPaths.length > 0) {
    const attDesc = attachmentPaths.map((p) => `[attachment: ${p}]`).join("\n");
    content = content ? `${content}\n\n${attDesc}` : attDesc;
  }

  if (!content) return;

  // 新用户消息到达 → 如果 agent 还在忙（不 idle），先发 Ctrl+C 打断，让新消息覆盖旧任务
  {
    try {
      const listResult = await runManager("list");
      const agent = (listResult.agents || []).find((a: any) => a.channelId === channelId);
      const targetWindow = agent ? `master:${agent.name}` : `master:0`;
      const { idleVerdict } = await import("./lib/tmux-helper.js");
      // 用三态判断：契约可疑（CC 可能改了底部文案）时宁可不打断。旧的两态版本在
      // 文案漂移时会恒判"在忙" → 每条消息都误发一次 Ctrl+C，静默打断用户的工作。
      const verdict = await idleVerdict(targetWindow);
      if (verdict === "unknown") {
        console.warn(`⚠️ ${targetWindow} 忙闲判据失效（TUI 文案可能已变），跳过自动打断`);
      }
      if (verdict === "busy") {
        console.log(`⚡ 新消息到达但 ${targetWindow} 还在忙，发 Ctrl+C 打断`);
        await tmuxRaw(["send-keys", "-t", targetWindow, "C-c"]).catch(() => {});
        await Bun.sleep(400);
      }
    } catch { /* non-critical */ }

    // v2.4.16+ 用户发消息 = 显式接管这个 channel 的对话方向。把该 channel 上挂着
    // 的所有 inter-agent pending 一并清掉，否则它们会在下一轮 Stop hook 触发
    // drain兜底 / nudge，把用户刚说的 "停下来" 拽回 agent-to-agent 链里去。
    const cleared = clearInterAgentPendingsForChannel(channelId);
    if (cleared > 0) {
      console.log(`🧹 user 消息到达 → 清掉 ${cleared} 条 inter-agent pending (channel=${channelId})`);
    }
  }

  // 清理上一轮状态 + 重置 tool 追踪
  stopTyping(channelId);
  clearSafetyTimer(channelId);
  await finishStatusMessage(discord, channelId, t("✅ 完成", "✅ Done"));
  resetToolTracking(channelId);
  startTypingWithSafety(channelId);
  // 状态消息走 deliver(bridge → user)。discordReply 内部会 buildComponents +
  // trackSentMessage，返回的 id 拿来做"✅ 完成"编辑的目标。
  const statusDelivery = await deliver({
    from: { kind: "bridge", label: "status" },
    to: { kind: "user", userId: msg.author.id, channelId },
    intent: "notification",
    content: t("💭 大聪明思考中...", "💭 Thinking..."),
    meta: {
      messageId: `status_${channelId}_${Date.now()}`,
      triggerKind: "bridge_synth",
      ts: new Date().toISOString(),
      threadId: newThreadId(),
      components: agentActionButtons(channelId, true),
    },
  });
  if (statusDelivery.outcome.kind === "sent" && statusDelivery.outcome.discordMessageIds?.[0]) {
    trackStatusMessage(channelId, statusDelivery.outcome.discordMessageIds[0]);
  }

  // 转发给 channel-server
  const meta: Record<string, string> = {
    chat_id: channelId,
    message_id: msg.id,
    user: msg.author.username,
    user_id: msg.author.id,
    ts: msg.createdAt.toISOString(),
  };
  if (attachmentPaths.length > 0) {
    meta.attachment_count = String(attachmentPaths.length);
    meta.attachments = attachmentPaths.join(";");
  }
  // 记录触发源:人类消息 = "user"(下游 Stop 发完成 @)。写给共享同一 ws 的全部 channel。
  for (const [cid, info] of clients.entries()) {
    if (info.ws === client.ws) {
      lastMessageSource.set(cid, "user");
    }
  }

  // v2.0.0 Phase 3：统一走 deliver(envelope)。header 注入都在
  // renderContentForLocal 里做，messageCreate 不再碰 content。只负责：
  //   - decide from / to
  //   - 填原始 content（strip mention 后的纯文本）+ attachments
  //   - 交给 deliver
  const from: RouterUserEndpoint = { kind: "user", userId: msg.author.id, channelId, username: msg.author.username };
  const to: RouterLocalEndpoint = {
    kind: "local",
    channelId: client.channelId,
    ws: client.ws,
    cwd: client.cwd,
  };
  const env: RouterEnvelope = {
    from,
    to,
    intent: "request",
    content,
    meta: {
      messageId: msg.id,
      triggerKind: "user_discord",
      ts: msg.createdAt.toISOString(),
      threadId: newThreadId(),
      attachments: attachmentPaths.length > 0 ? attachmentPaths : undefined,
    },
  };
  try {
    const delivery = await deliver(env);
    if (delivery.outcome.kind === "sent") {
      recordMetric("message_in", { channelId, meta: { len: content.length, attachments: attachmentPaths.length } });
    } else if (delivery.outcome.kind === "dropped") {
      console.log(`📪 deliver dropped ${envelopeLabel(env)}: ${delivery.outcome.reason}`);
      recordMetric("message_dropped", { channelId, meta: { reason: delivery.outcome.reason } });
    } else {
      console.error(`deliver 失败 ${envelopeLabel(env)}:`, delivery.outcome.error);
      recordMetric("error", { channelId, meta: { phase: "deliver", err: String(delivery.outcome.error) } });
    }
  } catch (err) {
    console.error(`deliver 抛异常 channel=${channelId}:`, err);
    recordMetric("error", { channelId, meta: { phase: "deliver_throw", err: String(err) } });
  }

  // idle 检测由 JSONL watcher 的静默超时控制（不再用 tmux 轮询）
});

// ============================================================
// 外部 guild 事件通知（bot 被邀请 / 频道权限变化）
// ============================================================

// 工具：往 master 控制频道发一条通知（系统广播，bridge → user 信道）
/**
 * 启动后做一次 TUI 契约自检。两次采样都可疑才告警 —— master pane 可能正处在弹窗、
 * 全屏 diff、compact 之类的瞬时画面，单次采样不足以下结论。
 * 只告警、不做任何自动处置：这类问题需要人去看一眼 CC 到底改成了什么。
 */
async function checkTuiContractOnce(): Promise<void> {
  const sample = async (): Promise<ReturnType<typeof probeTuiContract> | null> => {
    try {
      const pane = await tmuxCapture(`${MASTER_SESSION}:0`, 40);
      return probeTuiContract(pane);
    } catch {
      return null; // tmux 不在 / master 没起来 —— 不是契约问题，交给别的守护去管
    }
  };

  await new Promise((r) => setTimeout(r, 90_000)); // 等 master TUI 稳定
  const first = await sample();
  if (!first?.suspect) return;

  await new Promise((r) => setTimeout(r, 30_000));
  const second = await sample();
  if (!second?.suspect) return;

  const msg =
    "⚠️ **TUI 契约自检未通过** — master 屏幕上有 Claude Code 的界面，但底部既没有模式 banner" +
    "（`shift+tab to cycle`）也没有忙碌指示（`esc to interrupt`）。\n\n" +
    "这两个文案是判断 agent「空闲 / 在忙 / 是否还活着」的依据，约 25 处控制流依赖它们。" +
    "如果 Claude Code 改了这两句话，症状不会是报错，而是**判活逻辑静默反转**（典型表现：" +
    "agent 明明活着却被判定死亡并无限重启）。\n\n" +
    "请人工看一眼 master 窗口现在长什么样，必要时更新 `src/lib/tmux-helper.ts` 里的 " +
    "`CC_MODE_BANNER_RE` 等匹配规则。";
  console.error(`⚠️ [tui-contract] 自检未通过，已告警。matched=${JSON.stringify(second.matched)}`);
  await notifyMaster(msg).catch(() => {});
  recordMetric("error", { meta: { kind: "tui_contract_suspect" } });
}

async function notifyMaster(content: string): Promise<void> {
  const controlChannelId = CONTROL_CHANNEL_ID;
  if (!controlChannelId) return;
  try {
    await deliver({
      from: { kind: "bridge", label: "notifyMaster" },
      to: {
        kind: "user",
        userId: primaryOwnerId(),
        channelId: controlChannelId,
      },
      intent: "notification",
      content,
      meta: {
        messageId: `notify_${Date.now()}`,
        triggerKind: "bridge_synth",
        ts: new Date().toISOString(),
        threadId: newThreadId(),
      },
    });
  } catch { /* non-critical */ }
}

// 我方 bot 被邀请加入新 guild
discord.on("guildCreate", async (guild) => {
  // v2.11: Discord peer 已移除——加入外部 guild 只记日志,不再推「跨实例协作」指引
  console.log(`ℹ️ 我方 bot 被加到新 guild: ${guild.name} (${guild.id})——Discord peer 已移除,跨实例协作用 HTTP peer`);
});

// 我方 bot 在外部 guild 拿到新频道访问权限（对方给我们 allow View Channel）
// v2.11: channelCreate 通知已移除——它只服务「对方 Claudestra 主动 share 频道」
// 的 Discord peer 流程(现走 HTTP peer,无频道授予概念)。

// 我方 bot 在外部 guild 失去频道访问（频道被删了）
discord.on("channelDelete", async (channel) => {
  if (!("guild" in channel) || !channel.guild) return;
  if (channel.guild.id === DISCORD_GUILD_ID) return;
  const textCh = channel as TextChannel;
  if (typeof textCh.isTextBased !== "function" || !textCh.isTextBased()) return;
  console.log(`💨 外部 guild 频道被删: #${textCh.name} in ${textCh.guild?.name}`);
  await notifyMaster(
    [
      `💨 **${textCh.guild?.name ?? "外部 guild"} 里 #${textCh.name} 被删了**`,
    ].join("\n")
  );
});

// 已有频道权限变化：比如对方 grant 或 revoke 我们的 View Channel
// v2.11: channelUpdate 权限变动通知已随 Discord peer 移除。

// 别的 bot（不是我方）加入了我的 guild
// v2.11: guildMemberAdd handler 已删——bot 加入通知是 Discord peer 时代的 UX,
// GuildMembers 特权 intent 一并移除(Developer Portal 可关闭该开关)。

// ============================================================
// Interaction 处理（按钮、菜单、Slash Commands）
// ============================================================

/**
 * v2.4.22+ agent 频道消息底部的通用操作按钮行。挂在「💭 思考中」/「✅ 完成」/
 * button-click 回执这些**永远在频道底部、正文里**的消息上，用户一眼就能点 ——
 * 不用翻 pin（pin 弹窗里按钮 Discord 点不动）、不用打 /focus。
 * withInterrupt=true 时带打断（工作中），完成态不带。
 */

/** v2.4.22+ button 触发截图（复用 /screenshot slash 的逻辑）。返回 png 路径或 null。 */
async function captureChannelScreenshot(channelId: string): Promise<string | null> {
  const listResult = await runManager("list");
  const agent = (listResult.agents || []).find((a: any) => a.channelId === channelId);
  const windowName = agent ? agent.name : "master";
  console.log(`📸 截图（button）: window=${windowName} channel=${channelId}`);
  return tmuxScreenshot(windowName);
}

/**
 * v2.4.19+ 把 iTerm2 切到某 channel 对应的 tmux tab。button（focus:）和 /focus 共用。
 * 主路径（v2.5.4 定版）：activate 本机 iTerm → tmux select-window → iTerm 自己的
 * CC 跟随切 tab（前台 1s 内稳定；对远端 ssh -CC attach 的 iTerm 同样生效）。
 * 位置序号 AppleScript 只做验证失败后的本机兜底。
 */
async function focusITermTab(targetChannelId: string): Promise<{ ok: boolean; found: boolean; label: string; note: string }> {
  const controlId = CONTROL_CHANNEL_ID;
  let targetWindow: string;
  let label: string;
  if (targetChannelId === controlId) {
    targetWindow = `${MASTER_SESSION}:0`;
    label = "master";
  } else {
    const listResult = await runManager("list");
    const agent = (listResult.agents || []).find((a: any) => a.channelId === targetChannelId);
    if (!agent) {
      return { ok: false, found: false, label: "?", note: "❌ 找不到对应 agent（可能已被 kill）" };
    }
    targetWindow = `${MASTER_SESSION}:${agent.name}`;
    label = agent.name;
  }

  // v2.5.4 定版方案：**先 activate 再 select-window，让 iTerm 自己的 CC 跟随干活**。
  //
  // 实验结论（2026-07-08，逐秒观测）：iTerm CC 模式对 tmux 的 window-changed 通知，
  // 前台时 1 秒内稳定跟随；后台时 15s+ 有意忽略（spinner 还在动 = 不是卡死/App Nap，
  // 是防后台抢 tab 焦点的设计）。之前"后台随缘"的根因就是这个 —— 所以把 iTerm 先
  // activate 到前台再 select-window，跟随就从随缘变确定。这同时惠及**所有** -CC
  // client：远端设备 ssh attach 的 iTerm（AppleScript 够不着的那台）也收到同一条
  // select-window 通知，它在用户手上通常本来就是前台 → 一并跟随。
  // 「位置序号选 tab」降级为验证失败后的兜底（它假设单窗口 + tab 顺序==window 顺序，
  // 散窗时会错，不再当主路径）。

  const idxList = (await tmuxRaw(["list-windows", "-t", MASTER_SESSION, "-F", "#{window_index}"]).catch(() => "")).split("\n").filter(Boolean);
  const targetIdx = (await tmuxRaw(["display-message", "-p", "-t", targetWindow, "#{window_index}"]).catch(() => "")).trim();
  const ordinal = idxList.indexOf(targetIdx) + 1; // 1-based 位置（兜底 + 验证用）
  const tmuxCount = idxList.length;

  const clientsOut = await tmuxRaw(["list-clients", "-t", MASTER_SESSION]).catch(() => "");
  const hasCC = /control/.test(clientsOut);

  /** 跑一段 AppleScript，8s 超时 kill（iTerm 无响应时不拖垮 focus）。 */
  const osaRun = async (script: string): Promise<string> => {
    const p = Bun.spawn(["osascript", "-e", script], { stdout: "pipe", stderr: "pipe" });
    const out = await Promise.race([
      new Response(p.stdout).text().then((t) => t.trim()),
      new Promise<string>((r) => setTimeout(() => r("timeout"), 8000)),
    ]);
    if (out === "timeout") { try { p.kill(); } catch {} }
    await p.exited.catch(() => {});
    return out;
  };

  // 1) iTerm 提到前台（唤醒 CC 跟随）。远程 attach 时本机没开 iTerm 也无妨，照样走 2)。
  await osaRun('tell application "iTerm2" to activate');

  // 2) 切 tmux window —— 所有 -CC client（本机 + 远端）同时收到通知，前台的会跟。
  //
  // 曾把「给远端弹 macOS 通知」的所有路径都实验过（2026-07-08），全部否决，别再试：
  // - 临时 window 发裸 OSC 9：能弹，但点击必然跳到临时窗口（OSC 9 点击跳发出者 tab）；
  // - run-shell 注入目标 pane：输出不进 pane 的终端流，通知不发；
  // - Claude Code `!` bash mode 从目标 pane 发：输出被 CC 捕获渲染在 TUI 里（⎿ 框），
  //   不写入 pty，OSC 9 到不了 iTerm，还在 agent 会话留痕迹；忙时注入更是排队且不可控。
  await tmuxRaw(["select-window", "-t", targetWindow]).catch(() => {});

  // 2b) 1.8s 后单次补切（owner 批准，非循环）。对抗 iTerm 的防回显竞态：iTerm 因
  // App 焦点事件上报自己 tab 时会预扣 _ignoreWindowChangeNotificationCount 计数器
  // （iTerm2 源码 TmuxController.m），把我们这条切换通知误当回显吃掉，还把旧 tab 回写
  // 覆盖 tmux（把别的 attach 端拉回去）。补发一次：第一发被误吃时计数器已消耗，第二发
  // 必然生效；第一发已生效时第二发是 no-op。
  setTimeout(() => {
    tmuxRaw(["select-window", "-t", targetWindow]).catch(() => {});
  }, 1800);

  // 3) 给 1.5s 跟随，然后验证本机 iTerm 的 current tab 序号是否 == 目标序号。
  let outcome = "noattach";
  if (hasCC && ordinal >= 1) {
    await new Promise((r) => setTimeout(r, 1500));
    const idx = await osaRun('tell application "iTerm2" to return index of current tab of current window');
    if (idx === String(ordinal)) {
      outcome = "ok";
    } else {
      // 4) 没跟上（如本机 iTerm 根本没有 CC 窗口 = 远程 attach）→ 位置序号法兜底强制切。
      const forced = await osaRun([
        'tell application "iTerm2"',
        '  repeat with w in windows',
        `    if (count of tabs of w) is ${tmuxCount} then`,
        `      select tab ${ordinal} of w`,
        '      select w',
        '      return "ok"',
        '    end if',
        '  end repeat',
        '  return "nolocal"',
        'end tell',
      ].join("\n"));
      outcome = forced || "err";
    }
  }

  const found = outcome === "ok";
  console.log(`🖥 focus: ${targetWindow} → tab #${ordinal}/${tmuxCount} outcome=${outcome} (hasCC=${hasCC})`);
  let note: string;
  if (found) {
    note = `🖥 已跳到 **${label}** 的 iTerm tab`;
  } else if (!hasCC) {
    note = `🖥 当前没有 -CC attach，无法切 tab（tmux 内部已切到 **${label}**，attach 后可见）`;
  } else if (outcome === "nolocal") {
    note = `🖥 tmux 已切到 **${label}**。你像是**远程 attach**（本机没有 CC 窗口）—— 远端 iTerm 前台会自动跟着切，没跟就手动点下 tab`;
  } else if (outcome === "timeout") {
    note = `🖥 tmux 已切到 **${label}**，本机 iTerm 的 AppleScript 无响应（超时跳过）。前台 iTerm 会自动跟随`;
  } else {
    note = `🖥 tmux 已切到 **${label}**，但本机 iTerm tab 没跟上（outcome=${outcome}）`;
  }
  return { ok: true, found, label, note };
}

/**
 * v2.5.4+ 触发某个 agent 的「存记忆 + Compact」：往它的 tmux 发 /save-compact
 * （随包 skill：先挑重点存记忆 —— 有 mem0 用 mem0，没有用 CC 自带 memory ——
 * 再自动安排 /compact）。看板 select 和档位提醒按钮共用。agent 正忙也照发，
 * TUI 会排队，轮到时执行（跟 cron --target-agent 一个假设）。
 */
async function triggerSaveCompact(interaction: any, targetChannelId: string): Promise<void> {
  try {
    const listResult = await runManager("list");
    const agent = (listResult.agents || []).find((a: any) => a.channelId === targetChannelId);
    if (!agent) {
      await interaction.followUp({ content: "❌ 找不到对应 agent（可能已被 kill）", ephemeral: true }).catch(() => {});
      return;
    }
    noteSaveCompactInjected(`master:${agent.name}`);
    await tmuxSendLine(`master:${agent.name}`, "/save-compact");
    console.log(`🧹 save-compact 已发送: ${agent.name} (channel=${targetChannelId})`);
    await interaction
      .followUp({
        content: `🧹 已让 **${String(agent.name).replace(/^agent-/, "")}** 存记忆 + compact（正忙的话会排队，做完它会在自己频道汇报）`,
        ephemeral: true,
      })
      .catch(() => {});
  } catch (e) {
    console.error("🧹 save-compact 触发失败:", e);
    await interaction.followUp({ content: `❌ 触发失败: ${(e as Error).message}`, ephemeral: true }).catch(() => {});
  }
}

discord.on("interactionCreate", async (interaction: Interaction) => {
  try {
    const channelId = interaction.channelId;
    console.log(`🎯 Interaction: type=${interaction.type} channel=${channelId} user=${interaction.user?.id}`);
    if (!channelId) return;

    // fail-closed，同 messageCreate：空 allowlist 不再等于放行所有。按钮和 slash
    // 命令能直接触发 kill / restart / 发键，门禁标准不该比消息更松。
    const allowIds = allowedDiscordIds();
    if (allowIds.length === 0) {
      console.warn(
        `🚫 ALLOWED_USER_IDS 为空，已拒绝 ${interaction.user.id} 的交互。请在 .env 里配置后重载 bridge。`
      );
      return;
    }
    if (!allowIds.includes(interaction.user.id)) {
      console.log(`🚫 用户 ${interaction.user.id} 不在允许列表（principals/.env）中`);
      return;
    }

    // ── Slash Commands ──
    if (interaction.isChatInputCommand()) {
      const cmd = interaction.commandName;
      console.log(`⚡ Slash command: /${cmd} in ${channelId}`);
      recordMetric("slash_invoked", { channelId, meta: { cmd } });

      if (cmd === "screenshot") {
        try {
          await interaction.deferReply();
        } catch (e) {
          console.error("📸 deferReply 失败:", e);
          return;
        }
        try {
          const listResult = await runManager("list");
          const agent = (listResult.agents || []).find((a: any) => a.channelId === channelId);
          const windowName = agent ? agent.name : "master";
          console.log(`📸 截图: window=${windowName} channel=${channelId}`);
          const pngPath = await tmuxScreenshot(windowName);
          if (pngPath) {
            await interaction.editReply({ content: "**📸 终端截图**", files: [{ attachment: pngPath }] });
          } else {
            console.error("📸 tmuxScreenshot 返回 null");
            await interaction.editReply("❌ 截图失败：PNG 生成失败");
          }
        } catch (e) {
          console.error("📸 截图流程失败:", e);
          try { await interaction.editReply(`❌ 截图失败: ${(e as Error).message}`); } catch {}
        }
        return;
      }

      if (cmd === "interrupt") {
        const listResult = await runManager("list");
        const agent = (listResult.agents || []).find((a: any) => a.channelId === channelId);
        if (agent) {
          Bun.spawn(["tmux", "-S", TMUX_SOCK, "send-keys", "-t", `master:${agent.name}`, "C-c"]);
          stopTyping(channelId);
          clearSafetyTimer(channelId);
          // 同打断按钮：被打断的回合没有 Stop hook，主动收尾 done
          emitEvent({ agent: agent.name, chatId: channelId, type: "agent_status", data: { status: "done", trigger: "interrupt" } });
          await finishStatusMessage(discord, channelId, t("⚡ 已打断", "⚡ Interrupted"));
          await interaction.reply("⚡ 已发送 Ctrl+C");
        } else {
          await interaction.reply("⚠️ 当前频道没有关联的 agent");
        }
        return;
      }

      if (cmd === "focus") {
        // v2.4.20+ 可靠版跳 iTerm tab（不依赖 pin 弹窗里的按钮）。ephemeral 回执。
        try {
          await interaction.deferReply({ ephemeral: true });
        } catch { return; }
        try {
          const r = await focusITermTab(channelId);
          await interaction.editReply({ content: r.note }).catch(() => {});
        } catch (e) {
          await interaction.editReply({ content: `❌ 切换失败: ${(e as Error).message}` }).catch(() => {});
        }
        return;
      }

      if (cmd === "status") {
        await interaction.deferReply();
        const panel = await buildStatusPanel();
        const components = panel.components ? buildComponents(panel.components) : undefined;
        await interaction.editReply({ content: panel.text, components });
        return;
      }

      // v2.7+ /agents —— Claude 会话总览（前台/后台/分身检测/清理/收编）
      if (cmd === "agents") {
        await interaction.deferReply();
        const panel = await handleMgmtButton("show_sessions_panel", channelId);
        if (panel) {
          const components = panel.components ? buildComponents(panel.components) : undefined;
          await interaction.editReply({ content: panel.text, components });
        } else {
          await interaction.editReply("❌ 无法获取会话清单");
        }
        return;
      }

      if (cmd === "cron") {
        await interaction.deferReply();
        const cronPanel = await handleMgmtButton("show_cron_menu", channelId);
        if (cronPanel) {
          const components = cronPanel.components ? buildComponents(cronPanel.components) : undefined;
          await interaction.editReply({ content: cronPanel.text, components });
        } else {
          await interaction.editReply("❌ 无法获取定时任务信息");
        }
        return;
      }

      // ── 转发给 Claude Code 的 slash（built-in / skill） ──
      {
        // 立即 defer，防止 3s Discord token 过期（lookup 可能耗时）
        await interaction.deferReply().catch(() => {});

        // 找 channel 对应的 agent
        let agentName: string | null = null;
        let agentCwd: string | null = null;
        let agentSid: string | undefined;
        try {
          const listResult = await runManager("list");
          const agent = (listResult.agents || []).find((a: any) => a.channelId === channelId);
          if (agent) {
            agentName = agent.name;
            agentCwd = agent.project ? String(agent.project).replace(/^~/, process.env.HOME || "~") : null;
            agentSid = agent.sessionId || undefined;
          }
        } catch { /* non-critical */ }

        // 如果没找到 agent，就是 master channel（control channel）
        const targetWindow = agentName ? `master:${agentName}` : `master:0`;
        const targetLabel = agentName || "master";

        // 收集 option 值
        const vals: Record<string, string> = {};
        for (const opt of interaction.options.data) {
          if (typeof opt.value === "string") vals[opt.name] = opt.value;
        }

        // 先检查是不是其他 agent 的 project skill
        const otherOwner = isProjectSkillForOtherAgent(cmd, agentName);
        if (otherOwner) {
          await interaction.editReply({
            content: `⚠️ \`/${cmd}\` 是 **${otherOwner}** 的项目级 skill，在当前频道（${targetLabel}）不可用。切到 ${otherOwner} 的频道再试。`,
          }).catch(() => {});
          return;
        }

        const resolved = resolveInvocation(cmd, agentName, vals);
        if (!resolved.ok) {
          await interaction.editReply({ content: `⚠️ ${resolved.reason}` }).catch(() => {});
          return;
        }

        console.log(`⚡ 转发 slash: /${cmd} → window=${targetWindow} text="${resolved.ccText}"`);
        try {
          await tmuxSendLine(targetWindow, resolved.ccText);
          // v2.16.2 Discord slash 的 /model 同样登记切换意图 → watcher 代按二次确认
          if (cmd === "model" && agentName) {
            const { noteModelSwitchIntent } = await import("./bridge/permission-watcher.js");
            const { resolveModelAlias } = await import("./lib/claude-launch.js");
            const arg = resolved.ccText.replace(/^\/model\s*/, "").trim();
            if (arg) noteModelSwitchIntent(agentName, resolveModelAlias(arg));
          }
          // 直通 /clear 同样轮转 session——与 clear 端点一样挂轮转收尾（Web 直通
          // 同款补丁；master 无 registry/watcher 不需要）。Stop 自愈是最后兜底。
          if (cmd === "clear" && agentName && agentCwd) {
            scheduleClearRotation(agentName, channelId, agentCwd, agentSid);
          }
          // TUI 渲染需要几秒，截图作为反馈（否则像 /context 这类纯 TUI 命令 Discord 端完全没响应）
          await Bun.sleep(2500);
          await presentSlashResult(interaction, targetWindow, targetLabel, resolved.ccText);
        } catch (e) {
          console.error(`⚡ tmux 发送失败:`, e);
          await interaction.editReply({
            content: `❌ 发送失败：${(e as Error).message}`,
          }).catch(() => {});
        }
        return;
      }
    }

    // ── Buttons ──
    if (interaction.isButton()) {
      const id = interaction.customId;
      await interaction.deferUpdate().catch(async () => {
        await interaction.deferReply({ ephemeral: true }).catch(() => {});
      });

      // 用量看板「🔄 刷新」按钮 — 强制立即刷新（deferUpdate 已 ack，doUpdate 会编辑消息）
      if (id === "stats_refresh") {
        forceRefreshStatsDashboard(discord).catch((e) => console.error("📊 手动刷新失败:", e));
        return;
      }

      // v2.5.4+ 「🧹 存记忆 + Compact」按钮（上下文档位提醒消息上的）
      if (id.startsWith("savecompact:")) {
        const targetChannelId = id.slice("savecompact:".length);
        await triggerSaveCompact(interaction, targetChannelId);
        return;
      }

      // TUI modal 选项按钮 — 把键转发给 tmux，再截图 + 可能再出菜单
      if (id.startsWith("modal:")) {
        const rest = id.slice("modal:".length);
        const idx = rest.lastIndexOf(":");
        if (idx < 0) return;
        const targetWindow = rest.slice(0, idx);
        const key = rest.slice(idx + 1);
        await handleModalInteraction(interaction, targetWindow, key);
        return;
      }

      // 升级到大总管处理 — 把当前 agent 状态 + 截图 post 到 control 频道，master 自己 LLM 处理
      if (id.startsWith("escalate:")) {
        const rest = id.slice("escalate:".length);
        const idx = rest.indexOf(":");
        if (idx < 0) return;
        const targetWindow = rest.slice(0, idx);
        const ccText = decodeURIComponent(rest.slice(idx + 1));
        const agentName = targetWindow.replace(/^master:/, "");
        const controlChannelId = CONTROL_CHANNEL_ID;
        if (!controlChannelId) {
          await interaction.followUp({ content: "❌ 未配置 CONTROL_CHANNEL_ID，无法升级", ephemeral: true }).catch(() => {});
          return;
        }
        try {
          const pngPath = await tmuxScreenshot(agentName);
          const ctrlCh = (await discord.channels.fetch(controlChannelId)) as TextChannel;
          const msg = [
            `🤖 **需要你帮忙：** agent **${agentName}** 上的 \`${ccText}\` 的 TUI bridge 认不出，user 升级给你处理。`,
            ``,
            `你可以用这些 Bash 子命令控制这个 agent 的 tmux window：`,
            `- \`bun ../src/manager.ts tmux-screenshot ${agentName}\` — 截图（返回 PNG 路径，可用 Read 工具看）`,
            `- \`bun ../src/manager.ts tmux-capture ${agentName} [lines]\` — 读文本 pane`,
            `- \`bun ../src/manager.ts tmux-send-keys ${agentName} <keys...>\` — 发键（Enter/Escape/Left/Right/C-c/数字/字符串）`,
            `- \`bun ../src/manager.ts tmux-wait-idle ${agentName} [ms]\` — 等回到 idle`,
            ``,
            `请先截图看看现在 pane 什么状态，再决定怎么操作 + 用 reply 告诉原频道结果。原频道 channel_id=\`${interaction.channelId}\`。`,
          ].join("\n");
          await ctrlCh.send({
            content: msg,
            files: pngPath ? [{ attachment: pngPath }] : undefined,
          });
          await interaction.followUp({ content: `🤖 已升级到大总管（#control 频道），他会接手`, ephemeral: true }).catch(() => {});
          recordMetric("modal_button", { channelId: interaction.channelId, agent: agentName, meta: { action: "escalate", ccText } });
        } catch (e) {
          await interaction.followUp({ content: `❌ 升级失败：${(e as Error).message}`, ephemeral: true }).catch(() => {});
        }
        return;
      }

      // Wedge Esc 救回按钮
      if (id.startsWith("wedge_esc:")) {
        const agentName = id.slice("wedge_esc:".length);
        try {
          await tmuxSendEscape(`master:${agentName}`);
          clearWedgeState(agentName);
          await interaction.followUp({ content: `✅ 已发 Esc 到 ${agentName}`, ephemeral: true }).catch(() => {});
        } catch (e) {
          await interaction.followUp({ content: `❌ 发 Esc 失败: ${(e as Error).message}`, ephemeral: true }).catch(() => {});
        }
        return;
      }

      // v2.0.23+: agent 掉线（claude 退到 shell）的重启按钮
      if (id.startsWith("wedge_restart:")) {
        const agentName = id.slice("wedge_restart:".length);
        try {
          await interaction.followUp({ content: `🔄 正在重启 ${agentName}...`, ephemeral: true }).catch(() => {});
          const result = await runManager("restart", agentName);
          clearWedgeState(agentName);
          const ok = result?.ok;
          await interaction.followUp({
            content: ok ? `✅ ${agentName} 已重启` : `❌ 重启失败: ${result?.error || result?.message || "未知错误"}`,
            ephemeral: true,
          }).catch(() => {});
        } catch (e) {
          await interaction.followUp({ content: `❌ 重启失败: ${(e as Error).message}`, ephemeral: true }).catch(() => {});
        }
        return;
      }

      // v2.2.0+: auto 拦截「临时放行并重试」—— Shift+Tab 运行时切到 bypass + 注入重试
      if (id.startsWith("auto_allow:") || id.startsWith("auto_revert:")) {
        const isAllow = id.startsWith("auto_allow:");
        const targetChannelId = id.slice((isAllow ? "auto_allow:" : "auto_revert:").length);
        const target = isAllow ? "bypassPermissions" : "auto";
        try {
          const listResult = await runManager("list");
          const agent = (listResult.agents || []).find((a: any) => a.channelId === targetChannelId);
          if (!agent) {
            await interaction.followUp({ content: "❌ 找不到对应 agent", ephemeral: true }).catch(() => {});
            return;
          }
          const win = `master:${agent.name}`;
          const pane = await tmuxCapture(windowTarget(agent.name), 12);
          const cur = detectPermissionMode(pane);
          if (!cur) {
            await interaction.followUp({ content: "❌ 认不出当前权限模式，请手动 shift+tab 切", ephemeral: true }).catch(() => {});
            return;
          }
          const steps = btabStepsTo(cur, target);
          if (steps < 0) {
            await interaction.followUp({
              content: `❌ 切不到 ${target}（这个 agent 启动没带 allow-flag？需 restart 一次更新）`,
              ephemeral: true,
            }).catch(() => {});
            return;
          }
          // 发 steps 下 Shift+Tab（tmux 里是 BTab）
          for (let i = 0; i < steps; i++) {
            await tmuxRaw(["send-keys", "-t", win, "BTab"]);
            await Bun.sleep(150);
          }
          await Bun.sleep(300);
          const after = detectPermissionMode(await tmuxCapture(windowTarget(agent.name), 12));
          console.log(`⚡ auto_${isAllow ? "allow" : "revert"}: ${agent.name} ${cur}→${after} (${steps} BTab)`);

          if (isAllow) {
            // 切到 bypass 后，注入「重试」让 agent 重做被拦的操作
            const client = clients.get(targetChannelId);
            if (client) {
              startTypingWithSafety(targetChannelId);
              client.ws.send(JSON.stringify({
                type: "message",
                content: `[系统] 刚才被 auto 模式拦下的操作，用户已临时放行（已切到 bypass permissions）。请重试那个操作。完成后简单说一句，方便用户把你切回 auto。`,
                meta: { chat_id: targetChannelId, message_id: "", user: interaction.user.username, user_id: interaction.user.id, ts: new Date().toISOString() },
              }));
            }
            const note = after === "bypassPermissions" ? "已临时切到 bypass 并让它重试" : `尝试切 bypass（当前检测=${after || "?"}）并让它重试`;
            await interaction.message?.edit({
              content: `⚡ ${agent.name}：${note}。完事点下面切回 auto。`,
              components: buildComponents([
                { type: "buttons", buttons: [{ id: `auto_revert:${targetChannelId}`, label: "切回 auto", emoji: "🔒", style: "secondary" }] },
              ]),
            }).catch(() => {});
          } else {
            await interaction.message?.edit({
              content: after === "auto" ? `🔒 ${agent.name} 已切回 auto。` : `🔒 ${agent.name} 切回 auto（当前检测=${after || "?"}）。`,
              components: [],
            }).catch(() => {});
          }
        } catch (e) {
          await interaction.followUp({ content: `❌ 操作失败: ${(e as Error).message}`, ephemeral: true }).catch(() => {});
        }
        return;
      }

      // v2.4.19+ 跳到 iTerm tab 按钮（LLM-free）。逻辑抽到 focusITermTab()，
      // /focus slash 命令复用同一份（button 在 pin 弹窗里点不动，slash 更可靠）。
      if (id.startsWith("focus:")) {
        const targetChannelId = id.slice("focus:".length);
        try {
          const r = await focusITermTab(targetChannelId);
          await interaction.followUp({ content: r.note, ephemeral: true }).catch(() => {});
        } catch (e) {
          await interaction.followUp({ content: `❌ 切换失败: ${(e as Error).message}`, ephemeral: true }).catch(() => {});
        }
        return;
      }

      // v2.4.22+ 截图按钮（复用 /screenshot 逻辑）。ephemeral 回执带图，不刷屏。
      if (id.startsWith("screenshot:")) {
        const targetChannelId = id.slice("screenshot:".length);
        try {
          const pngPath = await captureChannelScreenshot(targetChannelId);
          if (pngPath) {
            await interaction.followUp({ content: "📸 终端截图", files: [{ attachment: pngPath }], ephemeral: true }).catch(() => {});
          } else {
            await interaction.followUp({ content: "❌ 截图失败：PNG 生成失败", ephemeral: true }).catch(() => {});
          }
        } catch (e) {
          await interaction.followUp({ content: `❌ 截图失败: ${(e as Error).message}`, ephemeral: true }).catch(() => {});
        }
        return;
      }

      // 打断按钮
      if (id.startsWith("interrupt:")) {
        const targetChannelId = id.slice("interrupt:".length);
        console.log(`⚡ 打断按钮点击: channel=${targetChannelId}`);
        try {
          // master (CONTROL_CHANNEL_ID) route 到 master:0，
          // 但它不在 registry.json 里 —— 直接认定目标是 master:0，不用查 registry
          const isMasterTarget = targetChannelId === CONTROL_CHANNEL_ID;

          let targetWindow: string;
          let agentLabel: string;
          if (isMasterTarget) {
            targetWindow = `${MASTER_SESSION}:0`;
            agentLabel = "master";
          } else {
            const listResult = await runManager("list");
            const agent = (listResult.agents || []).find((a: any) => a.channelId === targetChannelId);
            if (!agent) {
              console.error(`⚡ 打断失败：channel=${targetChannelId} 找不到对应 agent`);
              await interaction.followUp({ content: "❌ 打断失败：找不到对应 agent", ephemeral: true }).catch(() => {});
              return;
            }
            targetWindow = `master:${agent.name}`;
            agentLabel = agent.name;
          }

          console.log(`⚡ 发送 C-c 到 tmux window: ${targetWindow}`);
          const proc = Bun.spawn(
            ["tmux", "-S", TMUX_SOCK, "send-keys", "-t", targetWindow, "C-c"],
            { stdout: "pipe", stderr: "pipe" }
          );
          const stderr = await new Response(proc.stderr).text();
          await proc.exited;
          if (proc.exitCode !== 0) {
            console.error(`⚡ tmux send-keys 失败 (exit=${proc.exitCode}): ${stderr}`);
            await interaction.followUp({ content: `❌ tmux 发送 C-c 失败: ${stderr}`, ephemeral: true }).catch(() => {});
            return;
          }
          console.log(`⚡ C-c 已发送给 ${agentLabel}`);
          recordMetric("agent_interrupt", { channelId: targetChannelId, agent: agentLabel, meta: { trigger: "button" } });

          await finishStatusMessage(discord, targetChannelId, t("⚡ 已打断", "⚡ Interrupted"));
          stopTyping(targetChannelId);
          clearSafetyTimer(targetChannelId);
          // 被打断的回合没有 Stop hook —— 主动把回合状态收尾成 done，
          // 否则 agentStatuses 卡 thinking（web 黄点常驻 / busy 补锁复活）
          emitEvent({ agent: agentLabel, chatId: targetChannelId, type: "agent_status", data: { status: "done", trigger: "interrupt" } });
        } catch (e) {
          console.error(`⚡ 打断流程异常:`, e);
        }
        return;
      }

      // 权限弹窗 + session-idle 弹窗响应按钮
      const promptBtnPrefixes = [
        "perm_allow:", "perm_allow_session:", "perm_deny:",
        "session_summary:", "session_full:", "session_noask:",
      ];
      if (promptBtnPrefixes.some((p) => id.startsWith(p))) {
        const [action, targetChannelId] = id.split(":");
        // 按钮对应的 Claude Code 按键**序列**。
        // v2.0.22+: session-idle modal 不接受 digit 跳转（按 "2" 不会跳到 option 2，
        // Enter 还是确认高亮的 option 1 = 从摘要恢复 = compact）。改用 arrow nav：
        // 光标默认在 option 1，Down 一次到 2，两次到 3。perm 弹窗保留 digit（实测可用）。
        const keySeqMap: Record<string, string[]> = {
          perm_allow: ["1", "Enter"],
          perm_allow_session: ["2", "Enter"],
          perm_deny: ["3", "Enter"],
          session_summary: ["Enter"],              // option 1（高亮默认）
          session_full: ["Down", "Enter"],         // ↓ 到 option 2
          session_noask: ["Down", "Down", "Enter"],// ↓↓ 到 option 3
        };
        const labelMap: Record<string, string> = {
          perm_allow: "✅ 已允许",
          perm_allow_session: "✅ 已允许（本会话不再问）",
          perm_deny: "❌ 已拒绝",
          session_summary: "✨ 从摘要恢复",
          session_full: "📜 恢复完整会话",
          session_noask: "🔕 不再询问",
        };
        const keySeq = keySeqMap[action] || ["Enter"];
        const isPermBtn = action.startsWith("perm_");
        const isIdleBtn = action.startsWith("session_");
        console.log(`🔔 弹窗响应: channel=${targetChannelId} action=${action} keys=${keySeq.join(" ")}`);
        try {
          const listResult = await runManager("list");
          const agent = (listResult.agents || []).find((a: any) => a.channelId === targetChannelId);
          if (!agent) {
            await interaction.followUp({ content: "❌ 找不到对应 agent", ephemeral: true }).catch(() => {});
            return;
          }

          // 发键前再确认弹窗还在，避免把 digit+Enter 当成普通消息提交给 Claude
          const pane = await tmuxCapture(windowTarget(agent.name), 30);
          const hasPerm = detectRuntimePermissionPrompt(pane) !== null;
          const hasIdle = detectSessionIdlePrompt(pane) !== null;
          const dialogStillActive = (isPermBtn && hasPerm) || (isIdleBtn && hasIdle);

          if (!dialogStillActive) {
            console.log(`🔔 弹窗已关闭，跳过发键: channel=${targetChannelId} hasPerm=${hasPerm} hasIdle=${hasIdle}`);
            const msgId = permissionMessages.get(targetChannelId);
            if (msgId) {
              try {
                const ch = await discord.channels.fetch(targetChannelId) as TextChannel;
                const sm = await ch.messages.fetch(msgId);
                await sm.edit({ content: `🔕 弹窗已自动关闭，无需操作`, components: [] });
              } catch { /* non-critical */ }
              clearPermissionMessage(targetChannelId);
            }
            return;
          }

          const proc = Bun.spawn(
            ["tmux", "-S", TMUX_SOCK, "send-keys", "-t", `master:${agent.name}`, ...keySeq],
            { stdout: "pipe", stderr: "pipe" }
          );
          await proc.exited;
          if (proc.exitCode !== 0) {
            const stderr = await new Response(proc.stderr).text();
            console.error(`🔔 tmux send-keys 失败: ${stderr}`);
          }

          // 编辑原消息显示已处理（保留指纹让下次 poll 自然清理，避免竞争条件）
          const msgId = permissionMessages.get(targetChannelId);
          if (msgId) {
            try {
              const ch = await discord.channels.fetch(targetChannelId) as TextChannel;
              const sm = await ch.messages.fetch(msgId);
              await sm.edit({ content: `🔔 ${labelMap[action]}`, components: [] });
            } catch { /* non-critical */ }
            permissionMessages.delete(targetChannelId);
          }
        } catch (e) {
          console.error(`🔔 权限响应流程异常:`, e);
        }
        return;
      }

      // v2.0.19+: AskUserQuestion 的 Submit / Cancel 按钮
      if (id.startsWith("auq:")) {
        try {
          const { auqStates, buildAuqKeystrokes, clearAuqState, sendAuqKeys } =
            await import("./bridge/ask-user-question.js");
          const parts = id.split(":");
          const auqChannel = parts[1];
          const action = parts[2];
          const state = auqStates.get(auqChannel);
          if (!state) {
            await interaction.editReply({ content: `⚠️ AskUserQuestion 状态已过期，请等 agent 重新发起。`, components: [] }).catch(() => {});
            return;
          }
          if (action === "submit") {
            // v2.17.2：发键前重验弹窗还在（API answer 端点同款）。新键位模型含数字键，
            // 弹窗已被 TUI 侧应答时盲发会把数字真打进 composer。抓不到 pane 才盲发。
            let auqPane = "";
            try { auqPane = await tmuxCapture(state.tmuxTarget, 40); } catch { /* 跳过重验 */ }
            const auqParse = auqPane ? parseAuqPane(auqPane) : null;
            if (auqPane && !auqParse) {
              clearAuqState(auqChannel);
              emitEvent({ agent: agentNameForChannel(auqChannel) || "master", chatId: auqChannel, type: "question_cleared", data: { reason: "stale", via: "discord" } });
              await interaction.editReply({ content: `⚠️ 弹窗已在终端侧被应答/关闭，本次提交作废。`, components: [] }).catch(() => {});
              return;
            }
            const keys = buildAuqKeystrokes(state, auqParse);
            // 逐键分发（键间 120ms）：批量 send-keys 会被 AUQ 组件吞导航键，答错选项
            if (keys.length > 0) {
              await sendAuqKeys(state.tmuxTarget, keys);
            }
            const summary = state.selections.map((sel, i) => {
              if (sel.length === 0) return `Q${i + 1}: (none)`;
              const labels = sel.map((oi) => state.questions[i].options[oi]?.label || `?${oi}`).join(", ");
              return `Q${i + 1}: ${labels}`;
            }).join("\n");
            await interaction.editReply({
              content: `✅ 已提交 AskUserQuestion 选择：\n${summary}`,
              components: [],
            }).catch(() => {});
            recordMetric("auq_submit", { channelId: auqChannel, meta: { questions: String(state.questions.length) } });
            clearAuqState(auqChannel);
            // 同步收掉 web 端的交互卡
            emitEvent({ agent: agentNameForChannel(auqChannel) || "master", chatId: auqChannel, type: "question_cleared", data: { reason: "submit", via: "discord" } });
          } else if (action === "cancel") {
            await tmuxSendEscape(state.tmuxTarget);
            await interaction.editReply({
              content: `❌ 已取消 AskUserQuestion（发了 Esc 给 agent）`,
              components: [],
            }).catch(() => {});
            recordMetric("auq_cancel", { channelId: auqChannel });
            clearAuqState(auqChannel);
            // 同步收掉 web 端的交互卡
            emitEvent({ agent: agentNameForChannel(auqChannel) || "master", chatId: auqChannel, type: "question_cleared", data: { reason: "cancel", via: "discord" } });
          }
        } catch (e) {
          console.error("AUQ button 处理异常:", e);
        }
        return;
      }

      // 管理按钮
      const mgmtResult = await handleMgmtButton(id, channelId, interaction.message?.id, discord);
      if (mgmtResult) {
        if (mgmtResult.text !== "__HANDLED__") {
          // 走 deliver(bridge → user)：discordReply 内部 buildComponents。
          await deliver({
            from: { kind: "bridge", label: "mgmt-button" },
            to: { kind: "user", userId: interaction.user.id, channelId },
            intent: "notification",
            content: mgmtResult.text,
            meta: {
              messageId: `mgmt_${Date.now()}`,
              triggerKind: "bridge_synth",
              ts: new Date().toISOString(),
              threadId: newThreadId(),
              components: mgmtResult.components,
            },
          });
        }
        return;
      }

      // 未知按钮 → 走 deliver 转发给 LLM，agent 看到 content="[button:<id>]"
      const client = clients.get(channelId);
      if (!client) return;

      // v2.4.15+ UX：点击后清掉原按钮 + 标注"已点击"，**并在底下保留一个"打断"
      // 按钮**，让用户在 agent 处理过程中能随时中断（之前点完按钮就没打断按钮、
      // 一直要等 agent 自己跑完）。把这条 message 登记为本 channel 的当前 status
      // message —— Stop hook 触发时会自动 edit 成"✅ 完成"+ 去掉按钮，跟 typed
      // message 走 messageCreate 那条路径的语义完全一致。
      const clickedMsgId = interaction.message?.id;
      try {
        const label = (interaction.component as any)?.label || id;
        const origContent = interaction.message?.content || "";
        await interaction.editReply({
          content: `${origContent}\n\n✅ 已点击：**${label}**`,
          components: buildComponents(agentActionButtons(channelId, true)),
        }).catch(() => {});
      } catch { /* non-critical */ }

      // 切换 status 簿记到这条点击的消息，旧的清成"✅ 完成"
      stopTyping(channelId);
      clearSafetyTimer(channelId);
      if (statusMessageIdFor(channelId) !== clickedMsgId) {
        await finishStatusMessage(discord, channelId, t("✅ 完成", "✅ Done"));
      }
      if (clickedMsgId) trackStatusMessage(channelId, clickedMsgId);
      resetToolTracking(channelId);
      startTypingWithSafety(channelId);
      await deliver({
        from: { kind: "user", userId: interaction.user.id, channelId, username: interaction.user.username },
        to: { kind: "local", channelId: client.channelId, ws: client.ws, cwd: client.cwd },
        intent: "request",
        content: `[button:${id}]`,
        meta: {
          messageId: interaction.message?.id || `btn_${Date.now()}`,
          triggerKind: "user_discord",
          ts: new Date().toISOString(),
          threadId: newThreadId(),
        },
      });
      return;
    }

    // ── Select Menus ──
    if (interaction.isStringSelectMenu()) {
      const id = interaction.customId;
      const value = interaction.values[0];
      await interaction.deferUpdate().catch(() => {});

      // v2.5.4+ 看板「🧹 存记忆 + Compact」select（value = 目标 agent 的 channelId）
      if (id === "stats_savecompact") {
        await triggerSaveCompact(interaction, value);
        return;
      }

      // v2.0.19+: AskUserQuestion 的 select menu —— 用户选完更新 state，等 Submit 按钮
      // 一并把 selections 翻译成 keystroke 发到 TUI。
      if (id.startsWith("auq:") && /:q\d+$/.test(id)) {
        try {
          const { auqStates } = await import("./bridge/ask-user-question.js");
          const parts = id.split(":");
          const auqChannel = parts[1];
          const qIdxStr = parts[2].slice(1); // q0 -> 0
          const qIdx = parseInt(qIdxStr, 10);
          const state = auqStates.get(auqChannel);
          if (state && Number.isInteger(qIdx) && qIdx >= 0 && qIdx < state.questions.length) {
            // interaction.values 是 string[]，每个是 option index 字符串
            state.selections[qIdx] = interaction.values
              .map((v) => parseInt(v, 10))
              .filter((n) => Number.isInteger(n) && n >= 0 && n < state.questions[qIdx].options.length);
            console.log(`🎛 AUQ Q${qIdx + 1} 选了 ${state.selections[qIdx].length} 项 (channel=${auqChannel})`);
          }
        } catch (e) {
          console.error("AUQ select 处理异常:", e);
        }
        return;
      }

      // TUI modal 选择器
      if (id.startsWith("modal:")) {
        const rest = id.slice("modal:".length);
        // 格式：modal:<targetWindow>:select  —— 最后一段固定是 "select"
        const parts = rest.split(":");
        const targetWindow = parts.slice(0, -1).join(":");
        await handleModalInteraction(interaction, targetWindow, value);
        return;
      }

      const mgmtResult = await handleMgmtSelect(id, value, channelId, discord);
      if (mgmtResult) {
        if (mgmtResult.text !== "__HANDLED__") {
          await deliver({
            from: { kind: "bridge", label: "mgmt-select" },
            to: { kind: "user", userId: interaction.user.id, channelId },
            intent: "notification",
            content: mgmtResult.text,
            meta: {
              messageId: `mgmt_${Date.now()}`,
              triggerKind: "bridge_synth",
              ts: new Date().toISOString(),
              threadId: newThreadId(),
              components: mgmtResult.components,
            },
          });
        }
        return;
      }

      // 未知菜单 → 转发给 LLM。
      // v2.14+ 多选：Discord 的 max_values>1 会一次交回多个值，全部带上（逗号分隔）。
      // 单选保持原样 `[select:id:value]`，agent 侧的老分支不受影响。
      const client = clients.get(channelId);
      if (!client) return;
      startTypingWithSafety(channelId);
      const picked = interaction.values.length > 1
        ? interaction.values.join(",")
        : value;
      client.ws.send(JSON.stringify({
        type: "message",
        content: `[select:${id}:${picked}]`,
        meta: { chat_id: channelId, message_id: interaction.message?.id || "", user: interaction.user.username, user_id: interaction.user.id, ts: new Date().toISOString() },
      }));
      return;
    }
  } catch (err) {
    console.error("❌ Interaction error:", err);
  }
});

// ============================================================
// WebSocket Server — channel-server 实例连接
// ============================================================

async function handleClientMessage(ws: ServerWebSocket<unknown>, raw: string) {
  let msg: any;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }

  // v2.13.1+ 任何来自这条连接的消息都是"它还活着"的证据（keepalive ping 也走这里）。
  // case "register" 的冲突判定靠它区分活连接与僵尸连接。
  for (const info of clients.values()) {
    if (info.ws === ws) {
      info.lastSeen = Date.now();
      break;
    }
  }

  switch (msg.type) {
    case "ping": {
      // v2.2.0+: keepalive。收到本身就重置了 Bun 的 ws idleTimeout；回个 pong
      // 让 channel-server 那侧的 idle 也重置。无需其它处理。
      try { ws.send(JSON.stringify({ type: "pong" })); } catch { /* non-critical */ }
      return;
    }
    case "register": {
      const old = clients.get(msg.channelId);
      if (old && old.ws !== ws) {
        // 顶替语义保持不变：后来者接管。典型场景是 Claude Code 重启了它的 MCP server
        // （旧进程尚未完全退出、ws 还没 close 时新进程已连上），这时新连接才是对的。
        //
        // 2026-07-25 曾误改成"活连接优先"来解决一次主会话失联，但实测证伪：subagent
        // 并不会起自己的 channel-server（它复用父会话的 MCP 连接，jsonl 里的工具列表
        // 只是继承）。真正的现象是 channel-server 被反复重启、Claude Code 重试若干次后
        // 放弃。"活连接优先"会拒掉重启后的正统实例，反而加速耗尽重试次数 —— 已回滚。
        // 这里只保留 idle 时长的诊断输出，便于下次判断旧连接究竟是活的还是僵尸。
        const idleMs = Date.now() - (old.lastSeen ?? 0);
        console.log(
          `🔄 频道 ${msg.channelId} 重新注册 — 主动关闭旧连接（旧连接 ${Math.round(idleMs / 1000)}s 前还在通信）`
        );
        // 主动关闭旧的 ws：发送 "replaced" 通知 + close(**4001**)。
        // v2.2.0+: 用专用 close code 4001（不是 1000）。旧 channel-server 凭 close code
        // 就能判定"被取代 → exit"，不依赖 "replaced" 消息能否赶在 close 前送达（竞态）。
        // 1000 留给"bridge 干净重启"语义（→ channel-server 重连，不退出）。
        try {
          old.ws.send(JSON.stringify({ type: "replaced", reason: "channel re-registered" }));
        } catch { /* non-critical */ }
        try {
          old.ws.close(4001, "replaced by newer registration");
        } catch { /* non-critical */ }
      }
      clients.set(msg.channelId, {
        ws,
        channelId: msg.channelId,
        userId: msg.userId,
        cwd: msg.cwd,
        lastSeen: Date.now(),
      });
      console.log(`📌 注册频道: ${msg.channelId} (共 ${clients.size} 个)`);
      ws.send(JSON.stringify({ type: "registered", channelId: msg.channelId }));

      // 启动 JSONL watcher（仅用于 tool use 流式展示，空闲检测由 hooks 处理）。
      // create 路径 race：register 先于 manager 落 registry（create 到第 6 步才写），
      // 单次 lookup 必落空且 catch 静默 → 新建 agent 直到下次 bridge/agent 重启都
      // 没有 watcher（2026-07-14 test-compact 实锤）。改成短轮询等 registry 出现，
      // 5s×12 上限；restart 路径 registry 已在，首轮即命中，行为不变。
      if (msg.channelId !== CONTROL_CHANNEL_ID) {
        void (async () => {
          for (let i = 0; i < 12; i++) {
            try {
              const regResult = await runManager("list");
              const agent = (regResult.agents || []).find((a: any) => a.channelId === msg.channelId);
              if (agent?.sessionId && agent?.project) {
                const cwd = agent.project.replace(/^~/, process.env.HOME || "~");
                startWatching(agent.name, cwd, agent.sessionId, msg.channelId, discord);
                return;
              }
            } catch { /* registry 竞写等瞬时错，下一轮再试 */ }
            await new Promise((r) => setTimeout(r, 5000));
          }
          console.warn(`⚠️ register 后 60s registry 仍无此频道的 agent，放弃挂 watcher: ${msg.channelId}`);
        })();
      } else {
        // 大总管走单独一条：它不在 registry，sessionId 从 MASTER_DIR 的 projects
        // 目录里取最新的那个 jsonl（详见 syncMasterWatcher 上方的注释）。
        syncMasterWatcher(discord);
      }

      break;
    }

    case "reply": {
      // v1.9.24+: 在任何 await 之前先删 pending。这样即使 Stop hook 在我们还在
      // 打 Discord API 的时候到达，后面的 cleanup 路径不会误触发。
      pendingReplies.delete(msg.chatId);

      try {
        const text = msg.text?.replace(/\s*\[DONE\]\s*$/, "") || msg.text || "";

        // v2.0.0 Phase 4d: reply 从 discordReply 直接调改成构造 envelope 过 deliver。
        // from=local（发 reply 的这个 agent），to 根据 chat_id 判断 user / api。
        let fromChannelId = "";
        for (const [chId, info] of clients.entries()) {
          if (info.ws === ws) { fromChannelId = chId; break; }
        }
        // v2.14+ 兜底通道（src/discord-reply.ts）不是注册过的 channel-server，ws 反查
        // 必然落空。它会在消息里自报 channelId（来自 Claude Code 注入的
        // DISCORD_CHANNEL_ID）—— 没有这个身份，下游 deliverToApi 会用空 key 去找等待
        // 中的 HTTP 请求（永远匹配不上）、并把 SSE 事件的 agent 填成字面 "?"，前端
        // 于是既不显示也不结束等待,而调用方还收到一个「成功」的空结果。
        // 2026-07-25 一整条带按钮的消息就是这样丢掉的。
        // 信任边界：ws 已限制同源 + 默认只绑 127.0.0.1，本机进程与 channel-server 同级。
        if (!fromChannelId && typeof msg.fromChannelId === "string") {
          fromChannelId = msg.fromChannelId;
        }
        if (!fromChannelId) {
          // 认不出来源就明确失败,绝不静默投给 "?"。
          ws.send(JSON.stringify({
            type: "response",
            requestId: msg.requestId,
            error: "reply 无法确定来源 agent（连接未注册且未提供 fromChannelId），已拒绝投递",
          }));
          break;
        }
        if (fromChannelId) {
          // v2.0.16+: agent 调了 reply()（任意频道）= 它在回应/行动，清掉 inter-agent
          // 看门狗，Stop hook 不会再 nudge。清这个 ws 名下所有 channel key。
          for (const [chId, info] of clients.entries()) {
            if (info.ws === ws && pendingInterAgentMsg.delete(chId)) {
              console.log(`✅ inter-agent 看门狗清掉（${chId} 调了 reply()）`);
            }
          }
        }
        const fromEndpoint: RouterLocalEndpoint = {
          kind: "local",
          channelId: fromChannelId,
          ws,
        };
        const toEndpoint = await resolveReplyTarget(msg.chatId);
        const env: RouterEnvelope = {
          from: fromEndpoint,
          to: toEndpoint,
          intent: "response",
          content: text,
          meta: {
            messageId: `reply_${Date.now()}`,
            triggerKind: "agent_tool",
            ts: new Date().toISOString(),
            threadId: newThreadId(),
            replyTo: msg.replyTo,
            components: msg.components,
            files: msg.files,
          },
        };
        const delivery = await deliver(env);
        if (delivery.outcome.kind !== "sent") {
          const errMsg = delivery.outcome.kind === "dropped"
            ? `reply dropped: ${delivery.outcome.reason}`
            : (delivery.outcome as any).error?.message || "unknown";
          ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, error: errMsg }));
          break;
        }
        const ids = delivery.outcome.discordMessageIds || [];
        ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, result: { messageIds: ids } }));

        // v2.6.0+ 事件埋点：agent 的正式回复镜像（out）
        // api: 目的地跳过——deliverToApi 已统一埋点（带 threadId/api 标记），
        // 这里再发就是同一条回复的重复事件（web 前端会渲染两遍）。
        if (parseChatId(msg.chatId).transport !== "api") {
          const evAgent = agentLabelForChannel(fromChannelId);
          emitEvent({ agent: evAgent, chatId: msg.chatId, type: "chat_message", data: { direction: "out", from: evAgent, text, threadId: env.meta.threadId, ...(msg.components ? { components: msg.components } : {}) } });
        }

        // v1.9.21+ send_to_agent 推回机制：
        // 如果 reply 的 chat_id 正好是某个 pending send_to_agent 的 target agent 的
        // channel，说明 agent 在它自己的 channel 里发了答案（discord 看得到，供审计）；
        // bridge 同时把这段 text push 回 caller 的 ws 作为合成消息，caller 不用再轮询。
        //
        // v2.0.0 Phase 4b：这条推回从直接 pending.callerWs.send 改成 deliver(envelope)。
        // from=local(target agent), to=local(caller agent), intent=response。
        // renderContentForLocal 的 from.kind==="local" 分支会拼 "[🤖 来自 <name>]"
        // 前缀（原来写的是 "[🤖 target 回复]"，语义等价 —— 都是标识"这条是别的
        // agent 发来的 response"）。
        const pending = pendingAgentCalls.get(msg.chatId);
        if (pending) {
          try {
            // v2.0.1+: from.channelId 用 originalReplyChannel（caller 手头的
            // 原 inbound 请求频道）而不是 target 的私频。
            // resolveReplyBackChannel 对 from.kind=local 返回 from.channelId，
            // pushback 的 meta.chat_id 就会是原频道，caller LLM 顺手回就对了。
            // 没有 originalReplyChannel 时回退到 msg.chatId（target 私频）—
            // 这是旧行为，保守兜底。
            const replyBackHint = pending.originalReplyChannel || msg.chatId;
            const cleanedReply = text.replace(/<@!?\d+>\s*/g, "").trim();
            // v2.0.12+: 如果 caller 当时填了 `expecting`，在 push 的最前面注入
            // 一段提醒，让 caller LLM 不靠"自己记得"也知道这次答复后该续什么动作。
            const pushBody = pending.expecting
              ? `[💡 你之前 send_to_agent 给 ${pending.targetName} 时填的期望：${pending.expecting}\n对方答复如下，请按计划继续，不要只 relay 给用户。]\n\n${cleanedReply}`
              : cleanedReply;
            const pushEnv: RouterEnvelope = {
              from: {
                kind: "local",
                agentName: pending.targetName,
                channelId: replyBackHint,
                ws,
              },
              to: {
                kind: "local",
                agentName: pending.callerName,
                channelId: pending.callerChannelId,
                ws: pending.callerWs,
              },
              intent: "response",
              content: pushBody,
              meta: {
                messageId: `agent_reply_${Date.now()}`,
                triggerKind: "agent_tool",
                ts: new Date().toISOString(),
                threadId: newThreadId(),
              },
            };
            const delivery = await deliver(pushEnv);
            if (delivery.outcome.kind === "sent") {
              lastMessageSource.set(pending.callerChannelId, "agent");
              console.log(`📨 AGENT PUSH-BACK: ${pending.targetName} 回复 → push 给 caller=${pending.callerChannelId} (免去 fetch_messages 轮询)`);
              recordMetric("agent_pushback", { channelId: pending.callerChannelId, meta: { targetName: pending.targetName } });
            } else if (delivery.outcome.kind === "error") {
              console.error("AGENT PUSH-BACK 发送失败:", delivery.outcome.error);
            }
          } catch (e) {
            console.error("AGENT PUSH-BACK 异常:", e);
          }
          pendingAgentCalls.delete(msg.chatId);
        }
      } catch (err) {
        ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, error: (err as Error).message }));
      }
      break;
    }

    case "ask_codex": {
      // v2.20+ agent → 本机 Codex(ChatGPT.app CLI,订阅额度)。per-call spawn,
      // 零常驻;并发上限防 agent 集体轰配额;结果同步回 MCP 工具调用。
      // 调用过程本身在 jsonl-watcher 流里可见(工具卡),无需额外镜像。
      try {
        if (codexInflight >= CODEX_MAX_INFLIGHT) {
          ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, error: `Codex 并发已满(${CODEX_MAX_INFLIGHT} 路在跑),稍后再试。` }));
          break;
        }
        const sandbox = CODEX_SANDBOXES.includes(msg.sandbox) ? (msg.sandbox as CodexSandbox) : undefined;
        codexInflight++;
        console.log(`🧠 ask_codex from=${msg.fromChannel || "?"} thread=${msg.thread || "-"} sandbox=${sandbox || "read-only"} promptLen=${String(msg.prompt || "").length}`);
        recordMetric("ask_codex", { channelId: String(msg.fromChannel || ""), meta: { thread: String(msg.thread || "") } });
        runCodex({
          prompt: String(msg.prompt || ""),
          thread: msg.thread ? String(msg.thread) : undefined,
          cwd: msg.cwd ? String(msg.cwd) : undefined,
          sandbox,
        })
          .then((result) => {
            console.log(`🧠 ask_codex 完成 ok=${result.ok} ${Math.round(result.elapsedMs / 1000)}s thread=${result.thread || "-"}`);
            ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, result }));
          })
          .catch((err) => {
            ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, error: (err as Error).message }));
          })
          .finally(() => {
            codexInflight--;
          });
      } catch (err) {
        ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, error: (err as Error).message }));
      }
      break;
    }

    case "fetch_messages": {
      try {
        // v2.6.0+ C2-2：这仨工具是 Discord 语义。api:/telegram: 会话没有"消息
        // 历史/表情/编辑"的等价物 —— 明确报错，别让 agent 拿到静默失败瞎猜。
        const dest = parseChatId(String(msg.channel || ""));
        if (dest.transport !== "discord") {
          ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, error: `fetch_messages 仅支持 Discord 会话（收到 ${dest.transport}: 前缀地址）。API 会话请直接 reply，对方消息会作为新的 user 消息进来。` }));
          break;
        }
        const result = await discordFetchMessages(discord, dest.id, msg.limit);
        ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, result }));
      } catch (err) {
        ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, error: (err as Error).message }));
      }
      break;
    }

    case "react": {
      try {
        const dest = parseChatId(String(msg.chatId || ""));
        if (dest.transport !== "discord") {
          ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, error: `react 仅支持 Discord 会话（收到 ${dest.transport}: 前缀地址），非 Discord 会话无表情语义，直接 reply 即可。` }));
          break;
        }
        await discordReact(discord, dest.id, msg.messageId, msg.emoji);
        ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, result: { ok: true } }));
      } catch (err) {
        ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, error: (err as Error).message }));
      }
      break;
    }

    case "edit_message": {
      try {
        const dest = parseChatId(String(msg.chatId || ""));
        if (dest.transport !== "discord") {
          ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, error: `edit_message 仅支持 Discord 会话（收到 ${dest.transport}: 前缀地址），API 会话的消息发出后不可编辑，需更正就再 reply 一条。` }));
          break;
        }
        await discordEditMessage(discord, dest.id, msg.messageId, msg.text);
        ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, result: { ok: true } }));
      } catch (err) {
        ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, error: (err as Error).message }));
      }
      break;
    }

    case "create_channel": {
      try {
        // v2.6.0+ C2-5：会话地址供给走 adapter（ws 消息类型保留老名字做协议兼容）。
        // 将来纯 API agent = 换一个 provisioner，manager create 流程零改动。
        // Web-only: 无 Discord 时由 local adapter 供给 local-* 合成地址
        const adapter = adapterFor(WEB_ONLY ? "local" : "discord");
        if (!adapter?.provisionConversation) throw new Error("adapter 不支持 provisionConversation");
        const { chatId: channelId } = await adapter.provisionConversation(msg.name, { category: msg.category });
        ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, result: { channelId } }));
      } catch (err) {
        ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, error: (err as Error).message }));
      }
      break;
    }

    case "delete_channel": {
      try {
        // Web-only: local-* 合成地址没有平台面，删除是 no-op
        if (!String(msg.channelId || "").startsWith("local-")) {
          await discordDeleteChannel(discord, msg.channelId);
        }
        ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, result: { ok: true } }));
      } catch (err) {
        ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, error: (err as Error).message }));
      }
      break;
    }

    case "rename_channel": {
      try {
        // Web-only: local-* 合成地址没有平台面，重命名是 no-op
        if (String(msg.channelId || "").startsWith("local-")) {
          ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, result: { ok: true } }));
          break;
        }
        const ch = await discord.channels.fetch(msg.channelId);
        if (!ch || !("setName" in ch)) throw new Error("channel 不存在或不可重命名");
        await (ch as TextChannel).setName(msg.name);
        ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, result: { ok: true } }));
      } catch (err) {
        ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, error: (err as Error).message }));
      }
      break;
    }

    case "announce_focus": {
      // v2.4.19+ manager create/resume 后调：在 agent 频道发一条置顶公告，带
      // 「🖥 跳到 iTerm tab」按钮（focus:<channelId>，LLM-free 直接执行）。
      // v2.4.20+ 主推 /focus slash 命令 —— pin 弹窗里的按钮 Discord 点不动，得
      // 先跳到消息才行。公告文案改成引导用 /focus，按钮留作从消息本体点的备选。
      // 返回 messageId 给 manager 存 registry，避免 restart 重复发。
      try {
        const annChannelId = msg.channelId as string;
        const annAgentName = msg.agentName as string;
        // Web-only: local-* 地址没有 Discord 频道，公告是 no-op
        if (annChannelId.startsWith("local-")) {
          ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, result: { ok: true, messageId: "" } }));
          break;
        }
        const ids = await discordReply(
          discord,
          annChannelId,
          `📌 **${annAgentName}** 控制台\n-# 在本频道输入 \`/focus\` 即可把 Mac 的 iTerm 切到这个 agent 的 tab（下面的按钮从 pin 弹窗里点不动，用 /focus 更省事）`,
          undefined,
          [{
            type: "buttons",
            buttons: [
              { id: `focus:${annChannelId}`, label: "🖥 跳到 iTerm tab", style: "primary" },
            ],
          }],
        );
        const annMsgId = ids[ids.length - 1];
        // pin 失败不算错（权限不够时公告仍在，只是没置顶）
        try {
          const ch = await discord.channels.fetch(annChannelId);
          if (ch && "messages" in ch) {
            const m = await (ch as TextChannel).messages.fetch(annMsgId);
            await m.pin();
          }
        } catch (e) {
          console.warn(`📌 announce_focus pin 失败（公告已发未置顶）: ${(e as Error).message}`);
        }
        ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, result: { messageId: annMsgId } }));
      } catch (err) {
        ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, error: (err as Error).message }));
      }
      break;
    }

    case "list_channels": {
      // 列出本 bot 能看到的所有文字频道。用于跨 Claudestra 场景：
      // peer 的 agent 自己看我这边有哪些频道、topic 是什么、该去哪里 @ 我的 bot。
      try {
        const channels: any[] = [];
        for (const [_, ch] of discord.channels.cache) {
          // 只要能发消息的文字频道（TextChannel type = 0）
          if (ch.type !== 0) continue;
          const textCh = ch as TextChannel;
          channels.push({
            id: textCh.id,
            name: textCh.name,
            topic: textCh.topic || "",
            guild: textCh.guild?.name || "",
            guild_id: textCh.guild?.id || "",
          });
        }
        ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, result: { channels } }));
      } catch (err) {
        ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, error: (err as Error).message }));
      }
      break;
    }

    case "move_channel": {
      // v2.21+ project-assign 时频道随归属挪 category。web-only(local-*)无平台面,no-op
      try {
        if (!WEB_ONLY && !String(msg.channelId || "").startsWith("local-")) {
          await discordMoveChannel(discord, msg.channelId, String(msg.category || ""));
        }
        ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, result: { ok: true } }));
      } catch (err) {
        ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, error: (err as Error).message }));
      }
      break;
    }

    case "project_info": {
      // v2.21+ Phase 2:agent 自查项目归属——成员(在线状态/purpose)+ 目录。
      // master / 未归属 agent 拿到的是全部 project 的总览(它们是跨项目视角)。
      try {
        let fromChannelId = "";
        for (const [chId, info] of clients.entries()) {
          if (info.ws === ws) { fromChannelId = chId; break; }
        }
        const [{ projects }, regs] = await Promise.all([readProjects(), readRegistryAgents()]);
        const online = (channelId?: string) => !!(channelId && clients.has(channelId));
        const membersOf = (pid: string) =>
          regs
            .filter((r) => r.projectId === pid)
            .map((r) => ({
              name: r.name,
              purpose: r.purpose || "",
              status: r.status || "unknown",
              online: online(r.channelId),
            }));
        const self = regs.find((r) => r.channelId === fromChannelId);
        const myProj = self?.projectId ? projects.find((p) => p.id === self.projectId) : null;
        const result = myProj
          ? {
              scope: "project",
              self: self!.name,
              project: {
                id: myProj.id, name: myProj.name, emoji: myProj.emoji || null,
                dirs: myProj.dirs, description: myProj.description || null,
                members: membersOf(myProj.id),
              },
            }
          : {
              scope: "all",
              self: self?.name || (fromChannelId === CONTROL_CHANNEL_ID ? "master" : null),
              projects: projects.map((p) => ({
                id: p.id, name: p.name, emoji: p.emoji || null, dirs: p.dirs,
                description: p.description || null, members: membersOf(p.id),
              })),
            };
        ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, result }));
      } catch (err) {
        ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, error: (err as Error).message }));
      }
      break;
    }

    case "route_to_agent": {
      try {
        // 找发送方的 channelId
        let fromChannelId = "";
        let fromName = msg.fromName || "";
        for (const [chId, info] of clients.entries()) {
          if (info.ws === ws) { fromChannelId = chId; break; }
        }
        // v2.0.16+: agent 调了 send_to_agent = 它在行动/回应，清掉 inter-agent 看门狗。
        // 清这个 ws 名下所有 channel key。
        for (const [chId, info] of clients.entries()) {
          if (info.ws === ws && pendingInterAgentMsg.delete(chId)) {
            console.log(`✅ inter-agent 看门狗清掉（${chId} 调了 send_to_agent）`);
          }
        }

        // v1.9.22+: 解析 target，支持 peer: 语法：
        //   "future_data"                        → 本地 agent-future_data
        //   "peer:ahh.future_data"               → 跨 peer（HTTP transport）
        //   "future_data@ahh"                    → 同上（短格式）
        const rawTarget = (msg.targetName as string) || "";
        const peerMatch = rawTarget.match(/^peer:([^.]+)\.(.+)$/) || rawTarget.match(/^([^@]+)@(.+)$/);
        if (peerMatch) {
          const [, first, second] = peerMatch;
          const peerIdentifier = rawTarget.startsWith("peer:") ? first : second;
          const peerAgentName = rawTarget.startsWith("peer:") ? second : first;
          // v2.11+: peers.json httpPeers 名字命中即走 HTTP transport
          {
            const { findHttpPeer } = await import("./lib/peers.js");
            const httpPeer = await findHttpPeer(peerIdentifier);
            // 握手未完成(invite 后等回执的窗口,缺 outToken/baseUrl)会落到下面的
            // 未知 peer 报错,提示里带已配置列表
            if (httpPeer && httpPeer.outToken && httpPeer.baseUrl) {
              const { routeToHttpPeer } = await import("./bridge/http-peer.js");
              const result = routeToHttpPeer(
                ws, fromChannelId, fromName, httpPeer, peerAgentName,
                String(msg.text || ""),
                typeof msg.expecting === "string" ? msg.expecting.trim() || undefined : undefined,
                msg.oneShot === true, // v2.17.2 任务#85:FYI 不挂 2h 轮询/超时推回
              );
              ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, result }));
              console.log(`🌐 HTTP PEER ROUTE: ${fromName} → ${httpPeer.name}/${peerAgentName} (${httpPeer.baseUrl})`);
              return;
            }
          }
          // v2.11: Discord peer 已移除——HTTP peers 没命中即未知 peer;
          // 命中但凭据不全 = 握手进行中,报错要区分(review 2026-07-20 #6)
          {
            const { readPeers } = await import("./lib/peers.js");
            const all = (await readPeers()).httpPeers || [];
            const half = all.find((pp) => pp.name === peerIdentifier && !pp.disabled);
            const err = half
              ? `HTTP peer "${peerIdentifier}" 握手未完成(${!half.baseUrl ? "还没收到对方回执" : "缺 outToken"})——等 owner 跑完 peer-http-accept 再试`
              : `未知 peer "${peerIdentifier}"。已配置的 HTTP peers: ${all.filter((pp) => !pp.disabled).map((pp) => pp.name).join(", ") || "(无——用 peer-http-invite 添加)"}`;
            ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, error: err }));
          }
          return;
        }

        // 从 registry 找目标 agent
        const regResult = await runManager("list");
        const agents: any[] = regResult.agents || [];

        // 补全发送方名字。CONTROL_CHANNEL_ID 不在 registry（master 不是常规
        // agent），特判成 "master"；worker 查 registry；都找不到才回退到
        // channelId（理论上进不到这里，写个兜底）。
        if (!fromName && fromChannelId) {
          if (fromChannelId === CONTROL_CHANNEL_ID) {
            fromName = "master";
          } else {
            const fromAgent = agents.find((a: any) => a.channelId === fromChannelId);
            fromName = fromAgent?.name || fromChannelId;
          }
        }

        const targetName = rawTarget.startsWith("agent-") ? rawTarget : `agent-${rawTarget}`;
        const target = agents.find((a: any) => a.name === targetName);
        if (!target) {
          ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, error: `Agent '${targetName}' 不存在或未在 registry 中` }));
          break;
        }

        const targetClient = clients.get(target.channelId);
        if (!targetClient) {
          ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, error: `Agent '${targetName}' 未连接到 Bridge（可能已停止）` }));
          break;
        }

        // v2.0.0 Phase 4: 通过 deliver(envelope) 注入消息。
        // from=local(caller agent), to=local(target agent)。renderContentForLocal
        // 看到 from.kind=="local" 会自动拼 "[🤖 来自 fromName]" 前缀。
        const fromEnv: RouterLocalEndpoint = {
          kind: "local",
          agentName: fromName,
          channelId: fromChannelId,
          ws,
        };
        const toEnv: RouterLocalEndpoint = {
          kind: "local",
          agentName: targetName,
          channelId: target.channelId,
          ws: targetClient.ws,
          cwd: targetClient.cwd,
        };
        // v2.4.16+ oneShot=true：fire-and-forget，跳 pushback 和 watchdog。
        const oneShot = msg.oneShot === true;
        const env: RouterEnvelope = {
          from: fromEnv,
          to: toEnv,
          intent: "request",
          content: msg.text || "",
          meta: {
            messageId: `agent_${Date.now()}`,
            triggerKind: "agent_tool",
            ts: new Date().toISOString(),
            threadId: newThreadId(),
            skipInterAgentWatchdog: oneShot || undefined,
          },
        };
        const delivery = await deliver(env);
        if (delivery.outcome.kind !== "sent") {
          const reason = delivery.outcome.kind === "dropped" ? delivery.outcome.reason : String((delivery.outcome as any).error);
          ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, error: `deliver 失败: ${reason}` }));
          break;
        }

        // v1.9.6+: send_to_agent 触发的 turn 不发完成 @（用户没在这个 channel 问问题）
        lastMessageSource.set(target.channelId, "agent");

        // v1.9.21+: 记 pending agent call。当 target agent 下一次 reply 到自己 channel
        // 时，bridge 把那段 text 也 push 回 caller 的 ws（免 fetch_messages 轮询）。
        //
        // v2.0.1+: 同时推断 originalReplyChannel —— caller 手头正在处理的
        // inbound 请求的 intendedReplyChannel。pushback 用它做 meta.chat_id，
        // caller LLM 就不会错用 target 的私频当作回复目标（Bug 2 修复）。
        //
        // v2.4.16+: 支持 oneShot=true —— fire-and-forget 模式，不挂 pending（不会
        // pushback），同时下游 deliverToLocal 跳过给 target 挂 pendingInterAgentMsg
        // watchdog。用于 status sync / ack / FYI 等 agent 之间不期待回应的消息。
        if (fromChannelId && !oneShot) {
          let originalReplyChannel: string | undefined;
          for (const [, p] of pendingReplies.entries()) {
            if (p.targetWs === ws) {
              originalReplyChannel = p.intendedReplyChannel;
              break;
            }
          }
          pendingAgentCalls.set(target.channelId, {
            callerChannelId: fromChannelId,
            callerWs: ws,
            callerName: fromName,
            targetName,
            originalReplyChannel,
            expecting: typeof msg.expecting === "string" ? msg.expecting.trim() || undefined : undefined,
            ts: Date.now(),
          });
        }

        ws.send(JSON.stringify({
          type: "response",
          requestId: msg.requestId,
          result: {
            ok: true,
            targetChannelId: target.channelId,
            targetName,
            pushBack: !oneShot,
          },
        }));
      } catch (err) {
        ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, error: (err as Error).message }));
      }
      break;
    }
  }
}

// ============================================================
// 启动
// ============================================================

// ── Hook HTTP 处理 ──
// channelId → 最近一次完成通知时间戳，用于去抖
const lastCompletionSent = new Map<string, number>();
// v1.9.6+: 记录每个 channel 的最近一次消息触发源。如果是 "agent"（send_to_agent 转发）
// 那次 turn 结束时就不发完成 @ — 用户没问问题，不用通知他。
// v2.10+ "api"(owner 2026-07-16「谁发的谁回」):Web 端触发的回合不发 Discord @
// 推送(内容 mirror 照旧,用户在 Web 上收;未来 Web push 反向同理——Discord 触发
// 的回合不打 Web 推送,本 map 就是两边共用的分流依据)。
/**
 * v2.11.x: lastMessageSource 持久化——「web 消息 Discord 还 @」第三次根治
 * (2026-07-20)。此前的 jsonl 尾部推断有 256KB 窗口:一个 25 分钟长回合写了
 * 271KB 工具结果,把入站消息挤出窗口 → 推断失败 → 回落默认误 @(实锤)。
 * 持久态与窗口彻底解耦:set 节流 300ms 原子落盘,bridge 重启同步读回;
 * jsonl 推断降级为「文件丢失/新频道」的兜底。
 */
class PersistedSourceMap extends Map<string, "user" | "agent" | "api"> {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly path = `${process.env.HOME}/.claude-orchestrator/msg-source.json`;
  /**
   * 「最后一个**人类**是从哪儿来的」——只记 user / api，不被 agent 覆盖。
   *
   * 主 map 的语义是「最后一条入站消息的来源」，而入站消息包括 agent→agent 转发、
   * HTTP peer pushback、看门狗 nudge 等机器注入，它们都会把值刷成 "agent"。用它
   * 判断「该不该打扰 Web 用户」会失准：2026-07-25 实测，一个纯 Web 会话的值是
   * "agent"，bg 子区照样建到了 Discord。
   * 内存态即可：bridge 重启后为空 → 回落到「建子区」的老行为（保守方向），
   * 下一条人类消息进来就恢复。
   */
  private humanSources = new Map<string, "user" | "api">();
  constructor() {
    super();
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as Record<string, unknown>;
      for (const [k, v] of Object.entries(raw)) {
        if (v === "user" || v === "agent" || v === "api") super.set(k, v);
      }
    } catch {
      /* 首次运行/文件损坏——空表启动,靠推断兜底 */
    }
  }
  override set(k: string, v: "user" | "agent" | "api"): this {
    super.set(k, v);
    if (v === "user" || v === "api") this.humanSources.set(k, v);
    this.scheduleFlush();
    return this;
  }
  /** 最后一次人类交互的来源；从没有过人类消息则 undefined */
  lastHuman(k: string): "user" | "api" | undefined {
    return this.humanSources.get(k);
  }
  private scheduleFlush() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const tmp = `${this.path}.tmp.${process.pid}`;
      try {
        writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.entries())));
        renameSync(tmp, this.path);
      } catch {
        /* best-effort:落盘失败退化回内存态,不影响主流程 */
      }
    }, 300);
  }
}
const lastMessageSource = new PersistedSourceMap();
const COMPLETION_DEDUPE_MS = 10_000; // 10 秒内不重复发完成通知

/**
 * bridge 重启后 lastMessageSource 内存清零——重启后的第一个回合会误判成
 * 「user 触发」照发 Discord @(2026-07-16 两次真机撞上:Web 对话结束仍被 @)。
 * 兜底:从 agent 的 session jsonl 尾部推断最后一条 inbound 的来源——Web/API
 * 消息的注入头「[🌐 来自」是持久痕迹,重启也丢不了。只在 map 查不到时读盘,
 * 结果回填 map,同频道后续 Stop 不再读。
 */
async function inferInboundSourceFromJsonl(channelId: string): Promise<"api" | undefined> {
  try {
    let cwd: string | undefined;
    let sessionId: string | undefined;
    if (channelId === CONTROL_CHANNEL_ID) {
      cwd = MASTER_DIR;
      sessionId = latestSessionIdForCwd(cwd);
    } else {
      const reg = (await readRegistryAgents()).find((a) => a.channelId === channelId);
      cwd = reg?.cwd;
      sessionId = reg?.sessionId;
    }
    if (!cwd || !sessionId) return undefined;
    const f = Bun.file(projectJsonlPath(cwd, sessionId));
    const size = f.size;
    if (!size) return undefined;
    const start = Math.max(0, size - 256 * 1024);
    const lines = (await f.slice(start, size).text()).split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"type":"user"')) continue;
      try {
        const e = JSON.parse(lines[i]);
        if (e.type !== "user") continue;
        const c = e.message?.content;
        const txt =
          typeof c === "string"
            ? c
            : Array.isArray(c)
              ? c.map((b: { text?: string }) => b?.text ?? "").join("\n")
              : "";
        if (!txt.trim() || /^\[Request interrupted/.test(txt)) continue; // 工具结果/中断标记不是 inbound
        // 双信号:channel 标签的 chat_id="api: 属性(机器化,最稳)或注入头文案
        return txt.includes('chat_id="api:') || txt.includes("[🌐 来自") ? "api" : undefined;
      } catch {
        /* 跨 chunk 断行 */
      }
    }
  } catch {
    /* 文件不存在等 → 未知 */
  }
  return undefined;
}

/**
 * v2.0.0 Phase 4d: 根据 agent reply 传的 chat_id 反推目标 endpoint：
 *   1. `api:<tokenId>` 前缀 → API 用户
 *   2. 其他（agent 自己频道 / #control）→ UserEndpoint with ALLOWED_USER_IDS[0]
 *      作为 userId。deliverToUser 不自动 @ user（push 通知在 Stop hook 完成通知
 *      里另管）。
 */
async function resolveReplyTarget(chatId: string): Promise<RouterUserEndpoint | RouterApiUserEndpoint> {
  // v2.6.0+ 虚拟 chat_id `api:<tokenId>`（统一 keyspace D7）→ API 用户
  const parsed = parseChatId(chatId);
  if (parsed.transport === "api") {
    let name = parsed.id;
    try {
      const file = await readPrincipals();
      const p = file.principals.find((x) => x.id === `token:${parsed.id}`);
      if (p?.name) name = p.name;
    } catch { /* 名字仅展示用，查不到就用 tokenId */ }
    return { kind: "api", tokenId: parsed.id, name };
  }
  // user channel
  const userId = primaryOwnerId();
  return { kind: "user", userId, channelId: chatId };
}

/**
 * v1.9.28+ bridge 重启后清理残留的"💭 大聪明思考中..."按钮消息。
 * 在 ready 事件里跑：扫每个 registered channel 的近期消息，把我方 bot 发的
 * 以 💭 开头、还带 components（interrupt 按钮）的消息编辑成"bridge 重启了"，
 * 避免用户看到永远转圈的思考中 UI。
 */
async function cleanupStaleThinkingMessages(): Promise<void> {
  try {
    // 收集需要扫的 channel：master CONTROL + 所有 agent 频道
    const channelIds = new Set<string>();
    if (CONTROL_CHANNEL_ID) channelIds.add(CONTROL_CHANNEL_ID);
    try {
      const listResult = await runManager("list");
      for (const a of listResult.agents || []) {
        if (a.channelId) channelIds.add(a.channelId);
      }
    } catch { /* non-critical */ }

    const myBotId = getBotUserId();
    let cleaned = 0;
    for (const cid of channelIds) {
      try {
        const ch = await discord.channels.fetch(cid).catch(() => null);
        if (!ch || !("messages" in ch)) continue;
        const recent = await (ch as TextChannel).messages.fetch({ limit: 20 }).catch(() => null);
        if (!recent) continue;
        for (const [, msg] of recent) {
          // 只改我方 bot 的、以 💭 开头、还带按钮（未 Stop 编辑过）的消息
          if (msg.author.id !== myBotId) continue;
          if (!msg.content?.startsWith("💭")) continue;
          if (!msg.components || msg.components.length === 0) continue; // 已经被 Stop 清了
          try {
            await msg.edit({
              content: t(
                "⚠️ bridge 重启了，上一轮任务状态丢失。如果你的请求没完成，重新发一次就好。",
                "⚠️ Bridge restarted — previous task state is lost. If your request didn't complete, please send it again.",
              ),
              components: [],
            });
            cleaned++;
          } catch { /* non-critical */ }
        }
      } catch { /* non-critical */ }
    }
    if (cleaned > 0) {
      console.log(`🧹 启动清理：修复了 ${cleaned} 条遗留的"💭 思考中..."消息（bridge 重启前卡住的）`);
      recordMetric("bridge_start_cleanup", { meta: { cleaned: String(cleaned) } });
    }
  } catch (e) {
    console.error("cleanupStaleThinkingMessages 异常:", e);
  }
}


/** v1.9.21+ 每分钟扫一次，清超过 10min 仍未被 agent 回复消化的 pendingAgentCalls。
 * 正常情况下 agent 会在几十秒内回 → 被 reply handler 清掉。残留条目只会发生在
 * agent 挂了 / 忘了回 / fetch_messages 被用户取消等极端场景。留太多占内存。 */
setInterval(() => {
  const now = Date.now();
  const STALE_MS = 10 * 60_000;
  for (const [channelId, pending] of pendingAgentCalls.entries()) {
    if (now - pending.ts > STALE_MS) {
      pendingAgentCalls.delete(channelId);
      console.log(`🧹 pendingAgentCalls stale: 清掉 target=${pending.targetName} (caller=${pending.callerName})`);
    }
  }
  // v2.6.0+ API 会话状态 TTL（10min）：pending 请求、轮询结果、附件登记
  sweepApiState(now);
  // v2.13.1+ pendingThreads 也要扫。它是唯一一个既不在这里清扫、也不在 ws close
  // 里清理的 Map —— 正常路径靠 response 或 Stop hook 精确删除，但任何异常收尾
  // （agent 崩溃、被 kill、/clear 打断回合、裸 tmux kill-window）都会永久留下一条，
  // 而每条 value 都钉着整个请求 envelope（完整用户文本 + 附件）和一个死掉的 ws。
  // 30min 是给最长的回合留足余量，正常 thread 活不过几分钟。
  const THREAD_STALE_MS = 30 * 60_000;
  for (const [tid, t] of pendingThreads.entries()) {
    if (now - t.ts > THREAD_STALE_MS) {
      pendingThreads.delete(tid);
      console.log(`🧹 pendingThreads stale: 清掉 ${tid}（超 ${THREAD_STALE_MS / 60_000}min 未收尾）`);
    }
  }
  for (const [channelId, pending] of pendingInterAgentMsg.entries()) {
    if (now - pending.ts > STALE_MS) {
      pendingInterAgentMsg.delete(channelId);
      console.log(`🧹 pendingInterAgentMsg stale: 清掉 ${channelId}（来自 ${pending.fromLabel}）`);
    }
  }
  // v2.0.19+: AskUserQuestion state，留 30 min 给用户慢慢选
  import("./bridge/ask-user-question.js").then(({ auqStates }) => {
    for (const [channelId, state] of auqStates.entries()) {
      if (now - state.ts > 30 * 60_000) {
        auqStates.delete(channelId);
        console.log(`🧹 auqStates stale: 清掉 ${channelId}（${state.questions.length} 问，30min 没 submit）`);
      }
    }
  }).catch(() => { /* non-critical */ });
}, 60_000).unref();

/** 返回跟 channelId 共享同一个 ws 的所有其他 channelId（不含自身）。
 *  一个 ws 挂多个 channel key 时，任何一端的 Stop hook 都得同步清另一端的
 *  typing / status message。 */
function sameWsChannels(channelId: string): string[] {
  const self = clients.get(channelId);
  if (!self) return [];
  const out: string[] = [];
  for (const [otherId, info] of clients.entries()) {
    if (otherId !== channelId && info.ws === self.ws) out.push(otherId);
  }
  return out;
}

async function handleHookRequest(req: Request): Promise<Response> {
  try {
    const body = await req.json() as { channelId: string; event: string };
    const { channelId, event } = body;
    if (!channelId || !event) {
      return new Response("Missing channelId or event", { status: 400 });
    }

    // 所有 hook 事件都停 typing / 清 safety timer
    // 兼容旧版 hook 发的 "stop"
    if (event === "Stop" || event === "StopFailure" || event === "Notification" || event === "stop") {
      console.log(`🏁 Hook 收到 ${event}: channel=${channelId}`);
      // v2.4.25+ 对话完成 → 刷用量看板（防抖合并，内部惰性缓存 /status）
      if (event === "Stop" || event === "StopFailure" || event === "stop") {
        updateStatsDashboard(discord);
        // v2.6.0+ 事件埋点：turn 结束（在去抖/通知判断之前 —— 事件流忠实反映 hook）
        const evAgent = await agentLabelForChannelAsync(channelId);
        // v2.20.2+ 回合结束≠任务完成:后台还有活(subagent/bg shell)时带上
        // bgPending,web 端把绿勾换成「后台继续中」(owner 实报提前完成误导)
        const bgPending = hasActiveBgActivities(evAgent);
        emitEvent({ agent: evAgent, chatId: channelId, type: "agent_status", data: { status: "done", ...(bgPending ? { bgPending: true } : {}) } });
        // 回合结束核对 registry session 是否还是活文件——原生 /clear 类
        // 轮转（不经 clear 端点）自愈。后台异步，不阻塞 Stop 主流程。
        void maybeHealRotatedSession(channelId);
      }
      // typing + safety timer：本 channel + 共享 ws 的所有 channel 都停（参见
      // sameWsChannels 的注释）。
      stopTyping(channelId);
      clearSafetyTimer(channelId);
      for (const otherId of sameWsChannels(channelId)) {
        stopTyping(otherId);
        clearSafetyTimer(otherId);
      }

      // 只有 Stop / StopFailure 触发完成通知，Notification 不触发（避免 Stop+Notification 连发两次）
      // 同时 10 秒内去抖，防止 Claude Code 重复 fire Stop 事件
      let shouldNotify = event === "Stop" || event === "StopFailure" || event === "stop";
      const now = Date.now();
      const last = lastCompletionSent.get(channelId) || 0;
      if (shouldNotify && now - last < COMPLETION_DEDUPE_MS) {
        console.log(`🏁 去抖跳过（${Math.round((now - last) / 1000)}s 内已发过）: channel=${channelId}`);
        return new Response("ok");
      }

      // v1.9.6+: 如果最近一次 message 来自 agent（send_to_agent 转发），
      // 这次 Stop 是"为 agent 工作" — 用户没问过问题，不用 @ 他。
      // v2.10+ "api" 同跳（owner「谁发的谁回」）:Web 端触发的回合,用户在 Web 上
      // 看回复,Discord 不再 @ 推送(mirror 内容照旧)。
      {
        let src = lastMessageSource.get(channelId);
        // bridge 重启后 map 清零 → 从 jsonl 尾部推断(Web 注入头是持久痕迹),
        // 否则重启后的第一个回合必误发 Discord @(2026-07-16 两次真机撞上)
        if (src === undefined && shouldNotify) {
          src = await inferInboundSourceFromJsonl(channelId);
          if (src) lastMessageSource.set(channelId, src);
        }
        if (shouldNotify && (src === "agent" || src === "api")) {
          console.log(`🏁 跳过完成通知（触发源=${src},非 Discord 用户）: channel=${channelId}`);
          shouldNotify = false;
        }
      }

      // 防御性：等 Claude Code TUI 稳定下来（~1.5s），再看 pane 状态确认真的"完成"。
      // 有几种场景 Stop 会提前触发：
      //   - pane 上有权限/session-idle 弹窗 → Claude 实际在等用户输入
      //   - pane 不在 ❯ idle 提示符 → Claude 可能在下一步（工具调用流转等）
      // 这两种都应该跳过完成通知，等真正 idle 时的下一个 Stop 事件再发。
      if (shouldNotify) {
        await Bun.sleep(1500);
        try {
          const listResult = await runManager("list");
          const agent = (listResult.agents || []).find((a: any) => a.channelId === channelId);
          if (agent) {
            const target = windowTarget(agent.name);
            const pane = await tmuxCapture(target, 30);
            if (detectRuntimePermissionPrompt(pane) || detectSessionIdlePrompt(pane)) {
              console.log(`🏁 pane 有弹窗，跳过完成通知: channel=${channelId} agent=${agent.name}`);
              shouldNotify = false;
            } else {
              const { isIdle } = await import("./lib/tmux-helper.js");
              const idle = await isIdle(target);
              if (!idle) {
                console.log(`🏁 Stop 触发但 pane 不是 ❯ idle 状态，Claude 还在工作 → 跳过这次通知，等下一个 Stop: channel=${channelId} agent=${agent.name}`);
                shouldNotify = false;
              }
            }
            // v2.4.17+ 检测 ScheduleWakeup：新版 Claude Code 把任务包成
            // run_in_background bash + ScheduleWakeup 排队回调，turn 干净结束 →
            // Stop hook 误判为"已完成" → @ 用户。用户反馈这种情况频繁。
            // 检测命中就跳过 @，等真正的"用户任务"完成时下一个 Stop 再走通知。
            if (shouldNotify && agent.sessionId && agent.project) {
              const cwd = String(agent.project).replace(/^~/, process.env.HOME || "~");
              const wakeupPending = await hasRecentScheduleWakeup(cwd, agent.sessionId);
              if (wakeupPending) {
                console.log(`🌀 跳过完成通知（agent 用 ScheduleWakeup 排队下次回调，任务未结束）: channel=${channelId} agent=${agent.name}`);
                shouldNotify = false;
              }
            }
          }
        } catch { /* non-critical */ }
      }

      // 收集所有需要清状态消息的 channel：Stop 的 channelId + 共享同一个 ws 的
      // 其他 channel + pendingReplies 里 targetWs 匹配的 intendedReplyChannel。
      // 否则"💭 思考中..."按钮永远不会变成"✅ 完成"。
      const channelsToClear = new Set<string>([channelId]);
      const thisClientForStatus = clients.get(channelId);
      if (thisClientForStatus) {
        for (const otherId of sameWsChannels(channelId)) {
          channelsToClear.add(otherId);
        }
        for (const [, pending] of pendingReplies.entries()) {
          if (pending.targetWs === thisClientForStatus.ws) {
            channelsToClear.add(pending.intendedReplyChannel);
            stopTyping(pending.intendedReplyChannel);
            clearSafetyTimer(pending.intendedReplyChannel);
          }
        }
      }

      // v1.9.37+: 在"改 ✅ / 发完成通知"前，强制让 watcher 把这条 channel 的
      // jsonl 读干净 + flush pending textQueue。这样 turn 结束的"agent 只打字
      // 不 reply" 场景里，watcher debounce 还没 fire 的 `💬 text` 不会丢，也不
      // 需要再跑一份 rescue 从 jsonl 另外抽一遍（双发源头）。
      // channelsToClear 里每个 channel 都 drain —— ws 与 intendedReplyChannel
      // 可能不同。
      if (event === "Stop" || event === "StopFailure" || event === "stop") {
        const { drainChannelWatcher } = await import("./bridge/jsonl-watcher.js");
        for (const cid of channelsToClear) {
          try {
            const drainResult = await drainChannelWatcher(cid, discord);
            const drainedText = drainResult.text;

            // v2.0.13+ 兜底 1: 本地 send_to_agent caller 在等 push。如果 target 这轮
            // 走了 watcher drain（assistant 文字直接 post 到自己 channel）而**不是**
            // reply()，老 pushback 路径根本不触发 → caller 永远等不到。这里在 Stop
            // drain 之后强制 pushback 一次：
            //   - drain 出了文字 → push 该文字
            //   - drain 没文字（连 assistant text 都没有）→ push 一句 "对方结束了
            //     turn 但没回复"，至少让 caller 不会无限静默等
            const pendingAgent = pendingAgentCalls.get(cid);
            if (pendingAgent) {
              if (!drainedText) {
                // v2.4.16+ no-text 静默清掉 pending，**不 push** 回 caller。
                // 历史上这里 push 一条"[⚠️ 对方没产出，你需要主动追问或换路线]"，
                // 等于积极激励 caller 再发一轮 send_to_agent → target 又没产出
                // → 又一轮 push → 死循环（agent 之间永无止境聊天的根因）。
                // 现在静默：caller 的 send_to_agent promise 不 resolve，caller 早
                // 就 end_turn 了，最多等 staleCleanup 10min 扫掉。caller 没收到推
                // 不会发起新轮 → 链条天然中断，对应"对方没回话就别盯着"的人类直觉。
                pendingAgentCalls.delete(cid);
                console.log(
                  `🤫 drain兜底 no-text 静默清 pending: ${pendingAgent.targetName} → ${pendingAgent.callerName}`
                );
                recordMetric("agent_pushback_drain_silent", {
                  channelId: pendingAgent.callerChannelId,
                  meta: { target: pendingAgent.targetName },
                });
              } else {
                try {
                  const callerCtxLine = pendingAgent.expecting
                    ? `[💡 你之前 send_to_agent 给 ${pendingAgent.targetName} 时填的期望：${pendingAgent.expecting}]\n`
                    : "";
                  const pushBody = `${callerCtxLine}[ℹ️ 对方 (${pendingAgent.targetName}) 这轮没用 reply() 工具，下面是 bridge 从 assistant 文字兜底转发的：]\n\n${drainedText}`;
                  const stopWsClient = clients.get(cid);
                  const replyBackHint = pendingAgent.originalReplyChannel || cid;
                  const drainPushEnv: RouterEnvelope = {
                    from: {
                      kind: "local",
                      agentName: pendingAgent.targetName,
                      channelId: replyBackHint,
                      ws: stopWsClient?.ws ?? pendingAgent.callerWs,
                    },
                    to: {
                      kind: "local",
                      agentName: pendingAgent.callerName,
                      channelId: pendingAgent.callerChannelId,
                      ws: pendingAgent.callerWs,
                    },
                    intent: "response",
                    content: pushBody,
                    meta: {
                      messageId: `agent_drain_${Date.now()}`,
                      triggerKind: "agent_tool",
                      ts: new Date().toISOString(),
                      threadId: newThreadId(),
                    },
                  };
                  await deliver(drainPushEnv);
                  pendingAgentCalls.delete(cid);
                  console.log(`📨 AGENT PUSH-BACK (drain兜底): ${pendingAgent.targetName} → ${pendingAgent.callerName}（drain 文字）`);
                  recordMetric("agent_pushback_drain", { channelId: pendingAgent.callerChannelId, meta: { hadText: "yes" } });
                } catch (e) {
                  console.error("AGENT PUSH-BACK (drain兜底) 失败:", e);
                }
              }
            }

            // v2.6.0+ R3: API waiter 兜底 —— agent end_turn 没 reply() 时，用
            // drain 出的 assistant 文本 resolve 挂着的 API 请求，wait 调用方不必
            // 干等到超时。连文本都没有 → resolve reply:null（"结束但没回复"）。
            for (const [pKey, pQueue] of pendingApiRequests.entries()) {
              if (!pQueue.length || pQueue[0].agentChannelId !== cid) continue;
              pendingApiRequests.delete(pKey);
              for (const p of pQueue) {
                const result: ApiReplyResult = {
                  reply: drainedText || null,
                  threadId: p.threadId,
                  agent: p.agentName,
                  viaFallback: true,
                };
                apiThreadResults.set(p.threadId, { result, ts: Date.now(), tokenId: p.tokenId });
                p.resolve?.(result);
                emitEvent({
                  agent: p.agentName,
                  chatId: `api:${p.tokenId}`,
                  type: "chat_message",
                  data: { direction: "out", from: p.agentName, text: drainedText || "", threadId: p.threadId, api: true, viaFallback: true },
                });
                console.log(`🌐 API waiter drain 兜底: ${p.agentName} → token ${p.tokenId}（${drainedText ? drainedText.length + " chars" : "no-text"}）`);
              }
            }

            // v2.0.16+ inter-agent 看门狗: 这一轮结束时如果 cid 还挂着 inter-agent
            // 消息 pending（agent 既没 reply 也没 send_to_agent —— 大概率收到消息后
            // 啥也没干或没报告），注一条 nudge 到它的 ws 提醒处理 + reply() 报告。
            // v2.4.16+: 最多 nudge **1** 次（之前是 2 次，跟 drain兜底 no-text push
            // 叠加导致 agent 反复 wake-up 抓 LLM turn，是"聊不停"的另一个根因）。
            // 1 次未响应直接放弃，少打扰对面 + 少烧 token。
            const iaPending = pendingInterAgentMsg.get(cid);
            if (iaPending) {
              if (iaPending.retries >= 1) {
                pendingInterAgentMsg.delete(cid);
                console.log(`⚠️ inter-agent 看门狗放弃（${cid} nudge 1 次仍无响应，来自 ${iaPending.fromLabel}）`);
              } else {
                const stopClientForNudge = clients.get(cid);
                if (stopClientForNudge) {
                  try {
                    const nudgeText = [
                      `[ℹ️ 上一轮你收到来自 ${iaPending.fromLabel} 的消息，turn 结束时既没 reply() 也没 send_to_agent。`,
                      `如果你**判断它不需要回应**（比如纯 FYI、已经被你内部处理掉了、对方只是状态同步），end_turn 是 OK 的，这条 nudge 忽略即可。`,
                      `如果是**漏了**：现在补上 reply() 到自己频道告诉用户做了什么；如果是问你的就 send_to_agent 回 ${iaPending.fromLabel}。`,
                      `避免毫无产出地静默 end_turn，但也别为了应付这条 nudge 编一段"我收到了"——那只会污染对话。]`,
                    ].join("\n");
                    // 标记这个 channel 最近一条消息源是 agent/系统，避免 nudge 被处理后
                    // 的 Stop hook 误 @ 用户。
                    lastMessageSource.set(cid, "agent");
                    await deliver({
                      from: { kind: "bridge", label: "ia-watchdog" },
                      to: { kind: "local", channelId: cid, ws: stopClientForNudge.ws, cwd: stopClientForNudge.cwd },
                      intent: "notification",
                      content: nudgeText,
                      meta: {
                        messageId: `ia_nudge_${Date.now()}`,
                        triggerKind: "bridge_synth",
                        ts: new Date().toISOString(),
                        threadId: newThreadId(),
                      },
                    });
                    iaPending.retries += 1;
                    console.log(`📨 inter-agent 看门狗 nudge #${iaPending.retries} → ${cid}（来自 ${iaPending.fromLabel}）`);
                    recordMetric("ia_watchdog_nudge", { channelId: cid, meta: { from: iaPending.fromLabel, retry: String(iaPending.retries) } });
                  } catch (e) {
                    console.error("inter-agent 看门狗 nudge 失败:", e);
                  }
                } else {
                  // agent 的 ws 没了 → 清掉 pending，没法 nudge
                  pendingInterAgentMsg.delete(cid);
                }
              }
            }
          } catch { /* non-critical */ }
        }
      }

      // 清所有 pending*（targetWs 匹配这次 Stop ws 的那些）。watcher drain 完
      // 就不再需要 "pending 挂着等 rescue" 的语义了，留着只会让下次 Stop 误判。
      // 同时 pendingThreads 按 threadId 带 log，知道哪些具体 thread 结束了。
      const stopClientForPending = clients.get(channelId);
      if (stopClientForPending && (event === "Stop" || event === "StopFailure" || event === "stop")) {
        for (const [cid, pending] of pendingReplies.entries()) {
          if (pending.targetWs === stopClientForPending.ws) pendingReplies.delete(cid);
        }
        const closedThreads: string[] = [];
        for (const [tid, t] of pendingThreads.entries()) {
          if (t.targetWs === stopClientForPending.ws) {
            pendingThreads.delete(tid);
            closedThreads.push(tid);
          }
        }
        if (closedThreads.length > 0) {
          console.log(`🧵 Stop 清 pending threads: ${closedThreads.join(", ")} (channel=${channelId})`);
        }
      }

      // 把所有相关 channel 的"💭 思考中..."状态消息改成"✅ 完成"。
      // v2.4.22+ 去掉 interrupt（活干完了），但**保留 focus + screenshot 按钮** ——
      // 这条消息永远在频道底部附近，用户随手能点跳 tab / 截图，不用翻 pin 或打命令。
      for (const cid of channelsToClear) {
        await finishStatusMessage(discord, cid, t("✅ 完成", "✅ Done"), agentActionButtons(cid, false));
      }

      // 发完成通知 @ user（仅 Stop/StopFailure）。watcher 已经把 agent 的消息推
      // 到 Discord 了，这条就是纯"活干完了戳你一下"的 push 通知 —— umadone 短语
      // 不带实质内容，跟 watcher 推的 `💬 text` 不重复。
      if (shouldNotify) {
        try {
          const ch = await discord.channels.fetch(channelId);
          if (ch && "messages" in ch) {
            const textCh = ch as TextChannel;
            const mention = primaryOwnerId() ? `<@${primaryOwnerId()}>` : "";
            if (mention) {
              await textCh.send(`${randomUmaDone()} ${mention}`);
              lastCompletionSent.set(channelId, now);
              console.log(`🏁 完成通知已发送: channel=${channelId}`);
              recordMetric("agent_completed", { channelId });
            }
          }
        } catch (e) {
          console.error(`🏁 完成通知发送失败:`, e);
        }
      }
    }

    return new Response("ok");
  } catch {
    return new Response("Invalid request", { status: 400 });
  }
}

/**
 * v2.6.0+ GET /events —— 结构化事件流（SSE）。设计 §4.3。
 * ?agent=<name> 过滤单 agent；?since=<seq> 或 Last-Event-ID 断线补发。
 * 30s 心跳注释防代理超时。本机部署默认免鉴权（服务只绑 127.0.0.1，见下）。
 */
function handleEventsRequest(req: Request, extraFilter?: EventFilter): Response {
  const url = new URL(req.url);
  const agent = url.searchParams.get("agent") || undefined;
  const sinceParam = url.searchParams.get("since") ?? req.headers.get("Last-Event-ID");
  const since = sinceParam !== null ? Number(sinceParam) : NaN;
  const filter: EventFilter = { ...(extraFilter || {}), ...(agent ? { agent } : {}) };
  let unsub: (() => void) | null = null;
  let ping: ReturnType<typeof setInterval> | null = null;
  const cleanup = () => {
    unsub?.();
    unsub = null;
    if (ping) { clearInterval(ping); ping = null; }
  };
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      const send = (evt: { seq: number }) => {
        try {
          controller.enqueue(enc.encode(`id: ${evt.seq}\ndata: ${JSON.stringify(evt)}\n\n`));
        } catch {
          cleanup(); // controller 已关（客户端断开），停止推送
        }
      };
      // 立即发首包注释：flush 响应头 + 重置 Bun 的连接空闲计时。
      // Bun.serve 默认 HTTP idleTimeout ≈10s——不发任何字节的空闲 SSE 连接
      // 会在 ~10s 被掐（实测 10.7s close），30s ping 根本活不到第一轮。
      try { controller.enqueue(enc.encode(`: connected\n\n`)); } catch { cleanup(); }
      if (Number.isFinite(since)) {
        for (const evt of replayEventsSince(since, filter)) send(evt);
      }
      unsub = subscribeEvents(filter, send);
      // ping 30s→5s：必须小于 Bun.serve 默认 idleTimeout（~10s），
      // 否则事件间隙超过 10s 的订阅者会被静默断开（web 前端首当其冲）。
      ping = setInterval(() => {
        try { controller.enqueue(enc.encode(`: ping\n\n`)); } catch { cleanup(); }
      }, 5_000);
    },
    cancel() { cleanup(); },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}

// /api/v1 路由与鉴权：v2.9.2 起整体在 bridge/api-routes.ts。这里注入它需要的
// bridge 运行时依赖（ws 会话表 / 统一投递 / 镜像 / typing / SSE 处理器）。
initApiRoutes({
  clients,
  deliver,
  mirrorApiExchange,
  startTypingWithSafety,
  lastMessageSource,
  handleEventsRequest,
  // clear 端点后台轮转收尾（依赖 bridge 本地的 discord/startWatching，注入）
  scheduleClearRotation,
  // v2.15+ peer 一键邀请被兑换时通知 owner（control 频道）
  notifyOwner: notifyMaster,
});

// v2.11+ HTTP peer 出站 transport（docs/design-http-peers.md）
initHttpPeer({ deliver, getClientWs: (channelId) => (clients.get(channelId)?.ws as any) ?? null });

const CORS_ORIGIN_SETTING = process.env.BRIDGE_CORS_ORIGIN || "";
const STATIC_DIR = process.env.BRIDGE_STATIC_DIR || "";

/**
 * clear 后的会话轮转收尾（后台异步）。
 *
 * TUI 里 /clear 会轮转 sessionId，但新 session 的 jsonl 往往要等**首条消息**
 * 才落盘——所以 clear 端点先返回 202，这里每 1.5s poll cwd 的 projects slug 目录。
 *
 * M2：同 cwd 可能有多个 agent，共享同一个 projects slug 目录。光取「最新 jsonl」
 * 会把别的 agent 正在写的既有 session 误认成自己的新会话，串台并污染 registry。
 * 改为**快照 diff**：clear 前记录目录里已有的全部 sid（beforeSids），此后只认领
 * 快照里没有、且非 oldSid 的**新** sid（列表按 mtime 降序，取最新的那个）。再叠一层
 * ownedByOther（新 sid 恰好是别的 agent 官方 session 则跳过）兜双重巧合。命中后：
 *   manager set-session（归档旧会话 + registry 切换，保持 manager 唯一写者）
 *   -> stopWatchingByChannel + startWatching 重绑 jsonl-watcher（否则盯死文件，工具流断掉）。
 * 超时（2min，比如该 CC 版本 /clear 不轮转 session）则放弃，watcher 维持原样。
 */
function scheduleClearRotation(agentName: string, channelId: string, cwd: string, oldSid?: string) {
  const deadline = Date.now() + 120_000;
  const beforeSids = new Set(listSessionIdsForCwd(cwd)); // clear 前的会话快照
  const tick = async () => {
    try {
      // 只认领快照外的新 sid（排除同 cwd 其他 agent 一直在写的既有 session）；
      // 列表 mtime 降序，[0] 是最新出现的那个新会话。
      const sid = listSessionIdsForCwd(cwd).find((s) => !beforeSids.has(s) && s !== oldSid);
      if (sid) {
        const listResult = await runManager("list");
        const ownedByOther = ((listResult.agents || []) as any[]).some(
          (a) => a.name !== agentName && a.sessionId === sid,
        );
        if (!ownedByOther) {
          const r = await runManager("set-session", agentName, sid);
          if (r?.ok) {
            stopWatchingByChannel(channelId);
            startWatching(agentName, cwd, sid, channelId, discord);
            console.log(`🧹 clear 轮转完成 agent=${agentName} ${oldSid?.slice(0, 8) ?? "?"}->${sid.slice(0, 8)}`);
          } else {
            console.error(`🧹 clear 轮转 set-session 失败 agent=${agentName}:`, r?.error);
          }
          return;
        }
      }
    } catch { /* 下一轮重试 */ }
    if (Date.now() < deadline) setTimeout(tick, 1500);
    else console.warn(`🧹 clear 轮转超时 agent=${agentName}（未见新 session jsonl，watcher 维持原 session）`);
  };
  setTimeout(tick, 1200);
}

/**
 * Stop 时的 session 轮转自愈（2026-07-23 用户报：temp 历史停在 7-15）。
 *
 * 原生 /clear 不经 clear 端点也会轮转 session——远程终端里直敲、Discord slash
 * 直通、TUI 里手动打——registry 全程不知情，jsonl-watcher/history 从此盯死文件：
 * 工具流断、历史冻结，而 reply/推送照常（不走 jsonl），故障极隐蔽（temp 断了
 * 整整 7 天才被发现）。回合结束是天然核对点：registry 指向的 jsonl 若整个回合
 * 毫无写入（mtime 陈旧），而同 slug 刚有别的 jsonl 在写 → 真实会话已迁移，按
 * clear 轮转同款流程认领（set-session 归档+registry 切换，watcher 重绑）。
 *
 * 防串台：同 cwd 多 agent 时，候选 sid 是其他 agent 的官方 session 则不认领
 * （scheduleClearRotation 的 ownedByOther 同款）；且候选 mtime 必须落在刚结束
 * 的回合窗口内（<3min），排除认领陈年老文件。
 */
const ROTATION_FRESH_MS = 3 * 60_000;
const rotationHealInflight = new Set<string>();
async function maybeHealRotatedSession(channelId: string) {
  if (rotationHealInflight.has(channelId)) return;
  rotationHealInflight.add(channelId);
  try {
    const agents = await readRegistryAgents();
    const me = agents.find((a) => a.channelId === channelId && a.status === "active");
    if (!me?.cwd || !me.sessionId) return;
    const cwd = me.cwd.replace(/^~/, process.env.HOME || "~");
    // 快路径（绝大多数回合）：registry session 本回合有写入 → 一切正常
    try {
      if (Date.now() - statSync(projectJsonlPath(cwd, me.sessionId)).mtimeMs < ROTATION_FRESH_MS) return;
    } catch { /* registry session 文件已消失 → 继续找真身 */ }
    const newest = listSessionIdsForCwd(cwd).find((s) => s !== me.sessionId); // mtime 降序
    if (!newest) return;
    let newestMtime = 0;
    try {
      newestMtime = statSync(`${process.env.HOME}/.claude/projects/${projectsSlug(cwd)}/${newest}.jsonl`).mtimeMs;
    } catch { return; }
    if (Date.now() - newestMtime > ROTATION_FRESH_MS) return; // 没有本回合在写的新文件
    if (agents.some((a) => a.name !== me.name && a.sessionId === newest)) return; // ownedByOther
    const r = await runManager("set-session", me.name, newest);
    if (r?.ok) {
      stopWatchingByChannel(channelId);
      startWatching(me.name, cwd, newest, channelId, discord);
      recordMetric("session_selfheal", { channelId, agent: me.name, meta: { from: me.sessionId, to: newest } });
      console.log(`🩹 session 轮转自愈 agent=${me.name} ${me.sessionId.slice(0, 8)}->${newest.slice(0, 8)}（原生 /clear 类轮转，registry 未跟上）`);
    } else {
      console.error(`🩹 session 轮转自愈 set-session 失败 agent=${me.name}:`, r?.error);
    }
  } catch { /* 自愈失败不影响 Stop 主流程 */ } finally {
    rotationHealInflight.delete(channelId);
  }
}

async function handleHttpRoutes(req: Request, url: URL): Promise<Response> {
    if (url.pathname === "/hook" && req.method === "POST") {
      return handleHookRequest(req);
    }

    // v2.4.25+ 用量看板开放 JSON 接口（给 Web 端）
    if (url.pathname === "/stats" && req.method === "GET") {
      return handleStatsRequest();
    }

    // Web 看板强制刷新（同 Discord 🔄 按钮语义,force 抓取最长 ~20s）
    if (url.pathname === "/stats/refresh" && req.method === "POST") {
      const { handleStatsRefreshRequest } = await import("./bridge/stats-dashboard.js");
      return handleStatsRefreshRequest();
    }

    // v2.6.0+ 结构化事件流（SSE，本机免鉴权版；token 版挂 /api/v1/events）
    if (url.pathname === "/events" && req.method === "GET") {
      return handleEventsRequest(req);
    }

    // v2.6.0+ token 鉴权的入站 API（多前端架构 Phase B）
    if (url.pathname.startsWith("/api/v1/")) {
      // Web 远程终端 3 端点先行匹配（不走 30req/min 限流——逐键输入秒超；
      // 鉴权在 web-terminal.ts：Bearer + agentInScope + termId 属主校验）
      const termRes = await handleTerminalApi(req, url);
      if (termRes) return termRes;
      return handleApiRequest(req, url);
    }

    // Skills 重新扫描（manager 在 create/resume/kill 后调）
    if (url.pathname === "/skills/rescan" && req.method === "POST") {
      try {
        const body = (await req.json().catch(() => ({}))) as {
          agent?: string;
          cwd?: string;
          action?: "add" | "remove" | "full";
        };
        const action = body.action || "full";
        if (action === "remove" && body.agent) {
          clearProjectSkills(body.agent);
          clearWedgeState(body.agent);
        } else if (action === "add" && body.agent && body.cwd) {
          await scanProjectSkills(body.agent, body.cwd);
        } else {
          // full rescan
          await scanGlobalSkills();
          try {
            const listResult = await runManager("list");
            for (const a of listResult.agents || []) {
              if (a.status === "active" && a.cwd) {
                await scanProjectSkills(a.name, a.cwd);
              } else {
                clearProjectSkills(a.name);
              }
            }
          } catch { /* non-critical */ }
        }
        await registerSlashCommands();
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: (e as Error).message }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // v2.4.16+ manager kill 后调用 → 清掉所有引用该 channel 的 inter-agent
    // pending。避免被 kill 的 agent 复活/被 resume 后被陈年 pushback /
    // watchdog nudge 轰炸。restart (transient flap) 不调，只在永久 kill 调。
    if (url.pathname === "/agent/cleanup" && req.method === "POST") {
      try {
        const body = (await req.json().catch(() => ({}))) as { channelId?: string };
        if (!body.channelId) {
          return new Response(JSON.stringify({ ok: false, error: "missing channelId" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }
        const n = clearInterAgentPendingsForChannel(body.channelId);
        // agent 被永久 kill —— 顺手丢掉它在事件总线里的环形缓冲和回合态。
        // 那 500 条事件（含未截断的 assistant_text）不会再有人订阅，留着只是占内存，
        // 建了又删的 agent 会一路堆积。
        const goneAgent = (body as { agent?: string }).agent;
        if (goneAgent) forgetAgent(goneAgent);
        for (const [tid, t] of pendingThreads.entries()) {
          if (t.request.to.kind === "local" && t.request.to.channelId === body.channelId) {
            pendingThreads.delete(tid);
          }
        }
        console.log(`🧹 /agent/cleanup channel=${body.channelId} 清掉 ${n} 条 pending`);
        return new Response(JSON.stringify({ ok: true, cleared: n }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: (e as Error).message }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // v2.11: Discord peer 通告端点已移除，留 410 tombstone——peer 协作走 HTTP transport
    if (url.pathname === "/peer/announce" && req.method === "POST") {
      return new Response(JSON.stringify({ ok: false, error: "discord peer removed (v2.11) — use peer-http-* commands" }), {
        status: 410,
        headers: { "Content-Type": "application/json" },
      });
    }

    // v2.10+ 静态托管（BRIDGE_STATIC_DIR）：以上路由都没接住的 GET 落到这里，
    // web 前端构建产物可由 bridge 直接 serve（含 SPA fallback），免配反代。
    if (STATIC_DIR && req.method === "GET") {
      const staticPath = resolveStaticPath(STATIC_DIR, url.pathname);
      if (staticPath) return new Response(Bun.file(staticPath));
    }

    return new Response("Claude Orchestrator Bridge", { status: 200 });
}

const server = Bun.serve({
  port: BRIDGE_PORT,
  // v2.6.0+ 默认只绑回环 —— /hook /stats /skills/rescan 一直无鉴权，之前默认
  // 0.0.0.0 等于把它们暴露在内网。跨机器场景（自定义 BRIDGE_URL 指向远程）用
  // BRIDGE_BIND=0.0.0.0 显式放开，网络边界（反代/TLS/防火墙）由用户自己负责。
  hostname: process.env.BRIDGE_BIND || "127.0.0.1",
  async fetch(req, server) {
    const reqOrigin = req.headers.get("Origin");
    const crossOrigin = isCrossOrigin(reqOrigin, req.url);

    // v2.13.1+ ws 跨源防护。WebSocket 不受同源策略约束 —— 用户访问的任意网页都能
    // 连上这个端口并发 route_to_agent，等价于在这台机器上执行任意命令。回环绑定
    // 挡不住它（实测：伪造 Origin 的连接被接受并拿到全部频道）。合法客户端
    // （channel-server / manager / discord-reply）都是 Bun 进程、不带 Origin，
    // 因此这道闸对它们完全透明。
    if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      if (crossOrigin && !isOriginExplicitlyAllowed(reqOrigin, CORS_ORIGIN_SETTING)) {
        console.warn(`🚫 拒绝跨源 WebSocket 升级: Origin=${reqOrigin}`);
        return new Response("cross-origin websocket refused", { status: 403 });
      }
    }
    if (server.upgrade(req)) return undefined;
    const url = new URL(req.url);
    // v2.10+ CORS（BRIDGE_CORS_ORIGIN 未设 = 不发头，行为同旧版）
    const cors = corsHeadersFor(reqOrigin, CORS_ORIGIN_SETTING);
    if (req.method === "OPTIONS" && cors) {
      return new Response(null, { status: 204, headers: cors });
    }
    // v2.13.1+ 跨源 HTTP 一并拒掉：/hook、/skills/rescan、/agent/cleanup 等控制端点
    // 没有 CSRF token，而简单 POST 不触发 preflight，浏览器页面可以直接打进来。
    // cors 非 null ⇒ 该 origin 已在 BRIDGE_CORS_ORIGIN 白名单（或用户设了 "*"）。
    if (crossOrigin && !cors) {
      console.warn(`🚫 拒绝跨源 HTTP: ${req.method} ${url.pathname} Origin=${reqOrigin}`);
      return new Response("cross-origin request refused", { status: 403 });
    }
    const resp = await handleHttpRoutes(req, url);
    if (cors) for (const [k, v] of Object.entries(cors)) resp.headers.set(k, v);
    return resp;
  },
  websocket: {
    // v2.2.0+: 抬高 idleTimeout（Bun 默认 120s）。配合 channel-server 每 25s 的
    // keepalive ping，空闲 agent 的连接不会被关 → 不再 flap。255 是 Bun 上限。
    idleTimeout: 255,
    open(ws) {
      console.log("🔌 新的 channel-server 连接");
    },
    message(ws, message) {
      // 必须 catch：这是个 async 函数，返回的 promise 之前被直接丢弃。任何逃逸出来的
      // 异常都会变成 unhandledRejection —— 装了 crash-guard 之后那等于**整个 bridge
      // 退出**（所有 agent 一起断线）。单条消息处理失败不该有这个后果。
      void handleClientMessage(
        ws,
        typeof message === "string" ? message : new TextDecoder().decode(message)
      ).catch((e) => {
        console.error("handleClientMessage 未捕获异常:", e);
      });
    },
    close(ws) {
      for (const [channelId, info] of clients.entries()) {
        if (info.ws === ws) {
          clients.delete(channelId);
          // 同步兜底：直接按 channelId 在 watcher Map 中查，避免依赖异步 runManager
          stopWatchingByChannel(channelId);
          console.log(`🔌 断开: 频道 ${channelId} (剩余 ${clients.size} 个)`);
        }
      }
      // v2.13.1+ 这条 ws 上挂着的 pendingThreads 一起清掉 —— 它们的 targetWs 已经
      // 死了，回合不可能再有结果回来。留着只会一直钉住整个请求 envelope。
      // （30min 定时清扫是兜底，这里是即时回收。）
      let dropped = 0;
      for (const [tid, t] of pendingThreads.entries()) {
        if (t.targetWs === ws) {
          pendingThreads.delete(tid);
          dropped++;
        }
      }
      if (dropped > 0) console.log(`🧹 连接关闭，顺带清掉 ${dropped} 条挂在它上面的 pendingThread`);
    },
  },
});

console.log(`🚀 Bridge WebSocket 启动: ws://localhost:${BRIDGE_PORT}`);

// 清扫上次崩溃/被杀残留的 webterm-* viewer session（grouped session 视图，
// kill 不伤 master 本体）。Discord 与 Web-only 模式都需要。
sweepStaleTerminalSessions().catch(() => {});

// v2.21+ 存量 agent 的 project 归属补齐(「每个 agent 必属一个 project」对老数据
// 成立)。委托 manager(写锁+原子写),幂等——没缺的直接 migrated:0 返回。
setTimeout(() => {
  runManager("project-migrate")
    .then((r: any) => {
      if (r?.ok && r.migrated > 0) console.log(`📁 project 迁移:${r.migrated} 个 agent 已按目录归组`);
    })
    .catch(() => {});
}, 3_000);

// Web-only: 无 DISCORD_BOT_TOKEN → Web-only 模式：不连 Discord，只跑与
// 平台无关的初始化子集。HTTP/ws/api/事件流在上面 Bun.serve 时已就绪。
// 跳过的 Discord 专属项：cleanupStaleThinkingMessages / initStatsDashboard /
// registerSlashCommands / startPermissionWatcher / startWedgeWatcher /
// startSessionReconciler / gateway 看门狗（它们的告警面/交互面都是 Discord）。
if (WEB_ONLY) {
  console.log("🕸️ Web-only 模式：未设 DISCORD_BOT_TOKEN，跳过 Discord 登录");
  // v2.8+ bg 活动追踪 — provisionThread 走 local adapter（落空），bg_task_* 事件照发
  startBgActivityWatcher({ sourceProvider: (cid) => lastMessageSource.lastHuman(cid) });
  // v2.9+ 归档每日兜底 — 纯文件系统操作，历史 API 依赖它
  startArchiveSweeper();
  // v2.13.1+ 给 web 前端补一个"重启了"的信号。Discord 侧靠
  // cleanupStaleThinkingMessages 把卡住的"💭 思考中"改写成可重发提示，而那是
  // Discord 专属（要编辑历史消息），web-only 模式整段跳过 —— 结果 bridge 重启后
  // web 端会一直停在"正在回复"，因为那个回合的 done 事件永远不会来了
  // （pendingThreads 已随进程消失）。这里给每个已注册频道补发一条 done。
  setTimeout(() => {
    for (const [chId, info] of clients.entries()) {
      const agentName = info.cwd ? chId : chId; // 事件按 chatId 过滤，agent 名尽力而为
      emitEvent({
        agent: agentName,
        chatId: chId,
        type: "agent_status",
        data: { status: "done", reason: "bridge_restarted" },
      });
    }
    console.log(`🔄 web-only：已向 ${clients.size} 个频道补发 done（bridge 重启，旧回合状态已丢失）`);
  }, 5_000);
  recordMetric("bridge_start", { meta: { channels: clients.size, webOnly: true } });
} else {
  if (!DISCORD_TOKEN) {
    console.error("❌ 请设置 DISCORD_BOT_TOKEN");
    process.exit(1);
  }
  // login 失败（token 失效 / 缺 privileged intent / 断网）之前是未捕获的 rejection：
  // 进程直接死，launchd 10 秒后重启，如此循环，而 Discord 那边什么都看不到 ——
  // 用户只知道"bot 不上线"。这里明确报出原因再退出。
  // Discord 限流可见化。此前没有任何 rateLimited 监听 —— 批量建频道会撞
  // Discord 每 10 分钟的频道创建配额，表现是"新建 agent 就是卡住"，日志里没有
  // 任何线索。discord.js 会自己排队重试，我们只需要把它打出来。
  discord.rest.on("rateLimited", (info: any) => {
    console.warn(
      `⏳ Discord 限流：${info?.method ?? ""} ${info?.route ?? info?.url ?? ""} ` +
        `等待 ${Math.round((info?.timeToReset ?? 0) / 1000)}s（global=${!!info?.global}）`
    );
  });

  // v2.19.0 自我消息对账的发送侧：包住 REST post，所有 .send()/.reply()/followUp
  // 最终都从那儿出去，一个点覆盖全部（逐个调用点插桩漏一个就是一次假警）
  installSelfSendTracker(discord as unknown as { rest: { post: (r: string, o?: unknown) => Promise<unknown> } });

  discord.login(DISCORD_TOKEN).catch((e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(
      `❌ Discord 登录失败：${msg}\n` +
        `   常见原因：DISCORD_BOT_TOKEN 失效或被重置；未在 Developer Portal 打开三个 ` +
        `Privileged Gateway Intents（尤其 MESSAGE CONTENT）；网络不通。\n` +
        `   改完 .env 后：launchctl kickstart -k gui/$(id -u)/com.claudestra.bridge`
    );
    process.exit(1);
  });
}

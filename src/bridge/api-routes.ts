/**
 * v2.9.2+ /api/v1 HTTP 路由 —— 从 bridge.ts 拆出的独立模块（多前端架构 §5）。
 *
 * 职责：Bearer 鉴权 + 限流、全部 /api/v1/* 端点分发、API 会话状态
 * （pending 请求 / 轮询结果 / 附件登记 / 限流器）。这些状态的 owner 是本模块，
 * bridge.ts 的 deliverToApi（出站回路）import 这里的 Map 读写。
 *
 * 与 bridge.ts 的耦合走 initApiRoutes(deps) 注入：clients（ws 会话表）、
 * deliver（统一投递）、镜像 / typing / 完成通知抑制、SSE 处理器。
 * 其余依赖（manager 调用、principals、session-history……）都是无状态模块，直接 import。
 */

import { runtimeForSessionPath, sessionJsonlPath } from "../lib/session-source.js";
import { DEFAULT_RUNTIME, managedFor, manageableRuntimeIds, sourceFor } from "../lib/runtimes/index.js";
import { runtimeCatalog } from "../lib/runtimes/catalog.js";
// cwd → 会话 id 列举（原定义在本文件；bridge.ts 也要用，挪到 session-ids.ts 解开反向依赖）
import { latestSessionIdForCwd } from "./session-ids.js";
import {
  apiJson,
  apiErrorResponse,
  isFullScope,
  forbidden,
  notInScope,
  inScopeEitherName,
  INVALID_JSON,
  readJsonBody,
  invalidJsonBody,
  liveInteractiveHolder,
} from "./api-respond.js";
import { interruptAgent } from "../lib/runtimes/window-ops.js";
import { existsSync, readdirSync, statSync } from "fs";
import { TMP_DIR, MASTER_DIR, INBOX_DIR, REPO_ROOT } from "./config.js";
import {
  readPrincipals,
  findByBearer,
  agentInScope,
  tokenIdOf,
  SlidingWindowLimiter,
  type Principal,
} from "../lib/principals.js";
import { runManager } from "./management.js";
import { parseAuqPane } from "../lib/auq-pane.js";
import { readPeers } from "../lib/peers.js";
import { loadJobs } from "../cron.js";
import { HYGIENE_JOB_NAME, HYGIENE_FREQS, freqOfSchedule, hygienePrompt, type HygieneFreq } from "../lib/memory-hygiene.js";
import { readConfig as readAppConfig, setAutoCompact } from "../lib/config-store.js";
import { readRegistryAgents } from "../lib/registry.js";
import { nonClaudeRuntimeError } from "../lib/claude-settings-runtime.js";
import { collectSessions } from "./sessions-inventory.js";
import { readPiRuntimeSnapshot } from "../lib/pi-env.js";
import { findSessionJsonlBySessionId } from "../lib/session-source.js";
import { cleanupBgJob } from "../lib/bg-jobs.js";
import { emitEvent, getAgentStatus, type EventFilter, isBusyStatus } from "./event-bus.js";
import { listAgentSessions, readSessionHistory, isValidSessionId, isValidSubagentId } from "../lib/session-history.js";
import { formatTool, formatToolDetail, agentNameForChannel } from "./jsonl-watcher.js";
import { newThreadId, type Envelope, type ApiUserEndpoint } from "./router.js";
// additive 端点（interrupt/clear/answer/pending/create/lifecycle）复用的共享 helper。
// 绝大多数是平台无关模块，直接 import；仅 scheduleClearRotation 依赖 bridge 本地
// 的 discord/startWatching，走 initApiRoutes 注入。
import {
  tmuxRaw,
  tmuxSendEscape,
  tmuxCapture,
  tmuxSendLine,
  paneLooksIdle,
  windowTarget,
  detectRuntimePermissionPrompt,
  listWindows,
  MASTER_SESSION,
  paneLooksWorking,
} from "../lib/tmux-helper.js";
import { stopTyping } from "./components.js";
import { clearSafetyTimer } from "./discord-adapter.js";
import { recordMetric } from "../lib/metrics.js";
import { commandsForAgent, resolveWebInvocation, isProjectSkillForOtherAgent } from "./slash-registry.js";
import { piCommandsFor } from "../lib/pi-env.js";
import { scanSessionTail, TAIL_WINDOWS, type SessionTailInfo } from "../lib/session-tail.js";
import { resolveModelAlias, isKnownEffort, isKnownRuntimeEffort, KNOWN_EFFORT_LEVELS, RUNTIME_ONLY_EFFORT_LEVELS } from "../lib/claude-launch.js";
import { isPiThinkingLevel } from "../lib/pi-launch.js";
import { activeBgJob, bgJobLog, bgJobLogResponse, spawnBgJob } from "./bg-jobs-http.js";
import { handleUpdateRoutes } from "./update-routes.js";

/**
 * 只允许当作**单层目录名**用的标识（归档区 archived/<name>）：拒绝路径分隔符、相对段、NUL。
 * 路由正则的 [^/]+ 挡不住 %2F —— decodeURIComponent 之后 "..%2F..%2Fx" 就是 "../../x"，
 * 直接拼进 mkdir -p 是目录穿越（review #10 安全项）。
 */
function isPathSafeName(x: string): boolean {
  return !!x && x !== "." && x !== ".." && !/[\/\\\0]/.test(x);
}

// master 不在 registry，从 env 读其控制频道 id（各端点的 master 特判用）
const CONTROL_CHANNEL_ID = process.env.CONTROL_CHANNEL_ID || "";

/** interrupt 端点的每 agent 冷却(防双击双 C-c——空闲态连按两次是 CC 退出键)。 */
const interruptCooldown = new Map<string, number>();

// ── API 会话状态（v2.6.0+，原 bridge.ts Phase B 区块） ──────────────────

/**
 * 一次 POST /api/v1/agents/:name/messages 的追踪。key = `${tokenId}|${agentChannelId}`
 * （同 token 对同 agent 的并发请求按 FIFO 队列 resolve）。
 * agent 的 reply(chat_id="api:<tokenId>") 进 deliverToApi 时按 key 出队：
 * resolve 同步 waiter + emit chat_message(out)（带原请求 threadId）+ 存结果供轮询。
 */
export interface PendingApiRequest {
  tokenId: string;
  tokenName: string;
  agentChannelId: string;
  agentName: string;
  threadId: string;
  ts: number;
  /** wait 模式挂的 resolver（无 wait 则为空） */
  resolve?: (result: ApiReplyResult) => void;
}

export interface ApiReplyResult {
  reply: string | null;
  components?: unknown[];
  files?: { name: string; url: string }[];
  threadId: string;
  agent: string;
  /** true = agent 没调 reply()，文本来自 Stop-hook drain 兜底（R3） */
  viaFallback?: boolean;
}

export const pendingApiRequests = new Map<string, PendingApiRequest[]>();
/** threadId → 已完成结果（轮询兜底用，TTL 清理见 sweepApiState）。
 *  tokenId = 发起请求的 token——GET /threads 校验属主,peer token 发到外部实例后
 *  threadId 可枚举面变大,不能让它读别的 token 的结果(review 2026-07-19 #4) */
export const apiThreadResults = new Map<string, { result: ApiReplyResult; ts: number; tokenId?: string }>();
/** 出站附件登记：opaqueId → 本地路径 + 属主 token（防任意文件读取） */
export const apiFiles = new Map<string, { path: string; tokenId: string; name: string }>();
/**
 * API 每 token 每分钟配额。**唯一真值** —— 限流器与 429 文案都从这里取。
 * 曾经限流器写 120、文案硬写 30、三份设计文档各说各话（30/30/120），
 * 撞限流的人拿到的是个假数字。
 * 120 是 2026-07-14 从 30 提上来的：web 重度使用下 SSE 重连风暴（每次重连烧
 * 连流+历史+列表轮询+pending 一整套）会打爆 30，触发 429 循环 → 直播流死掉。
 */
export const API_RATE_LIMIT_PER_MIN = 120;
/** per-token 限流器（内存态，60s 滑动窗口） */
const apiLimiters = new Map<string, SlidingWindowLimiter>();
// v2.16 拆双 TTL(外部用户报「>10 分钟的长任务收不到回复/推送」实锤):
// pending 队列的 TTL 就是「迟到 reply 还能找回原 threadId」的窗口——10 分钟
// 对长任务远远不够,被清后 reply 落到新造的 threadId 下,轮询方(HTTP API
// 调用者/peer 推回)永远等不到。放宽到 2h(条目极小,内存无虞);轮询结果
// 本身在 reply 写入后留 30 分钟足够(30s 轮询间隔一两拍就取走)。
const API_PENDING_TTL_MS = 2 * 3600_000;
const API_RESULT_TTL_MS = 30 * 60_000;

export function apiReqKey(tokenId: string, agentChannelId: string): string {
  return `${tokenId}|${agentChannelId}`;
}

/** API 会话状态 TTL 清理（bridge 的 staleCleanup 周期里调用） */
export function sweepApiState(now = Date.now()): void {
  for (const [key, queue] of pendingApiRequests.entries()) {
    const fresh = queue.filter((p) => now - p.ts <= API_PENDING_TTL_MS);
    if (fresh.length === 0) pendingApiRequests.delete(key);
    else if (fresh.length !== queue.length) pendingApiRequests.set(key, fresh);
  }
  for (const [tid, hit] of apiThreadResults.entries()) {
    if (now - hit.ts > API_RESULT_TTL_MS) apiThreadResults.delete(tid);
  }
  if (apiFiles.size > 200) {
    // 附件登记只按容量截断（文件本身在 TMP_DIR，系统自己清）
    const excess = apiFiles.size - 200;
    let i = 0;
    for (const k of apiFiles.keys()) {
      if (i++ >= excess) break;
      apiFiles.delete(k);
    }
  }
}

// ── bridge.ts 运行时依赖（initApiRoutes 注入） ──────────────────────────

export interface ApiDeps {
  /** channelId → channel-server ws 会话（在线判定 + Envelope 投递目标） */
  clients: Map<string, { ws: unknown; cwd?: string }>;
  deliver: (env: Envelope) => Promise<{ envelope: Envelope; outcome: { kind: string; [k: string]: unknown } }>;
  mirrorApiExchange: (to: ApiUserEndpoint, agentChannelId: string, text: string) => Promise<void>;
  startTypingWithSafety: (channelId: string) => void;
  /** 完成通知抑制：API 触发的 turn 不 @ owner */
  lastMessageSource: Map<string, string>;
  handleEventsRequest: (req: Request, extraFilter?: EventFilter) => Response;
  // clear 端点的后台会话轮转收尾（依赖 bridge 本地 discord/startWatching，注入）
  scheduleClearRotation: (agentName: string, channelId: string, cwd: string, oldSid?: string) => void;
  /** v2.15+ 发 owner 通知（bridge 注入 notifyMaster）——peer 一键邀请被兑换时告知 */
  notifyOwner?: (content: string) => Promise<void>;
  /** v2.21.1+ 跨端已读:删该频道最近一条 Discord 完成 @(Web 端读过后清未读徽标) */
  clearCompletionPing?: (channelId: string) => Promise<boolean>;
}

let deps: ApiDeps | null = null;

export function initApiRoutes(d: ApiDeps): void {
  deps = d;
}

// ── 鉴权 + 通用 helper ──────────────────────────────────────────────────

/**
 * Bearer 鉴权 + 限流。失败直接返回 Response，成功返回 principal。
 * v2.10+ 也接受 ?token=<secret>（header 优先）：浏览器 EventSource 不能带
 * Authorization header，SSE 场景的标准折衷。secret 进 URL 的暴露面由「bridge
 * 默认只绑回环 + 对外自备反代/TLS」的既有边界兜住；非 SSE 调用仍应走 header。
 */
async function authApi(req: Request, url: URL): Promise<Principal | Response> {
  const auth = req.headers.get("Authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  // ?token= 只对 SSE 端点放行(EventSource 不能带 header 的折衷本意)——此前对
  // 全部 /api/v1/* 放行,secret 会进代理日志/浏览历史(Codex review 2026-08-26)
  const sseTokenOk = req.method === "GET" && url.pathname === "/api/v1/events";
  const secret = m?.[1]?.trim() || (sseTokenOk ? url.searchParams.get("token") || "" : "");
  if (!secret) return apiJson(401, { ok: false, error: "missing Authorization: Bearer <secret> (only GET /events may use ?token=)" });
  const file = await readPrincipals();
  const p = findByBearer(file, secret);
  if (!p) return apiJson(401, { ok: false, error: "invalid or revoked token" });
  const tid = tokenIdOf(p);
  let limiter = apiLimiters.get(tid);
  if (!limiter) {
    // 120/min:默认 30 在 web 重度使用下会被打爆——SSE 重连风暴(每次重连烧
    // 连流+历史+列表轮询+pending 一整套)循环触发 429 → 直播流死掉 → 「收不到
    // 回复/没有思考中」(2026-07-14 真机)。个人部署,提额比精打细算更实际。
    limiter = new SlidingWindowLimiter(API_RATE_LIMIT_PER_MIN);
    apiLimiters.set(tid, limiter);
  }
  // 文案跟着上面的常量走 —— 曾经硬写 30 而实际是 120,撞限流的人拿到的是个假数字
  if (!limiter.tryAcquire()) return apiJson(429, { ok: false, error: `rate limit exceeded (${API_RATE_LIMIT_PER_MIN} req/min)` });
  if (p.peer) void import("./peer-presence.js").then((m) => m.notePeerInbound(p.peer!)); // 在线 peer 列表的「最近来访」
  return p;
}

/** registry 名双向兼容（"worker" ↔ "agent-worker"），返回 manager list 里的条目 */
async function findApiAgent(name: string): Promise<{ name: string; channelId: string; idle?: boolean; status?: string; purpose?: string; cwd?: string; sessionId?: string } | null> {
  // master 特判：master 不在 registry。channelId = CONTROL_CHANNEL_ID，
  // cwd 优先取 channel-server 注册信息（在线时准确），离线回退 MASTER_DIR；
  // sessionId probe 该 cwd 下最新 jsonl（历史 API 用）。scope 把关在各端点的
  // agentInScope（master 必须显式列入 token scope，"*" 不含 master）。
  if (name === "master" && CONTROL_CHANNEL_ID) {
    const client = deps?.clients.get(CONTROL_CHANNEL_ID);
    const cwd = client?.cwd || MASTER_DIR;
    return {
      name: "master",
      channelId: CONTROL_CHANNEL_ID,
      status: client ? "active" : "stopped",
      purpose: "master orchestrator (大总管)",
      cwd,
      // master 恒为 Claude Code（硬规则），显式给 runtime 免得走 Pi 分支
      sessionId: latestSessionIdForCwd(cwd, "claude-code"),
    };
  }
  try {
    const listResult = await runManager("list");
    const agents = (listResult.agents || []) as any[];
    return agents.find((a) => a.name === name || a.name === `agent-${name}` || `agent-${a.name}` === name) ?? null;
  } catch {
    return null;
  }
}

/**
 * v2.21.4 历史端点专用的 agent 查找:只读 registry.json,不再 spawn `manager list`
 * (findApiAgent 每次起一个 bun 子进程 ≈150–200ms,是差量同步「正在同步消息」的
 * 固定开销大头,owner 2026-09-06)。历史端点只需要 cwd / sessionId / 名字。
 */
async function findHistoryAgent(
  name: string,
): Promise<{ name: string; cwd?: string; sessionId?: string; runtime?: string } | null> {
  if (name === "master") return findApiAgent(name);
  const { readRegistryAgents } = await import("../lib/registry.js");
  const regs = await readRegistryAgents();
  const hit = regs.find((a) => a.name === name || a.name === `agent-${name}` || `agent-${a.name}` === name);
  // v2.23+ 带上 runtime：Pi 的会话文件要扫目录、行要翻译
  return hit ? { name: hit.name, cwd: hit.cwd, sessionId: hit.sessionId, runtime: hit.runtime } : null;
}

/**
 * 会话文件里最后一条真实对话记录（user/assistant，带 timestamp）的时间。
 *
 * 不能用文件 mtime 当「最近对话时间」：CC 会持续原地更新状态类记录
 * （last-prompt / mode / file-history-snapshot 等），且自己的 housekeeping
 * 还会周期性 touch 会话文件（2026-08-10 实测：12 个 agent 的 jsonl 被逐个
 * touch，字节与归档副本 cmp 完全一致）——空闲 agent 的 mtime 一直在刷新，
 * 列表排序就出现「没动静的 agent 莫名顶到最前」
 * （2026-07-13 router；2026-08-10 qingniao-miniapp owner 报「我明明啥也没干」）。
 *
 * 扫描策略（v2.18.1 修正）：tail 逐级放宽 256KB → 2MB → 8MB 逆序找，命中即停；
 * 长期只被 restart 的 agent，尾部窗口可能全是重启残渣（No response requested. +
 * /model 命令记录 + file-history-snapshot），真实对话被挤到更早的位置。
 * 全读完仍找不到 → convTs 为 **null**（旧实现退回 mtime，等于把「CC 摸过文件」
 * 当成活动，正是上面那个 bug 的直接成因；调用方退回 registry.created 更诚实）。
 * 按 (path, mtimeMs) 缓存——mtime 没变不重读，放宽窗口的读放大只在 touch 后发生一次。
 */
const tailInfoCache = new Map<string, { mtimeMs: number; info: SessionTailInfo }>();
export async function sessionTailInfo(path: string): Promise<SessionTailInfo | null> {
  try {
    const st = statSync(path);
    const hit = tailInfoCache.get(path);
    if (hit && hit.mtimeMs === st.mtimeMs) return hit.info;
    let info: SessionTailInfo = {
      convTs: null, ctxTokens: null, model: null, modelTs: null, effort: null, effortTs: null,
    };
    for (const win of TAIL_WINDOWS) {
      const start = Math.max(0, st.size - win);
      info = scanSessionTail(await Bun.file(path).slice(start, st.size).text(), runtimeForSessionPath(path));
      // 真实对话已命中，或已经读到文件头（再放宽也没有新内容）→ 收工
      if (info.convTs !== null || start === 0) break;
    }
    tailInfoCache.set(path, { mtimeMs: st.mtimeMs, info });
    return info;
  } catch {
    return null;
  }
}

/**
 * claude-settings 切换的乐观显示（owner 2026-07-27:「切换完直接把模型显示成
 * 新的，读到 jsonl 不一样再改」）。注入 /model、/effort 成功后先记在这里，
 * agents 列表优先显示；一旦 jsonl 里实测到**切换之后**的记录（无论值是否一致），
 * 实测重新接管并清掉本条——注入静默失败最多骗到下一条消息为止。
 * 内存态，bridge 重启即退回纯实测链（可接受:只差一条消息的显示滞后）。
 */
const claudeSwitchOverride = new Map<
  string,
  { model?: { v: string; ts: number }; effort?: { v: string; ts: number } }
>();
const overrideKey = (name: string) => String(name).replace(/^agent-/, "");

/** 记一次"刚切换"的乐观值（Claude Code 与 Pi 两条切换路径共用） */
function rememberSwitchOverride(name: string, patch: { model?: string; effort?: string }): void {
  const key = overrideKey(name);
  const prev = claudeSwitchOverride.get(key) ?? {};
  const now = Date.now();
  claudeSwitchOverride.set(key, {
    model: patch.model ? { v: patch.model, ts: now } : prev.model,
    effort: patch.effort ? { v: patch.effort, ts: now } : prev.effort,
  });
}

/** jsonl 实测超过此时限视为陈旧——重启后一轮没跑过的 agent,老会话里的模型
 *  读数是老黄历(2026-07-27 实例:5 月的 opus-4-7 盖过了 registry 钉的 opus-5),
 *  显示回退到 registry/全局配置更接近「下一轮会用什么」。 */
const CLAUDE_READ_STALE_MS = 7 * 24 * 3600_000;
const freshOrNull = <T>(v: T | null | undefined, ts: number | null | undefined): T | null =>
  v != null && ts != null && Date.now() - ts < CLAUDE_READ_STALE_MS ? v : null;
/** 列表侧取乐观值:比实测记录新才算数;两个字段都被实测追上就顺手清掉 */
function pickClaudeOverride(name: string, info: SessionTailInfo | null | undefined) {
  const key = overrideKey(name);
  const ov = claudeSwitchOverride.get(key);
  if (!ov) return { model: null as string | null, effort: null as string | null };
  const model = ov.model && ov.model.ts > (info?.modelTs ?? 0) ? ov.model.v : null;
  const effort = ov.effort && ov.effort.ts > (info?.effortTs ?? 0) ? ov.effort.v : null;
  if (model === null && effort === null) claudeSwitchOverride.delete(key);
  return { model, effort };
}

// ── v2.15+ 一键邀请兑换（无 Bearer 的公开端点，见 handleApiRequest 顶部）──

const redeemLimiter = new SlidingWindowLimiter(10, 60_000);

async function handlePeerRedeem(req: Request): Promise<Response> {
  if (!redeemLimiter.tryAcquire()) {
    return apiJson(429, { ok: false, error: "rate limited" });
  }
  const body: any = await readJsonBody(req);
  if (body === INVALID_JSON) return invalidJsonBody();
  const join = typeof body?.join === "string" ? body.join.trim() : "";
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const peerUrl = typeof body?.url === "string" ? body.url.trim() : "";
  const token = typeof body?.token === "string" ? body.token.trim() : "";
  if (!join || !name) return apiJson(400, { ok: false, error: '"join" and "name" required' });
  const r: any = await runManager(
    "peer-invite-redeem", "--join", join, "--name", name,
    ...(peerUrl ? ["--url", peerUrl] : []), ...(token ? ["--token", token] : []),
  );
  if (r?.ok) {
    recordMetric("peer_managed", { meta: { action: "redeem", peer: r.peer } });
    console.log(`🤝 [api] peer 邀请已兑换: ${r.peer}（scope: ${(r.agents || []).join(",")}）`);
    void deps?.notifyOwner?.(
      `🤝 新 peer「${r.peer}」通过一键邀请接入，可访问: ${(r.agents || []).join(", ") || "（无）"}` +
        (r.oneWay ? "（单向：对方访问我，我未获对方权限）" : "") +
        `。撤销：Web 设置 → Peer 协作 → 移除，或 \`peer-http-remove ${r.peer}\``,
    ).catch(() => {});
  }
  // 失败一律 400 且不细分原因等级——这是个无鉴权端点，不给探测者更多信息面
  return apiJson(r?.ok ? 200 : 400, r ?? { ok: false, error: "manager failed" });
}

// ── 路由分发 ────────────────────────────────────────────────────────────

/**
 * /api/v1 入口（bridge.ts 调它，不直接调 handleApiRequest）。handler 里逃逸的异常以前一路冒到 Bun.serve，而 Bun 在没设 NODE_ENV 时
 * （launchd 就不设）回的是 67KB 的 HTML 调试页——web 端拿到的不是 JSON（D5-11）。
 * 最常见的来源是路由正则匹配后的 decodeURIComponent 遇到非法百分号编码抛 URIError：
 * 那是请求的错，回 400；其余回 500，body 都是 {ok:false,error}。
 */
export async function serveApiRequest(req: Request, url: URL): Promise<Response> {
  try {
    return await handleApiRequest(req, url);
  } catch (e) {
    return apiErrorResponse(e);
  }
}

// 路由本体保持原名：防腐闸门按函数名给超长函数记账（fnLong:handleApiRequest）
async function handleApiRequest(req: Request, url: URL): Promise<Response> {
  if (!deps) return apiJson(503, { ok: false, error: "api routes not initialized" });

  // v2.15+ POST /api/v1/peers/redeem —— 一键邀请的兑换回调（对方 bridge 打进来，
  // 拿不到我方 Bearer）。鉴权依据是 body 里的一次性 joinSecret（manager 侧常数
  // 时间比对）。48 hex 穷举本不现实，限流是纵深防御 + 挡日志噪音。
  if (url.pathname === "/api/v1/peers/redeem" && req.method === "POST") {
    return handlePeerRedeem(req);
  }

  const auth = await authApi(req, url);
  if (auth instanceof Response) return auth;
  const principal = auth;
  const tokenId = tokenIdOf(principal);
  const path = url.pathname.slice("/api/v1".length);

  // GET /api/v1/agents —— scope 内的 agent 快照
  if (path === "/agents" && req.method === "GET") {
    try {
      const listResult = await runManager("list");
      // v2.23+「已归档」标记：归档区里有这个 agent 的话标出来，网页据此把它从工作列表
      // 隐藏（归档 = 收起来，不是删掉；恢复时归档目录被清掉，它自然回到列表）。
      // 为什么不靠 kill：列表本来就包含已停止的 agent（灰点），光停窗口移不出去。
      const { USER_ARCHIVE_ROOT } = await import("../lib/session-archive.js");
      const { existsSync: existsSyncFs } = await import("node:fs");
      const agents = ((listResult.agents || []) as any[])
        .filter((a) => agentInScope(principal, a.name))
        .map((a) => ({
          name: a.name,
          status: a.status,
          idle: a.idle,
          purpose: a.purpose,
          created: a.created,
        }));
      // busy：正在回合中（hook 驱动的 agent_status，与 /pending 的
      // thinking 同源——manager list 的 tmux idle 探测在回合中也常报 idle，
      // 不可靠，只作 OR 兜底）。web 列表的黄色状态点数据源。
      // 第三信号(2026-07-16「两个 working 只有点进去过的才黄」):event-bus 状态
      // 随 bridge 重启清零且回合中途不再有新事件——重启后正在跑的 agent 状态
      // undefined、idle 探测又误报空闲 → 黄标失灵。对这类状态不明的 active
      // agent 补一发 pane spinner 探测(与 deliverToLocal 抢占判据同款三信号)。
      await Promise.all(
        (agents as any[]).map(async (a) => {
          const st = getAgentStatus(a.name) ?? getAgentStatus(String(a.name).replace(/^agent-/, ""));
          a.busy = isBusyStatus(st) || a.idle === false;
          // v2.23+ 已归档标记（真正的列表构建器在这里 —— 上面那个 map 不是生效路径，
          // 2026-09-14 我改错过一次）：归档区里有它的目录 ⇒ 网页把它从工作列表隐藏。
          try {
            const { USER_ARCHIVE_ROOT } = await import("../lib/session-archive.js");
            const { existsSync: ex } = await import("node:fs");
            (a as any).archived = ex(`${USER_ARCHIVE_ROOT}/${String(a.name).replace(/^agent-/, "")}`);
          } catch {
            /* 归档区读不到就当作未归档 */
          }
          // v2.21.2+ 正在压缩上下文(侧栏/列表可区分于普通忙碌)
          a.compacting = st === "compacting";
          if (!a.busy && st === undefined && a.status !== "stopped") {
            try {
              const tail = (await tmuxRaw(["capture-pane", "-t", windowTarget(a.name), "-p"]))
                .split("\n")
                .slice(-10)
                .join("\n");
              if (paneLooksWorking(tail)) a.busy = true;
            } catch {
              /* 窗口不存在等,保持不忙 */
            }
          }
        })
      );
      // lastActivityTs：agent 最后一条真实对话的时间（不是 mtime——见
      // sessionTailInfo 注释）。contextTokens:当前上下文占用(web 端超标提示)。
      {
        const { readRegistryAgents } = await import("../lib/registry.js");
        const regs = await readRegistryAgents();
        const regByName = new Map(regs.map((r) => [r.name, r]));
        const bySessions = new Map<string, SessionTailInfo>();
        for (const r of regs) {
          if (!r.cwd || !r.sessionId) continue;
          // v2.23+ runtime 感知：Pi 的会话文件在 ~/.pi/agent/sessions/ 下，拿 CC 路径
          // 去找必然空手 → model/effort 回落全局默认（owner 实测：Pi agent 顶栏显示
          // 「Opus 5 · xhigh」，实际是 deepseek-v4.1-flash + thinking off）
          const path = sessionJsonlPath(r.runtime, r.cwd, r.sessionId);
          if (!path) continue;
          const info = await sessionTailInfo(path);
          if (info) bySessions.set(r.name, info);
        }
        // model/effort 兜底链末端:全局默认(settings.json)
        let gModel: string | null = null;
        let gEffort: string | null = null;
        try {
          const s = JSON.parse(await Bun.file(`${process.env.HOME}/.claude/settings.json`).text());
          if (typeof s.model === "string") gModel = s.model;
          if (typeof s.effortLevel === "string") gEffort = s.effortLevel;
        } catch { /* 无全局默认 */ }
        for (const a of agents) {
          const info = bySessions.get(a.name);
          const r = regByName.get(a.name);
          (a as any).lastActivityTs = info?.convTs ?? null;
          (a as any).contextTokens = info?.ctxTokens ?? null;
          // v2.21+ project 归属(web 侧栏分组数据源;master 特判无此字段)
          (a as any).projectId = r?.projectId ?? null;
          // 运行时徽章 + 顶栏挂哪种切换器的数据源：如实透传（未知/缺失 = claude-code），只认 pi 的话 Codex 会拿到 CC 面板
          (a as any).runtime = sourceFor(r?.runtime).id;
          // 当前模型/effort。显示链:刚切换的乐观值(实测追上前) → jsonl 实测
          // (会话内切换即时反映,防 registry 漂移) → registry 钉的(创建/切换
          // 端点写入) → 全局默认
          const ov = pickClaudeOverride(a.name, info);
          // 实测过旧(重启后没跑过回合)不参与,回退 registry/全局;全部落空才用陈旧值兜底
          (a as any).model =
            ov.model ??
            freshOrNull(info?.model, info?.modelTs) ??
            // Pi 的 model 是 provider/id（如 cc-switch-open-code-go/deepseek-v4.1-flash），
            // 不能拿 Claude Code 的别名表去改写它
            (r?.model ? (r.runtime === "pi" ? r.model : resolveModelAlias(r.model)) : null) ??
            gModel ??
            info?.model ??
            null;
          const piRuntime = r?.runtime === "pi";
          // Pi 的 thinking 档位通常只在开场写一条 thinking_level_change，落在会话文件的
          // **头部**，而 session-tail 只扫尾部窗口 ⇒ 扫不到、回落全局默认（实测顶栏显示
          // xhigh 而实际是 off/max）。扩展在启动时把运行实况写进了快照，这里用它兜底；
          // tail 扫到更新鲜的值时优先（会话内切换思考档位的情况）。
          const piSnap = piRuntime ? readPiRuntimeSnapshot(a.name) : null;
          (a as any).effort = piRuntime
            ? (info?.effort ?? piSnap?.thinking ?? r?.effort ?? null)
            : (ov.effort ?? freshOrNull(info?.effort, info?.effortTs) ?? r?.effort ?? gEffort ?? info?.effort ?? null);
        }
        // 「该重启/该 pi update」提示：不给 peer（不向别的实例透露本机确切版本）；出任何错都只少个提示，不能让整张列表 500
        if (!principal.peer) await import("../lib/update-hints.js").then((m) => m.attachUpdateHints(agents as any[], regByName))
          .catch((e) => console.warn("⚠️ [api] 更新提示附加失败（列表照常返回）:", e));
      }
      // ?include=stopped：registry 里已停止的 agent 也入列（additive；
      // web 侧栏保留 stopped 会话入口，其历史经归档仍可读——正是归档的意义）。
      if (url.searchParams.get("include") === "stopped") {
        const { readRegistryAgents } = await import("../lib/registry.js");
        const { projectJsonlPath } = await import("../lib/jsonl-cost.js");
        const listed = new Set(agents.map((a) => a.name));
        for (const r of await readRegistryAgents()) {
          if (listed.has(r.name) || !agentInScope(principal, r.name)) continue;
          let ts: number | null = null;
          if (r.cwd && r.sessionId) {
            ts = (await sessionTailInfo(projectJsonlPath(r.cwd, r.sessionId)))?.convTs ?? null;
          }
          // ⚠ 已停止的 agent 走这条**独立路径**进来（不在 manager list 里），
          // 归档标记必须在这也带一份 —— 上一版只在上面的 .map() 里加了，结果灰点的
          // 归档 agent 照样留在列表里（owner「被归档，但是还是在列表里」，2026-09-14）。
          agents.push({
            name: r.name,
            status: "stopped",
            idle: undefined,
            purpose: r.purpose,
            lastActivityTs: ts,
            created: (r as any).created,
            projectId: r.projectId ?? null,
            archived: existsSyncFs(`${USER_ARCHIVE_ROOT}/${String(r.name).replace(/^agent-/, "")}`),
          } as any);
        }
      }
      // master 入列（token scope 显式含 "master" 才可见，"*" 不含）。
      // web 前端的「大总管」置顶入口靠它。
      if (CONTROL_CHANNEL_ID && agentInScope(principal, "master")) {
        // master 的 model/effort:probe 其 cwd 最新 jsonl(master 不在 registry)
        let mInfo: SessionTailInfo | null = null;
        try {
          const mCwd = deps.clients.get(CONTROL_CHANNEL_ID)?.cwd || MASTER_DIR;
          const mSid = latestSessionIdForCwd(mCwd);
          if (mCwd && mSid) {
            const { projectJsonlPath } = await import("../lib/jsonl-cost.js");
            mInfo = await sessionTailInfo(projectJsonlPath(mCwd, mSid));
          }
        } catch { /* master 会话 probe 失败不影响列表 */ }
        // master 不在 registry:jsonl 实测之外只剩全局默认这级兜底
        let mgModel: string | null = null;
        let mgEffort: string | null = null;
        try {
          const s = JSON.parse(await Bun.file(`${process.env.HOME}/.claude/settings.json`).text());
          if (typeof s.model === "string") mgModel = s.model;
          if (typeof s.effortLevel === "string") mgEffort = s.effortLevel;
        } catch { /* 无全局默认 */ }
        const mOv = pickClaudeOverride("master", mInfo);
        agents.unshift({
          name: "master",
          status: deps.clients.has(CONTROL_CHANNEL_ID) ? "active" : "stopped",
          idle: undefined,
          purpose: "master orchestrator (大总管)",
          busy: isBusyStatus(getAgentStatus("master")),
          compacting: getAgentStatus("master") === "compacting",
          model: mOv.model ?? freshOrNull(mInfo?.model, mInfo?.modelTs) ?? mgModel ?? mInfo?.model ?? null,
          effort: mOv.effort ?? freshOrNull(mInfo?.effort, mInfo?.effortTs) ?? mgEffort ?? mInfo?.effort ?? null,
        } as any);
      }
      return apiJson(200, { ok: true, agents });
    } catch (e) {
      return apiJson(500, { ok: false, error: (e as Error).message });
    }
  }

  // v2.7+ GET /api/v1/sessions —— 全机器 Claude 会话清单（agents 模式适配，
  // 中性 NeutralSessionInfo；Discord 面板与 web 前端共用同一数据源）。
  // scope 规则：全权 token（"*"）看全部（含野生会话）；受限 token 只看 scope
  // 内 agent 的正式会话及其分身。
  if (path === "/sessions" && req.method === "GET") {
    const list = await collectSessions();
    if (list === null) return apiJson(503, { ok: false, error: "claude agents --json unavailable" });
    const full = principal.agents.includes("*");
    const visible = full
      ? list
      : list.filter((s) => {
          const owner = s.registeredAgent ?? s.doppelgangerOf;
          return owner ? agentInScope(principal, owner) : false;
        });
    return apiJson(200, { ok: true, sessions: visible });
  }

  // v2.23+ GET /api/v1/pi-models —— Pi provider 配了哪些模型（web 模型选择器用）。
  // 与 /config/claude-defaults 的分工：那个是 Claude Code 的全局默认；这个是 Pi 侧
  // ~/.pi/agent/models.json 里 providers[].models[]，给 Pi agent 的选择器渲染用。
  if (path === "/pi-models" && req.method === "GET") {
    if (!isFullScope(principal)) return forbidden("pi-models requires a full-scope token");
    try {
      const raw = JSON.parse(await Bun.file(`${process.env.HOME}/.pi/agent/models.json`).text());
      const models: Array<Record<string, unknown>> = [];
      for (const [provider, cfg] of Object.entries<any>(raw?.providers ?? {})) {
        for (const m of cfg?.models ?? []) {
          models.push({
            id: `${provider}/${m.id}`,
            provider,
            name: m.name ?? m.id,
            input: Array.isArray(m.input) ? m.input : ["text"],
            images: Array.isArray(m.input) && m.input.includes("image"),
            thinking: m.reasoning === true,
            contextWindow: m.contextWindow ?? null,
          });
        }
      }
      return apiJson(200, { ok: true, count: models.length, models });
    } catch (e) {
      return apiJson(500, { ok: false, error: `读取 models.json 失败: ${(e as Error).message}` });
    }
  }

  // GET /api/v1/remote-access —— 网页「手机访问」面板：Tailscale 状态、每个入口（可达 / 证书剩余天数）、
  // 建议。只读：绝不在这里配 serve 或改任何机器配置（那只在 setup 的交互终端里、经用户同意做）。
  // 全权 token：返回里有 tailnet 主机名、CLI 路径、监听地址这些机器信息。peer token 即便是 `*`
  // 也拒：那是另一台 Claudestra，本机的网络盘点不该给它。
  if (path === "/remote-access" && req.method === "GET") {
    if (!principal.agents.includes("*") || principal.peer) {
      return apiJson(403, { ok: false, error: "remote-access requires a full-scope token" });
    }
    const { remoteAccessSnapshot } = await import("../lib/tailscale.js");
    const { readWebPort } = await import("../lib/doctor-remote.js");
    try {
      // ?fresh=1：面板上的「重新检测」要绕过 60 秒缓存（刚配完 serve / 刚续完证书就想看结果）
      const maxAge = url.searchParams.get("fresh") === "1" ? 0 : 60_000;
      return apiJson(200, { ok: true, ...(await remoteAccessSnapshot(readWebPort(REPO_ROOT), maxAge)) });
    } catch (e) {
      return apiJson(500, { ok: false, error: `探测失败: ${(e as Error).message}` });
    }
  }

  // GET /api/v1/claude-models —— Claude Code 的模型目录（web 三处模型下拉用）。
  // 与 /pi-models 对称：那个读 Pi 的 models.json；这个读 CC 自己拉的目录（本地缓存 →
  // 公开端点 → 别名表兜底），见 lib/model-catalog.ts。目录本身是公开的，不限 scope。
  // ponytail: 每次请求现读；本地缓存缺失时每次都会打一次公开端点（5s 超时），
  // 只在没跑过 CC 的机器上发生，真成问题再加内存 TTL。
  if (path === "/claude-models" && req.method === "GET") {
    const { loadModelCatalog } = await import("../lib/model-catalog.js");
    const catalog = await loadModelCatalog();
    return apiJson(200, { ok: true, source: catalog.source, count: catalog.models.length, models: catalog.models });
  }

  // v2.23+ POST /api/v1/agents/:name/pi-settings —— Pi agent 切模型/思考档位。
  // 与 claude-settings 的分工：那个注入 Claude Code 的 `/model`、`/effort`；Pi 侧
  // 的 `/model` 是**打开选择器**的交互语义（未验证收不收参数），所以走我们自己扩展
  // 注册的确定性命令 `/claudestra-model <provider/id>`、`/claudestra-thinking <level>`
  // （扩展内部直接调 setModel/setThinkingLevel），注入方式与 CC 相同：tmux send-keys。
  const piSetMatch = path.match(/^\/agents\/([^/]+)\/pi-settings$/);
  if (piSetMatch && req.method === "POST") {
    if (!isFullScope(principal)) return forbidden("pi-settings requires a full-scope token");
    const agentName = decodeURIComponent(piSetMatch[1]);
    const canonical = agentName.startsWith("agent-") ? agentName : `agent-${agentName}`;
    if (!agentInScope(principal, canonical)) return notInScope(canonical);
    const body: any = await readJsonBody(req);
    if (body === INVALID_JSON) return invalidJsonBody();
    const model = String(body?.model || "").trim();
    const effort = String(body?.effort || "").trim();
    if (!model && !effort) {
      return apiJson(400, { ok: false, error: 'body must be {"model"?,"effort"?}' });
    }
    // effort 原样进 tmux send-keys -l：不校验 = 换行即可向 agent TUI 注入第二行任意输入
    if (effort && !isPiThinkingLevel(effort)) {
      return apiJson(400, { ok: false, error: `未知的 thinking 档位：${effort}` });
    }
    if (model && !/^[A-Za-z0-9._\/@:-]+$/.test(model)) {
      return apiJson(400, { ok: false, error: "model 含非法字符" });
    }
    const agents = await readRegistryAgents();
    const reg = agents.find((a) => a.name === canonical);
    if (!reg) return apiJson(404, { ok: false, error: `agent "${canonical}" not found` });
    if (reg.runtime !== "pi") {
      return apiJson(400, { ok: false, error: `agent "${canonical}" 不是 Pi agent（用 /claude-settings）` });
    }
    // 模型 id 先对着 models.json 校验：扩展内部解析不到会拒绝，而桥接这边的"乐观显示"
    // 没法知道注入的结果 ⇒ 假 id 会在顶栏显示一个根本不存在的模型（实测踩过）。
    if (model) {
      try {
        const raw = JSON.parse(await Bun.file(`${process.env.HOME}/.pi/agent/models.json`).text());
        const ids = new Set<string>();
        for (const [provider, cfg] of Object.entries<any>(raw?.providers ?? {})) {
          for (const m of cfg?.models ?? []) ids.add(`${provider}/${m.id}`);
        }
        if (ids.size && !ids.has(model)) {
          return apiJson(400, { ok: false, error: `未知的 Pi 模型：${model}` });
        }
      } catch { /* 读不到清单就不拦（扩展侧仍会拒绝） */ }
    }
    const { tmuxSendLine, windowTarget } = await import("../lib/tmux-helper.js");
    const target = windowTarget(canonical);
    try {
      if (model) await tmuxSendLine(target, `/claudestra-model ${model}`);
      if (effort) await tmuxSendLine(target, `/claudestra-thinking ${effort}`);
    } catch (e) {
      return apiJson(500, { ok: false, error: `注入失败: ${(e as Error).message}` });
    }
    // 乐观显示：与 claude-settings 同款（切换生效前让顶栏先跟着变）
    rememberSwitchOverride(canonical, { ...(model ? { model } : {}), ...(effort ? { effort } : {}) });
    return apiJson(200, { ok: true, agent: canonical, model: model || null, effort: effort || null });
  }

  // v2.23+ GET /api/v1/session-list —— 机器上所有会话（两种 runtime，活的+历史的）。
  // 与 /sessions 的区别：那个是 Claude Code 的**活**会话清单（doppelganger 检测用，
  // NeutralSessionInfo）；这个是 manager 扫盘得到的**会话历史清单**（含未纳管的
  // pi-web / 终端手敲的 Pi 会话），供 web 端「会话列表」用。仅全权 token。
  if (path === "/session-list" && req.method === "GET") {
    if (!principal.agents.includes("*")) {
      return apiJson(403, { ok: false, error: "session-list requires a full-scope token" });
    }
    const r = await runManager("sessions");
    if (!r?.ok) return apiJson(500, { ok: false, error: r?.error || "manager sessions failed" });
    // 标出哪些已经纳管（有 registry 条目）—— Web 端据此决定「收编」还是「打开对话」
    const regs = await readRegistryAgents();
    const byId = new Map<string, string>();
    for (const a of regs) if (a.sessionId) byId.set(a.sessionId, a.name);
    const sessions = ((r.sessions as any[]) || []).map((s) => ({
      ...s,
      agentName: byId.get(String(s.sessionId)) ?? null,
      // 目录已消失（/tmp 被清、项目搬走）→ 收编必然失败，提前标出来别让用户白试
      cwdExists: typeof s.cwd === "string" && s.cwd ? existsSync(s.cwd) : false,
      manageable: sourceFor(String(s.runtime ?? "")).manageable, // 取自运行时适配器：前端据此给不给「收编」按钮
    }));
    return apiJson(200, { ok: true, count: sessions.length, sessions });
  }

  // v2.24+ GET /api/v1/runtimes —— 可建 agent 的运行时 + 本机能不能用（见 lib/runtimes/catalog.ts）
  if (path === "/runtimes" && req.method === "GET") {
    if (!principal.agents.includes("*")) return apiJson(403, { ok: false, error: "runtimes requires a full-scope token" });
    return apiJson(200, { ok: true, runtimes: await runtimeCatalog() });
  }

  // v2.7+ POST /api/v1/sessions/:bgId/cleanup —— 清理 bg job（死分身/残留）。
  // 耗时操作（kill → 等 daemon 静默 → 隔离目录，最长 ~90s）→ 202 后台执行，
  // 结果以 session_anomaly kind=cleanup_result 进事件流。仅全权 token。
  const cleanupMatch = path.match(/^\/sessions\/([^/]+)\/cleanup$/);
  if (cleanupMatch && req.method === "POST") {
    if (!isFullScope(principal)) return forbidden("cleanup requires a full-scope token");
    const bgId = decodeURIComponent(cleanupMatch[1]);
    const list = await collectSessions();
    const target = list?.find((s) => s.bgId === bgId && s.kind === "background");
    if (!target) return apiJson(404, { ok: false, error: `bg session "${bgId}" not found` });
    cleanupBgJob(bgId, { pid: target.pid })
      .then((r) => {
        emitEvent({
          agent: target.doppelgangerOf ?? target.name ?? bgId,
          chatId: "",
          type: "session_anomaly",
          data: { kind: "cleanup_result", bgId, ...r },
        });
      })
      .catch(() => {});
    return apiJson(202, {
      ok: true,
      accepted: true,
      hint: "cleanup runs in background; watch /api/v1/events for session_anomaly kind=cleanup_result",
    });
  }

  // v2.7+ POST /api/v1/sessions/:sessionId/adopt —— 收编：把该 session 立为
  // 某正式 agent 的会话并重启拉起（body: {"agent": "<name>"}）。仅全权 token。
  const adoptMatch = path.match(/^\/sessions\/([^/]+)\/adopt$/);
  if (adoptMatch && req.method === "POST") {
    if (!isFullScope(principal)) return forbidden("adopt requires a full-scope token");
    const sid = decodeURIComponent(adoptMatch[1]);
    let agentName = "";
    try {
      agentName = String(((await req.json()) as any)?.agent || "");
    } catch {
      /* fallthrough → 400 */
    }
    if (!agentName) return apiJson(400, { ok: false, error: 'body must be {"agent": "<name>"}' });
    runManager("adopt", agentName, sid)
      .then((r) => {
        emitEvent({
          agent: agentName,
          chatId: "",
          type: "session_anomaly",
          data: { kind: "adopt_result", sessionId: sid, ok: !!r?.ok, ...r },
        });
      })
      .catch(() => {});
    return apiJson(202, {
      ok: true,
      accepted: true,
      hint: "adoption runs in background (~1-2 min); watch /api/v1/events for session_anomaly kind=adopt_result",
    });
  }

  // v2.23+ POST /api/v1/agents/:name/archive —— 给某个 agent 的当前会话做快照
  // （= CLI `manager archive <name>`；**不动 agent 本身**，非破坏性）。
  // 网页侧栏 agent 行左滑「归档」用它。仅全权 token。
  const archMatch = path.match(/^\/agents\/([^/]+)\/archive$/);
  if (archMatch && req.method === "POST") {
    if (!isFullScope(principal)) return forbidden("archive requires a full-scope token");
    const name = decodeURIComponent(archMatch[1]);
    if (!isPathSafeName(name)) return apiJson(400, { ok: false, error: "invalid agent name" });
    if (!agentInScope(principal, name)) return apiJson(403, { ok: false, error: "agent out of scope" });
    // 大总管不参与归档（它是常驻调度器；把它归档掉 = 侧栏消失，2026-09-14 我的测试脚本
    // 误选它当靶子，正好验证了这个坑必须堵）
    if (String(name).replace(/^agent-/, "") === "master") {
      return apiJson(400, { ok: false, error: "master 不参与归档" });
    }
    // **归档 = 分类**（owner 2026-09-14「他不是只是一个显示逻辑和分类问题吗」）：
    // 只建标记目录（瞬间）⇒ 列表立刻隐藏、归档栏立刻出现，请求亚秒返回；
    // 会话快照与停窗口 fire-and-forget 跑后台，卡住/失败都不影响分类结果。
    {
      const { USER_ARCHIVE_ROOT } = await import("../lib/session-archive.js");
      const { existsSync: ex2 } = await import("node:fs");
      const { mkdir: mk2 } = await import("node:fs/promises");
      if (!ex2(`${USER_ARCHIVE_ROOT}/${name}`)) {
        await mk2(`${USER_ARCHIVE_ROOT}/${name}`, { recursive: true }).catch(() => {});
      }
      void runManager("archive", name).catch(() => {});
      void runManager("kill", name).catch(() => {});
      return apiJson(200, { ok: true, archived: true, background: "快照 + 停窗口在后台跑" });
    }
  }

  // v2.23+ 归档保留天数读写（owner：90 天自动清理，天数在设置里改）。
  // GET 任何 token 可读；POST 需全权。0 = 永不清理。
  if (path === "/settings/archive-retention" && (req.method === "GET" || req.method === "POST")) {
    const { readConfig, setArchiveRetention, DEFAULT_ARCHIVE_RETENTION_DAYS } = await import("../lib/config-store.js");
    if (req.method === "GET") {
      const cfg = await readConfig();
      return apiJson(200, {
        ok: true,
        days: cfg.archiveRetentionDays ?? DEFAULT_ARCHIVE_RETENTION_DAYS,
        defaultDays: DEFAULT_ARCHIVE_RETENTION_DAYS,
      });
    }
    if (!isFullScope(principal)) return forbidden("changing archive retention requires a full-scope token");
    let body: any = {};
    try {
      body = await req.json();
    } catch {
      body = {};
    }
    const days = Number(body?.days);
    if (!Number.isFinite(days) || days < 0) {
      return apiJson(400, { ok: false, error: 'body must be {"days": <number >= 0>}' });
    }
    const cfg = await setArchiveRetention(days);
    return apiJson(200, { ok: true, days: cfg.archiveRetentionDays });
  }

  // v2.23+ POST /api/v1/sessions/archived/:id/restore —— 把归档条目**回归**：
  //   kind=agent     → manager resume <name> <sessionId>（回到工作列表）+ 删掉归档副本
  //   kind=unmanaged → 把会话文件搬回 meta 里记的原路径（重回「未纳管会话」）+ 删掉归档副本
  // 依赖归档时写的 .meta.json（cwd 编码不可逆，只能靠它还原位置）。仅全权 token。
  const restoreMatch = path.match(/^\/sessions\/archived\/([^/]+)\/restore$/);
  if (restoreMatch && req.method === "POST") {
    if (!isFullScope(principal)) return forbidden("restore requires a full-scope token");
    const rid = decodeURIComponent(restoreMatch[1]);
    if (!isPathSafeName(rid)) return apiJson(400, { ok: false, error: "invalid archive id" });
    const { USER_ARCHIVE_ROOT } = await import("../lib/session-archive.js");
    const fsp = await import("node:fs/promises");
    const dir = `${USER_ARCHIVE_ROOT}/${rid}`;
    let meta: any = null;
    try {
      meta = JSON.parse(await fsp.readFile(`${dir}/.meta.json`, "utf8"));
    } catch {
      /* 老条目没有 meta：agent 可以靠 registry 推，未纳管会话推不出来 */
    }
    const kind = meta?.kind ?? (await (async () => {
      const { readRegistryAgents } = await import("../lib/registry.js");
      const norm = (x: unknown) => String(x || "").replace(/^agent-/, "");
      return (await readRegistryAgents()).some((r) => norm(r.name) === norm(rid)) ? "agent" : "unmanaged";
    })());
    if (kind === "agent") {
      const { readRegistryAgents } = await import("../lib/registry.js");
      const { ARCHIVE_ROOT } = await import("../lib/session-archive.js");
      const norm = (x: unknown) => String(x || "").replace(/^agent-/, "");
      const info = (await readRegistryAgents()).find((r) => norm(r.name) === norm(rid));
      const sid = String(meta?.sessionId || (info as any)?.sessionId || "");
      // **第一步（关键）**：把它移出「归档」区 —— 工作列表的来源是 registry（含已停止的）
      // + tmux 窗口，归档只是 kill 了窗口，所以移出归档区它就**立刻回到列表**（stopped
      // 状态），不需要起窗口。owner 2026-09-14「你应该是回复到工作 list 先，这都无法成功吗」。
      // 不删除内容：挪到自动快照区 archive/<agent>/，防丢语义不变。
      try {
        await fsp.mkdir(`${ARCHIVE_ROOT}/${rid}`, { recursive: true });
        for (const f of await fsp.readdir(dir).catch(() => [])) {
          if (f === ".meta.json") continue;
          await fsp.rename(`${dir}/${f}`, `${ARCHIVE_ROOT}/${rid}/${f}`).catch(() => {});
        }
        await fsp.rm(dir, { recursive: true, force: true });
      } catch (e) {
        return apiJson(500, { ok: false, error: `移出归档区失败: ${(e as Error).message}` });
      }
      // 不再自动起窗口：resume 失败时会执行清理（实测把 registry 条目一起清掉 ⇒
      // 「恢复后它又消失了」✗）。恢复只负责**回到列表**（stopped 状态），起窗口由用户
      // 在列表里点重启 —— 那是他自己可控的动作，不会被后台任务反噬。
      return apiJson(200, {
        ok: true,
        kind: "agent",
        restored: true,
        window: sid ? "starting" : "skipped",
        hint: "已回到工作列表（stopped）；窗口在后台起，起来了会自动变活跃",
      });
    }
    const original = String(meta?.originalPath || "");
    if (!original) {
      return apiJson(400, { ok: false, error: "这条归档没有记录原始位置（老条目），只能手动恢复" });
    }
    try {
      await fsp.mkdir(original.split("/").slice(0, -1).join("/"), { recursive: true });
      const files = (await fsp.readdir(dir)).filter((f) => f !== ".meta.json");
      for (const f of files) {
        // 单个会话文件 → 直接搬回原始路径；其余（子会话目录等）→ 放在原文件同级的同名目录下
        const direct = files.length === 1 ? original : "";
        if (direct) {
          await fsp.rename(`${dir}/${f}`, direct);
        } else {
          const target = `${original.replace(/\.jsonl$/, "")}/${f}`;
          await fsp.mkdir(target.split("/").slice(0, -1).join("/"), { recursive: true });
          await fsp.rename(`${dir}/${f}`, target);
        }
      }
      await fsp.rm(dir, { recursive: true, force: true });
      return apiJson(200, { ok: true, kind: "unmanaged", restoredTo: original });
    } catch (e) {
      return apiJson(500, { ok: false, error: (e as Error).message });
    }
  }

  // v2.23+ GET /api/v1/sessions/archived —— 「归档」类别的内容：
  // 列 archive/archived/** （用户手动归档的会话本体）**不列** archive/<agent>/（自动快照）。
  if (path === "/sessions/archived" && req.method === "GET") {
    // 与其余 v2.23 会话端点一致：全权 token；否则 scoped/peer token 能枚举全部归档 agent
    if (!isFullScope(principal)) return forbidden("archived sessions require a full-scope token");
    const { USER_ARCHIVE_ROOT } = await import("../lib/session-archive.js");
    const fsp = await import("node:fs/promises");
    const entries: Record<string, unknown>[] = [];
    const walk = async (dir: string, id: string): Promise<void> => {
      let files = 0;
      let bytes = 0;
      let newest = 0;
      const rec = async (d: string): Promise<void> => {
        const list = await fsp.readdir(d, { withFileTypes: true }).catch(() => []);
        for (const e of list) {
          const full = `${d}/${e.name}`;
          if (e.isDirectory()) await rec(full);
          else {
            files++;
            const st = await fsp.stat(full).catch(() => null);
            if (st) {
              bytes += st.size;
              newest = Math.max(newest, st.mtimeMs);
            }
          }
        }
      };
      await rec(dir);
      entries.push({ id, sessions: files, bytes, archivedAt: newest });
    };
    const top = await fsp.readdir(USER_ARCHIVE_ROOT, { withFileTypes: true }).catch(() => []);
    for (const e of top) {
      if (!e.isDirectory()) continue; // 目录里只有目录，单个文件也允许
      await walk(`${USER_ARCHIVE_ROOT}/${e.name}`, e.name);
    }
    entries.sort((a, b) => Number(b.archivedAt || 0) - Number(a.archivedAt || 0));
    return apiJson(200, { ok: true, entries });
  }

  // v2.23+ GET /api/v1/capabilities —— 这台机器支持什么（当前只有 Pi 有没有装）。
  // 给网页用：没装 Pi 的用户应该**无感**（新建 agent 里不出现 Pi 选项），而不是
  // 选了一个点了才报错的选项。轻量、无副作用，任何 token 都能读。
  if (path === "/capabilities" && req.method === "GET") {
    const { piAvailable } = await import("../lib/pi-env.js");
    return apiJson(200, { ok: true, piAvailable: await piAvailable() });
  }

  // v2.23+ POST /api/v1/sessions/:sessionId/manage —— 未纳管会话的处置（仅全权 token）。
  // body: { action: "archive" | "delete", runtime?, cwd? }
  //   archive：会话文件快照进 ~/.claude-orchestrator/archive/unmanaged/<sid>/，再删原文件
  //            ⇒ 列表不再显示，内容留档（可逆）
  //   delete ：只删原文件（不可逆，前端二次确认）
  // 两者都拒绝「看起来正在跑」的会话（文件 2 分钟内还在写）——顺带一提，这也和侧栏
  // 那个「活跃」标记同一口径。
  const manageMatch = path.match(/^\/sessions\/([^/]+)\/manage$/);
  if (manageMatch && req.method === "POST") {
    if (!isFullScope(principal)) return forbidden("session management requires a full-scope token");
    const sid = decodeURIComponent(manageMatch[1]);
    if (!isValidSessionId(sid)) return apiJson(400, { ok: false, error: "invalid sessionId" });
    let mbody: any = {};
    try {
      mbody = await req.json();
    } catch {
      /* → 400 */
    }
    const action = mbody?.action === "delete" ? "delete" : mbody?.action === "archive" ? "archive" : null;
    if (!action) return apiJson(400, { ok: false, error: 'body must be {"action":"archive"|"delete"}' });
    const mRuntime = typeof mbody?.runtime === "string" ? mbody.runtime : undefined;
    const mCwd = typeof mbody?.cwd === "string" ? mbody.cwd : undefined;
    // 定位口径与 /sessions/:id/history 完全一致（Pi 文件名带时间戳，光有 id 推不出路径）
    let mfile = mCwd ? sessionJsonlPath(mRuntime, mCwd, sid) : null;
    if (!mfile || !existsSync(mfile)) {
      mfile =
        findSessionJsonlBySessionId(mRuntime ?? "pi", sid) ??
        findSessionJsonlBySessionId("claude-code", sid) ??
        findSessionJsonlBySessionId("codex", sid);
    }
    if (!mfile || !existsSync(mfile)) {
      return apiJson(404, { ok: false, error: `session "${sid}" not found on disk` });
    }
    const fsp = await import("node:fs/promises");
    try {
      const st = await fsp.stat(mfile);
      if (Date.now() - st.mtimeMs < 120_000) {
        return apiJson(409, {
          ok: false,
          error: "session looks live (file written within 2 min) — stop it before archiving/deleting",
        });
      }
    } catch {
      /* stat 失败就照常走 */
    }
    if (action === "archive") {
      const { USER_ARCHIVE_ROOT } = await import("../lib/session-archive.js");
      const dest = `${USER_ARCHIVE_ROOT}/${sid}`;
      await fsp.mkdir(dest, { recursive: true });
      await fsp.copyFile(mfile, `${dest}/${mfile.split("/").pop()}`);
      // 记一份 meta：恢复时要知道它原来在哪个目录（cwd 编码不可逆）
      await fsp.writeFile(
        `${dest}/.meta.json`,
        JSON.stringify({ kind: "unmanaged", originalPath: mfile, runtime: mRuntime ?? null, cwd: mCwd ?? null, sessionId: sid }, null, 2),
      );
    }
    await fsp.rm(mfile, { force: true });
    console.log(`🗂 会话处置: ${action} ${sid} (${mfile})`);
    return apiJson(200, { ok: true, action, sessionId: sid, archived: action === "archive" });
  }

  // v2.23+ GET /api/v1/sessions/:sessionId/history —— 任意会话的历史（不要求已纳管）。
  // 已有 /agents/:name/history/:sessionId 只认 registry 里的 agent；Web 端的会话列表
  // 里大部分是**未纳管**的会话（pi-web 起的、终端手敲的），点开它们要看历史只能走这条。
  const sessHistMatch = path.match(/^\/sessions\/([^/]+)\/history$/);
  if (sessHistMatch && req.method === "GET") {
    if (!isFullScope(principal)) return forbidden("session history requires a full-scope token");
    const sid = decodeURIComponent(sessHistMatch[1]);
    if (!isValidSessionId(sid)) return apiJson(400, { ok: false, error: "invalid sessionId" });
    const runtime = url.searchParams.get("runtime") || undefined;
    const cwd = url.searchParams.get("cwd") || undefined;
    const limit = Math.min(Number(url.searchParams.get("limit") || 100) || 100, 500);
    const before = url.searchParams.get("before");
    // 定位：先按 cwd+runtime 精确推，再两种 runtime 各自全库兜底扫
    let file = cwd ? sessionJsonlPath(runtime, cwd, sid) : null;
    if (!file || !existsSync(file)) {
      file =
        findSessionJsonlBySessionId(runtime ?? "pi", sid) ??
        findSessionJsonlBySessionId("claude-code", sid) ??
        findSessionJsonlBySessionId("codex", sid);
    }
    if (!file || !existsSync(file)) {
      return apiJson(404, { ok: false, error: `session "${sid}" not found on disk` });
    }
    const page = await readSessionHistory(file, {
      limit,
      ...(before ? { before: Number(before) } : {}),
    });
    return apiJson(200, { ok: true, sessionId: sid, path: file, ...page });
  }

  // GET /api/v1/events —— token 版 SSE（scope 过滤）
  if (path === "/events" && req.method === "GET") {
    // 双向兼容前缀：scope 里存裸名时补 agent- 前缀的变体
    const scopeAgents = principal.agents.includes("*") ? undefined : principal.agents.flatMap((a) => [a, `agent-${a}`]);
    return deps.handleEventsRequest(req, scopeAgents ? { agents: scopeAgents } : undefined);
  }

  // GET /api/v1/whoami —— 调用方自己的 token 身份（web 推送据此只推自己的对话，不推 peer / 其它 token 的）
  if (path === "/whoami" && req.method === "GET") return apiJson(200, { ok: true, tokenId, name: principal.name ?? null, peer: principal.peer ?? null });

  // GET /api/v1/threads/:threadId —— wait 超时后的轮询兜底
  const threadMatch = path.match(/^\/threads\/([^/]+)$/);
  if (threadMatch && req.method === "GET") {
    const hit = apiThreadResults.get(threadMatch[1]);
    // 属主校验:结果只给发起它的 token(老记录无 tokenId 的放行——兼容窗口内的在飞请求)
    if (!hit || (hit.tokenId && hit.tokenId !== tokenId)) {
      return apiJson(404, { ok: false, error: "thread not found (not answered yet, or expired)" });
    }
    return apiJson(200, { ok: true, ...hit.result });
  }

  // GET /api/v1/files/:id —— 出站附件下载（校验属主 token）
  const fileMatch = path.match(/^\/files\/([^/]+)$/);
  if (fileMatch && req.method === "GET") {
    const entry = apiFiles.get(fileMatch[1]);
    if (!entry || entry.tokenId !== tokenId) return apiJson(404, { ok: false, error: "file not found" });
    const f = Bun.file(entry.path);
    if (!(await f.exists())) return apiJson(410, { ok: false, error: "file no longer on disk" });
    return new Response(f, {
      headers: { "Content-Disposition": `attachment; filename="${encodeURIComponent(entry.name)}"` },
    });
  }

  // GET /api/v1/agents/:name/bg-tasks —— 当前活跃 bg 任务快照（replay）。
  // web 刷新/连流后据此重建后台任务面板（SSE 只带增量,不 replay 已发生的）。
  const bgTasksMatch = path.match(/^\/agents\/([^/]+)\/bg-tasks$/);
  if (bgTasksMatch && req.method === "GET") {
    const agentParam = decodeURIComponent(bgTasksMatch[1]);
    if (!inScopeEitherName(principal, agentParam)) return notInScope(agentParam);
    const { activeBgTasksFor } = await import("./bg-activity-watcher.js");
    const name = agentParam.startsWith("agent-") ? agentParam : `agent-${agentParam}`;
    // 两种名字形态都试（master/裸名兼容）
    const tasks = [...activeBgTasksFor(name), ...(name !== agentParam ? activeBgTasksFor(agentParam) : [])];
    return apiJson(200, { ok: true, tasks });
  }

  // GET /api/v1/history/search —— 跨 agent 跨 session 聊天记录全文搜索。
  //   ?q=<词，≥2 字符>&limit=<1..100，默认 30>&agent=<可选，只搜这个 agent>
  // 场景：compact 后 agent 忘事 / 用户只剩模糊记忆——对话正文全局检索捞回来。
  // 覆盖 live + 归档（含已 remove 的 agent，归档在即可搜）。按 session mtime
  // 降序扫，凑满 3×limit 早停（新会话优先，防全盘扫描拖时长）。
  if (path === "/history/search" && req.method === "GET") {
    const q = (url.searchParams.get("q") || "").trim();
    if (q.length < 2) return apiJson(400, { ok: false, error: "q 至少 2 个字符" });
    const limitRaw = Number(url.searchParams.get("limit") || 30);
    const limit = Math.max(1, Math.min(100, Number.isFinite(limitRaw) ? Math.floor(limitRaw) : 30));
    const agentFilter = url.searchParams.get("agent");

    const { readRegistryAgents } = await import("../lib/registry.js");
    const { readdirSync } = await import("fs");
    const { ARCHIVE_ROOT } = await import("../lib/session-archive.js");
    // scope 内的候选 agent：registry 全量 + 归档目录（已删 agent）+ master（须显式 scope）
    const regAgents = await readRegistryAgents();
    const regMap = new Map(regAgents.map((a) => [a.name, a]));
    const candidates = new Set<string>();
    for (const a of regAgents) {
      if (agentInScope(principal, a.name)) candidates.add(a.name);
    }
    try {
      for (const d of readdirSync(ARCHIVE_ROOT, { withFileTypes: true })) {
        if (d.isDirectory() && d.name !== "master" && agentInScope(principal, d.name)) candidates.add(d.name);
      }
    } catch { /* 归档目录不存在 = 无归档 */ }
    if (agentInScope(principal, "master")) candidates.add("master");
    let names = [...candidates];
    if (agentFilter) {
      const want = agentFilter.startsWith("agent-") || agentFilter === "master" ? agentFilter : `agent-${agentFilter}`;
      if (!agentInScope(principal, agentFilter) && !agentInScope(principal, want)) {
        return apiJson(403, { ok: false, error: `agent "${agentFilter}" not in token scope` });
      }
      names = names.filter((n) => n === want || n === agentFilter);
    }

    type Hit = { agent: string; sessionId: string; source: string; seq: number; ts: string | null; role: string; snippet: string; from?: string; compact?: boolean };
    const { searchSessionHistory } = await import("../lib/session-history.js");
    const all: Hit[] = [];
    const collectBudget = limit * 3;
    // 全部候选 session 拉平后按 mtime 降序——最近的对话最可能是要找的。
    // cwd/sessionId 直接取 registry（已在手）——findApiAgent 对非 master 每次
    // 起一个 manager 子进程,17 个 agent 就是 ~2.5s,曾是本端点的真正大头
    // (2026-07-14 bench:枚举+清单本身只要 4ms,扫描 1.2s)。
    const files: { agent: string; sessionId: string; source: string; path: string; mtime: string }[] = [];
    for (const n of names) {
      let cwd: string | undefined;
      let sessionId: string | undefined;
      let runtime: string | undefined;
      if (n === "master") {
        const m = await findApiAgent("master"); // master 分支不起子进程
        cwd = m?.cwd;
        sessionId = m?.sessionId;
      } else {
        const a = regMap.get(n);
        cwd = a?.cwd;
        sessionId = a?.sessionId;
        runtime = a?.runtime;
      }
      const sessions = await listAgentSessions(n, {
        cwd,
        currentSessionId: sessionId,
        runtime,
      });
      for (const s of sessions) files.push({ agent: n, sessionId: s.sessionId, source: s.source, path: s.path, mtime: s.mtime });
    }
    files.sort((a, b) => b.mtime.localeCompare(a.mtime));
    // 并发扫描（owner 2026-07-14「免费优化」）：6 路并发重叠 IO 与解析,
    // 领任务顺序保持 mtime 降序;收集超预算后不再领新文件（在扫的照常收尾）。
    const perFile: Hit[][] = new Array(files.length);
    let cursor = 0;
    let collected = 0;
    const scanWorker = async () => {
      while (cursor < files.length && collected < collectBudget) {
        const idx = cursor++;
        const f = files[idx];
        try {
          const hits = await searchSessionHistory(f.path, q, { maxHits: 20 });
          perFile[idx] = hits.map((h) => ({ agent: f.agent, sessionId: f.sessionId, source: f.source, ...h }));
          collected += hits.length;
        } catch {
          perFile[idx] = []; // 单文件失败不影响整体
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(6, files.length) }, scanWorker));
    for (const part of perFile) if (part) all.push(...part);
    all.sort((a, b) => (b.ts || "").localeCompare(a.ts || ""));
    return apiJson(200, { ok: true, query: q, hits: all.slice(0, limit), scanned: files.length });
  }

  // GET /api/v1/agents/:name/tasks —— Claude Code 原生任务清单。
  // TaskCreate/TaskUpdate 落盘在 ~/.claude/tasks/<sessionId>/<id>.json(每任务一
  // 文件:{id,subject,description,activeForm,status,blocks,blockedBy})。Web 会话
  // 页任务面板的数据源(owner 2026-07-16:「console 里的 todo 适配到 Web UI」)。
  const tasksMatch = path.match(/^\/agents\/([^/]+)\/tasks$/);
  if (tasksMatch && req.method === "GET") {
    const agentParam = decodeURIComponent(tasksMatch[1]);
    if (!inScopeEitherName(principal, agentParam)) return notInScope(agentParam);
    const agent = await findApiAgent(agentParam);
    if (!agent?.sessionId) return apiJson(200, { ok: true, tasks: [] });
    const dir = `${process.env.HOME}/.claude/tasks/${agent.sessionId}`;
    const tasks: {
      id: string;
      subject: string;
      activeForm?: string;
      status: string;
      blockedBy: string[];
    }[] = [];
    try {
      for (const f of readdirSync(dir)) {
        if (!/^\d+\.json$/.test(f)) continue;
        try {
          const t = JSON.parse(await Bun.file(`${dir}/${f}`).text());
          tasks.push({
            id: String(t.id ?? f.replace(".json", "")),
            subject: String(t.subject ?? ""),
            ...(t.activeForm ? { activeForm: String(t.activeForm) } : {}),
            status: String(t.status ?? "pending"),
            blockedBy: Array.isArray(t.blockedBy) ? t.blockedBy.map(String) : [],
          });
        } catch {
          /* 单个坏文件跳过 */
        }
      }
    } catch {
      /* 目录不存在 = 该会话没建过任务 */
    }
    tasks.sort((a, b) => Number(a.id) - Number(b.id));
    return apiJson(200, { ok: true, tasks });
  }

  // v2.9+ GET /api/v1/agents/:name/history —— session 清单（live + 归档快照）。
  // agent 已被 kill 时归档仍可读（这正是归档存在的意义），所以 registry 查不到
  // 不算 404，降级为只列归档。响应不含服务器路径（path 字段剥掉）。
  const histListMatch = path.match(/^\/agents\/([^/]+)\/history$/);
  if (histListMatch && req.method === "GET") {
    const agentParam = decodeURIComponent(histListMatch[1]);
    if (!inScopeEitherName(principal, agentParam)) return notInScope(agentParam);
    const agent = await findHistoryAgent(agentParam);
    const canonical = agent?.name ?? (agentParam.startsWith("agent-") ? agentParam : `agent-${agentParam}`);
    const sessions = await listAgentSessions(canonical, {
      cwd: agent?.cwd,
      currentSessionId: agent?.sessionId,
      runtime: agent?.runtime,
    });
    if (!agent && !sessions.length) {
      return apiJson(404, { ok: false, error: `agent "${agentParam}" not found (no registry entry, no archives)` });
    }
    return apiJson(200, {
      ok: true,
      agent: canonical,
      sessions: sessions.map(({ path: _p, ...rest }) => rest),
    });
  }

  // v2.9+ GET /api/v1/agents/:name/history/:sessionId —— 消息分页
  //   ?limit=100（1..500）&before=<seq 往前翻页>&subagent=agent-xxx（读 subagent 会话）
  const histSessMatch = path.match(/^\/agents\/([^/]+)\/history\/([^/]+)$/);
  if (histSessMatch && req.method === "GET") {
    const agentParam = decodeURIComponent(histSessMatch[1]);
    if (!inScopeEitherName(principal, agentParam)) return notInScope(agentParam);
    const sid = decodeURIComponent(histSessMatch[2]);
    if (!isValidSessionId(sid)) return apiJson(400, { ok: false, error: "invalid sessionId" });
    const agent = await findHistoryAgent(agentParam);
    const canonical = agent?.name ?? (agentParam.startsWith("agent-") ? agentParam : `agent-${agentParam}`);
    // 热路径快捷:请求的就是当前活 session → 直接推 live 路径,跳过归档目录扫描
    // (listAgentSessions 每次 stat 全部归档快照 + 子 agent 目录;差量同步 100% 走这条)
    let found: { sessionId: string; source: "live" | "archive"; path: string } | undefined;
    if (agent?.cwd && agent.sessionId === sid) {
      const { projectJsonlPath } = await import("../lib/jsonl-cost.js");
      // v2.23+ runtime 感知（Pi 返回 null ⇒ 落回下面的 listAgentSessions 扫描）
      const lp = sessionJsonlPath(agent.runtime, agent.cwd, sid);
      if (lp && existsSync(lp)) found = { sessionId: sid, source: "live", path: lp };
    }
    if (!found) {
      const sessions = await listAgentSessions(canonical, {
        cwd: agent?.cwd,
        currentSessionId: agent?.sessionId,
        runtime: agent?.runtime,
      });
      found = sessions.find((s) => s.sessionId === sid);
    }
    if (!found) return apiJson(404, { ok: false, error: `session "${sid}" not found for agent "${canonical}"` });

    let file = found.path;
    const subagent = url.searchParams.get("subagent");
    if (subagent) {
      if (!isValidSubagentId(subagent)) return apiJson(400, { ok: false, error: "invalid subagent id" });
      file = `${found.path.replace(/\.jsonl$/, "")}/subagents/${subagent}.jsonl`;
      if (!existsSync(file)) return apiJson(404, { ok: false, error: `subagent "${subagent}" not found in session` });
    }
    const limitRaw = Number(url.searchParams.get("limit") || 100);
    const beforeRaw = url.searchParams.get("before");
    const before = beforeRaw != null ? Number(beforeRaw) : undefined;
    // v2.16+ after=<seq> 差量同步(唤醒追平):只回锚点之后的新消息
    const afterRaw = url.searchParams.get("after");
    const after = afterRaw != null ? Number(afterRaw) : undefined;
    try {
      const page = await readSessionHistory(file, {
        limit: Number.isFinite(limitRaw) ? limitRaw : 100,
        before: before != null && Number.isFinite(before) ? before : undefined,
        after: after != null && Number.isFinite(after) ? after : undefined,
        formatToolFn: formatTool,
        toolDetailFn: formatToolDetail,
      });
      return apiJson(200, {
        ok: true,
        agent: canonical,
        sessionId: sid,
        source: found.source,
        ...(subagent ? { subagent } : {}),
        ...page,
      });
    } catch (e) {
      return apiJson(500, { ok: false, error: (e as Error).message });
    }
  }

  // POST /api/v1/agents/:name/messages —— 给 agent 发消息（同步 wait / 202+轮询）
  const msgMatch = path.match(/^\/agents\/([^/]+)\/messages$/);
  if (msgMatch && req.method === "POST") {
    const agentParam = decodeURIComponent(msgMatch[1]);
    if (!inScopeEitherName(principal, agentParam)) return notInScope(agentParam);
    const agent = await findApiAgent(agentParam);
    if (!agent) return apiJson(404, { ok: false, error: `agent "${agentParam}" not found` });
    const client = deps.clients.get(agent.channelId);
    if (!client) {
      // ws 不在 ≠ agent 死了。channel-server 是独立子进程，被顶替/重启时 ws 会短暂
      // 缺席，而 tmux window 里的 Claude Code 照常跑着上一回合（2026-07-25 owner:
      // 「提示已断开，我进 console 看你还在进行上一轮对话」）。window 还在就报可重试的
      // 503，别把「链路重连中」说成「会话不存在」。
      const alive = (await listWindows().catch((): string[] => [])).includes(agent.name);
      if (alive) {
        return apiJson(503, {
          ok: false,
          retryable: true,
          error: `agent "${agent.name}" 消息链路重连中（会话仍在运行），请稍后重试`,
        });
      }
      return apiJson(409, { ok: false, error: `agent "${agent.name}" is offline (no active session)` });
    }

    // body：JSON {text, wait} 或 multipart（text 字段 + files，R5 入站附件）
    let text = "";
    let waitSec = 0;
    const attachments: string[] = [];
    const contentType = req.headers.get("Content-Type") || "";
    try {
      if (contentType.includes("multipart/form-data")) {
        const form = await req.formData();
        text = String(form.get("text") || "");
        waitSec = Number(form.get("wait") || 0);
        const inboxDir = INBOX_DIR;
        await Bun.spawn(["mkdir", "-p", inboxDir]).exited;
        // 不用 `f is File` 类型谓词：Bun 的全局 File 与 node:buffer 的 File 在类型
        // 上不兼容（缺 webkitRelativePath/slice），谓词写法会被 tsc 拒。运行时判据
        // 仍是 instanceof File，只是把窄化交给 typeof 排除字符串项。
        const files = form
          .getAll("files")
          .filter((f) => typeof f !== "string" && f instanceof File)
          .slice(0, 5) as unknown as File[];
        for (const f of files) {
          if (f.size > 10 * 1024 * 1024) return apiJson(413, { ok: false, error: `file "${f.name}" exceeds 10MB` });
          const dest = `${inboxDir}/api_${Date.now()}_${f.name.replace(/[^\w.\-]/g, "_")}`;
          await Bun.write(dest, f);
          attachments.push(dest);
        }
      } else {
        const body = (await req.json()) as { text?: string; wait?: number };
        text = String(body.text || "");
        waitSec = Number(body.wait || 0);
      }
    } catch {
      return apiJson(400, { ok: false, error: "invalid body (JSON {text, wait?} or multipart with text/files)" });
    }
    if (!text.trim() && attachments.length === 0) {
      return apiJson(400, { ok: false, error: "text is required" });
    }
    waitSec = Math.min(Math.max(waitSec, 0), 300);

    // Web slash 直通：文本形如 "/cmd [args]" 且命中注册表 → tmux 字面注入
    // （CC 原生解释，与 Discord slash 同款 tmuxSendLine 路径）。未命中注册表的
    // "/xxx" 落回普通消息——用户可能真想发以 / 开头的文本。TUI 类命令没有回合，
    // 响应带 slash:true 让前端不进「正在回复」态。
    // v2.11: peer token 不给 slash 直通——那是 TUI 控制权(/clear 可跨机清上下文),
    // messaging scope 不该静默升级(review 2026-07-19 #5)。peer 文本一律按普通消息投。
    const slashM = attachments.length === 0 && !principal.peer ? text.trim().match(/^\/([\w:-]+)(?:\s+([\s\S]+))?$/) : null;
    if (slashM) {
      const regName = agent.name === "master" ? null : agent.name;
      // Pi agent 的命令表是 Pi 自己的（快照），不走 CC 的注册表解析 —— 同名命令
      // 在两端语义不同（Pi 的 /compact 是 Pi 内置），交给 Pi 原生解释。
      const piHit = String((agent as any).runtime || "") === "pi"
        ? piCommandsFor(agent.name).find((c) => c.name === slashM[1])
        : undefined;
      const resolved = piHit
        ? { ok: true as const, ccText: `/${piHit.invokeName}${(slashM[2] || "").trim() ? ` ${slashM[2].trim()}` : ""}`, scope: "pi" }
        : resolveWebInvocation(slashM[1], regName, slashM[2] || "");
      if (resolved.ok) {
        const win = agent.name === "master" ? `${MASTER_SESSION}:0` : windowTarget(agent.name);
        try {
          await tmuxSendLine(win, resolved.ccText);
          // v2.16.2 输入框打 /model 也登记切换意图(peer 报告根因 1:slash 直通
          // 无任何代按逻辑,弹窗迟到 1.5s 无人按,agent 卡死)——watcher 兜底代按
          if (slashM[1] === "model" && (slashM[2] || "").trim()) {
            const { noteModelSwitchIntent } = await import("./permission-watcher.js");
            noteModelSwitchIntent(agent.name, resolveModelAlias((slashM[2] || "").trim()));
          }
        } catch (e) {
          return apiJson(500, { ok: false, error: `tmux 注入失败: ${(e as Error).message}` });
        }
        const tn = principal.name || tokenId;
        deps.mirrorApiExchange({ kind: "api", tokenId, name: tn }, agent.channelId, `[🌐 API←${tn}] ${text}`).catch(() => {});
        recordMetric("api_slash", { channelId: agent.channelId, agent: agent.name, meta: { cmd: slashM[1] } });
        // skill 类命令(非 builtin)注入后跑的是真实 LLM 回合,Stop hook 会正常
        // 收尾——发 thinking 让 web 思考徽章/侧栏 busy 亮起(2026-07-24 owner:
        // 「命令运行时没有思考中提示,agent 状态也不是工作状态」)。builtin TUI
        // 命令(/cost /compact /context…)无回合无 Stop hook,发了会永久卡
        // thinking,维持不发。
        if (resolved.scope !== "builtin") {
          const evAgentSlash =
            agentNameForChannel(agent.channelId) ||
            (agent.channelId === CONTROL_CHANNEL_ID ? "master" : agent.name);
          emitEvent({ agent: evAgentSlash, chatId: agent.channelId, type: "agent_status", data: { status: "thinking" } });
        }
        // 直通的 /clear 与 clear 端点一样会轮转 session——必须同样挂轮转收尾，
        // 否则 registry/watcher/history 盯死文件（2026-07-15 用户在 Web 输入框
        // 打 /clear，temp 的历史冻结整整 7 天才被发现）。
        if (slashM[1] === "clear" && agent.name !== "master" && agent.cwd) {
          deps.scheduleClearRotation(agent.name, agent.channelId, agent.cwd, agent.sessionId);
        }
        console.log(`⚡ [api] slash 注入 ${agent.name}: ${resolved.ccText}`);
        return apiJson(202, { ok: true, accepted: true, slash: true, ccText: resolved.ccText, agent: agent.name });
      }
      const other = isProjectSkillForOtherAgent(slashM[1], regName);
      if (other) {
        return apiJson(409, { ok: false, error: `/${slashM[1]} 是 ${other.replace(/^agent-/, "")} 的项目技能，当前 agent 不可用` });
      }
      // 不是已知命令 → 继续按普通消息投递
    }

    const tokenName = principal.name || tokenId;
    const threadId = newThreadId();
    const env: Envelope = {
      from: { kind: "api", tokenId, name: tokenName, ...(principal.peer ? { peer: principal.peer } : {}) },
      to: { kind: "local", agentName: agent.name, channelId: agent.channelId, ws: client.ws as any, cwd: client.cwd },
      intent: "request",
      content: text,
      meta: {
        messageId: `api_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        triggerKind: "system",
        ts: new Date().toISOString(),
        threadId,
        attachments: attachments.length ? attachments : undefined,
        // API 请求不需要 inter-agent watchdog（有自己的 wait/轮询语义）
        skipInterAgentWatchdog: true,
      },
    };

    // 挂 pending（无论是否 wait —— deliverToApi 靠它关联 threadId / R3 兜底靠它找 waiter）
    const key = apiReqKey(tokenId, agent.channelId);
    const entry: PendingApiRequest = {
      tokenId,
      tokenName,
      agentChannelId: agent.channelId,
      agentName: agent.name,
      threadId,
      ts: Date.now(),
    };
    const queue = pendingApiRequests.get(key) || [];
    queue.push(entry);
    pendingApiRequests.set(key, queue);

    const delivery = await deps.deliver(env);
    if (delivery.outcome.kind !== "sent") {
      const idx = queue.indexOf(entry);
      if (idx >= 0) queue.splice(idx, 1);
      const reason = delivery.outcome.kind === "dropped" ? (delivery.outcome as any).reason : (delivery.outcome as any).error?.message;
      return apiJson(502, { ok: false, error: `delivery failed: ${reason || "unknown"}` });
    }

    // R2 入站镜像
    deps.mirrorApiExchange({ kind: "api", tokenId, name: tokenName }, agent.channelId, `[🌐 API←${tokenName}] ${text}`).catch(() => {});
    deps.startTypingWithSafety(agent.channelId);
    // API 触发的 turn 不发 Stop 完成通知 @ owner（回复走 API 回路 + R2 镜像已可见）
    deps.lastMessageSource.set(agent.channelId, "agent");

    if (waitSec === 0) {
      return apiJson(202, { ok: true, accepted: true, threadId, agent: agent.name, hint: `poll GET /api/v1/threads/${threadId} or subscribe /api/v1/events` });
    }

    const result = await new Promise<ApiReplyResult | null>((resolve) => {
      entry.resolve = resolve;
      setTimeout(() => resolve(null), waitSec * 1000);
    });
    if (!result) {
      entry.resolve = undefined; // 超时后 deliverToApi/R3 仍会把结果写进 apiThreadResults
      return apiJson(202, { ok: true, accepted: true, timedOut: true, threadId, agent: agent.name, hint: `poll GET /api/v1/threads/${threadId}` });
    }
    return apiJson(200, { ok: true, ...result });
  }

  // ============================================================
  // 以下为 fork 侧 additive 端点（upstream /api/v1 无对应能力）。
  // 全部遵守 upstream 合同：Bearer + agentInScope、additive-only、复用
  // Discord 按钮同款 tmux keystroke 逻辑（buildAuqKeystrokes / 权限 keySeqMap
  // + 发键前 tmuxCapture 重验）。
  //   POST /agents/:name/interrupt       一键中断（tmux C-c）
  //   POST /agents/:name/clear           远程原生 /clear + 后台会话轮转
  //   POST /agents/:name/answer          AUQ / 权限弹窗回传（tmux 键序列）
  //   GET  /agents/:name/pending         当前挂起交互 + thinking 态（SSE 迟到订阅者补发）
  //   POST /agents                       create（仅全权 token）
  //   POST /agents/:name/kill|restart    生命周期（仅全权 token）
  // ============================================================

  // GET /api/v1/agents/:name/skills —— Web 命令面板数据源：该 agent
  // 可用的全部 slash 命令（builtin + 全局 skill + 本 agent 项目 skill）。
  const skillsMatch = path.match(/^\/agents\/([^/]+)\/skills$/);
  if (skillsMatch && req.method === "GET") {
    const agentParam = decodeURIComponent(skillsMatch[1]);
    if (!inScopeEitherName(principal, agentParam)) return notInScope(agentParam);
    const agent = await findApiAgent(agentParam);
    if (!agent) return apiJson(404, { ok: false, error: `agent "${agentParam}" not found` });
    // Pi agent 的命令来自它自己的运行时快照（CC 的 skills 扫描在 Pi 上不适用）。
    // 这里也决定了「能注入什么」：面板里没有的命令，直通分支会拒绝 —— 两边同源。
    const isPiAgent = String((agent as any).runtime || "") === "pi";
    const commands = isPiAgent
      ? piCommandsFor(agent.name)
      : commandsForAgent(agent.name === "master" ? null : agent.name);
    return apiJson(200, { ok: true, agent: agent.name, runtime: isPiAgent ? "pi" : "claude-code", commands });
  }

  // POST /api/v1/agents/:name/interrupt —— 复刻 Discord ⚡ 打断按钮
  const interruptMatch = path.match(/^\/agents\/([^/]+)\/interrupt$/);
  if (interruptMatch && req.method === "POST") {
    const agentParam = decodeURIComponent(interruptMatch[1]);
    if (!inScopeEitherName(principal, agentParam)) return notInScope(agentParam);
    const agent = await findApiAgent(agentParam);
    if (!agent) return apiJson(404, { ok: false, error: `agent "${agentParam}" not found` });
    // 防重入(owner 2026-07-16:「打断按钮点两次出两个打断」):3s 冷却——
    // 空闲态连发两次 C-c 是 CC 的退出快捷键,双击可能直接把会话关了
    const lastInt = interruptCooldown.get(agent.name) ?? 0;
    if (Date.now() - lastInt < 3_000) return apiJson(200, { ok: true, deduped: true });
    interruptCooldown.set(agent.name, Date.now());
    // 按键由运行时决定（空闲的 Codex 收到 C-c 会直接退出，所以它空闲时一个键都不发）
    const sent = await interruptAgent(agent.name).catch((e: Error) => e);
    if (sent instanceof Error) return apiJson(500, { ok: false, error: `tmux send-keys 失败: ${sent.message}` });
    if (sent.length) recordMetric("agent_interrupt", { channelId: agent.channelId, agent: agent.name, meta: { trigger: "api" } });
    else interruptCooldown.delete(agent.name); // 空闲没发键：不记打断指标，也不占 3s 冷却
    stopTyping(agent.channelId);
    clearSafetyTimer(agent.channelId);
    // 被打断的回合 CC 不触发 Stop hook —— agentStatuses 会永远卡在 thinking：
    // 列表黄点常驻、前端乐观解锁后又被 15s 轮询的 busy 补锁锁回「正在回复」
    // (owner 2026-07-14 真机)。打断即回合收尾：状态置 done + SSE 广播解锁。
    const evAgentInt =
      agentNameForChannel(agent.channelId) ||
      (agent.channelId === CONTROL_CHANNEL_ID ? "master" : agent.name);
    emitEvent({ agent: evAgentInt, chatId: agent.channelId, type: "agent_status", data: { status: "done", trigger: "interrupt" } });
    console.log(`⚡ [api] ${sent.length ? "打断键已发送" : "当前空闲，未发打断键"}：${agent.name} (token=${tokenId})`);
    return apiJson(200, { ok: true, agent: agent.name, ...(sent.length ? {} : { idle: true }) }); // done 照发：前端误判忙时借此解锁
  }

  // POST /api/v1/agents/:name/clear —— 远程调用 CC 原生 /clear（清上下文）。
  // 语义分层（owner 哲学对齐）：本端点只做「打 /clear + 会话轮转收尾」这件原生事；
  // clear 后要不要发开机指令、发什么，是前端（用户层）的事，这里零感知。
  // master：/clear 后 CLAUDE.md 人设自动重载，且不在 registry、无 watcher —— 只发键。
  const clearMatch = path.match(/^\/agents\/([^/]+)\/clear$/);
  if (clearMatch && req.method === "POST") {
    const agentParam = decodeURIComponent(clearMatch[1]);
    if (!inScopeEitherName(principal, agentParam)) return notInScope(agentParam);
    const agent = await findApiAgent(agentParam);
    if (!agent) return apiJson(404, { ok: false, error: `agent "${agentParam}" not found` });
    const isMasterClear = agent.name === "master";
    const targetWindow = isMasterClear ? `${MASTER_SESSION}:0` : windowTarget(agent.name);
    // 回合进行中打 /clear 会插进对话流 → 先验 idle（与权限按钮同款防误击思路）
    let pane = "";
    try {
      pane = await tmuxCapture(targetWindow, 40);
    } catch (e) {
      return apiJson(502, { ok: false, error: `tmux 不可达: ${(e as Error).message}` });
    }
    if (!paneLooksIdle(pane)) {
      return apiJson(409, { ok: false, error: "agent 正在回合中，先停止（interrupt）再 clear" });
    }
    try {
      await tmuxSendLine(targetWindow, "/clear");
    } catch (e) {
      return apiJson(500, { ok: false, error: `tmux 发送失败: ${(e as Error).message}` });
    }
    recordMetric("agent_clear", { channelId: agent.channelId, agent: agent.name, meta: { trigger: "api" } });
    console.log(`🧹 [api] /clear 已发送给 ${agent.name} (token=${tokenId})`);
    if (isMasterClear) {
      return apiJson(200, { ok: true, agent: "master" });
    }
    // 会话轮转收尾在后台跑（新 jsonl 可能等首条消息才出现）
    if (agent.cwd) {
      deps.scheduleClearRotation(agent.name, agent.channelId, agent.cwd, agent.sessionId);
    }
    return apiJson(202, {
      ok: true,
      accepted: true,
      agent: agent.name,
      hint: "session rotation completes in background; watcher rebinds when the new session jsonl appears",
    });
  }

  // POST /api/v1/agents/:name/claude-settings —— 会话级切模型/effort：tmux 注入原生 /model、/effort(与 TUI 手打同一生效路径)。
  // 非 CC runtime 400;回合进行中 409(注入只会排进输入框);非 master 同步写 registry(manager set-claude)——restart 后沿用。
  const claudeSetMatch = path.match(/^\/agents\/([^/]+)\/claude-settings$/);
  if (claudeSetMatch && req.method === "POST") {
    const agentParam = decodeURIComponent(claudeSetMatch[1]);
    if (!inScopeEitherName(principal, agentParam)) return notInScope(agentParam);
    const body: any = await readJsonBody(req);
    if (body === INVALID_JSON) return invalidJsonBody();
    const model = typeof body?.model === "string" && body.model.trim() ? resolveModelAlias(body.model) : undefined;
    const effort = typeof body?.effort === "string" && body.effort.trim() ? body.effort.trim() : undefined;
    if (!model && !effort) return apiJson(400, { ok: false, error: 'body must contain "model" and/or "effort"' });
    // v2.21.1+ 会话级切换接受 runtime-only 档(ultracode)——它就是「this session
    // only」语义,与 /effort 注入这条路完全对齐(peer owner 请求 2026-08-30)
    if (effort && !isKnownRuntimeEffort(effort)) {
      return apiJson(400, { ok: false, error: `未知 effort: "${effort}"。可用: ${[...KNOWN_EFFORT_LEVELS, ...RUNTIME_ONLY_EFFORT_LEVELS].join(", ")}` });
    }
    const runtimeErr = nonClaudeRuntimeError(agentParam, await readRegistryAgents());
    if (runtimeErr) return apiJson(400, { ok: false, error: runtimeErr });
    const agent = await findApiAgent(agentParam);
    if (!agent) return apiJson(404, { ok: false, error: `agent "${agentParam}" not found` });
    const isMasterSet = agent.name === "master";
    const targetWindow = isMasterSet ? `${MASTER_SESSION}:0` : windowTarget(agent.name);
    let pane = "";
    try {
      pane = await tmuxCapture(targetWindow, 40);
    } catch (e) {
      return apiJson(502, { ok: false, error: `tmux 不可达: ${(e as Error).message}` });
    }
    const { detectSwitchConfirmPrompt, switchPromptMatches, runSwitchCommand, pressSwitchConfirm } = await import("../lib/tmux-helper.js");
    const promptTitle = (k: "model" | "effort") => (k === "model" ? "Switch model?" : "Change effort level?");
    {
      // 残留的切换确认框也让 paneLooksIdle 为假——以前统一回「正在回合中」,用户照
      // 提示去下拉重选只会一直 409。框的目标与本次选择一致 = 用户重申了意图,直接代按。
      const leftover = detectSwitchConfirmPrompt(pane);
      if (leftover) {
        const want = leftover.kind === "model" ? model : effort;
        if (!want || !switchPromptMatches(leftover, leftover.kind, want)) {
          return apiJson(409, { ok: false, error: `会话停在「${promptTitle(leftover.kind)}」确认框上(切到 ${leftover.target}),与本次选择不符,请到终端或 Discord 按钮处理` });
        }
        await pressSwitchConfirm(targetWindow, leftover);
        await Bun.sleep(800);
        pane = await tmuxCapture(targetWindow, 40).catch(() => "");
      }
    }
    if (!paneLooksIdle(pane)) {
      return apiJson(409, { ok: false, error: "agent 正在回合中，等回合结束再切换" });
    }
    const warnings: string[] = [];
    try {
      // 会话有 prompt cache 时 /model 弹「Switch model?」、/effort 弹「Change effort level?」
      // (CC 2.1.280 实测两者都弹)。用户已在 web 下拉拍过板,没人按 TUI 就永远卡在框上。
      // runSwitchCommand 注入 → 见框代按 → 等命令真正落地才返回,两条命令不会叠进同一个框。
      const { noteModelSwitchIntent, noteEffortSwitchIntent, clearSwitchIntent } = await import("./permission-watcher.js");
      // 总时长封顶:web BFF 代理超时 20s,两条命令各等满 7s 再加 set-claude 就贴边了
      const deadline = Date.now() + 11_000;
      const TICK_MS = 700;
      /** 没落地的结局 → 409 文案;null = 可以继续 */
      const failure = (kind: "model" | "effort", r: Awaited<ReturnType<typeof runSwitchCommand>>): string | null => {
        const label = kind === "model" ? "模型" : "effort";
        if (r.outcome === "rejected") {
          if (kind === "effort" && effort === "ultracode") {
            return "CC 拒绝了 ultracode:需要在该 agent 的 /config 里开启 dynamic workflows(或超出 effort 上限 / 被组织策略限制)。";
          }
          return `CC 拒绝了这次切换:${r.reason ?? "原因见终端"}`;
        }
        const stuck = detectSwitchConfirmPrompt(r.pane);
        if (r.outcome === "foreign" && stuck) {
          return `会话停在「${promptTitle(stuck.kind)}」确认框上(切到 ${stuck.target}),与本次选择不符,请到终端或 Discord 按钮处理`;
        }
        if (stuck) return `切${label}的确认框没能自动确认,请到终端或 Discord 按钮处理`;
        return null;
      };
      if (model) {
        // 先登记意图:轮询窗外迟到的框由 watcher 按意图代按
        noteModelSwitchIntent(agent.name, resolveModelAlias(model));
        const r = await runSwitchCommand(targetWindow, "model", model, { intervalMs: TICK_MS });
        if (r.outcome === "applied" || r.outcome === "confirmed" || r.outcome === "rejected") clearSwitchIntent(agent.name, "model");
        const err = failure("model", r);
        if (err) return apiJson(409, { ok: false, error: effort ? `${err}(effort 未切换)` : err });
        if (r.outcome === "timeout") {
          // 没框也没等到结果行:状态不明时别再注入 /effort——迟到的框会把它吞掉
          if (effort) return apiJson(409, { ok: false, error: "没等到 /model 落地,effort 未切换,稍后再试" });
          warnings.push("没等到 /model 落地,以会话实际显示为准");
        }
      }
      if (effort) {
        noteEffortSwitchIntent(agent.name, effort);
        const ticks = Math.max(4, Math.floor((deadline - Date.now()) / TICK_MS));
        const r = await runSwitchCommand(targetWindow, "effort", effort, { intervalMs: TICK_MS, ticks });
        if (r.outcome === "applied" || r.outcome === "confirmed" || r.outcome === "rejected") clearSwitchIntent(agent.name, "effort");
        // ultracode 有前提(CC /config 开 dynamic workflows),没开时 CC 只在 TUI 里打拒绝
        // 原因——web 用户看不到 TUI,runSwitchCommand 认出拒绝(⎿ 行或 toast)就透传回去
        const err = failure("effort", r);
        if (err) return apiJson(409, { ok: false, error: err });
        if (r.outcome === "timeout") warnings.push("没等到 /effort 落地,以会话实际显示为准");
      }
    } catch (e) {
      return apiJson(500, { ok: false, error: `tmux 发送失败: ${(e as Error).message}` });
    }
    {
      // 乐观显示:注入已成功,列表立即按新值显示;jsonl 实测追上后自动接管
      rememberSwitchOverride(agent.name, { ...(model ? { model } : {}), ...(effort ? { effort } : {}) });
      const key = overrideKey(agent.name);
      const prev = claudeSwitchOverride.get(key) ?? {};
      const now = Date.now();
      claudeSwitchOverride.set(key, {
        ...prev,
        ...(model ? { model: { v: model, ts: now } } : {}),
        ...(effort ? { effort: { v: effort, ts: now } } : {}),
      });
    }
    if (!isMasterSet) {
      try {
        const setArgs = ["set-claude", agent.name];
        if (model) setArgs.push("--model", model);
        // ultracode 是 session-only:不落 registry(否则 restart 会拿它当启动
        // flag,而重启后的新 session 本来就不继承它——落钉是谎言)
        if (effort && effort !== "ultracode") setArgs.push("--effort", effort);
        if (setArgs.length > 2) await runManager(...setArgs);
      } catch { /* registry 同步失败不影响本次生效(jsonl 探测仍会显示真值) */ }
    }
    recordMetric("agent_claude_updated", { channelId: agent.channelId, agent: agent.name, meta: { model, effort, tokenId } });
    console.log(`🎛 [api] claude-settings ${agent.name}: model=${model ?? "-"} effort=${effort ?? "-"} (token=${tokenId})`);
    return apiJson(200, { ok: true, agent: agent.name, model: model ?? null, effort: effort ?? null, ...(warnings.length ? { warning: warnings.join("；") } : {}) });
  }

  // POST /api/v1/agents/:name/answer —— 交互卡回传。
  // body {kind:"auq", action:"submit"|"cancel", selections?: number[][]}
  //   或 {kind:"permission", action:"allow"|"allow_session"|"deny"}
  const answerMatch = path.match(/^\/agents\/([^/]+)\/answer$/);
  if (answerMatch && req.method === "POST") {
    const agentParam = decodeURIComponent(answerMatch[1]);
    if (!inScopeEitherName(principal, agentParam)) return notInScope(agentParam);
    const agent = await findApiAgent(agentParam);
    if (!agent) return apiJson(404, { ok: false, error: `agent "${agentParam}" not found` });
    const body: any = await readJsonBody(req);
    if (body === INVALID_JSON) return invalidJsonBody();
    const kind = String(body?.kind || "");

    if (kind === "auq") {
      const { auqStates, buildAuqKeystrokes, clearAuqState, sendAuqKeys } = await import("./ask-user-question.js");
      const state = auqStates.get(agent.channelId);
      if (!state) return apiJson(404, { ok: false, error: "no pending AskUserQuestion for this agent" });
      const action = String(body?.action || "submit");
      if (action === "cancel") {
        try {
          await tmuxSendEscape(state.tmuxTarget);
        } catch { /* non-critical：状态照清 */ }
        clearAuqState(agent.channelId);
        recordMetric("auq_cancel", { channelId: agent.channelId, meta: { trigger: "api" } });
        emitEvent({ agent: agent.name, chatId: agent.channelId, type: "question_cleared", data: { reason: "cancel", via: "api" } });
        return apiJson(200, { ok: true, cancelled: true });
      }
      // submit：body.selections 覆盖状态（web 前端一次性提交所有选择）
      if (Array.isArray(body?.selections)) {
        state.selections = state.questions.map((q, i) => {
          const sel = Array.isArray(body.selections[i]) ? body.selections[i] : [];
          return sel
            .map((n: unknown) => Number(n))
            .filter((n: number) => Number.isInteger(n) && n >= 0 && n < q.options.length);
        });
      }
      // M4：发键前重验弹窗还在（与 permission 分支同款防误击）。AUQ 若已在 TUI 侧
      // 被应答/取消而 AuqState 尚未清（/pending replay 让陈旧提交更易发生），键会
      // 误入 composer——v2.17.2 起键序列含数字键，误入会真的打出字符，必须挡。
      // v2.17.2：判据从 paneLooksIdle 升级为 parseAuqPane（弹窗签名不在=stale，
      // 覆盖"已应答且 agent 正忙"的窗口）；解析结果顺手交给 buildAuqKeystrokes
      // 做现场对账（光标位/勾选态）。抓不到 pane 才跳过重验，退回盲发。
      let auqPane = "";
      try { auqPane = await tmuxCapture(state.tmuxTarget, 40); } catch { /* 跳过重验 */ }
      const auqParse = auqPane ? parseAuqPane(auqPane) : null;
      if (auqPane && !auqParse) {
        clearAuqState(agent.channelId);
        emitEvent({ agent: agent.name, chatId: agent.channelId, type: "question_cleared", data: { reason: "stale", via: "api" } });
        return apiJson(409, { ok: false, error: "AskUserQuestion no longer active (answered elsewhere?)" });
      }
      const keys = buildAuqKeystrokes(state, auqParse);
      try {
        // 逐键分发（sendAuqKeys）：批量 send-keys 会被 AUQ 组件吞导航键，答错选项
        if (keys.length > 0) await sendAuqKeys(state.tmuxTarget, keys);
      } catch (e) {
        return apiJson(500, { ok: false, error: `tmux send-keys 失败: ${(e as Error).message}` });
      }
      clearAuqState(agent.channelId);
      recordMetric("auq_submit", { channelId: agent.channelId, meta: { trigger: "api", questions: String(state.questions.length) } });
      emitEvent({ agent: agent.name, chatId: agent.channelId, type: "question_cleared", data: { reason: "submit", via: "api" } });
      return apiJson(200, { ok: true, keys: keys.length });
    }

    if (kind === "permission") {
      const action = String(body?.action || "");
      const keySeqMap: Record<string, string[]> = {
        allow: ["1", "Enter"],
        allow_session: ["2", "Enter"],
        deny: ["3", "Enter"],
      };
      const keySeq = keySeqMap[action];
      if (!keySeq) return apiJson(400, { ok: false, error: 'action must be "allow" | "allow_session" | "deny"' });
      const targetWindow = agent.name === "master" ? `${MASTER_SESSION}:0` : windowTarget(agent.name);
      // 发键前确认弹窗还在（与 Discord 按钮同款防误击：digit+Enter 别当普通输入提交）
      const pane = await tmuxCapture(targetWindow, 30);
      if (detectRuntimePermissionPrompt(pane) === null) {
        return apiJson(409, { ok: false, error: "permission dialog no longer active" });
      }
      try {
        await tmuxRaw(["send-keys", "-t", targetWindow, ...keySeq]);
      } catch (e) {
        return apiJson(500, { ok: false, error: `tmux send-keys 失败: ${(e as Error).message}` });
      }
      return apiJson(200, { ok: true });
    }

    return apiJson(400, { ok: false, error: 'kind must be "auq" or "permission"' });
  }

  // GET /api/v1/agents/:name/pending —— 当前挂起的交互卡 + thinking 态。
  // SSE 的 question 事件可能在前端连流之前发出（切会话/刷新/回前台），
  // 前端连流后调这里补拉（对应旧 web-hub 的 pendingInteraction replay）。
  const pendingMatch = path.match(/^\/agents\/([^/]+)\/pending$/);
  if (pendingMatch && req.method === "GET") {
    const agentParam = decodeURIComponent(pendingMatch[1]);
    if (!inScopeEitherName(principal, agentParam)) return notInScope(agentParam);
    const agent = await findApiAgent(agentParam);
    if (!agent) return apiJson(404, { ok: false, error: `agent "${agentParam}" not found` });
    const { auqStates } = await import("./ask-user-question.js");
    const auq = auqStates.get(agent.channelId);
    // thinking：该 agent 此刻是否在回合中（最近一次 agent_status=thinking）。
    // web 前端刷新/切回/回前台后连流时读它，同步 composer「暂停」态。同键：done 事件在
    // Stop hook 用 agentNameForChannel(channelId)（master 回退 CONTROL_CHANNEL_ID）落键。
    const evAgent = agentNameForChannel(agent.channelId) || (agent.channelId === CONTROL_CHANNEL_ID ? "master" : "?");
    const status = getAgentStatus(evAgent) ?? getAgentStatus(agent.name);
    return apiJson(200, {
      ok: true,
      agent: agent.name,
      question: auq ? { questions: auq.questions, ts: auq.ts } : null,
      // thinking 保持「忙」语义(压缩中也算),compacting 单独给出让前端显示「正在压缩上下文」
      thinking: isBusyStatus(status),
      compacting: status === "compacting",
    });
  }

  // POST /api/v1/agents/:name/notify-read —— v2.21.1+ 跨端已读回执:Web 端读过
  // 该 agent 的回复 → 删掉其频道里最近一条 Discord 完成 @(未读徽标消失)。
  // 幂等、best-effort:没有待删消息/已被人工清理都返回 ok。
  const notifyReadMatch = path.match(/^\/agents\/([^/]+)\/notify-read$/);
  if (notifyReadMatch && req.method === "POST") {
    const agentParam = decodeURIComponent(notifyReadMatch[1]);
    if (!inScopeEitherName(principal, agentParam)) return notInScope(agentParam);
    const agent = await findApiAgent(agentParam);
    if (!agent) return apiJson(404, { ok: false, error: `agent "${agentParam}" not found` });
    const cleared = (await deps.clearCompletionPing?.(agent.channelId)) ?? false;
    return apiJson(200, { ok: true, cleared });
  }

  // POST /api/v1/agents —— create（仅全权 token；复用 manager CLI）
  if (path === "/agents" && req.method === "POST") {
    if (!isFullScope(principal)) return forbidden("create requires a full-scope token");
    const body: any = await readJsonBody(req);
    if (body === INVALID_JSON) return invalidJsonBody();
    const name = String(body?.name || "").trim();
    const dir = String(body?.dir || "").trim();
    const purpose = String(body?.purpose || "").trim();
    // v2.10+ 可选钉模型/effort(owner 2026-07-16:「新建 agent 加选模型和 Effort」)。
    // 透传给 manager create --model/--effort,校验(别名/合法档位)由 manager 做。
    const model = String(body?.model || "").trim();
    const effort = String(body?.effort || "").trim();
    // v2.21+ 可选归属 project(缺省由 manager 按 dir 自动归属/建组)
    const project = String(body?.project || "").trim();
    // v2.23+ 运行时：Web 端也能建 Pi agent（此前只有命令行能建）
    const runtime = String(body?.runtime || "").trim();
    const piBase = String(body?.piBase || "").trim();
    if (runtime && !managedFor(runtime)) {
      return apiJson(400, { ok: false, error: `runtime must be one of: ${manageableRuntimeIds().join(", ")}` });
    }
    if (piBase && piBase !== "minimal" && piBase !== "inherit") {
      return apiJson(400, { ok: false, error: 'piBase must be "minimal" or "inherit"' });
    }
    if (!name || !dir) return apiJson(400, { ok: false, error: 'body must be {"name", "dir", "purpose"?, "model"?, "effort"?, "project"?, "runtime"?, "piBase"?}' });
    // name / dir 走位置参数，必须先挡掉长得像 flag 的值；purpose 改走具名
    // --purpose，避免自由文本被 manager 的 flag 提取抢先解析（详见
    // manager.ts 的 extractPurposeFlag 注释：曾可用 purpose 替换整个命令黑名单）。
    if (name.startsWith("-") || dir.startsWith("-") || project.startsWith("-")) {
      return apiJson(400, { ok: false, error: 'name/dir/project 不能以 "-" 开头' });
    }
    const createArgs = ["create", name, dir];
    if (purpose) createArgs.push("--purpose", purpose);
    if (model) createArgs.push("--model", model);
    if (effort) createArgs.push("--effort", effort);
    if (project) createArgs.push("--project", project);
    if (runtime && runtime !== DEFAULT_RUNTIME) createArgs.push("--runtime", runtime);
    if (piBase) createArgs.push("--pi-base", piBase);
    const r = await runManager(...createArgs);
    return apiJson(r?.ok ? 200 : 500, r ?? { ok: false, error: "manager create failed" });
  }

  // v2.23+ POST /api/v1/agents/resume —— 把一个**已存在的会话**收编成正式 agent。
  // 与 /sessions/:id/adopt 的区别：adopt 是「把 bg 分身立为**已有** agent 的正式会话」
  // （Claude Code 专属语义）；这条是「这个会话还不属于任何 agent，给它起个名字收编」，
  // 两种 runtime 都支持（Pi 走 resume --runtime pi，会话 id 是 open-or-create）。
  // 耗时（起 tmux 窗口 + 等就绪）→ 202 后台执行，结果进事件流。
  if (path === "/agents/resume" && req.method === "POST") {
    if (!principal.agents.includes("*")) {
      return apiJson(403, { ok: false, error: "resume requires a full-scope token" });
    }
    let body: any;
    try {
      body = await req.json();
    } catch {
      return apiJson(400, { ok: false, error: "invalid JSON body" });
    }
    const agent = String(body?.agent || "").trim();
    const sessionId = String(body?.sessionId || "").trim();
    const runtime = String(body?.runtime || "").trim();
    const cwd = String(body?.cwd || "").trim();
    if (!agent || !sessionId) {
      return apiJson(400, { ok: false, error: 'body must be {"agent", "sessionId", "runtime"?, "cwd"?}' });
    }
    if (agent.startsWith("-") || sessionId.startsWith("-") || cwd.startsWith("-")) {
      return apiJson(400, { ok: false, error: 'agent/sessionId/cwd 不能以 "-" 开头' });
    }
    if (!isValidSessionId(sessionId)) return apiJson(400, { ok: false, error: "invalid sessionId" });
    // 只读来源（Codex 在接线前）不能收编；以前这里不校验，未知值会被悄悄当 Claude Code 起
    if (runtime && !managedFor(runtime)) {
      return apiJson(400, { ok: false, error: `runtime must be one of: ${manageableRuntimeIds().join(", ")}` });
    }
    const args = ["resume", agent, sessionId];
    if (cwd) args.push(cwd);
    if (runtime && runtime !== DEFAULT_RUNTIME) args.push("--runtime", runtime);
    // ⚠ 必须**同步等**（与 POST /agents 的 create 一致）：原来做成 202 + 后台，
    // 结果只进事件流 → 界面只看到「已受理」，后台失败（最常见：默认名字与已有
    // agent 撞车 → manager 报「已存在」）时用户完全看不到原因，只会认为"收编失败"。
    // 代价是这个请求要挂 10-40s（起窗口 + 等就绪），browser 侧超时给到 180s。
    //
    // D1-5 占用闸：这个会话正被本机一个活的 interactive Claude Code 开着（用户在别的终端里），
    // 直接 resume 会让两个进程同时写同一个 session。没带 fork / takeover 就回 409 + {live,pid}，
    // 由前端给「接管（会关掉原窗口）/ 分叉副本」两个选择：
    //   takeover:true → manager takeover（SIGTERM 原进程后用同一个 id 接着开）
    //   fork:true     → resume --fork（原会话不动，收编一个分叉副本）
    const takeover = body?.takeover === true;
    const fork = body?.fork === true;
    if (!takeover && !fork && (!runtime || runtime === DEFAULT_RUNTIME)) {
      const holder = await liveInteractiveHolder(sessionId);
      if (holder) {
        return apiJson(409, {
          ok: false,
          live: true,
          pid: holder.pid,
          sessionId,
          error: "session is open in a live Claude Code process — retry with takeover or fork",
        });
      }
    }
    if (fork && !takeover) args.push("--fork");
    const r = takeover ? await runManager("takeover", sessionId, "--name", agent) : await runManager(...args);
    emitEvent({
      agent,
      chatId: "",
      type: "session_anomaly",
      data: { kind: "resume_result", sessionId, ok: !!r?.ok, ...r },
    });
    return apiJson(r?.ok ? 200 : 500, r ?? { ok: false, error: "manager resume failed" });
  }

  // GET/PUT /api/v1/config/claude-defaults —— 全局默认模型/effort 管理
  // (owner 2026-07-16:「设置里可以管理全局 model 和 effort」)。读写
  // ~/.claude/settings.json 的 model / effortLevel 两个字段,其余字段原样保留。
  // 影响所有不带 --model/--effort 的新 session(含终端里直接开的 claude)。
  if (path === "/config/claude-defaults") {
    if (!isFullScope(principal)) return forbidden("claude-defaults requires a full-scope token");
    const settingsPath = `${process.env.HOME}/.claude/settings.json`;
    if (req.method === "GET") {
      try {
        const s = JSON.parse(await Bun.file(settingsPath).text());
        return apiJson(200, {
          ok: true,
          model: typeof s.model === "string" ? s.model : null,
          effort: typeof s.effortLevel === "string" ? s.effortLevel : null,
        });
      } catch (e) {
        return apiJson(500, { ok: false, error: `读取 settings.json 失败: ${(e as Error).message}` });
      }
    }
    if (req.method === "PUT") {
      const body: any = await readJsonBody(req);
      if (body === INVALID_JSON) return invalidJsonBody();
      const model = typeof body?.model === "string" ? body.model.trim() : undefined;
      const effort = typeof body?.effort === "string" ? body.effort.trim() : undefined;
      if (model === undefined && effort === undefined) {
        return apiJson(400, { ok: false, error: 'body must contain "model" and/or "effort"' });
      }
      if (effort !== undefined && effort !== "" && !isKnownEffort(effort)) {
        return apiJson(400, { ok: false, error: `未知 effort: "${effort}"。可用: ${KNOWN_EFFORT_LEVELS.join(", ")}` });
      }
      try {
        // 重读-改字段-写回:只动 model/effortLevel,别的字段(hooks 等)原样保留
        const s = JSON.parse(await Bun.file(settingsPath).text());
        if (model !== undefined) {
          if (model === "") delete s.model;
          else s.model = resolveModelAlias(model);
        }
        if (effort !== undefined) {
          if (effort === "") delete s.effortLevel;
          else s.effortLevel = effort;
        }
        await Bun.write(settingsPath, JSON.stringify(s, null, 2) + "\n");
        recordMetric("claude_defaults_updated", { meta: { model: s.model, effort: s.effortLevel } });
        return apiJson(200, { ok: true, model: s.model ?? null, effort: s.effortLevel ?? null });
      } catch (e) {
        return apiJson(500, { ok: false, error: `写入 settings.json 失败: ${(e as Error).message}` });
      }
    }
    return apiJson(405, { ok: false, error: "GET / PUT only" });
  }

  // POST /api/v1/agents/:name/kill | /restart | /remove —— 生命周期（仅全权 token）
  // remove = kill + registry 条目删除(列表永久移除,归档保留)
  const lifecycleMatch = path.match(/^\/agents\/([^/]+)\/(kill|restart|remove)$/);
  if (lifecycleMatch && req.method === "POST") {
    if (!isFullScope(principal)) return forbidden(`${lifecycleMatch[2]} requires a full-scope token`);
    const agentParam = decodeURIComponent(lifecycleMatch[1]);
    if (agentParam === "master") return apiJson(400, { ok: false, error: "master lifecycle is managed by the launcher" });
    const r = await runManager(lifecycleMatch[2], agentParam);
    return apiJson(r?.ok ? 200 : 500, r ?? { ok: false, error: `manager ${lifecycleMatch[2]} failed` });
  }

  // ── v2.20+ /cron —— 定时任务管理面(owner 2026-08-26「cron 没有 UI」)。
  // 与 /peers 同款:全权 token 门禁,mutation 全走 runManager 复用 CLI 校验,
  // 与 Discord /cron 面板、CLI 手管三方等价互不打架。
  if (path === "/cron" || path.startsWith("/cron/")) {
    if (!isFullScope(principal)) return forbidden("cron management requires a full-scope token");
    if (path === "/cron" && req.method === "GET") {
      const jobs = await loadJobs();
      return apiJson(200, {
        ok: true,
        jobs: jobs.map((j) => ({
          id: j.id,
          name: j.name,
          schedule: j.schedule,
          dir: j.dir.replace(process.env.HOME || "", "~"),
          prompt: j.prompt, // 全文——编辑界面要用,不像 cron-list 截 80
          enabled: j.enabled,
          lastRun: j.lastRun ?? null,
          nextRun: j.nextRun ?? null,
          targetAgent: j.targetAgent ?? null,
          effort: j.effort ?? null, // null = 缺省(临时 agent 走 medium)
          project: j.project ?? null, // null = 按 dir 自动解析
          createdAt: j.createdAt,
        })),
      });
    }
    if (path === "/cron" && req.method === "POST") {
      const body: any = await readJsonBody(req);
      if (body === INVALID_JSON) return invalidJsonBody();
      const name = String(body?.name ?? "").trim();
      const schedule = String(body?.schedule ?? "").trim();
      const prompt = String(body?.prompt ?? "").trim();
      const dir = String(body?.dir ?? "~").trim() || "~";
      if (!name || !schedule || !prompt) {
        return apiJson(400, { ok: false, error: "name/schedule/prompt required" });
      }
      const extra: string[] = body?.targetAgent ? ["--target-agent", String(body.targetAgent)] : [];
      if (body?.effort) extra.push("--effort", String(body.effort));
      if (body?.project) extra.push("--project", String(body.project));
      const r = await runManager("cron-add", name, schedule, dir, ...extra, prompt);
      return apiJson(r?.ok ? 200 : 400, r ?? { ok: false, error: "manager failed" });
    }
    const cronAction = path.match(/^\/cron\/([^/]+)\/(toggle|remove|edit)$/);
    if (cronAction && req.method === "POST") {
      const id = decodeURIComponent(cronAction[1]);
      const action = cronAction[2];
      let r: any;
      if (action === "toggle") r = await runManager("cron-toggle", id);
      else if (action === "remove") r = await runManager("cron-remove", id);
      else {
        const body: any = await readJsonBody(req);
        if (body === INVALID_JSON) return invalidJsonBody();
        const flags: string[] = [];
        if (body?.schedule) flags.push("--schedule", String(body.schedule));
        if (body?.prompt) flags.push("--prompt", String(body.prompt));
        if (body?.name) flags.push("--name", String(body.name));
        if (body?.dir) flags.push("--dir", String(body.dir));
        if (body?.effort) flags.push("--effort", String(body.effort));
        // project: 传 "" / null 表示清除(回到按 dir 解析),manager 侧用 "-" 表示
        if (body?.project !== undefined) flags.push("--project", body.project ? String(body.project) : "-");
        if (!flags.length) return apiJson(400, { ok: false, error: "nothing to edit" });
        r = await runManager("cron-edit", id, ...flags);
      }
      return apiJson(r?.ok ? 200 : 400, r ?? { ok: false, error: "manager failed" });
    }
    return apiJson(405, { ok: false, error: "method not allowed" });
  }

  // ── v2.20.2+ /auto-compact —— 自动存记忆+compact 的阈值/闲置门槛(owner:
  // 「设置里看不到」——此前只有配置文件可改)。写入 Claudestra 自己的
  // config.json(CC 的 settings.json 会拒未知字段,只读兼容不写)。
  if (path === "/auto-compact") {
    if (!isFullScope(principal)) return forbidden("auto-compact config requires a full-scope token");
    const state = async () => {
      const cfg = await readAppConfig();
      return {
        ok: true,
        // window:0=关闭;undefined=未设(用默认或 settings.json 兼容值)
        window: cfg.autoCompact?.window ?? null,
        idleHours: cfg.autoCompact?.idleHours ?? null,
        // v2.21.3+ 93% 救命线独立开关(缺省开;常规线 window=0 时仍兜底)
        emergency: cfg.autoCompact?.emergency !== false,
        defaults: { window: 400_000, idleHours: 3, emergency: true, emergencyRatio: 0.93 },
      };
    };
    if (req.method === "GET") return apiJson(200, await state());
    if (req.method === "POST") {
      const body: any = await readJsonBody(req);
      if (body === INVALID_JSON) return invalidJsonBody();
      const patch: { window?: number; idleHours?: number; emergency?: boolean } = {};
      if (body.emergency !== undefined) patch.emergency = Boolean(body.emergency);
      if (body.window !== undefined) {
        const w = Number(body.window);
        if (!Number.isFinite(w) || w < 0 || w > 10_000_000) {
          return apiJson(400, { ok: false, error: "window must be 0..10000000 tokens" });
        }
        patch.window = w;
      }
      if (body.idleHours !== undefined) {
        const h = Number(body.idleHours);
        if (!Number.isFinite(h) || h < 0 || h > 168) {
          return apiJson(400, { ok: false, error: "idleHours must be 0..168" });
        }
        patch.idleHours = h;
      }
      if (patch.window === undefined && patch.idleHours === undefined && patch.emergency === undefined) {
        return apiJson(400, { ok: false, error: "nothing to set" });
      }
      await setAutoCompact(patch);
      return apiJson(200, await state());
    }
    return apiJson(405, { ok: false, error: "method not allowed" });
  }

  // ── v2.21+ /projects —— project 管理面(owner 2026-08-28「加 project 概念」)。
  // 与 /peers 同款:全权 token 门禁,GET 读 projects.json+registry,mutation 全
  // 走 runManager 的 project-*(CLI 校验/写锁/原子写是唯一事实源)。
  const upd = await handleUpdateRoutes(req, url, path, principal);
  if (upd) return upd;

  /**
   * v2.24+ POST /api/v1/restart-all —— 全体重启（含大总管）。
   *
   * 由来（owner 2026-09-22）：Claude Code 被意外登出后，在某一个会话里重新登录，
   * **其它会话照样是未登录**——凭证只在进程启动时读一次，已经在跑的进程既刷不动
   * 作废的 refresh token，也不会回头重读 keychain。唯一的解是让每个进程重启。
   *
   * 与 /update 同一形状：detached + 立刻 202。这里等不得的理由不同——18 个 agent
   * 逐个 `--resume` 拉起是分钟级，HTTP 早超时了。进度拉 GET /api/v1/restart-all/log。
   *
   * agent 走 `--resume <原 sessionId>`（上下文不丢）；大总管由 manager 退出、
   * launcher 15 秒内用交接单里的 id 接回（lib/master-session.ts）。
   */
  if (path === "/restart-all" && req.method === "POST") {
    if (!isFullScope(principal)) return forbidden("restart-all requires a full-scope token");
    let body: any = {};
    try {
      body = (await req.json()) ?? {};
    } catch { /* 空 body = 默认全带上 */ }
    const includeMaster = body?.includeMaster !== false;
    const busy = await activeBgJob("restart-all");
    if (busy) return apiJson(409, { ok: false, error: "上一轮全体重启还没结束", runId: busy });
    const flag = includeMaster ? " --include-master" : "";
    let runId: string;
    try {
      runId = spawnBgJob("restart-all", `restart-all${flag}`, `restart${flag}`);
    } catch (e) {
      return apiJson(500, { ok: false, error: `起不来重启进程: ${(e as Error).message}` });
    }
    return apiJson(202, {
      ok: true,
      accepted: true,
      runId,
      includeMaster,
      log: bgJobLog("restart-all"),
      hint: "逐个重启中（每个 agent 都 --resume 原会话）。进度拉 GET /api/v1/restart-all/log?run=<runId>",
    });
  }

  /** 全体重启的进度：只回本轮的行 + done/exitCode（不带 ?run 时 = 最后一轮，用来接回进行中的） */
  if (path === "/restart-all/log" && req.method === "GET") {
    if (!isFullScope(principal)) return forbidden("restart-all log requires a full-scope token");
    return bgJobLogResponse("restart-all", url);
  }

  if (path === "/projects") {
    if (!isFullScope(principal)) return forbidden("projects requires a full-scope token");
    if (req.method === "GET") {
      const r = await runManager("project-list");
      return apiJson(r?.ok ? 200 : 500, r ?? { ok: false, error: "manager failed" });
    }
    if (req.method === "POST") {
      const body: any = await readJsonBody(req);
      if (body === INVALID_JSON) return invalidJsonBody();
      const action = String(body?.action || "");
      const id = String(body?.id || "").trim();
      const str = (k: string) => (typeof body?.[k] === "string" ? (body[k] as string) : undefined);
      // 具名 flag 之前挡掉长得像 flag 的自由文本(与 /agents create 同款防线)
      if (id.startsWith("-")) return apiJson(400, { ok: false, error: 'id 不能以 "-" 开头' });
      let r: any;
      if (action === "add" || action === "edit") {
        if (!id) return apiJson(400, { ok: false, error: '"id" required' });
        const flags: string[] = [];
        if (str("name") !== undefined) flags.push("--name", str("name")!);
        if (str("emoji") !== undefined) flags.push("--emoji", str("emoji")!);
        if (Array.isArray(body?.dirs)) flags.push("--dirs", (body.dirs as unknown[]).filter((d) => typeof d === "string").join(","));
        if (str("desc") !== undefined) flags.push("--desc", str("desc")!);
        r = await runManager(`project-${action}`, id, ...flags);
      } else if (action === "remove") {
        if (!id) return apiJson(400, { ok: false, error: '"id" required' });
        r = await runManager("project-remove", id);
      } else if (action === "assign") {
        const agent = String(body?.agent || "").trim();
        if (!agent || !id) return apiJson(400, { ok: false, error: '"agent" and "id" required' });
        if (agent.startsWith("-")) return apiJson(400, { ok: false, error: 'agent 不能以 "-" 开头' });
        r = await runManager("project-assign", agent, id);
      } else {
        return apiJson(400, { ok: false, error: `unknown action "${action}" (add|edit|remove|assign)` });
      }
      return apiJson(r?.ok ? 200 : 500, r ?? { ok: false, error: "manager failed" });
    }
    return apiJson(405, { ok: false, error: "method not allowed" });
  }

  // ── v2.20+ /memory-hygiene —— mem0 记忆卫生(owner 2026-08-26「mem0 会变粪坑,
  // 做进产品+可配置」)。事实源 = cron 系统里的 mem0-hygiene 任务;这里只是
  // 设置界面的读写面,mutation 全走 runManager 的 cron-add/remove/toggle,
  // 与 CLI 手管等价。全权 token 门禁与 /peers 同级。
  if (path === "/memory-hygiene") {
    if (!isFullScope(principal)) return forbidden("memory hygiene requires a full-scope token");
    const findJob = async () => (await loadJobs()).find((j) => j.name === HYGIENE_JOB_NAME) ?? null;
    const stateOf = (j: Awaited<ReturnType<typeof findJob>>) => ({
      ok: true,
      exists: !!j,
      enabled: !!j?.enabled,
      freq: j ? freqOfSchedule(j.schedule) : null,
      schedule: j?.schedule ?? null,
      lastRun: j?.lastRun ?? null,
      nextRun: j?.nextRun ?? null,
      freqs: Object.fromEntries(Object.entries(HYGIENE_FREQS).map(([k, v]) => [k, v.label])),
    });

    if (req.method === "GET") {
      return apiJson(200, stateOf(await findJob()));
    }
    if (req.method === "POST") {
      const body: any = await readJsonBody(req);
      if (body === INVALID_JSON) return invalidJsonBody();
      const enabled = !!body?.enabled;
      const freq = String(body?.freq ?? "weekly") as HygieneFreq;
      if (enabled && !HYGIENE_FREQS[freq]) {
        return apiJson(400, { ok: false, error: `freq must be one of ${Object.keys(HYGIENE_FREQS).join("|")}` });
      }
      const job = await findJob();
      if (!enabled) {
        // 关闭 = 停用不删除(保留 lastRun 历史;cron-toggle 是翻转,只在当前启用时调)
        if (job?.enabled) await runManager("cron-toggle", HYGIENE_JOB_NAME);
      } else {
        const schedule = HYGIENE_FREQS[freq].schedule;
        if (!job) {
          await runManager("cron-add", HYGIENE_JOB_NAME, schedule, "~", hygienePrompt());
        } else {
          // 原地编辑保 id/lastRun(owner 2026-08-26「改个频率要重建不合理」)
          if (job.schedule !== schedule) {
            await runManager("cron-edit", HYGIENE_JOB_NAME, "--schedule", schedule);
          }
          if (!job.enabled) await runManager("cron-toggle", HYGIENE_JOB_NAME);
        }
      }
      recordMetric("cron_run", { meta: { action: "hygiene-config", enabled: String(enabled), freq } });
      return apiJson(200, stateOf(await findJob()));
    }
    return apiJson(405, { ok: false, error: "method not allowed" });
  }

  // ── v2.11.1+ /peers —— HTTP peer 管理面（web UI 后端;owner 2026-07-24
  // 「前端要能管理 peer 的权限以及在哪些远端有权限」）。全部 mutation 走
  // runManager 复用 CLI 的 R1 校验/token 签发/原子写,bridge 不直写 principals。
  if (path === "/peers" || path.startsWith("/peers/")) {
    if (!isFullScope(principal)) return forbidden("peers management requires a full-scope token");

    // GET /peers —— 清单:peers.json ⋈ principals(入站 scope) + 本地 agent 表(scope 编辑器数据源)
    if (path === "/peers" && req.method === "GET") {
      const [peersData, pf, regAgents] = await Promise.all([
        readPeers(),
        readPrincipals(),
        readRegistryAgents(),
      ]);
      const { peerPresence } = await import("./peer-presence.js");
      const peers = (peersData.httpPeers || []).map((p) => {
        const tok = pf.principals.find((x) => x.peer === p.name && !x.disabled);
        return {
          name: p.name,
          baseUrl: p.baseUrl || null,
          handshakeDone: !!(p.outToken && p.baseUrl),
          disabled: !!p.disabled,
          addedAt: p.addedAt,
          inTokenId: tok ? tokenIdOf(tok) : p.inTokenId ?? null,
          /** 对方 token 的 scope = 对方能访问我这边哪些 agent */
          exposedAgents: tok?.agents ?? [],
          presence: peerPresence(p.name), // 在线状态 + 最近来访（bridge/peer-presence.ts）
        };
      });
      const localAgents = regAgents.map((a) => ({
        name: a.name.startsWith("agent-") ? a.name.slice(6) : a.name,
        external: !!a.external,
        status: a.status ?? "unknown",
      }));
      // v2.15+ 待兑换的一键邀请（peer-invite-list 顺带清扫过期 + 吊销其 token）
      const invRes: any = await runManager("peer-invite-list");
      const pendingInvites = invRes?.ok ? invRes.invites || [] : [];
      return apiJson(200, { ok: true, peers, localAgents, pendingInvites });
    }

    // v2.15+ POST /peers/invite-new | /peers/join-auto | /peers/invite-revoke
    // —— 一键邀请（免回执自动握手）。mutation 照旧全部委托 runManager。
    if (req.method === "POST" && (path === "/peers/invite-new" || path === "/peers/join-auto" || path === "/peers/invite-revoke")) {
      const body: any = await readJsonBody(req);
      if (body === INVALID_JSON) return invalidJsonBody();
      const agentsCsv = Array.isArray(body?.agents)
        ? body.agents.map((s: unknown) => String(s).trim()).filter(Boolean).join(",")
        : "";
      const flags: string[] = body?.force ? ["--force"] : [];
      let r: any;
      if (path === "/peers/invite-new") {
        if (!agentsCsv) return apiJson(400, { ok: false, error: '"agents" must be a non-empty array' });
        r = await runManager("peer-invite-new", "--agents", agentsCsv,
          ...(body?.url ? ["--url", String(body.url)] : []), ...flags);
      } else if (path === "/peers/join-auto") {
        const invite = String(body?.invite ?? "").trim();
        if (!invite) return apiJson(400, { ok: false, error: '"invite" required' });
        r = await runManager("peer-join-auto", invite,
          ...(agentsCsv ? ["--agents", agentsCsv] : []),
          ...(body?.url ? ["--url", String(body.url)] : []), ...flags);
      } else {
        const id = String(body?.id ?? "").trim();
        if (!id) return apiJson(400, { ok: false, error: '"id" required' });
        r = await runManager("peer-invite-revoke", id);
      }
      if (r?.ok) recordMetric("peer_managed", { meta: { action: path.slice("/peers/".length), peer: r.peer ?? r.id ?? r.revoked ?? "" } });
      return apiJson(r?.ok ? 200 : 400, r ?? { ok: false, error: "manager failed" });
    }

    // POST /peers/invite | /peers/join | /peers/accept —— 握手三步
    if (req.method === "POST" && (path === "/peers/invite" || path === "/peers/join" || path === "/peers/accept")) {
      const body: any = await readJsonBody(req);
      if (body === INVALID_JSON) return invalidJsonBody();
      const name = typeof body?.name === "string" ? body.name.trim() : "";
      if (!name) return apiJson(400, { ok: false, error: '"name" required' });
      const agentsCsv = Array.isArray(body?.agents)
        ? body.agents.map((s: unknown) => String(s).trim()).filter(Boolean).join(",")
        : "";
      const flags: string[] = [];
      if (body?.force) flags.push("--force");
      if (body?.rotate) flags.push("--rotate");
      let r: any;
      if (path === "/peers/invite") {
        r = await runManager("peer-http-invite", name, "--agents", agentsCsv, "--url", String(body?.url ?? ""), ...flags);
      } else if (path === "/peers/join") {
        r = await runManager("peer-http-join", name, String(body?.invite ?? ""), "--agents", agentsCsv, "--url", String(body?.url ?? ""), ...flags);
      } else {
        r = await runManager("peer-http-accept", name, String(body?.receipt ?? ""));
      }
      if (r?.ok) recordMetric("peer_managed", { meta: { action: path.slice("/peers/".length), peer: name } });
      return apiJson(r?.ok ? 200 : 400, r ?? { ok: false, error: "manager failed" });
    }

    // POST /peers/:name/test | /peers/:name/scope | /peers/:name/remove
    const peerActionMatch = path.match(/^\/peers\/([^/]+)\/(test|scope|remove)$/);
    if (peerActionMatch && req.method === "POST") {
      const pname = decodeURIComponent(peerActionMatch[1]);
      const action = peerActionMatch[2];
      if (action === "test") {
        // 连通探测(顺带回答「我在对方那边有哪些 agent 可访问」)。失败也是数据不是服务错,一律 200
        const r = await runManager("peer-http-test", pname);
        return apiJson(200, r ?? { ok: false, error: "manager failed" });
      }
      if (action === "remove") {
        const r = await runManager("peer-http-remove", pname);
        if (r?.ok) recordMetric("peer_managed", { meta: { action: "remove", peer: pname } });
        return apiJson(r?.ok ? 200 : 400, r ?? { ok: false, error: "manager failed" });
      }
      // scope —— 改对方入站可访问的 agent 白名单(R1 校验在 manager 侧)
      const body: any = await readJsonBody(req);
      if (body === INVALID_JSON) return invalidJsonBody();
      const agentsCsv = Array.isArray(body?.agents)
        ? body.agents.map((s: unknown) => String(s).trim()).filter(Boolean).join(",")
        : "";
      if (!agentsCsv) return apiJson(400, { ok: false, error: '"agents" must be a non-empty array' });
      const r = await runManager("peer-http-scope", pname, "--agents", agentsCsv, ...(body?.force ? ["--force"] : []));
      if (r?.ok) recordMetric("peer_managed", { meta: { action: "scope", peer: pname, agents: agentsCsv } });
      return apiJson(r?.ok ? 200 : 400, r ?? { ok: false, error: "manager failed" });
    }

    return apiJson(404, { ok: false, error: "unknown peers endpoint" });
  }

  return apiJson(404, { ok: false, error: "unknown endpoint" });
}

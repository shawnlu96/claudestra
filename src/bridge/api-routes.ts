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

import { existsSync, readdirSync, statSync } from "fs";
import { TMP_DIR, MASTER_DIR, INBOX_DIR } from "./config.js";
import {
  readPrincipals,
  findByBearer,
  agentInScope,
  tokenIdOf,
  SlidingWindowLimiter,
  type Principal,
} from "../lib/principals.js";
import { runManager } from "./management.js";
import { readPeers } from "../lib/peers.js";
import { readRegistryAgents } from "../lib/registry.js";
import { collectSessions } from "./sessions-inventory.js";
import { cleanupBgJob } from "../lib/bg-jobs.js";
import { emitEvent, getAgentStatus, type EventFilter } from "./event-bus.js";
import { listAgentSessions, readSessionHistory, isValidSessionId, isValidSubagentId } from "../lib/session-history.js";
import { formatTool, formatToolDetail, agentNameForChannel } from "./jsonl-watcher.js";
import { newThreadId, type Envelope, type ApiUserEndpoint } from "./router.js";
// additive 端点（interrupt/clear/answer/pending/create/lifecycle）复用的共享 helper。
// 绝大多数是平台无关模块，直接 import；仅 scheduleClearRotation 依赖 bridge 本地
// 的 discord/startWatching，走 initApiRoutes 注入。
import {
  tmuxRaw,
  tmuxCapture,
  tmuxSendLine,
  paneLooksIdle,
  windowTarget,
  detectRuntimePermissionPrompt,
  listWindows,
  MASTER_SESSION,
} from "../lib/tmux-helper.js";
import { stopTyping } from "./components.js";
import { clearSafetyTimer } from "./discord-adapter.js";
import { recordMetric } from "../lib/metrics.js";
import { commandsForAgent, resolveWebInvocation, isProjectSkillForOtherAgent } from "./slash-registry.js";
import { projectsSlug } from "../lib/jsonl-cost.js";
import { resolveModelAlias, isKnownEffort, KNOWN_EFFORT_LEVELS } from "../lib/claude-launch.js";

// master 不在 registry，从 env 读其控制频道 id（各端点的 master 特判用）
const CONTROL_CHANNEL_ID = process.env.CONTROL_CHANNEL_ID || "";

/** interrupt 端点的每 agent 冷却(防双击双 C-c——空闲态连按两次是 CC 退出键)。 */
const interruptCooldown = new Map<string, number>();

/**
 * master 的最新 session id：master 不在 registry，从其 cwd 的
 * ~/.claude/projects/<slug>/ 目录里 probe mtime 最新的 jsonl。
 * bridge.ts 的 scheduleClearRotation 也 import 它（clear 轮转判重用）。
 */
export function latestSessionIdForCwd(cwd: string): string | undefined {
  try {
    const dir = `${process.env.HOME}/.claude/projects/${projectsSlug(cwd)}`;
    let best: { sid: string; mtime: number } | null = null;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".jsonl")) continue;
      const st = statSync(`${dir}/${f}`);
      if (!best || st.mtimeMs > best.mtime) best = { sid: f.slice(0, -".jsonl".length), mtime: st.mtimeMs };
    }
    return best?.sid;
  } catch {
    return undefined;
  }
}

/**
 * 列出 cwd 的 projects slug 目录里所有 session id（无序）。
 * clear 轮转用它做"clear 前快照 vs 之后新增"的集合 diff（M2）——同 cwd 多 agent
 * 共享一个 slug 目录，光取"最新 jsonl"会误认别人正在写的既有 session；只认领
 * 快照里没有的**新 sid**才不会串台。
 */
export function listSessionIdsForCwd(cwd: string): string[] {
  try {
    const dir = `${process.env.HOME}/.claude/projects/${projectsSlug(cwd)}`;
    return readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => ({ sid: f.slice(0, -".jsonl".length), mtime: statSync(`${dir}/${f}`).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime) // mtime 降序：调用方取 [0] 即最新
      .map((e) => e.sid);
  } catch {
    return [];
  }
}

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
const API_REQUEST_TTL_MS = 10 * 60_000;

export function apiReqKey(tokenId: string, agentChannelId: string): string {
  return `${tokenId}|${agentChannelId}`;
}

/** API 会话状态 TTL 清理（bridge 的 staleCleanup 周期里调用） */
export function sweepApiState(now = Date.now()): void {
  for (const [key, queue] of pendingApiRequests.entries()) {
    const fresh = queue.filter((p) => now - p.ts <= API_REQUEST_TTL_MS);
    if (fresh.length === 0) pendingApiRequests.delete(key);
    else if (fresh.length !== queue.length) pendingApiRequests.set(key, fresh);
  }
  for (const [tid, hit] of apiThreadResults.entries()) {
    if (now - hit.ts > API_REQUEST_TTL_MS) apiThreadResults.delete(tid);
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
}

let deps: ApiDeps | null = null;

export function initApiRoutes(d: ApiDeps): void {
  deps = d;
}

// ── 鉴权 + 通用 helper ──────────────────────────────────────────────────

function apiJson(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Bearer 鉴权 + 限流。失败直接返回 Response，成功返回 principal。
 * v2.10+ 也接受 ?token=<secret>（header 优先）：浏览器 EventSource 不能带
 * Authorization header，SSE 场景的标准折衷。secret 进 URL 的暴露面由「bridge
 * 默认只绑回环 + 对外自备反代/TLS」的既有边界兜住；非 SSE 调用仍应走 header。
 */
async function authApi(req: Request, url: URL): Promise<Principal | Response> {
  const auth = req.headers.get("Authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  const secret = m?.[1]?.trim() || url.searchParams.get("token") || "";
  if (!secret) return apiJson(401, { ok: false, error: "missing Authorization: Bearer <secret> (SSE may use ?token=)" });
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
      sessionId: latestSessionIdForCwd(cwd),
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
 * 会话文件里最后一条真实对话记录（user/assistant，带 timestamp）的时间。
 *
 * 不能用文件 mtime 当「最近对话时间」：CC 会持续原地更新状态类记录
 * （last-prompt / mode / file-history-snapshot 等）——空闲 agent 的 mtime
 * 也一直在刷新，列表排序就出现「没动静的 agent 莫名顶到最前」
 * （2026-07-13 真机实锤：router 尾部内容停在 07-12，mtime 却是当下）。
 * tail 256KB 逆序找；找不到（超大 tool_result 把对话挤出窗口）退回 mtime。
 * 按 (path, mtimeMs) 缓存——mtime 没变不重读。
 */
interface SessionTailInfo {
  /** 最后一条真实对话(user/assistant)的时间,找不到退 mtime */
  convTs: number | null;
  /** 最近一条 assistant 的 usage 合计 ≈ 当前上下文占用 token 数 */
  ctxTokens: number | null;
  /** 最近一条 assistant 实际用的 model id（会话内 /model 切换后即时反映，防 registry 漂移） */
  model: string | null;
  /** model 读取自的那条 assistant 记录的时间——切换端点的乐观显示靠它判断实测是否已追上 */
  modelTs: number | null;
  /** 会话内最近一次 /effort 的结果档位（stdout 自述,tail 窗内没有则 null → 调用方回退 registry/全局） */
  effort: string | null;
  /** effort 读取自的那条记录的时间（同 modelTs 用途） */
  effortTs: number | null;
}
const tailInfoCache = new Map<string, { mtimeMs: number; info: SessionTailInfo }>();
async function sessionTailInfo(path: string): Promise<SessionTailInfo | null> {
  try {
    const st = statSync(path);
    const hit = tailInfoCache.get(path);
    if (hit && hit.mtimeMs === st.mtimeMs) return hit.info;
    const start = Math.max(0, st.size - 262144);
    const text = await Bun.file(path).slice(start, st.size).text();
    const lines = text.split("\n");
    let convTs: number | null = null;
    let ctxTokens: number | null = null;
    let model: string | null = null;
    let modelTs: number | null = null;
    let effort: string | null = null;
    let effortTs: number | null = null;
    for (
      let i = lines.length - 1;
      i >= 0 && (convTs === null || ctxTokens === null || model === null || effort === null);
      i--
    ) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const rec = JSON.parse(line);
        // compact 边界比最近一条 assistant 更新时,占用以 postTokens 为准——
        // 否则压缩刚完、新回合未跑的窗口里,轮询会把 ctx 徽章顶回压缩前的值
        if (ctxTokens === null && rec.type === "system" && rec.subtype === "compact_boundary") {
          const post = rec.compactMetadata?.postTokens;
          if (typeof post === "number") ctxTokens = post;
        }
        // 上下文占用:最近一条带 usage 的 assistant——input + cache 读写就是
        // 本轮进模型的全部上下文(web 端「context 快满」指示的数据源)。
        // 合计为 0 的跳过:restart 回放命令产生的「No response requested.」等
        // 合成记录 usage 全 0,采纳它会让全列表 ctx 归零(2026-07-14 CC 升级
        // 全量 restart 后「各会话上下文占用只剩一个」的根因)
        if (ctxTokens === null && rec.type === "assistant") {
          const u = rec.message?.usage;
          if (u && typeof u.input_tokens === "number") {
            const total =
              u.input_tokens + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
            if (total > 0) ctxTokens = total;
          }
        }
        // 当前模型:最近一条 assistant 的 message.model(错误占位的 "<synthetic>" 跳过)
        if (model === null && rec.type === "assistant") {
          const m = rec.message?.model;
          if (typeof m === "string" && m && !m.startsWith("<")) {
            model = m;
            const t = Date.parse(rec.timestamp);
            modelTs = Number.isFinite(t) ? t : null;
          }
        }
        // 会话内 /effort 切换:stdout 自述("Kept/Set effort level as/to xxx")
        if (effort === null && rec.type === "user") {
          const c = rec.message?.content;
          const body = typeof c === "string" ? c : "";
          const em = body.includes("local-command-stdout")
            ? body.match(/(?:Kept|Set) effort level (?:as|to) (\w+)/)
            : null;
          if (em) {
            effort = em[1];
            const t = Date.parse(rec.timestamp);
            effortTs = Number.isFinite(t) ? t : null;
          }
        }
        if (convTs === null && (rec.type === "user" || rec.type === "assistant") && typeof rec.timestamp === "string") {
          // TUI 命令记录（批量 /model 之类）不算对话——不跳过的话一次批量维护
          // 会让全部 agent 的「最后对话」并列在同一时刻
          if (rec.type === "user") {
            const c = rec.message?.content;
            const body = typeof c === "string" ? c : "";
            if (/^\s*<(command-name|command-message|local-command-stdout|local-command-caveat)/.test(body)) continue;
          }
          // restart/resume 回放排队命令时,CC 会产出一条礼节性 assistant
          // 「No response requested.」——不是真对话,不排除的话每次 restart
          // 都把该 agent 顶到列表最前(owner 2026-07-14:「重启不算用户真正的会话」)
          if (rec.type === "assistant") {
            const c = rec.message?.content;
            const txt = Array.isArray(c)
              ? c.filter((b: any) => b?.type === "text").map((b: any) => b.text || "").join("")
              : typeof c === "string" ? c : "";
            if (/^\s*No response requested\.?\s*$/.test(txt)) continue;
          }
          const t = Date.parse(rec.timestamp);
          if (Number.isFinite(t)) convTs = t;
        }
      } catch {
        /* tail 起点切到半行 */
      }
    }
    const info: SessionTailInfo = { convTs: convTs ?? st.mtimeMs, ctxTokens, model, modelTs, effort, effortTs };
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
  let body: any;
  try {
    body = await req.json();
  } catch {
    return apiJson(400, { ok: false, error: "invalid JSON body" });
  }
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

export async function handleApiRequest(req: Request, url: URL): Promise<Response> {
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
      const agents = ((listResult.agents || []) as any[])
        .filter((a) => agentInScope(principal, a.name))
        .map((a) => ({ name: a.name, status: a.status, idle: a.idle, purpose: a.purpose, created: a.created }));
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
          a.busy = st === "thinking" || a.idle === false;
          if (!a.busy && st === undefined && a.status !== "stopped") {
            try {
              const tail = (await tmuxRaw(["capture-pane", "-t", windowTarget(a.name), "-p"]))
                .split("\n")
                .slice(-10)
                .join("\n");
              if (/esc to interrupt/i.test(tail) || /…\s*\(\d+m?\s*\d*s\b/.test(tail)) a.busy = true;
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
        const { projectJsonlPath } = await import("../lib/jsonl-cost.js");
        const regs = await readRegistryAgents();
        const regByName = new Map(regs.map((r) => [r.name, r]));
        const bySessions = new Map<string, SessionTailInfo>();
        for (const r of regs) {
          if (!r.cwd || !r.sessionId) continue;
          const info = await sessionTailInfo(projectJsonlPath(r.cwd, r.sessionId));
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
          // 当前模型/effort。显示链:刚切换的乐观值(实测追上前) → jsonl 实测
          // (会话内切换即时反映,防 registry 漂移) → registry 钉的(创建/切换
          // 端点写入) → 全局默认
          const ov = pickClaudeOverride(a.name, info);
          // 实测过旧(重启后没跑过回合)不参与,回退 registry/全局;全部落空才用陈旧值兜底
          (a as any).model =
            ov.model ??
            freshOrNull(info?.model, info?.modelTs) ??
            (r?.model ? resolveModelAlias(r.model) : null) ??
            gModel ??
            info?.model ??
            null;
          (a as any).effort =
            ov.effort ?? freshOrNull(info?.effort, info?.effortTs) ?? r?.effort ?? gEffort ?? info?.effort ?? null;
        }
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
          agents.push({ name: r.name, status: "stopped", idle: undefined, purpose: r.purpose, lastActivityTs: ts, created: (r as any).created } as any);
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
          busy: getAgentStatus("master") === "thinking",
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

  // v2.7+ POST /api/v1/sessions/:bgId/cleanup —— 清理 bg job（死分身/残留）。
  // 耗时操作（kill → 等 daemon 静默 → 隔离目录，最长 ~90s）→ 202 后台执行，
  // 结果以 session_anomaly kind=cleanup_result 进事件流。仅全权 token。
  const cleanupMatch = path.match(/^\/sessions\/([^/]+)\/cleanup$/);
  if (cleanupMatch && req.method === "POST") {
    if (!principal.agents.includes("*")) {
      return apiJson(403, { ok: false, error: "cleanup requires a full-scope token" });
    }
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
    if (!principal.agents.includes("*")) {
      return apiJson(403, { ok: false, error: "adopt requires a full-scope token" });
    }
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

  // GET /api/v1/events —— token 版 SSE（scope 过滤）
  if (path === "/events" && req.method === "GET") {
    let scopeAgents: string[] | undefined;
    if (!principal.agents.includes("*")) {
      // 双向兼容前缀：scope 里存裸名时补 agent- 前缀的变体
      scopeAgents = principal.agents.flatMap((a) => [a, `agent-${a}`]);
    }
    return deps.handleEventsRequest(req, scopeAgents ? { agents: scopeAgents } : undefined);
  }

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
    if (!agentInScope(principal, agentParam) && !agentInScope(principal, `agent-${agentParam}`)) {
      return apiJson(403, { ok: false, error: `agent "${agentParam}" not in token scope` });
    }
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
      if (n === "master") {
        const m = await findApiAgent("master"); // master 分支不起子进程
        cwd = m?.cwd;
        sessionId = m?.sessionId;
      } else {
        const a = regMap.get(n);
        cwd = a?.cwd;
        sessionId = a?.sessionId;
      }
      const sessions = await listAgentSessions(n, { cwd, currentSessionId: sessionId });
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
    if (!agentInScope(principal, agentParam) && !agentInScope(principal, `agent-${agentParam}`)) {
      return apiJson(403, { ok: false, error: `agent "${agentParam}" not in token scope` });
    }
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
    if (!agentInScope(principal, agentParam) && !agentInScope(principal, `agent-${agentParam}`)) {
      return apiJson(403, { ok: false, error: `agent "${agentParam}" not in token scope` });
    }
    const agent = await findApiAgent(agentParam);
    const canonical = agent?.name ?? (agentParam.startsWith("agent-") ? agentParam : `agent-${agentParam}`);
    const sessions = await listAgentSessions(canonical, {
      cwd: agent?.cwd,
      currentSessionId: agent?.sessionId,
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
    if (!agentInScope(principal, agentParam) && !agentInScope(principal, `agent-${agentParam}`)) {
      return apiJson(403, { ok: false, error: `agent "${agentParam}" not in token scope` });
    }
    const sid = decodeURIComponent(histSessMatch[2]);
    if (!isValidSessionId(sid)) return apiJson(400, { ok: false, error: "invalid sessionId" });
    const agent = await findApiAgent(agentParam);
    const canonical = agent?.name ?? (agentParam.startsWith("agent-") ? agentParam : `agent-${agentParam}`);
    const sessions = await listAgentSessions(canonical, {
      cwd: agent?.cwd,
      currentSessionId: agent?.sessionId,
    });
    const found = sessions.find((s) => s.sessionId === sid);
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
    if (!agentInScope(principal, agentParam) && !agentInScope(principal, `agent-${agentParam}`)) {
      return apiJson(403, { ok: false, error: `agent "${agentParam}" not in token scope` });
    }
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
      const resolved = resolveWebInvocation(slashM[1], regName, slashM[2] || "");
      if (resolved.ok) {
        const win = agent.name === "master" ? `${MASTER_SESSION}:0` : windowTarget(agent.name);
        try {
          await tmuxSendLine(win, resolved.ccText);
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
    if (!agentInScope(principal, agentParam) && !agentInScope(principal, `agent-${agentParam}`)) {
      return apiJson(403, { ok: false, error: `agent "${agentParam}" not in token scope` });
    }
    const agent = await findApiAgent(agentParam);
    if (!agent) return apiJson(404, { ok: false, error: `agent "${agentParam}" not found` });
    const commands = commandsForAgent(agent.name === "master" ? null : agent.name);
    return apiJson(200, { ok: true, agent: agent.name, commands });
  }

  // POST /api/v1/agents/:name/interrupt —— 复刻 Discord ⚡ 打断按钮
  const interruptMatch = path.match(/^\/agents\/([^/]+)\/interrupt$/);
  if (interruptMatch && req.method === "POST") {
    const agentParam = decodeURIComponent(interruptMatch[1]);
    if (!agentInScope(principal, agentParam) && !agentInScope(principal, `agent-${agentParam}`)) {
      return apiJson(403, { ok: false, error: `agent "${agentParam}" not in token scope` });
    }
    const agent = await findApiAgent(agentParam);
    if (!agent) return apiJson(404, { ok: false, error: `agent "${agentParam}" not found` });
    // 防重入(owner 2026-07-16:「打断按钮点两次出两个打断」):3s 冷却——
    // 空闲态连发两次 C-c 是 CC 的退出快捷键,双击可能直接把会话关了
    const lastInt = interruptCooldown.get(agent.name) ?? 0;
    if (Date.now() - lastInt < 3_000) {
      return apiJson(200, { ok: true, deduped: true });
    }
    interruptCooldown.set(agent.name, Date.now());
    const targetWindow = agent.name === "master" ? `${MASTER_SESSION}:0` : windowTarget(agent.name);
    try {
      await tmuxRaw(["send-keys", "-t", targetWindow, "C-c"]);
    } catch (e) {
      return apiJson(500, { ok: false, error: `tmux send-keys 失败: ${(e as Error).message}` });
    }
    recordMetric("agent_interrupt", { channelId: agent.channelId, agent: agent.name, meta: { trigger: "api" } });
    stopTyping(agent.channelId);
    clearSafetyTimer(agent.channelId);
    // 被打断的回合 CC 不触发 Stop hook —— agentStatuses 会永远卡在 thinking：
    // 列表黄点常驻、前端乐观解锁后又被 15s 轮询的 busy 补锁锁回「正在回复」
    // (owner 2026-07-14 真机)。打断即回合收尾：状态置 done + SSE 广播解锁。
    const evAgentInt =
      agentNameForChannel(agent.channelId) ||
      (agent.channelId === CONTROL_CHANNEL_ID ? "master" : agent.name);
    emitEvent({ agent: evAgentInt, chatId: agent.channelId, type: "agent_status", data: { status: "done", trigger: "interrupt" } });
    console.log(`⚡ [api] C-c 已发送给 ${agent.name} (token=${tokenId})`);
    return apiJson(200, { ok: true, agent: agent.name });
  }

  // POST /api/v1/agents/:name/clear —— 远程调用 CC 原生 /clear（清上下文）。
  // 语义分层（owner 哲学对齐）：本端点只做「打 /clear + 会话轮转收尾」这件原生事；
  // clear 后要不要发开机指令、发什么，是前端（用户层）的事，这里零感知。
  // master：/clear 后 CLAUDE.md 人设自动重载，且不在 registry、无 watcher —— 只发键。
  const clearMatch = path.match(/^\/agents\/([^/]+)\/clear$/);
  if (clearMatch && req.method === "POST") {
    const agentParam = decodeURIComponent(clearMatch[1]);
    if (!agentInScope(principal, agentParam) && !agentInScope(principal, `agent-${agentParam}`)) {
      return apiJson(403, { ok: false, error: `agent "${agentParam}" not in token scope` });
    }
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

  // POST /api/v1/agents/:name/claude-settings —— per-会话切换模型/effort
  // (owner 2026-07-23:「每个对话显示当前 model/effort + 快速切换」)。原生
  // /model、/effort 命令 tmux 注入(与 TUI 手打同一生效路径);回合进行中 409
  // (此时注入只会排进输入框,语义不明)。非 master 同步写 registry(manager
  // set-claude,保持 manager 唯一写者)——restart 后模型/effort 沿用。
  const claudeSetMatch = path.match(/^\/agents\/([^/]+)\/claude-settings$/);
  if (claudeSetMatch && req.method === "POST") {
    const agentParam = decodeURIComponent(claudeSetMatch[1]);
    if (!agentInScope(principal, agentParam) && !agentInScope(principal, `agent-${agentParam}`)) {
      return apiJson(403, { ok: false, error: `agent "${agentParam}" not in token scope` });
    }
    let body: any;
    try {
      body = await req.json();
    } catch {
      return apiJson(400, { ok: false, error: "invalid JSON body" });
    }
    const model = typeof body?.model === "string" && body.model.trim() ? resolveModelAlias(body.model) : undefined;
    const effort = typeof body?.effort === "string" && body.effort.trim() ? body.effort.trim() : undefined;
    if (!model && !effort) return apiJson(400, { ok: false, error: 'body must contain "model" and/or "effort"' });
    if (effort && !isKnownEffort(effort)) {
      return apiJson(400, { ok: false, error: `未知 effort: "${effort}"。可用: ${KNOWN_EFFORT_LEVELS.join(", ")}` });
    }
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
    if (!paneLooksIdle(pane)) {
      return apiJson(409, { ok: false, error: "agent 正在回合中，等回合结束再切换" });
    }
    try {
      if (model) {
        await tmuxSendLine(targetWindow, `/model ${model}`);
        // CC 2.1.220+ 会话有 prompt cache 时切模型弹「Switch model?」二次确认。
        // 用户已在 web UI 做过选择,没人替他按 Yes 的话 TUI 就永远卡在弹窗上
        // (2026-07-27 用户截图实锤)。短轮询探测,出现即确认(❯ 预选 Yes,Enter 即可);
        // 看到 "Set model to"(未弹窗直接生效)就提前收工。
        for (let i = 0; i < 4; i++) {
          await Bun.sleep(700);
          const p2 = await tmuxCapture(targetWindow, 25).catch(() => "");
          if (/Switch model\?/.test(p2)) {
            await tmuxRaw(["send-keys", "-t", targetWindow, "Enter"]);
            await Bun.sleep(400);
            break;
          }
          if (/Set model to/i.test(p2)) break;
        }
      }
      if (model && effort) await Bun.sleep(600); // 两条命令之间让 TUI 消化
      if (effort) await tmuxSendLine(targetWindow, `/effort ${effort}`);
    } catch (e) {
      return apiJson(500, { ok: false, error: `tmux 发送失败: ${(e as Error).message}` });
    }
    {
      // 乐观显示:注入已成功,列表立即按新值显示;jsonl 实测追上后自动接管
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
        if (effort) setArgs.push("--effort", effort);
        await runManager(...setArgs);
      } catch { /* registry 同步失败不影响本次生效(jsonl 探测仍会显示真值) */ }
    }
    recordMetric("agent_claude_updated", { channelId: agent.channelId, agent: agent.name, meta: { model, effort, tokenId } });
    console.log(`🎛 [api] claude-settings ${agent.name}: model=${model ?? "-"} effort=${effort ?? "-"} (token=${tokenId})`);
    return apiJson(200, { ok: true, agent: agent.name, model: model ?? null, effort: effort ?? null });
  }

  // POST /api/v1/agents/:name/answer —— 交互卡回传。
  // body {kind:"auq", action:"submit"|"cancel", selections?: number[][]}
  //   或 {kind:"permission", action:"allow"|"allow_session"|"deny"}
  const answerMatch = path.match(/^\/agents\/([^/]+)\/answer$/);
  if (answerMatch && req.method === "POST") {
    const agentParam = decodeURIComponent(answerMatch[1]);
    if (!agentInScope(principal, agentParam) && !agentInScope(principal, `agent-${agentParam}`)) {
      return apiJson(403, { ok: false, error: `agent "${agentParam}" not in token scope` });
    }
    const agent = await findApiAgent(agentParam);
    if (!agent) return apiJson(404, { ok: false, error: `agent "${agentParam}" not found` });
    let body: any;
    try {
      body = await req.json();
    } catch {
      return apiJson(400, { ok: false, error: "invalid JSON body" });
    }
    const kind = String(body?.kind || "");

    if (kind === "auq") {
      const { auqStates, buildAuqKeystrokes, clearAuqState } = await import("./ask-user-question.js");
      const state = auqStates.get(agent.channelId);
      if (!state) return apiJson(404, { ok: false, error: "no pending AskUserQuestion for this agent" });
      const action = String(body?.action || "submit");
      if (action === "cancel") {
        try {
          await tmuxRaw(["send-keys", "-t", state.tmuxTarget, "Escape"]);
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
      // M4：发方向键+Enter 前重验菜单还在（与 permission 分支同款防误击）。AUQ 若已在
      // TUI 侧被应答/取消而 AuqState 尚未清（/pending replay 让陈旧提交更易发生），pane
      // 会回到空闲输入框——此时导航键会误入 composer。pane 已 idle → 清态 + 409。
      // 抓不到 pane 就跳过重验，退回原行为（不因抓取失败误拒合法提交）。
      let auqPane = "";
      try { auqPane = await tmuxCapture(state.tmuxTarget, 40); } catch { /* 跳过重验 */ }
      if (auqPane && paneLooksIdle(auqPane)) {
        clearAuqState(agent.channelId);
        emitEvent({ agent: agent.name, chatId: agent.channelId, type: "question_cleared", data: { reason: "stale", via: "api" } });
        return apiJson(409, { ok: false, error: "AskUserQuestion no longer active (answered elsewhere?)" });
      }
      const keys = buildAuqKeystrokes(state);
      try {
        if (keys.length > 0) await tmuxRaw(["send-keys", "-t", state.tmuxTarget, ...keys]);
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
    if (!agentInScope(principal, agentParam) && !agentInScope(principal, `agent-${agentParam}`)) {
      return apiJson(403, { ok: false, error: `agent "${agentParam}" not in token scope` });
    }
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
      thinking: status === "thinking",
    });
  }

  // POST /api/v1/agents —— create（仅全权 token；复用 manager CLI）
  if (path === "/agents" && req.method === "POST") {
    if (!principal.agents.includes("*")) {
      return apiJson(403, { ok: false, error: "create requires a full-scope token" });
    }
    let body: any;
    try {
      body = await req.json();
    } catch {
      return apiJson(400, { ok: false, error: "invalid JSON body" });
    }
    const name = String(body?.name || "").trim();
    const dir = String(body?.dir || "").trim();
    const purpose = String(body?.purpose || "").trim();
    // v2.10+ 可选钉模型/effort(owner 2026-07-16:「新建 agent 加选模型和 Effort」)。
    // 透传给 manager create --model/--effort,校验(别名/合法档位)由 manager 做。
    const model = String(body?.model || "").trim();
    const effort = String(body?.effort || "").trim();
    if (!name || !dir) return apiJson(400, { ok: false, error: 'body must be {"name", "dir", "purpose"?, "model"?, "effort"?}' });
    // name / dir 走位置参数，必须先挡掉长得像 flag 的值；purpose 改走具名
    // --purpose，避免自由文本被 manager 的 flag 提取抢先解析（详见
    // manager.ts 的 extractPurposeFlag 注释：曾可用 purpose 替换整个命令黑名单）。
    if (name.startsWith("-") || dir.startsWith("-")) {
      return apiJson(400, { ok: false, error: 'name/dir 不能以 "-" 开头' });
    }
    const createArgs = ["create", name, dir];
    if (purpose) createArgs.push("--purpose", purpose);
    if (model) createArgs.push("--model", model);
    if (effort) createArgs.push("--effort", effort);
    const r = await runManager(...createArgs);
    return apiJson(r?.ok ? 200 : 500, r ?? { ok: false, error: "manager create failed" });
  }

  // GET/PUT /api/v1/config/claude-defaults —— 全局默认模型/effort 管理
  // (owner 2026-07-16:「设置里可以管理全局 model 和 effort」)。读写
  // ~/.claude/settings.json 的 model / effortLevel 两个字段,其余字段原样保留。
  // 影响所有不带 --model/--effort 的新 session(含终端里直接开的 claude)。
  if (path === "/config/claude-defaults") {
    if (!principal.agents.includes("*")) {
      return apiJson(403, { ok: false, error: "claude-defaults requires a full-scope token" });
    }
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
      let body: any;
      try {
        body = await req.json();
      } catch {
        return apiJson(400, { ok: false, error: "invalid JSON body" });
      }
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
    if (!principal.agents.includes("*")) {
      return apiJson(403, { ok: false, error: `${lifecycleMatch[2]} requires a full-scope token` });
    }
    const agentParam = decodeURIComponent(lifecycleMatch[1]);
    if (agentParam === "master") return apiJson(400, { ok: false, error: "master lifecycle is managed by the launcher" });
    const r = await runManager(lifecycleMatch[2], agentParam);
    return apiJson(r?.ok ? 200 : 500, r ?? { ok: false, error: `manager ${lifecycleMatch[2]} failed` });
  }

  // ── v2.11.1+ /peers —— HTTP peer 管理面（web UI 后端;owner 2026-07-24
  // 「前端要能管理 peer 的权限以及在哪些远端有权限」）。全部 mutation 走
  // runManager 复用 CLI 的 R1 校验/token 签发/原子写,bridge 不直写 principals。
  if (path === "/peers" || path.startsWith("/peers/")) {
    if (!principal.agents.includes("*")) {
      return apiJson(403, { ok: false, error: "peers management requires a full-scope token" });
    }

    // GET /peers —— 清单:peers.json ⋈ principals(入站 scope) + 本地 agent 表(scope 编辑器数据源)
    if (path === "/peers" && req.method === "GET") {
      const [peersData, pf, regAgents] = await Promise.all([
        readPeers(),
        readPrincipals(),
        readRegistryAgents(),
      ]);
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
        };
      });
      const localAgents = regAgents.map((a) => ({
        name: a.name.startsWith("agent-") ? a.name.slice(6) : a.name,
        external: !!a.external,
        status: a.status ?? "unknown",
      }));
      // v2.14+ 顺带给出本机对外地址候选：握手时 --url / web 输入框预填用。
      // 手抄这个地址是三步握手里最容易错的一环，错了要拖到 peer-http-test 才暴露。
      const { detectBridgeUrls } = await import("../lib/net-addr.js");
      const suggestedUrls = detectBridgeUrls(parseInt(process.env.BRIDGE_PORT || "3847"));
      // v2.15+ 待兑换的一键邀请（peer-invite-list 顺带清扫过期 + 吊销其 token）
      const invRes: any = await runManager("peer-invite-list");
      const pendingInvites = invRes?.ok ? invRes.invites || [] : [];
      return apiJson(200, { ok: true, peers, localAgents, suggestedUrls, pendingInvites });
    }

    // v2.15+ POST /peers/invite-new | /peers/join-auto | /peers/invite-revoke
    // —— 一键邀请（免回执自动握手）。mutation 照旧全部委托 runManager。
    if (req.method === "POST" && (path === "/peers/invite-new" || path === "/peers/join-auto" || path === "/peers/invite-revoke")) {
      let body: any;
      try {
        body = await req.json();
      } catch {
        return apiJson(400, { ok: false, error: "invalid JSON body" });
      }
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
      let body: any;
      try {
        body = await req.json();
      } catch {
        return apiJson(400, { ok: false, error: "invalid JSON body" });
      }
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
      let body: any;
      try {
        body = await req.json();
      } catch {
        return apiJson(400, { ok: false, error: "invalid JSON body" });
      }
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

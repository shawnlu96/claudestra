/**
 * 上下文边界的执行：每分钟看一遍在跑的 Claude Code 会话，按 lib/ctx-boundary-decision.ts 的决策表，经 ctx-boundary-inject.ts 注入
 * `/compact <保留清单>` 或 `/save-compact`。不挂在 Discord 看板上（web-only / 沙箱也要跑），bridge 启动时 startCtxBoundary()。
 * 开关 config autoCompact.inject 缺省关，只管这次新加的：具名策略和大总管。关着时具名策略覆盖的 agent 按全局线和救命线走（原有行为，
 * 开关管不着），大总管不自动压。`manager ctx-boundary dry-run` 用同一套判定、按开关关 / 开各列一遍结果，不发键。
 * 设计 docs/architecture/context-boundary.md；单测 tests/ctx-boundary.test.ts（全部依赖可注入）。
 */
import { statSync } from "fs";
import { resolve } from "path";
import { readConfigSync } from "../lib/config-store.js";
import { agentRuntime, isMasterAgent, readRegistryAgents } from "../lib/registry.js";
import { statePath } from "../lib/paths.js";
import { readJsonStateSync } from "../lib/state-file.js";
import { resolveSessionIdsForWindows } from "../lib/cc-sessions.js";
import { isLinkedWorktree } from "../lib/linked-worktree.js";
import { findSessionJsonlBySessionId, sessionJsonlPath } from "../lib/session-source.js";
import { sessionTailInfo } from "../lib/session-tail.js";
import { readSessionCtx } from "../lib/usage-cache.js";
import { paneLooksWorking } from "../lib/turn-state.js";
import { formatTokens } from "../lib/agent-stats.js";
import { effectiveAction, isExecutor, matchPolicy, resolvePolicies, type PolicyWarning } from "../lib/ctx-boundary-policy.js";
import { describeCompactPlan } from "../lib/ctx-boundary-fit.js";
import {
  boundaryDecision, boundaryView, globalBoundary, policyBoundary, SKIP_REASON_TEXT,
  type Boundary, type BoundaryVerdict, type CtxBoundaryView, type GlobalAutoCompact, type SkipReason,
} from "../lib/ctx-boundary-decision.js";
import {
  agentTarget, agentWindowName, compactInjectedRecently, injectCompact, liveInjectDeps, loadInjectState, paneGateOf, resetInjectState, sweepPendingEcho, withWindow,
  type InjectDeps, type InjectResult, type InjectTarget, type PaneCapture,
} from "./ctx-boundary-inject.js";
import { MASTER_DIR } from "./config.js";
export { compactInjectedRecently, injectCompact } from "./ctx-boundary-inject.js"; // 看板 / 手动按钮原来从这里拿
import { PersistedMap } from "./persisted-map.js";
import { adapterFor } from "./adapters.js";
import { emitEvent } from "./event-bus.js";
import { parseChatId } from "./router.js";

const TICK_MS = 60_000;
/** 注入后 30 分钟没回落到线下才重试：注入可能被 TUI 吞掉，布尔标记会卡成永久沉默（git log -S AUTO_COMPACT_RETRY_MS） */
const RETRY_MS = 30 * 60_000;
/** 发送失败（窗口没了、tmux 出错）、窗口太小：5 分钟后再试，不进 30 分钟的沉默期（也不每分钟往窗口里敲了又删） */
const FAIL_RETRY_MS = 5 * 60_000;
/** 过救命线又被挡住（或敲进去的字没提交）时提醒 owner：同一个 agent 30 分钟最多一次 */
const ALERT_EVERY_MS = 30 * 60_000;
const ALERT_ON = new Set<SkipReason>(["draft", "queued", "menu", "quota-wall", "copy-mode"]);
/** 面板 / agent 列表一次请求里每个 agent 都要看策略：线上依赖读配置、解析一次管 2 秒 */
const POLICY_CACHE_MS = 2_000;
const TRIG_FILE = statePath("ctx-boundary-trig.json");
const OFF_TEXT = "新增的自动压缩关着（config autoCompact.inject）：具名策略的 agent 先按全局线和 93% 救命线走，大总管不自动压";

export interface BoundaryAgent extends InjectTarget {
  projectId: string | null;
  channelId: string | null;
  cwd: string | null;
  sessionId: string;
  /** null = 读不到会话文件 */
  ctx: number | null;
  /** 最后一条真实对话的时间（不单用 mtime：CC 会周期性 touch 会话文件） */
  convTs: number | null;
  /** 会话文件 mtime：全局路径（个人 agent）沿用的旧闲置口径，和新口径同时满足才算闲（PM 09-29 定，保持今天的行为） */
  mtime: number | null;
  /** statusline 落盘的真实窗口；null = 没配 statusline */
  realWindow: number | null;
}

export interface CtxBoundaryDeps extends InjectDeps {
  agents(): Promise<BoundaryAgent[]>;
  /** 按窗口里实际在跑的会话校正（/clear 之后 registry 还指着旧文件），换了的按新会话重读；每轮对全体做一次 */
  liveSessions(as: BoundaryAgent[]): Promise<BoundaryAgent[]>;
  autoCompact(): (GlobalAutoCompact & { policies?: unknown }) | undefined;
  log(line: string): void;
  alert(a: BoundaryAgent, text: string, data: Record<string, unknown>): void;
  /** true = 只判定不发键、不写状态、不删字（manager ctx-boundary dry-run） */
  dryRun?: boolean;
  /** dry-run 用：按开关关 / 开各判一遍，不看 config 里的 inject */
  injectAs?: boolean;
}

export interface TickOutcome {
  agent: string;
  ctx: number;
  boundary: Boundary;
  verdict: BoundaryVerdict;
  /** 具名策略或大总管：开关打开才自动压的那部分 */
  gated: boolean;
  inject?: InjectResult;
  /** dry-run：会发的那一行 */
  would?: string;
}

let lastTrig: Map<string, number> = new Map();
const lastSkip = new Map<string, string>();
const alertedAt = new Map<string, number>();
const warned = new Set<string>();
let policyCache: { at: number; value: ReturnType<typeof resolveNow> } | null = null;
let offLogged = false;

/** 测试用：清掉进程内状态 */
export function resetCtxBoundaryState(): void {
  for (const m of [lastTrig, lastSkip, alertedAt]) m.clear();
  warned.clear();
  policyCache = null;
  offLogged = false;
  resetInjectState();
}

function resolveNow(deps: Pick<CtxBoundaryDeps, "autoCompact" | "log">) {
  const ac = deps.autoCompact();
  const r = resolvePolicies(ac?.policies);
  for (const w of r.warnings) {
    const k = `${w.policy ?? "-"}|${w.text}`;
    if (warned.has(k)) continue;
    warned.add(k);
    deps.log(`⚠️ 上下文边界配置${w.policy ? `（策略 ${w.policy}）` : ""}：${w.text}`);
  }
  return { ac, ...r };
}

function currentPolicies(deps: Pick<CtxBoundaryDeps, "autoCompact" | "log" | "now">) {
  if (deps !== liveDeps) return resolveNow(deps);
  const now = deps.now();
  if (!policyCache || now - policyCache.at > POLICY_CACHE_MS) policyCache = { at: now, value: resolveNow(deps) };
  return policyCache.value;
}

/** 开关关着时不看具名策略，一律按全局线（原有行为） */
function boundaryFor(
  a: Pick<BoundaryAgent, "name" | "projectId" | "realWindow" | "executor">,
  p: ReturnType<typeof resolveNow>,
  on: boolean,
): Boundary {
  const m = on ? matchPolicy(p.policies, a) : null;
  const b = m ? policyBoundary(m, a.realWindow) : globalBoundary(p.ac, a.realWindow);
  return { ...b, action: effectiveAction(a.executor, b.action) };
}

const overLine = (ctx: number | null, b: Boundary) => ctx !== null && ((b.window > 0 && ctx >= b.window) || (b.hardCap !== null && ctx >= b.hardCap));

/** 新口径：最后一条对话满 idleMs 且画面不忙。全局路径另加旧口径（mtime 满 idleMs），两者都满足才算闲 */
function idleEnough(a: BoundaryAgent, b: Boundary, pane: PaneCapture | null, now: number): boolean {
  if (b.idleMs <= 0) return true;
  if (a.convTs === null || pane === null) return false;
  const fresh = now - a.convTs >= b.idleMs && !paneLooksWorking(pane.plain);
  return b.policy === "global" ? fresh && a.mtime !== null && now - a.mtime >= b.idleMs : fresh;
}

function maybeAlert(a: BoundaryAgent, now: number, deps: CtxBoundaryDeps, text: string, data: Record<string, unknown>): void {
  const last = alertedAt.get(a.name);
  if (last !== undefined && now - last < ALERT_EVERY_MS) return;
  alertedAt.set(a.name, now);
  deps.alert(a, text, data);
}

/** 过救命线却被草稿 / 排队 / 对话框挡住：挡是对的（不能把 owner 的字连着命令提交），但得让 owner 知道，否则只能等 CC 在 ~967K 裸压 */
function alertBlocked(a: BoundaryAgent & { ctx: number }, b: Boundary, reason: SkipReason, now: number, deps: CtxBoundaryDeps): void {
  if (deps.dryRun || b.hardCap === null || a.ctx < b.hardCap || !ALERT_ON.has(reason)) return;
  const text =
    `⚠️ ${a.name} 上下文 ${formatTokens(a.ctx)}，过了救命线 ${formatTokens(b.hardCap)}，但${SKIP_REASON_TEXT[reason]}，自动压缩发不出去。` +
    "请去这个窗口处理一下，不然会一直涨到 Claude Code 自己在 ~967K 裸压（记忆全丢）。";
  maybeAlert(a, now, deps, text, { ctx: a.ctx, cap: b.hardCap, reason });
}

async function checkOne(a: BoundaryAgent & { ctx: number }, b: Boundary, deps: CtxBoundaryDeps): Promise<Omit<TickOutcome, "gated">> {
  const pane = await deps.capture(a.target);
  const now = deps.now();
  const verdict = boundaryDecision({
    ctx: a.ctx,
    window: b.window,
    hardCap: b.hardCap,
    idle: idleEnough(a, b, pane, now),
    pane: pane === null ? null : paneGateOf(pane, deps.readPane(pane.plain, pane.esc)),
    injectedRecently: compactInjectedRecently(a.target, now),
    lastTrig: lastTrig.get(a.name) ?? 0,
    now,
    retryMs: RETRY_MS,
  });
  const base = { agent: a.name, ctx: a.ctx, boundary: b, verdict };
  const tag = `${a.name} @ ${formatTokens(a.ctx)}（策略 ${b.policy}，线 ${formatTokens(b.window)} / 上限 ${b.hardCap === null ? "—" : formatTokens(b.hardCap)}）`;
  if (!verdict.fire) {
    // 同一个原因只记一次，免得每分钟刷日志
    if (lastSkip.get(a.name) !== verdict.reason) deps.log(`🧭 上下文边界 跳过 ${tag}：${SKIP_REASON_TEXT[verdict.reason]}`);
    lastSkip.set(a.name, verdict.reason);
    alertBlocked(a, b, verdict.reason, now, deps);
    return base;
  }
  lastSkip.delete(a.name);
  if (deps.dryRun) return { ...base, would: describeCompactPlan(effectiveAction(a.executor, b.action), b.keep, pane?.size ?? null) };
  const inject = await injectCompact(a, { action: b.action, keep: b.keep, pane }, deps);
  if (inject.status === "executed" || inject.status === "queued") lastTrig.set(a.name, now);
  else if (inject.status === "failed" || (inject.status === "skipped" && inject.reason === "window-small")) lastTrig.set(a.name, now - RETRY_MS + FAIL_RETRY_MS);
  if (inject.status === "failed" && inject.leftover) {
    maybeAlert(a, now, deps, `⚠️ 往 ${a.name} 注入压缩没成功：${inject.error}。`, { ctx: a.ctx, cap: b.hardCap, reason: "leftover" });
  }
  if (inject.status === "skipped" && inject.reason === "window-small") {
    maybeAlert(a, now, deps, `⚠️ ${a.name} 该压缩了（${formatTokens(a.ctx)}），但${inject.text}。`, { ctx: a.ctx, cap: b.hardCap, reason: "window-small" });
  }
  const why = inject.status === "failed" ? `（${inject.error}）` : inject.status === "skipped" ? `（${inject.text}）` : inject.note ? `（${inject.note}）` : "";
  deps.log(`🧹 上下文边界 ${verdict.kind === "hard-cap" ? "硬上限" : "闲置"}触发 ${tag}：${b.action} → ${inject.status}${why}`);
  return { ...base, inject };
}

/**
 * 一轮：先删上轮留在框里的字（开关关着也删，手动按钮也会留字）；每个 agent 按窗口里实际在跑的会话算，过线的才读画面、
 * 才可能注入；回到线下就清掉冷却（上次注入见效，或者手动压过）。开关关着：具名策略不看、大总管跳过，全局线和救命线照旧
 */
export async function ctxBoundaryTick(deps: CtxBoundaryDeps = liveDeps): Promise<TickOutcome[]> {
  const p = currentPolicies(deps);
  const on = deps.injectAs ?? p.ac?.inject === true;
  if (!deps.dryRun) {
    if (!on && !offLogged) deps.log(`🧭 上下文边界：${OFF_TEXT}；打开前先跑 manager ctx-boundary dry-run`);
    offLogged = !on;
    await sweepPendingEcho(deps, deps.log);
  }
  const out: TickOutcome[] = [];
  for (const a of await deps.liveSessions(await deps.agents())) {
    const master = isMasterAgent(a.name);
    const b = boundaryFor(a, p, on);
    const ctx = a.ctx;
    if (ctx === null || (master && !on) || !overLine(ctx, b)) {
      if (!deps.dryRun) lastTrig.delete(a.name);
      lastSkip.delete(a.name);
      continue;
    }
    // 抓屏、判定、注入都在窗口执行权里：批量动作 / 手动按钮正在这个窗口发键就这轮不看，下一分钟再来
    const busy = (who: string) => void deps.log(`🧭 上下文边界 跳过 ${a.name}：${who}正在操作这个窗口`);
    const r = await withWindow(a.target, "自动压缩", () => checkOne({ ...a, ctx }, b, deps), busy);
    if (r) out.push({ ...r, gated: master || b.policy !== "global" });
  }
  return out;
}

/** 面板 / 网页列表显示用：这个 agent 命中哪条线、还剩多少 */
export function ctxBoundaryViewFor(
  a: { name: string; projectId?: string | null; runtime?: string; sessionId?: string; cwd?: string },
  ctx: number | null,
): CtxBoundaryView | null {
  if (agentRuntime(a) !== "claude-code") return null;
  const p = currentPolicies(liveDeps);
  const on = p.ac?.inject === true;
  if (!on && isMasterAgent(a.name)) return null; // 开关关着大总管不自动压，不显示线
  const realWindow = a.sessionId ? readSessionCtx(a.sessionId)?.window ?? null : null;
  const executor = isExecutor({ name: a.name, worktree: isLinkedWorktree(a.cwd) });
  return boundaryView(boundaryFor({ name: a.name, projectId: a.projectId ?? null, realWindow, executor }, p, on), ctx, p.warnings);
}

/** 当前配置的问题（越界的 ccWindow、写错的字段…），面板顶上列出来；开关关着也列一条 */
export function ctxBoundaryWarnings(): PolicyWarning[] {
  const p = currentPolicies(liveDeps);
  return p.ac?.inject === true ? p.warnings : [{ policy: null, text: OFF_TEXT }, ...p.warnings];
}

/** 按 registry 名字拼注入对象（Discord 手动按钮、T35 的批量动作用） */
export async function injectTargetFor(name: string): Promise<InjectTarget> {
  const r = (await readRegistryAgents()).find((x) => x.name === name);
  return { name, target: agentTarget(name), executor: isExecutor({ name, worktree: isLinkedWorktree(r?.cwd) }) };
}

async function sessionStats(runtime: string | undefined, cwd: string | null, sessionId: string) {
  const path = (cwd ? sessionJsonlPath(runtime, cwd, sessionId) : null) ?? findSessionJsonlBySessionId(runtime, sessionId);
  const realWindow = readSessionCtx(sessionId)?.window ?? null;
  if (!path) return { ctx: null, convTs: null, mtime: null, realWindow };
  let mtime: number | null = null;
  try {
    mtime = statSync(path).mtimeMs;
  } catch {
    mtime = null; // 文件刚被挪走：旧口径判不出闲置，全局路径就不走闲置触发（救命线不受影响）
  }
  const info = await sessionTailInfo(path);
  return { ctx: info?.ctxTokens ?? null, convTs: info?.convTs ?? null, mtime, realWindow };
}

/**
 * registry.json 不一定登记大总管（launcher 起它不写 registry）：没有 isMasterAgent 的条目就补这一条。窗口、cwd 同 launcher，
 * 会话留空交给 liveSessionsOf 从窗格里的 CC 认；认不到 ctx 就是 null，这一轮跳过。registry 有条目时不补（哪怕那条被过滤掉）
 */
export function masterStandIn(masterDir: string, channelId: string | null): BoundaryAgent {
  const name = "agent-master";
  return {
    name, projectId: null, channelId, cwd: resolve(masterDir), sessionId: "", target: agentTarget(name), executor: false,
    ctx: null, convTs: null, mtime: null, realWindow: null,
  };
}

export const needsMasterStandIn = (rows: { name: string }[]): boolean => !rows.some((r) => isMasterAgent(r.name));

async function liveAgents(): Promise<BoundaryAgent[]> {
  const out: BoundaryAgent[] = [];
  const rows = await readRegistryAgents();
  if (needsMasterStandIn(rows)) out.push(masterStandIn(MASTER_DIR, process.env.CONTROL_CHANNEL_ID || null));
  for (const r of rows) {
    // 只管 Claude Code：注入的是 CC 的斜杠命令，画面判定也是 CC 的；Codex / Pi 有各自的压缩
    if ((r.status && r.status !== "active") || agentRuntime(r) !== "claude-code" || !r.sessionId) continue;
    const cwd = r.cwd ? r.cwd.replace(/^~/, process.env.HOME || "~") : null;
    out.push({
      name: r.name,
      projectId: r.projectId ?? null,
      channelId: r.channelId ?? null,
      cwd,
      sessionId: r.sessionId,
      target: agentTarget(r.name),
      executor: isExecutor({ name: r.name, worktree: isLinkedWorktree(cwd) }),
      ...(await sessionStats(r.runtime, cwd, r.sessionId)),
    });
  }
  return out;
}

/** CC 在 /clear 时会把 ~/.claude/sessions/<pid>.json 的 sessionId 换成新的（09-29 实测），按它认窗口里实际在跑的会话 */
async function liveSessionsOf(as: BoundaryAgent[]): Promise<BoundaryAgent[]> {
  const wins = as.flatMap((a) => (a.cwd ? [{ key: a.name, tmuxName: agentWindowName(a.name), cwd: a.cwd }] : []));
  const hits = await resolveSessionIdsForWindows(wins).catch((e) => {
    console.error("🧭 上下文边界 查各窗口的实际会话失败（按 registry 记的算）:", (e as Error).message);
    return new Map<string, string>();
  });
  return Promise.all(
    as.map(async (a) => {
      const sid = hits.get(a.name);
      return !sid || sid === a.sessionId ? a : { ...a, sessionId: sid, ...(await sessionStats(undefined, a.cwd, sid)) };
    }),
  );
}

/** 往 owner 看得到的地方推一条：web 的 session_anomaly（两种模式都有），这个 agent 是 Discord 频道时再发一条 */
function alertOwner(a: BoundaryAgent, text: string, data: Record<string, unknown>): void {
  console.log(`🧭 上下文边界 提醒 owner：${text}`);
  emitEvent({ agent: a.name, chatId: a.channelId ?? "", type: "session_anomaly", data: { kind: "ctx_boundary_blocked", ...data } });
  const chat = a.channelId ? parseChatId(a.channelId) : null;
  if (chat?.transport !== "discord") return;
  adapterFor("discord")
    ?.send(chat.id, { text })
    .catch((e) => console.error(`🧭 上下文边界 Discord 提醒发送失败 ${a.name}:`, (e as Error).message));
}

const liveDeps: CtxBoundaryDeps = {
  ...liveInjectDeps,
  agents: liveAgents,
  liveSessions: liveSessionsOf,
  autoCompact: () => readConfigSync().autoCompact,
  log: (l) => console.log(l),
  alert: alertOwner,
};

/** dry-run 里单独给大总管的一行：它以前从没被覆盖过（窗口名拼错），要不要自动压由 owner 定 */
interface MasterDryRun {
  agent: string;
  ctx: number | null;
  boundary: Boundary;
  /** null = 在线下，这一轮不动 */
  outcome: TickOutcome | null;
}

/**
 * manager ctx-boundary dry-run：线上的 registry、画面、配置和落盘的冷却 / 守卫照常判定，按开关关（off，原有行为）和开（on）各判一遍；
 * 不发键、不写任何状态、不删字、不提醒
 */
export async function ctxBoundaryDryRun(): Promise<{ off: TickOutcome[]; on: TickOutcome[]; logs: string[]; inject: boolean; master: MasterDryRun | null }> {
  loadInjectState("read-only");
  const r = readJsonStateSync(TRIG_FILE);
  const trig = r.status === "ok" && r.data && typeof r.data === "object" ? (r.data as Record<string, unknown>) : {};
  lastTrig = new Map(Object.entries(trig).filter((e): e is [string, number] => typeof e[1] === "number"));
  const logs: string[] = [];
  let listed: BoundaryAgent[] = [];
  const liveSessions = async (as: BoundaryAgent[]) => (listed = await liveSessionsOf(as));
  const deps: CtxBoundaryDeps = { ...liveDeps, liveSessions, log: (l) => void logs.push(l), alert: () => {}, dryRun: true };
  const off = await ctxBoundaryTick({ ...deps, injectAs: false });
  const on = await ctxBoundaryTick({ ...deps, injectAs: true });
  const m = listed.find((a) => isMasterAgent(a.name));
  const master = m ? { agent: m.name, ctx: m.ctx, boundary: boundaryFor(m, currentPolicies(deps), true), outcome: on.find((o) => o.agent === m.name) ?? null } : null;
  return { off, on, logs: [...new Set(logs)], inject: deps.autoCompact()?.inject === true, master };
}

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

/** bridge 启动时调一次（幂等）。冷却和注入守卫落盘，bridge 重启不清零。一轮没跑完不叠下一轮。 */
export function startCtxBoundary(): void {
  if (timer) return;
  loadInjectState("live");
  lastTrig = new PersistedMap<number>(TRIG_FILE, "上下文边界冷却", (v) => typeof v === "number");
  currentPolicies(liveDeps); // 启动时就把配置问题打出来，不等第一个过线的 agent
  timer = setInterval(() => {
    if (running) return;
    running = true;
    ctxBoundaryTick()
      .catch((e) => console.error("🧭 上下文边界检查失败:", (e as Error).message))
      .finally(() => {
        running = false;
      });
  }, TICK_MS);
  timer.unref?.();
}

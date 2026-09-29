/**
 * 上下文边界的执行：每分钟看一遍在跑的 Claude Code 会话，按 lib/ctx-boundary-decision.ts 的决策表，经 ctx-boundary-inject.ts 注入
 * `/compact <保留清单>` 或 `/save-compact`。不挂在 Discord 看板上（web-only / 沙箱也要跑），bridge 启动时 startCtxBoundary()。
 * 自动注入缺省关（config autoCompact.inject）；`manager ctx-boundary dry-run` 用同一套判定只列结果、不发键。
 * 设计 docs/architecture/context-boundary.md；单测 tests/ctx-boundary.test.ts（全部依赖可注入）。
 */
import { existsSync, readFileSync, statSync } from "fs";
import { dirname, join } from "path";
import { readConfigSync } from "../lib/config-store.js";
import { agentRuntime, isMasterAgent, readRegistryAgents } from "../lib/registry.js";
import { statePath } from "../lib/paths.js";
import { readJsonStateSync } from "../lib/state-file.js";
import { resolveSessionIdForWindow } from "../lib/cc-sessions.js";
import { findSessionJsonlBySessionId, sessionJsonlPath } from "../lib/session-source.js";
import { sessionTailInfo } from "../lib/session-tail.js";
import { readSessionCtx } from "../lib/usage-cache.js";
import { paneLooksWorking } from "../lib/turn-state.js";
import { formatTokens } from "../lib/agent-stats.js";
import { compactCommand, effectiveAction, isExecutor, matchPolicy, resolvePolicies, type PolicyWarning } from "../lib/ctx-boundary-policy.js";
import {
  boundaryDecision, boundaryView, globalBoundary, policyBoundary, SKIP_REASON_TEXT,
  type Boundary, type BoundaryVerdict, type CtxBoundaryView, type GlobalAutoCompact, type SkipReason,
} from "../lib/ctx-boundary-decision.js";
import {
  agentWindowName, compactInjectedRecently, injectCompact, liveInjectDeps, loadInjectGuard, paneGateOf, resetInjectState, sweepPendingEcho,
  type InjectDeps, type InjectResult, type InjectTarget, type PaneCapture,
} from "./ctx-boundary-inject.js";
import { windowTarget } from "../lib/tmux-helper.js";
export { compactInjectedRecently, injectCompact } from "./ctx-boundary-inject.js"; // 看板 / 手动按钮原来从这里拿
import { PersistedMap } from "./persisted-map.js";
import { adapterFor } from "./adapters.js";
import { emitEvent } from "./event-bus.js";
import { parseChatId } from "./router.js";

const TICK_MS = 60_000;
/** 注入后 30 分钟没回落到线下才重试：注入可能被 TUI 吞掉，布尔标记会卡成永久沉默（git log -S AUTO_COMPACT_RETRY_MS） */
const RETRY_MS = 30 * 60_000;
/** 发送失败（窗口没了、tmux 出错）：5 分钟后再试，不进 30 分钟的沉默期 */
const FAIL_RETRY_MS = 5 * 60_000;
/** 过救命线又被挡住（或敲进去的字没提交）时提醒 owner：同一个 agent 30 分钟最多一次 */
const ALERT_EVERY_MS = 30 * 60_000;
const ALERT_ON = new Set<SkipReason>(["draft", "queued", "menu", "quota-wall", "copy-mode"]);
/** 面板 / agent 列表一次请求里每个 agent 都要看策略：线上依赖读配置、解析一次管 2 秒 */
const POLICY_CACHE_MS = 2_000;
const TRIG_FILE = statePath("ctx-boundary-trig.json");

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
  /** 过线的 agent 再核一次窗口里实际在跑的会话（/clear 之后 registry 还指着旧文件），换了就按新会话重读 */
  liveSession(a: BoundaryAgent): Promise<BoundaryAgent>;
  autoCompact(): (GlobalAutoCompact & { policies?: unknown }) | undefined;
  log(line: string): void;
  alert(a: BoundaryAgent, text: string, data: Record<string, unknown>): void;
  /** true = 只判定不发键、不写状态（manager ctx-boundary dry-run），也不看 inject 开关 */
  dryRun?: boolean;
}

export interface TickOutcome {
  agent: string;
  ctx: number;
  boundary: Boundary;
  verdict: BoundaryVerdict;
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

function boundaryFor(
  a: Pick<BoundaryAgent, "name" | "projectId" | "realWindow" | "executor">,
  p: ReturnType<typeof resolveNow>,
): Boundary {
  const m = matchPolicy(p.policies, a);
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

async function checkOne(a: BoundaryAgent & { ctx: number }, b: Boundary, deps: CtxBoundaryDeps): Promise<TickOutcome> {
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
  if (deps.dryRun) return { ...base, would: compactCommand(b.action, b.keep) };
  const inject = await injectCompact(a, { action: b.action, keep: b.keep, pane }, deps);
  if (inject.status === "executed" || inject.status === "queued") lastTrig.set(a.name, now);
  else if (inject.status === "failed") lastTrig.set(a.name, now - RETRY_MS + FAIL_RETRY_MS);
  if (inject.status === "failed" && inject.leftover) {
    maybeAlert(a, now, deps, `⚠️ 往 ${a.name} 注入压缩没成功：${inject.error}。`, { ctx: a.ctx, cap: b.hardCap, reason: "leftover" });
  }
  const why = inject.status === "failed" ? `（${inject.error}）` : inject.status === "skipped" ? `（${inject.text}）` : "";
  deps.log(`🧹 上下文边界 ${verdict.kind === "hard-cap" ? "硬上限" : "闲置"}触发 ${tag}：${b.action} → ${inject.status}${why}`);
  return { ...base, inject };
}

/** 一轮：过线的才读画面、才可能注入；回到线下就清掉冷却（上次注入见效，或者手动压过） */
export async function ctxBoundaryTick(deps: CtxBoundaryDeps = liveDeps): Promise<TickOutcome[]> {
  const p = currentPolicies(deps);
  if (!deps.dryRun && p.ac?.inject !== true) {
    if (!offLogged) deps.log("🧭 上下文边界：自动注入关着（config autoCompact.inject），只显示不压缩；先跑 manager ctx-boundary dry-run 看结果");
    offLogged = true;
    return [];
  }
  offLogged = false;
  if (!deps.dryRun) await sweepPendingEcho(deps, deps.log);
  const out: TickOutcome[] = [];
  for (const listed of await deps.agents()) {
    let a = listed;
    let b = boundaryFor(a, p);
    if (overLine(a.ctx, b)) {
      a = await deps.liveSession(a);
      b = boundaryFor(a, p);
    }
    if (a.ctx === null || !overLine(a.ctx, b)) {
      if (!deps.dryRun) lastTrig.delete(a.name);
      lastSkip.delete(a.name);
      continue;
    }
    out.push(await checkOne({ ...a, ctx: a.ctx }, b, deps));
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
  const realWindow = a.sessionId ? readSessionCtx(a.sessionId)?.window ?? null : null;
  const executor = isExecutor({ name: a.name, worktree: isLinkedWorktree(a.cwd) });
  return boundaryView(boundaryFor({ name: a.name, projectId: a.projectId ?? null, realWindow, executor }, p), ctx, p.warnings);
}

/** 当前配置的问题（越界的 ccWindow、写错的字段…），面板顶上列出来；自动注入关着也列一条 */
export function ctxBoundaryWarnings(): PolicyWarning[] {
  const p = currentPolicies(liveDeps);
  return p.ac?.inject === true ? p.warnings : [{ policy: null, text: "自动注入关着（config autoCompact.inject）：只显示边界，不自动压缩" }, ...p.warnings];
}

const worktreeCache = new Map<string, boolean>();
/**
 * 工作目录是不是 git 的 linked worktree：往上找第一个 .git，是文件、且指向 `…/worktrees/<名字>` 才算。
 * submodule 的 .git 也是文件，但指向 `…/modules/…`，它的 memory 目录不和别人共用，不能当执行者。按目录缓存（cwd 不会变）
 */
export function isLinkedWorktree(dir: string | null | undefined): boolean {
  if (!dir) return false;
  const hit = worktreeCache.get(dir);
  if (hit !== undefined) return hit;
  let v = false;
  for (let d = dir; ; d = dirname(d)) {
    const g = join(d, ".git");
    if (existsSync(g)) {
      try {
        v = statSync(g).isFile() && /[\\/]worktrees[\\/][^\\/]+[\\/]?$/.test(readFileSync(g, "utf8").trim());
      } catch {
        v = false; // 刚好被删：当普通仓库，下次 cwd 变了才会重算（cwd 不变，这里只是防抛）
      }
      break;
    }
    if (dirname(d) === d) break;
  }
  worktreeCache.set(dir, v);
  return v;
}

/** 按 registry 名字拼注入对象（Discord 手动按钮、T35 的批量动作用） */
export async function injectTargetFor(name: string): Promise<InjectTarget> {
  const r = (await readRegistryAgents()).find((x) => x.name === name);
  return { name, target: windowTarget(agentWindowName(name)), executor: isExecutor({ name, worktree: isLinkedWorktree(r?.cwd) }) };
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

async function liveAgents(): Promise<BoundaryAgent[]> {
  const out: BoundaryAgent[] = [];
  for (const r of await readRegistryAgents()) {
    // 只管 Claude Code：注入的是 CC 的斜杠命令，画面判定也是 CC 的；Codex / Pi 有各自的压缩
    if ((r.status && r.status !== "active") || agentRuntime(r) !== "claude-code" || !r.sessionId) continue;
    const cwd = r.cwd ? r.cwd.replace(/^~/, process.env.HOME || "~") : null;
    out.push({
      name: r.name,
      projectId: r.projectId ?? null,
      channelId: r.channelId ?? null,
      cwd,
      sessionId: r.sessionId,
      target: windowTarget(agentWindowName(r.name)),
      executor: isExecutor({ name: r.name, worktree: isLinkedWorktree(cwd) }),
      ...(await sessionStats(r.runtime, cwd, r.sessionId)),
    });
  }
  return out;
}

/** CC 在 /clear 时会把 ~/.claude/sessions/<pid>.json 的 sessionId 换成新的（09-29 实测），按它认窗口里实际在跑的会话 */
async function liveSessionOf(a: BoundaryAgent): Promise<BoundaryAgent> {
  if (!a.cwd) return a;
  const hit = await resolveSessionIdForWindow(agentWindowName(a.name), a.cwd, { timeoutMs: 0 }).catch((e) => {
    console.error(`🧭 上下文边界 查 ${a.name} 的实际会话失败（按 registry 记的算）:`, (e as Error).message);
    return null;
  });
  if (!hit || hit.sessionId === a.sessionId) return a;
  return { ...a, sessionId: hit.sessionId, ...(await sessionStats(undefined, a.cwd, hit.sessionId)) };
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
  liveSession: liveSessionOf,
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

/** manager ctx-boundary dry-run：线上的 registry、画面、配置和落盘的冷却 / 守卫照常判定；不发键、不写任何状态、不提醒 */
export async function ctxBoundaryDryRun(): Promise<{ outcomes: TickOutcome[]; logs: string[]; inject: boolean; master: MasterDryRun | null }> {
  loadInjectGuard("read-only");
  const r = readJsonStateSync(TRIG_FILE);
  const trig = r.status === "ok" && r.data && typeof r.data === "object" ? (r.data as Record<string, unknown>) : {};
  lastTrig = new Map(Object.entries(trig).filter((e): e is [string, number] => typeof e[1] === "number"));
  const logs: string[] = [];
  let listed: BoundaryAgent[] = [];
  const agents = async () => (listed = await liveAgents());
  const deps: CtxBoundaryDeps = { ...liveDeps, agents, log: (l) => void logs.push(l), alert: () => {}, dryRun: true };
  const outcomes = await ctxBoundaryTick(deps);
  const m = listed.find((a) => isMasterAgent(a.name));
  const master = m ? { agent: m.name, ctx: m.ctx, boundary: boundaryFor(m, currentPolicies(deps)), outcome: outcomes.find((o) => o.agent === m.name) ?? null } : null;
  return { outcomes, logs, inject: deps.autoCompact()?.inject === true, master };
}

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

/** bridge 启动时调一次（幂等）。冷却和注入守卫落盘，bridge 重启不清零。一轮没跑完不叠下一轮。 */
export function startCtxBoundary(): void {
  if (timer) return;
  loadInjectGuard("live");
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

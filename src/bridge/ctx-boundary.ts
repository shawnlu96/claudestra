/**
 * 上下文边界的执行：每分钟看一遍在跑的 Claude Code 会话，按 lib/ctx-boundary-decision.ts 的决策表往 tmux 注入
 * `/compact <保留清单>` 或 `/save-compact`。不挂在 Discord 看板上（web-only / 沙箱也要跑），bridge 启动时 startCtxBoundary()。
 * 设计 docs/architecture/context-boundary.md；单测 tests/ctx-boundary.test.ts（全部依赖可注入）。
 */
import { existsSync, statSync } from "fs";
import { dirname, join } from "path";
import { readConfigSync } from "../lib/config-store.js";
import { agentRuntime, readRegistryAgents, type RegistryAgent } from "../lib/registry.js";
import { findSessionJsonlBySessionId, sessionJsonlPath } from "../lib/session-source.js";
import { sessionTailInfo } from "../lib/session-tail.js";
import { readSessionCtx } from "../lib/usage-cache.js";
import { tmuxRawStrict, tmuxSendLine, windowKey, windowTarget } from "../lib/tmux-helper.js";
import { paneLooksWorking } from "../lib/turn-state.js";
import { formatTokens } from "../lib/agent-stats.js";
import { compactCommand, effectiveAction, isExecutor, matchPolicy, resolvePolicies, type CompactAction, type PolicyWarning } from "../lib/ctx-boundary-policy.js";
import { paneQuotaState, stripAnsi, type PaneQuotaState } from "../lib/lp-state.js";
import {
  boundaryDecision, boundaryView, globalBoundary, policyBoundary, SKIP_REASON_TEXT,
  type Boundary, type BoundaryVerdict, type CtxBoundaryView, type GlobalAutoCompact, type SkipReason,
} from "../lib/ctx-boundary-decision.js";

const TICK_MS = 60_000;
/** 注入后 30 分钟没回落到线下才重试：注入可能被 TUI 吞掉，布尔标记会卡成永久沉默（git log -S AUTO_COMPACT_RETRY_MS） */
const RETRY_MS = 30 * 60_000;
/** 发送失败（窗口没了、tmux 出错）：5 分钟后再试，不进 30 分钟的沉默期 */
const FAIL_RETRY_MS = 5 * 60_000;
/** 刚注入过压缩的窗口：15 分钟内不再注入、也不给看板当 /status 抓取源（压缩中 pane 像闲着，抓取会硬中断它） */
const INJECT_GUARD_MS = 15 * 60_000;
/** 面板 / agent 列表一次请求里每个 agent 都要看策略：线上依赖读配置、解析一次管 2 秒 */
const POLICY_CACHE_MS = 2_000;
const QUEUED_RE = /Press up to edit queued messages/i;
/** 不做画面判定时的「画面」：什么都不挡（旧口径） */
const UNGATED: PaneQuotaState = { wall: false, lp: "unknown", exhausted: false, menu: false, compacting: false, draft: false };

/** 往哪个窗口注入、按不按执行者对待（执行者不跑 save-compact，见 lib effectiveAction） */
export interface InjectTarget {
  name: string;
  target: string;
  executor: boolean;
}

export interface BoundaryAgent extends InjectTarget {
  projectId: string | null;
  /** null = 读不到会话文件 */
  ctx: number | null;
  /** 最后一条真实对话的时间（不单用 mtime：CC 会周期性 touch 会话文件） */
  convTs: number | null;
  /** 会话文件 mtime：全局路径（个人 agent）沿用的旧闲置口径，和新口径同时满足才算闲（PM 09-29 定，保持今天的行为） */
  mtime: number | null;
  /** statusline 落盘的真实窗口；null = 没配 statusline */
  realWindow: number | null;
}

/** 一次 `capture-pane -p -e`：esc 给画面判定（输入框的灰色提示只有 ESC[2m 分得出来），plain 是它去色后的样子（忙闲 / 排队）。
 *  只抓一次：抓两次在画面快速变化时两份会对不上（r2 实测 200 次里 15 次） */
export interface PaneCapture {
  plain: string;
  esc: string;
}

export interface CtxBoundaryDeps {
  now(): number;
  agents(): Promise<BoundaryAgent[]>;
  capture(target: string): Promise<PaneCapture | null>;
  paneState(plain: string, esc: string): PaneQuotaState;
  send(target: string, line: string): Promise<void>;
  autoCompact(): (GlobalAutoCompact & { policies?: unknown }) | undefined;
  log(line: string): void;
  /** 全局路径（没命中具名策略的个人 agent）和 Discord 手动按钮要不要过画面判定（线上 true；留着开关给测试和回退） */
  gateGlobal: boolean;
}

type InjectSkip = Extract<SkipReason, "pane-unknown" | "quota-wall" | "menu" | "queued" | "draft" | "compacting">;
export type InjectResult =
  | { status: "executed" | "queued"; line: string }
  | { status: "skipped"; reason: InjectSkip; text: string }
  | { status: "failed"; error: string };

export interface TickOutcome {
  agent: string;
  boundary: Boundary;
  verdict: BoundaryVerdict;
  inject?: InjectResult;
}

const lastTrig = new Map<string, number>();
const injectedAt = new Map<string, number>();
const lastSkip = new Map<string, string>();
const warned = new Set<string>();
let policyCache: { at: number; value: ReturnType<typeof resolveNow> } | null = null;

/** 测试用：清掉进程内状态 */
export function resetCtxBoundaryState(): void {
  for (const m of [lastTrig, injectedAt, lastSkip]) m.clear();
  warned.clear();
  policyCache = null;
}

/** 所有往会话里注入压缩的路径（本模块、看板的手动按钮）都记这一笔，共用一份守卫。 */
export function noteCompactInjected(target: string, now = Date.now()): void {
  injectedAt.set(windowKey(target), now);
}

export function compactInjectedRecently(target: string, now = Date.now()): boolean {
  const ts = injectedAt.get(windowKey(target));
  return ts !== undefined && now - ts < INJECT_GUARD_MS;
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

/** 能证明输入框是空的、也没有排队，才发（PM 09-29：排队的多半就是上一条 /compact，再发就叠上去了）。排队和草稿分开报 */
function paneGate(ps: PaneQuotaState, plain: string): InjectSkip | null {
  if (ps.compacting) return "compacting";
  if ((ps.wall && ps.lp !== "on") || ps.exhausted) return "quota-wall";
  if (ps.menu) return "menu";
  if (QUEUED_RE.test(plain)) return "queued";
  if (ps.draft) return "draft";
  return null;
}

/**
 * 注入一次压缩（Discord 手动按钮、T35 的批量动作也走这里；拿不准目标时用 injectTargetFor(name)）。
 * 先读画面：读不到 / 撞墙没开 LP / 有选择菜单 / 输入框有草稿 / 正在压缩 → 不敲键。执行者的 save-compact 改成 compact。
 * 忙的时候敲进去会排队到回合结束（queued），闲着就是立刻执行（executed）。只有真发出去了才记注入守卫。
 * gate:false = 不做画面判定（旧口径，lp-state 到位前全局路径和 Discord 手动按钮用）。
 */
export async function injectCompact(
  t: InjectTarget,
  opts: { action: CompactAction; keep?: string | null; pane?: PaneCapture | null; gate?: boolean },
  deps: Pick<CtxBoundaryDeps, "capture" | "paneState" | "send" | "now"> = liveDeps,
): Promise<InjectResult> {
  const pane = opts.pane !== undefined ? opts.pane : await deps.capture(t.target);
  // 读不到画面（多半是窗口不在）不管 gate 都不发：tmux 往不存在的窗口 send-keys 不报错，发了也只会假报「已开始」
  const reason: InjectSkip | null = !pane ? "pane-unknown" : opts.gate === false ? null : paneGate(deps.paneState(pane.plain, pane.esc), pane.plain);
  if (reason || !pane) return { status: "skipped", reason: reason ?? "pane-unknown", text: SKIP_REASON_TEXT[reason ?? "pane-unknown"] };
  const line = compactCommand(effectiveAction(t.executor, opts.action), opts.keep ?? null);
  try {
    await deps.send(t.target, line);
  } catch (e) {
    return { status: "failed", error: (e as Error).message };
  }
  noteCompactInjected(t.target, deps.now());
  return { status: paneLooksWorking(pane.plain) ? "queued" : "executed", line };
}

/** 新口径：最后一条对话满 idleMs 且画面不忙。全局路径另加旧口径（mtime 满 idleMs），两者都满足才算闲 */
function idleEnough(a: BoundaryAgent, b: Boundary, pane: PaneCapture | null, now: number): boolean {
  if (b.idleMs <= 0) return true;
  if (a.convTs === null || pane === null) return false;
  const fresh = now - a.convTs >= b.idleMs && !paneLooksWorking(pane.plain);
  return b.policy === "global" ? fresh && a.mtime !== null && now - a.mtime >= b.idleMs : fresh;
}

async function checkOne(a: BoundaryAgent & { ctx: number }, b: Boundary, deps: CtxBoundaryDeps): Promise<TickOutcome> {
  const pane = await deps.capture(a.target);
  const now = deps.now();
  const gate = b.policy !== "global" || deps.gateGlobal;
  const verdict = boundaryDecision({
    ctx: a.ctx,
    window: b.window,
    hardCap: b.hardCap,
    idle: idleEnough(a, b, pane, now),
    pane: !gate ? UNGATED : pane === null ? null : deps.paneState(pane.plain, pane.esc),
    queued: pane !== null && QUEUED_RE.test(pane.plain),
    injectedRecently: compactInjectedRecently(a.target, now),
    lastTrig: lastTrig.get(a.name) ?? 0,
    now,
    retryMs: RETRY_MS,
  });
  const tag = `${a.name} @ ${formatTokens(a.ctx)}（策略 ${b.policy}，线 ${formatTokens(b.window)} / 上限 ${b.hardCap === null ? "—" : formatTokens(b.hardCap)}）`;
  if (!verdict.fire) {
    // 同一个原因只记一次，免得每分钟刷日志
    if (lastSkip.get(a.name) !== verdict.reason) deps.log(`🧭 上下文边界 跳过 ${tag}：${SKIP_REASON_TEXT[verdict.reason]}`);
    lastSkip.set(a.name, verdict.reason);
    return { agent: a.name, boundary: b, verdict };
  }
  lastSkip.delete(a.name);
  const inject = await injectCompact(a, { action: b.action, keep: b.keep, pane, gate }, deps);
  if (inject.status === "executed" || inject.status === "queued") lastTrig.set(a.name, now);
  else if (inject.status === "failed") lastTrig.set(a.name, now - RETRY_MS + FAIL_RETRY_MS);
  const why = inject.status === "failed" ? `（${inject.error}）` : inject.status === "skipped" ? `（${inject.text}）` : "";
  deps.log(`🧹 上下文边界 ${verdict.kind === "hard-cap" ? "硬上限" : "闲置"}触发 ${tag}：${b.action} → ${inject.status}${why}`);
  return { agent: a.name, boundary: b, verdict, inject };
}

/** 一轮：过线的才读画面、才可能注入；回到线下就清掉冷却（上次注入见效，或者手动压过） */
export async function ctxBoundaryTick(deps: CtxBoundaryDeps = liveDeps): Promise<TickOutcome[]> {
  const p = currentPolicies(deps);
  const out: TickOutcome[] = [];
  for (const a of await deps.agents()) {
    if (a.ctx === null) continue;
    const b = boundaryFor(a, p);
    if (!(b.window > 0 && a.ctx >= b.window) && !(b.hardCap !== null && a.ctx >= b.hardCap)) {
      lastTrig.delete(a.name);
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

/** 全局路径和 Discord 手动按钮现在过不过画面判定（lp-state 增量只改 liveDeps.gateGlobal 一处） */
export function gatesGlobal(): boolean {
  return liveDeps.gateGlobal;
}

/** 当前配置的问题（越界的 ccWindow、写错的字段…），面板顶上列出来 */
export function ctxBoundaryWarnings(): PolicyWarning[] {
  return currentPolicies(liveDeps).warnings;
}

const worktreeCache = new Map<string, boolean>();
/** 工作目录是不是 git 的 linked worktree：往上找第一个 .git，是文件（「gitdir: …」）就是。按目录缓存（agent 的 cwd 不会变） */
function isLinkedWorktree(dir: string | undefined): boolean {
  if (!dir) return false;
  const hit = worktreeCache.get(dir);
  if (hit !== undefined) return hit;
  let v = false;
  for (let d = dir; ; d = dirname(d)) {
    const g = join(d, ".git");
    if (existsSync(g)) {
      try {
        v = statSync(g).isFile();
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
  return { name, target: windowTarget(name), executor: isExecutor({ name, worktree: isLinkedWorktree(r?.cwd) }) };
}

async function liveAgents(): Promise<BoundaryAgent[]> {
  const out: BoundaryAgent[] = [];
  for (const r of await readRegistryAgents()) {
    // 只管 Claude Code：注入的是 CC 的斜杠命令，画面判定也是 CC 的；Codex / Pi 有各自的压缩
    if ((r.status && r.status !== "active") || agentRuntime(r) !== "claude-code" || !r.sessionId) continue;
    const { info, mtime } = await tailOf(r);
    out.push({
      name: r.name,
      projectId: r.projectId ?? null,
      target: windowTarget(r.name),
      executor: isExecutor({ name: r.name, worktree: isLinkedWorktree(r.cwd) }),
      ctx: info?.ctxTokens ?? null,
      convTs: info?.convTs ?? null,
      mtime,
      realWindow: readSessionCtx(r.sessionId)?.window ?? null,
    });
  }
  return out;
}

async function tailOf(r: RegistryAgent) {
  const path = (r.cwd ? sessionJsonlPath(r.runtime, r.cwd, r.sessionId!) : null) ?? findSessionJsonlBySessionId(r.runtime, r.sessionId!);
  if (!path) return { info: null, mtime: null };
  let mtime: number | null = null;
  try {
    mtime = statSync(path).mtimeMs;
  } catch {
    mtime = null; // 文件刚被挪走：旧口径判不出闲置，全局路径就不走闲置触发（救命线不受影响）
  }
  return { info: await sessionTailInfo(path), mtime };
}

/** 用 strict：tmuxRaw 会吞掉非零退出，窗口不在时拿到空串，后面就会对着不存在的窗口报「已发送」 */
async function capturePane(t: string): Promise<PaneCapture | null> {
  try {
    const esc = await tmuxRawStrict(["capture-pane", "-t", t, "-p", "-e"]);
    const plain = stripAnsi(esc);
    return plain.trim() ? { plain, esc } : null;
  } catch {
    return null; // 窗口不在 / tmux 出错：按「读不到画面」跳过，不盲敲
  }
}

const liveDeps: CtxBoundaryDeps = {
  now: () => Date.now(),
  agents: liveAgents,
  capture: capturePane,
  paneState: paneQuotaState,
  send: (t, line) => tmuxSendLine(t, line),
  autoCompact: () => readConfigSync().autoCompact,
  log: (l) => console.log(l),
  gateGlobal: true,
};

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

/** bridge 启动时调一次（幂等）。一轮没跑完不叠下一轮。 */
export function startCtxBoundary(): void {
  if (timer) return;
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

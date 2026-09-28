/**
 * 上下文边界的执行：每分钟看一遍在跑的 Claude Code 会话，按 lib/ctx-boundary-policy.ts 的决策表往 tmux 注入
 * `/compact <保留清单>` 或 `/save-compact`。不挂在 Discord 看板上（web-only / 沙箱也要跑），bridge 启动时 startCtxBoundary()。
 * 设计 docs/architecture/context-boundary.md；单测 tests/ctx-boundary.test.ts（全部依赖可注入）。
 */
import { readConfigSync } from "../lib/config-store.js";
import { agentRuntime, readRegistryAgents, type RegistryAgent } from "../lib/registry.js";
import { findSessionJsonlBySessionId, sessionJsonlPath } from "../lib/session-source.js";
import { sessionTailInfo } from "../lib/session-tail.js";
import { readSessionCtx } from "../lib/usage-cache.js";
import { tmuxRaw, tmuxSendLine, windowKey, windowTarget } from "../lib/tmux-helper.js";
import { paneLooksWorking } from "../lib/turn-state.js";
import { formatTokens } from "../lib/agent-stats.js";
import {
  boundaryDecision, boundaryView, compactCommand, effectiveAction, globalBoundary, matchPolicy, policyBoundary, resolvePolicies, SKIP_REASON_TEXT,
  type Boundary, type BoundaryVerdict, type CompactAction, type CtxBoundaryView, type GlobalAutoCompact, type PaneQuotaState,
  type PolicyWarning,
} from "../lib/ctx-boundary-policy.js";

const TICK_MS = 60_000;
/** 注入后 30 分钟没回落到线下才重试：注入可能被 TUI 吞掉，布尔标记会卡成永久沉默（git log -S AUTO_COMPACT_RETRY_MS） */
const RETRY_MS = 30 * 60_000;
/** 刚注入过压缩的窗口：15 分钟内不再注入、也不给看板当 /status 抓取源（压缩中 pane 像闲着，抓取会硬中断它） */
const INJECT_GUARD_MS = 15 * 60_000;
const QUEUED_RE = /Press up to edit queued messages/i;

export interface BoundaryAgent {
  name: string;
  projectId: string | null;
  target: string;
  /** null = 读不到会话文件 */
  ctx: number | null;
  /** 最后一条真实对话的时间（不用 mtime：CC 会周期性 touch 会话文件） */
  convTs: number | null;
  /** statusline 落盘的真实窗口；null = 没配 statusline */
  realWindow: number | null;
}

export interface CtxBoundaryDeps {
  now(): number;
  agents(): Promise<BoundaryAgent[]>;
  capture(target: string): Promise<string | null>;
  paneState(pane: string): PaneQuotaState;
  send(target: string, line: string): Promise<void>;
  autoCompact(): (GlobalAutoCompact & { policies?: unknown }) | undefined;
  log(line: string): void;
}

export type InjectResult =
  | { status: "executed" | "queued"; line: string }
  | { status: "skipped"; reason: "pane-unknown" | "quota-wall" | "menu" | "compacting"; text: string }
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

/** 测试用：清掉进程内状态 */
export function resetCtxBoundaryState(): void {
  for (const m of [lastTrig, injectedAt, lastSkip]) m.clear();
  warned.clear();
}

/** 所有往会话里注入压缩的路径（本模块、看板的手动按钮）都记这一笔，共用一份守卫。 */
export function noteCompactInjected(target: string, now = Date.now()): void {
  injectedAt.set(windowKey(target), now);
}

export function compactInjectedRecently(target: string, now = Date.now()): boolean {
  const ts = injectedAt.get(windowKey(target));
  return ts !== undefined && now - ts < INJECT_GUARD_MS;
}

function currentPolicies(deps: Pick<CtxBoundaryDeps, "autoCompact" | "log">) {
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

function boundaryFor(a: Pick<BoundaryAgent, "name" | "projectId" | "realWindow">, p: ReturnType<typeof currentPolicies>): Boundary {
  const m = matchPolicy(p.policies, a);
  const b = m ? policyBoundary(m, a.realWindow) : globalBoundary(p.ac, a.realWindow);
  return { ...b, action: effectiveAction(a.name, b.action) };
}

/**
 * 注入一次压缩（T35 的批量动作也走这里）：先读画面，读不到 / 撞墙没开 LP / 有选择菜单 / 正在压缩 → 不敲键。
 * 传了 agentName 时执行者的 save-compact 改成 compact（见 effectiveAction）。
 * 忙的时候敲进去会排队到回合结束（queued），闲着就是立刻执行（executed）。
 */
export async function injectCompact(
  target: string,
  opts: { action: CompactAction; keep?: string | null; pane?: string | null; agentName?: string },
  deps: Pick<CtxBoundaryDeps, "capture" | "paneState" | "send" | "now"> = liveDeps,
): Promise<InjectResult> {
  const pane = opts.pane !== undefined ? opts.pane : await deps.capture(target);
  const ps = pane === null ? null : deps.paneState(pane);
  const reason = !ps ? "pane-unknown" : ps.compacting ? "compacting" : ps.wall && ps.lp !== "on" ? "quota-wall" : ps.menu ? "menu" : null;
  if (reason || pane === null) return { status: "skipped", reason: reason ?? "pane-unknown", text: SKIP_REASON_TEXT[reason ?? "pane-unknown"] };
  const line = compactCommand(opts.agentName ? effectiveAction(opts.agentName, opts.action) : opts.action, opts.keep ?? null);
  try {
    noteCompactInjected(target, deps.now());
    await deps.send(target, line);
  } catch (e) {
    return { status: "failed", error: (e as Error).message };
  }
  return { status: paneLooksWorking(pane) ? "queued" : "executed", line };
}

function idleEnough(a: BoundaryAgent, idleMs: number, pane: string | null, now: number): boolean {
  if (idleMs <= 0) return true;
  if (a.convTs === null || pane === null) return false;
  return now - a.convTs >= idleMs && !paneLooksWorking(pane);
}

async function checkOne(a: BoundaryAgent & { ctx: number }, b: Boundary, deps: CtxBoundaryDeps): Promise<TickOutcome> {
  const pane = await deps.capture(a.target);
  const now = deps.now();
  const verdict = boundaryDecision({
    ctx: a.ctx,
    window: b.window,
    hardCap: b.hardCap,
    idle: idleEnough(a, b.idleMs, pane, now),
    pane: pane === null ? null : deps.paneState(pane),
    queued: pane !== null && QUEUED_RE.test(pane),
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
  lastTrig.set(a.name, now);
  lastSkip.delete(a.name);
  const inject = await injectCompact(a.target, { action: b.action, keep: b.keep, pane, agentName: a.name }, deps);
  deps.log(`🧹 上下文边界 ${verdict.kind === "hard-cap" ? "硬上限" : "闲置"}触发 ${tag}：${b.action} → ${inject.status}`);
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
  a: { name: string; projectId?: string | null; runtime?: string; sessionId?: string },
  ctx: number | null,
): CtxBoundaryView | null {
  if (agentRuntime(a) !== "claude-code") return null;
  const p = currentPolicies(liveDeps);
  const realWindow = a.sessionId ? readSessionCtx(a.sessionId)?.window ?? null : null;
  const b = boundaryFor({ name: a.name, projectId: a.projectId ?? null, realWindow }, p);
  return boundaryView(b, ctx, p.warnings);
}

/** 当前配置的问题（越界的 ccWindow、写错的字段…），面板顶上列出来 */
export function ctxBoundaryWarnings(): PolicyWarning[] {
  return currentPolicies(liveDeps).warnings;
}

async function liveAgents(): Promise<BoundaryAgent[]> {
  const out: BoundaryAgent[] = [];
  for (const r of await readRegistryAgents()) {
    // 只管 Claude Code：注入的是 CC 的斜杠命令，画面判定也是 CC 的；Codex / Pi 有各自的压缩
    if ((r.status && r.status !== "active") || agentRuntime(r) !== "claude-code" || !r.sessionId) continue;
    const info = await tailOf(r);
    out.push({
      name: r.name,
      projectId: r.projectId ?? null,
      target: windowTarget(r.name),
      ctx: info?.ctxTokens ?? null,
      convTs: info?.convTs ?? null,
      realWindow: readSessionCtx(r.sessionId)?.window ?? null,
    });
  }
  return out;
}

async function tailOf(r: RegistryAgent) {
  const path = (r.cwd ? sessionJsonlPath(r.runtime, r.cwd, r.sessionId!) : null) ?? findSessionJsonlBySessionId(r.runtime, r.sessionId!);
  return path ? sessionTailInfo(path) : null;
}

const liveDeps: CtxBoundaryDeps = {
  now: () => Date.now(),
  agents: liveAgents,
  capture: (t) => tmuxRaw(["capture-pane", "-t", t, "-p"]).catch(() => null), // 窗口不在 / tmux 出错：决策表按「读不到画面」跳过，不盲敲
  // 临时：T35 的 lib/lp-state.ts paneQuotaState 合进来之前一律当「有菜单」处理（不敲键）
  paneState: () => ({ wall: false, lp: "unknown", menu: true, compacting: false }),
  send: (t, line) => tmuxSendLine(t, line),
  autoCompact: () => readConfigSync().autoCompact,
  log: (l) => console.log(l),
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

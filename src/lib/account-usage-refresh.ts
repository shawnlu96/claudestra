/**
 * 账号用量「手动刷新」闸：唯一允许起 TUI 探测的入口（网页用户点刷新）都要过这里。
 *   - 失败（含探测中途崩溃 / 重启）后 30 分钟退避：期间再点只回旧读数 / 未知 + 下一可刷新时间，不再探测；
 *   - 同进程并发共用一次探测，跨进程靠锁（抢不到 = 别人在探测，本次不探测）；
 *   - 状态落盘（state 目录 account-usage-refresh.json）：退避和「探测进行中」标记跨重启有效，
 *     上一进程留下的探测会话按记录精确回收（只收自己建的那一个）。
 * 落盘的只有解析后的数字与重置时间——不存 pane 原文、不存任何令牌。单测 tests/account-usage-refresh.test.ts。
 */
import { acquireLock } from "./file-lock.js";
import { statePath } from "./paths.js";
import { readJsonStateSync, writeJsonAtomicSync } from "./state-file.js";
import type { AccountUsage } from "./account-usage-panel.js";

export const MANUAL_REFRESH_BACKOFF_MS = 30 * 60 * 1000;
/** 网页按 raw 认来源（非 statusline 字面量 = 面板读数），见 web/features/chat/usage-view.ts claudeQuotaSource */
export const MANUAL_RAW = "status panel (manual refresh)";
export const ACCOUNT_USAGE_REFRESH_PATH = statePath("account-usage-refresh.json");

/** 探测自己建出来的资源：会话名 + tmux 的 session id（$N）+ 临时目录。回收只认这份记录 */
export interface ProbeResource {
  session: string;
  id: string;
  dir: string;
}

export type StoredReading = Omit<AccountUsage, "raw" | "source" | "stale" | "reason">;

interface RefreshState {
  lastAttemptAt: number | null;
  lastFailureAt: number | null;
  lastFailureReason: string | null;
  nextAllowedAt: number | null;
  inFlight: { startedAt: number; pid: number; probe: ProbeResource | null } | null;
  lastReading: StoredReading | null;
}

export type ProbeResult = { ok: true; usage: AccountUsage } | { ok: false; reason: string };

export interface ProbeRunner {
  /** onCreated：探测一建好资源就回调，闸立刻落盘——中途崩溃后下一进程能按记录回收 */
  run(onCreated: (r: ProbeResource) => void): Promise<ProbeResult>;
  /** 回收上一进程留下的探测资源（只收这份记录里的那一个） */
  cleanup(r: ProbeResource): Promise<void>;
}

export interface RefreshOutcome {
  outcome: "refreshed" | "backoff" | "failed" | "busy";
  /** 本次成功的完整读数，否则上次成功读数（没有 = null，调用方显示未知） */
  usage: AccountUsage | null;
  nextAllowedAt: number | null;
  reason: string | null;
}

export interface RefreshDeps {
  now?: () => number;
  path?: string;
  probe: ProbeRunner;
}

const EMPTY: RefreshState = {
  lastAttemptAt: null, lastFailureAt: null, lastFailureReason: null, nextAllowedAt: null, inFlight: null, lastReading: null,
};

const isObj = (d: unknown): d is Record<string, unknown> => !!d && typeof d === "object" && !Array.isArray(d);

/** 读状态：不存在 = 空；损坏 = corrupt（调用方按失败处理：不探测、不覆盖） */
function readRefreshState(path = ACCOUNT_USAGE_REFRESH_PATH): { state: RefreshState; corrupt: boolean } {
  const r = readJsonStateSync(path, isObj);
  if (r.status === "missing") return { state: { ...EMPTY }, corrupt: false };
  if (r.status !== "ok") return { state: { ...EMPTY }, corrupt: true };
  return { state: { ...EMPTY, ...(r.data as Partial<RefreshState>) }, corrupt: false };
}

function save(path: string, s: RefreshState): void {
  writeJsonAtomicSync(path, s, { mode: 0o600 });
}

function storedReading(u: AccountUsage): StoredReading {
  const { sessionPct, sessionResets, weekPct, weekResets, totalCost, apiDuration, scrapedAt } = u;
  return { sessionPct, sessionResets, weekPct, weekResets, totalCost, apiDuration, scrapedAt };
}

const asUsage = (r: StoredReading | null): AccountUsage | null =>
  r ? { ...r, raw: MANUAL_RAW, source: "manual", stale: true, reason: null } : null;

/** 上次手动探测成功的读数（后台读取路径用；只读，绝不触发探测） */
export function lastManualReading(path = ACCOUNT_USAGE_REFRESH_PATH): StoredReading | null {
  const { state, corrupt } = readRefreshState(path);
  return corrupt ? null : state.lastReading;
}

const inProcess = new Map<string, Promise<RefreshOutcome>>();

/** 手动刷新：同一状态文件同进程只跑一次，并发调用方拿同一个结果 */
export function manualRefresh(deps: RefreshDeps): Promise<RefreshOutcome> {
  const path = deps.path ?? ACCOUNT_USAGE_REFRESH_PATH;
  const running = inProcess.get(path);
  if (running) return running;
  const p = gatedRefresh(path, deps).finally(() => inProcess.delete(path));
  inProcess.set(path, p);
  return p;
}

async function gatedRefresh(path: string, deps: RefreshDeps): Promise<RefreshOutcome> {
  const now = deps.now ?? Date.now;
  const lock = await acquireLock(`${path}.lock`, 0, 5 * 60_000);
  if (!lock) {
    const { state } = readRefreshState(path);
    return { outcome: "busy", usage: asUsage(state.lastReading), nextAllowedAt: state.nextAllowedAt, reason: "probe_in_progress" };
  }
  try {
    const { state, corrupt } = readRefreshState(path);
    if (corrupt) return { outcome: "failed", usage: null, nextAllowedAt: null, reason: "state_corrupt" };
    // 上一进程探测到一半就没了（崩溃 / 重启）：按失败记退避，并只回收它记下的那份资源
    if (state.inFlight) {
      if (state.inFlight.probe) await deps.probe.cleanup(state.inFlight.probe);
      markFailed(state, state.inFlight.startedAt, "interrupted");
      save(path, state);
    }
    if (state.nextAllowedAt !== null && now() < state.nextAllowedAt) {
      return { outcome: "backoff", usage: asUsage(state.lastReading), nextAllowedAt: state.nextAllowedAt, reason: state.lastFailureReason };
    }
    return await probeOnce(path, state, deps, now);
  } finally {
    lock.release();
  }
}

async function probeOnce(path: string, state: RefreshState, deps: RefreshDeps, now: () => number): Promise<RefreshOutcome> {
  const startedAt = now();
  state.lastAttemptAt = startedAt;
  state.inFlight = { startedAt, pid: process.pid, probe: null };
  save(path, state);
  let result: ProbeResult;
  try {
    result = await deps.probe.run((r) => {
      state.inFlight = { startedAt, pid: process.pid, probe: r };
      save(path, state);
    });
  } catch (e) {
    result = { ok: false, reason: `probe_error: ${(e as Error).message}`.slice(0, 200) };
  }
  if (result.ok) {
    state.inFlight = null;
    state.lastFailureAt = null;
    state.lastFailureReason = null;
    state.nextAllowedAt = null;
    state.lastReading = storedReading(result.usage);
    save(path, state);
    // 面板原文不出闸：不落盘也不随响应发出去，只留来源标记
    const usage: AccountUsage = { ...result.usage, raw: MANUAL_RAW, source: "manual", stale: false, reason: null };
    return { outcome: "refreshed", usage, nextAllowedAt: null, reason: null };
  }
  markFailed(state, now(), result.reason);
  save(path, state);
  return { outcome: "failed", usage: asUsage(state.lastReading), nextAllowedAt: state.nextAllowedAt, reason: result.reason };
}

function markFailed(state: RefreshState, at: number, reason: string): void {
  state.inFlight = null;
  state.lastFailureAt = at;
  state.lastFailureReason = reason;
  state.nextAllowedAt = at + MANUAL_REFRESH_BACKOFF_MS;
}

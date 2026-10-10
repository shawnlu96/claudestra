/**
 * bridge 存活探测（docs/architecture/bridge-watchdog.md）：launchd 的 KeepAlive 只在进程退出时拉起，
 * 进程活着但不干活（本机接口不应答、中继一直连不上且重连不前进）没人管。launcher 每轮体检调一次 tickBridgeWatchdog。
 * 判定是纯函数（observeRound / decideRound）；探测、重启、记录、通知都经 WatchdogDeps 注入，tests/bridge-watchdog.test.ts。
 * 不放在 bridge 进程里：卡住的进程查不了自己。
 */
import { CONFIG_PATH } from "./paths.js";
import { readJsonStateSync } from "./state-file.js";
import { deployLockPath, holderLiveness, readDeployLock } from "./pm-deploy-lock.js";
import { bridgePortOf } from "./bridge-port.js";
import { DEFAULT_BRIDGE_PORT } from "./bridge-url.js";
import { notify } from "./notify.js";
import { t } from "./i18n.js";

/** config.json 的键；缺省 / 坏值 = observe */
const WATCHDOG_CONFIG_KEY = "bridgeWatchdog";
export type WatchdogMode = "on" | "observe" | "off";
type StuckReason = "api" | "relay";

export const WATCHDOG_LIMITS = {
  probeTimeoutMs: 5_000,
  /** bridge 进程（按 PID 认）起来后这么久不判 */
  graceMs: 2 * 60_000,
  /** 接口连续失败这么多次判卡住 */
  apiFailures: 4,
  /** 中继连不上且重连状态不变满这么久判卡住 */
  relayStuckMs: 10 * 60_000,
  restartGapMs: 15 * 60_000,
  restartWindowMs: 60 * 60_000,
  /** 1 小时窗口里已重启这么多次，再卡住只报警 */
  maxRestartsPerWindow: 3,
  /** 同一原因的通知（observe 的「本该重启」、on 的报警）至少隔这么久 */
  notifyEveryMs: 60 * 60_000,
} as const;

export function parseWatchdogMode(raw: unknown): WatchdogMode {
  return raw === "on" || raw === "off" || raw === "observe" ? raw : "observe";
}

/** GET /relay/status 里判定要用的字段（relayInfo，src/bridge/relay-link.ts） */
export interface RelaySnapshot {
  enabled: boolean;
  connected: boolean;
  state: string | null;
  retryAt: number | null;
}

export type ProbeResult = { ok: true; relay: RelaySnapshot } | { ok: false; error: string };

export interface WatchdogState {
  pid: number | null;
  /** 当前 PID 第一次被看到的时间 = 启动宽限起点 */
  pidSince: number;
  apiFails: number;
  lastApiError: string | null;
  lastApiOkAt: number | null;
  /** 中继 enabled 且未连上的起点；连上 / 未启用 = null */
  relayDownSince: number | null;
  /** 重连状态签名（state|retryAt）与它最近一次变化的时间：签名在变 = 重连在前进 */
  relaySig: string | null;
  relaySigSince: number;
  lastRelayOkAt: number | null;
  restarts: number[];
  notifiedAt: Partial<Record<string, number>>;
}

export function initialWatchdogState(): WatchdogState {
  return {
    pid: null, pidSince: 0, apiFails: 0, lastApiError: null, lastApiOkAt: null,
    relayDownSince: null, relaySig: null, relaySigSince: 0, lastRelayOkAt: null, restarts: [], notifiedAt: {},
  };
}

export type Verdict = { stuck: false } | { stuck: true; reason: StuckReason; detail: string; lastOkAt: number | null };

function clearCounters(s: WatchdogState, reason?: StuckReason): WatchdogState {
  const api = { apiFails: 0, lastApiError: null };
  const relay = { relayDownSince: null, relaySig: null, relaySigSince: 0 };
  if (reason === "api") return { ...s, ...api };
  if (reason === "relay") return { ...s, ...relay };
  return { ...s, ...api, ...relay };
}

/**
 * 中继卡住：enabled、未连上满 10 分钟，且重连状态机不前进。relay-client 的重连循环是
 * offline(retryAt=未来) → 到点 open() 变 connecting(retryAt=null) → 失败回 offline(新 retryAt)，正常重连时签名几分钟内必变
 * （退避上限 30 秒，致命错误 5 分钟）。签名 10 分钟不变、且不是在等一个未来的 retryAt，才算不前进。
 * state 为 null（没有客户端）/ closed（主动关闭）不判：宁可漏报。
 */
function relayStuck(s: WatchdogState, r: RelaySnapshot, now: number): boolean {
  if (!r.enabled || r.connected || s.relayDownSince === null) return false;
  if (r.state !== "connecting" && r.state !== "offline") return false;
  if (r.retryAt !== null && r.retryAt > now) return false;
  const L = WATCHDOG_LIMITS.relayStuckMs;
  return now - s.relayDownSince >= L && now - s.relaySigSince >= L;
}

function trackRelay(s: WatchdogState, r: RelaySnapshot, now: number): WatchdogState {
  if (!r.enabled || r.connected) {
    return { ...s, relayDownSince: null, relaySig: null, relaySigSince: 0, lastRelayOkAt: r.connected ? now : s.lastRelayOkAt };
  }
  const sig = `${r.state}|${r.retryAt}`;
  const moved = sig !== s.relaySig;
  return { ...s, relayDownSince: s.relayDownSince ?? now, relaySig: sig, relaySigSince: moved ? now : s.relaySigSince };
}

/** 吃进一轮观测（bridge PID + 探测结果），给出新状态与判定 */
export function observeRound(prev: WatchdogState, pid: number, probe: ProbeResult, now: number): { state: WatchdogState; verdict: Verdict } {
  let s = prev;
  if (pid !== s.pid) s = { ...clearCounters(s), pid, pidSince: now }; // 部署 / 重启换了进程：计数清零、重新宽限
  if (probe.ok) s = trackRelay({ ...s, apiFails: 0, lastApiError: null, lastApiOkAt: now }, probe.relay, now);
  else s = { ...s, apiFails: s.apiFails + 1, lastApiError: probe.error };
  if (now - s.pidSince < WATCHDOG_LIMITS.graceMs) return { state: s, verdict: { stuck: false } };
  if (s.apiFails >= WATCHDOG_LIMITS.apiFailures) {
    const detail = `本机接口连续 ${s.apiFails} 次无响应（${s.lastApiError ?? "?"}）`;
    return { state: s, verdict: { stuck: true, reason: "api", detail, lastOkAt: s.lastApiOkAt } };
  }
  if (probe.ok && relayStuck(s, probe.relay, now)) {
    const mins = Math.round((now - s.relayDownSince!) / 60_000);
    const detail = `中继已 ${mins} 分钟未连上且重连没有前进（state=${probe.relay.state}, retryAt=${probe.relay.retryAt ?? "null"}）`;
    return { state: s, verdict: { stuck: true, reason: "relay", detail, lastOkAt: s.lastRelayOkAt } };
  }
  return { state: s, verdict: { stuck: false } };
}

export type WatchdogAction = "none" | "restart" | "cooldown" | "alarm" | "observe";

/**
 * 判定 → 动作。判过一次就清掉该原因的计数：下一次要重新攒满（4 次失败 / 10 分钟），不会每轮都报。
 * notify = 这次要不要发通知（observe 的「本该重启」与报警按原因每小时最多一次；重启每次都发）。
 */
export function decideRound(prev: WatchdogState, verdict: Verdict, mode: WatchdogMode, now: number): { state: WatchdogState; action: WatchdogAction; notify: boolean } {
  if (!verdict.stuck || mode === "off") return { state: prev, action: "none", notify: false };
  const L = WATCHDOG_LIMITS;
  const restarts = prev.restarts.filter((at) => now - at < L.restartWindowMs);
  let s: WatchdogState = { ...clearCounters(prev, verdict.reason), restarts };
  const throttled = (key: string) => {
    const last = s.notifiedAt[key];
    if (last !== undefined && now - last < L.notifyEveryMs) return false;
    s = { ...s, notifiedAt: { ...s.notifiedAt, [key]: now } };
    return true;
  };
  if (mode === "observe") return { action: "observe", notify: throttled(`observe:${verdict.reason}`), state: s };
  const last = restarts.at(-1);
  if (last !== undefined && now - last < L.restartGapMs) return { state: s, action: "cooldown", notify: false };
  if (restarts.length >= L.maxRestartsPerWindow) return { action: "alarm", notify: throttled(`alarm:${verdict.reason}`), state: s };
  return { state: { ...s, restarts: [...restarts, now] }, action: "restart", notify: true };
}

export interface WatchdogDeps {
  mode(): WatchdogMode;
  /** deploy-full 等部署正在跑（持有整机部署锁） */
  deployRunning(): boolean;
  /** launchd 里 bridge 的 PID；查不到 / 没在跑 = null（launchd 自己会拉起，这里不管） */
  bridgePid(): Promise<number | null>;
  probe(): Promise<ProbeResult>;
  restart(): Promise<void>;
  log(line: string): void;
  notify(text: string): Promise<void>;
  now(): number;
}

const fmtTime = (at: number | null) => (at === null ? t("无记录", "never") : new Date(at).toISOString());

function noticeText(action: WatchdogAction, v: Extract<Verdict, { stuck: true }>, restartError?: string): string {
  const n = WATCHDOG_LIMITS.maxRestartsPerWindow;
  const tail = t(`原因：${v.detail}；最后一次正常：${fmtTime(v.lastOkAt)}`, `Reason: ${v.detail}; last healthy: ${fmtTime(v.lastOkAt)}`);
  const head = restartError
    ? t(`⚠️ bridge 卡住，自动重启失败（${restartError}）。`, `⚠️ Bridge stuck; automatic restart failed (${restartError}). `)
    : action === "restart"
      ? t("🔁 bridge 卡住，已自动重启。", "🔁 Bridge was stuck and has been restarted automatically. ")
      : action === "alarm"
        ? t(`🚨 bridge 卡住，1 小时内已自动重启 ${n} 次，不再重启，请人工处理。`, `🚨 Bridge stuck; restarted ${n} times within an hour already, not restarting again. `)
        : t("👀 bridge 卡住，本该重启（observe 模式，未重启）。", "👀 Bridge stuck; would have restarted (observe mode, no restart). ");
  return head + tail;
}

/** 一轮：off 不探测；部署中跳过；查 PID → 探测 → 判定 → 执行 */
export async function runWatchdogRound(prev: WatchdogState, deps: WatchdogDeps): Promise<{ state: WatchdogState; action: WatchdogAction | "skipped" }> {
  const mode = deps.mode();
  if (mode === "off") return { state: prev, action: "skipped" };
  if (deps.deployRunning()) return { state: prev, action: "skipped" };
  const pid = await deps.bridgePid();
  if (pid === null) return { state: { ...clearCounters(prev), pid: null }, action: "skipped" };
  const now = deps.now();
  const seen = observeRound(prev, pid, await deps.probe(), now);
  const out = decideRound(seen.state, seen.verdict, mode, now);
  const v = seen.verdict;
  if (!v.stuck || out.action === "none") return { state: out.state, action: out.action };
  let restartError: string | undefined;
  if (out.action === "restart") {
    try {
      await deps.restart();
    } catch (e) {
      restartError = (e as Error).message;
    }
  }
  const label = { restart: "已重启", cooldown: "距上次重启不足 15 分钟，本次不重启", alarm: "重启过多，只报警", observe: "本该重启（observe）", none: "" }[out.action];
  deps.log(`🩺 bridge 卡住[${v.reason}] ${label}${restartError ? `，重启失败: ${restartError}` : ""}：${v.detail}；最后一次正常 ${fmtTime(v.lastOkAt)}`);
  if (out.notify) await deps.notify(noticeText(out.action, v, restartError)).catch((e) => deps.log(`🩺 通知失败: ${(e as Error).message}`));
  return { state: out.state, action: out.action };
}

// ── 生产依赖 ────────────────────────────────────────────────────────

const BRIDGE_LABEL = "com.claudestra.bridge";

async function launchctl(args: string[]): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(["launchctl", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, out: out || err };
}

/** `launchctl list <label>` 输出里的 "PID" = 123; */
export function parseLaunchctlPid(out: string): number | null {
  const m = /"PID"\s*=\s*(\d+)\s*;/.exec(out);
  return m ? Number(m[1]) : null;
}

function realWatchdogDeps(bridgeUrl: string, chatId: string): WatchdogDeps {
  const port = bridgePortOf(bridgeUrl) ?? DEFAULT_BRIDGE_PORT;
  const target = `gui/${process.getuid?.() ?? 0}/${BRIDGE_LABEL}`;
  return {
    mode: () => {
      const r = readJsonStateSync(CONFIG_PATH);
      return parseWatchdogMode(r.status === "ok" ? (r.data as Record<string, unknown> | null)?.[WATCHDOG_CONFIG_KEY] : undefined);
    },
    deployRunning: () => {
      const r = readDeployLock(deployLockPath());
      return r.status === "ok" && holderLiveness(r.record) !== "dead";
    },
    bridgePid: async () => {
      const r = await launchctl(["list", BRIDGE_LABEL]).catch(() => null);
      return r && r.code === 0 ? parseLaunchctlPid(r.out) : null;
    },
    probe: async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/relay/status`, { signal: AbortSignal.timeout(WATCHDOG_LIMITS.probeTimeoutMs) });
        if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
        const j = (await res.json()) as Record<string, unknown>;
        const retryAt = typeof j.retryAt === "number" ? j.retryAt : null;
        return { ok: true, relay: { enabled: j.enabled === true, connected: j.connected === true, state: typeof j.state === "string" ? j.state : null, retryAt } };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
    restart: async () => {
      const r = await launchctl(["kickstart", "-k", target]);
      if (r.code !== 0) throw new Error(r.out.trim() || `exit ${r.code}`);
      await Bun.sleep(8_000); // 通知走 bridge：等新进程起来再发，否则只落进 undelivered-alerts.log
    },
    log: (line) => console.log(line),
    notify: async (text) => {
      await notify({ source: "launcher", chatId, text });
    },
    now: () => Date.now(),
  };
}

let current = initialWatchdogState();
let inFlight = false;
let realDeps: WatchdogDeps | null = null;

/** launcher 主循环每轮调一次（不 await）：上一轮还没完（探测超时 / 重启等待中）就跳过本轮 */
export async function tickBridgeWatchdog(bridgeUrl: string, chatId: string): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    realDeps ??= realWatchdogDeps(bridgeUrl, chatId);
    current = (await runWatchdogRound(current, realDeps)).state;
  } catch (e) {
    console.error("bridge 存活探测异常:", e);
  } finally {
    inFlight = false;
  }
}

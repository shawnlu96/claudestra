/**
 * 开发者模式的事件环 + 计数器。纯逻辑,无 DOM。
 *
 * 前端所有打点走 lib/client-log 的 postClientLog,它同时把每条日志 **双写** 到这里——
 * 开发者模式下面板的「最近事件」直接显示,不再出现「线上只有日志、本地只有临时浮层」
 * 两套代码。开关关着时 devEvent 只是往环里 push 一条(200 条上限),开销可忽略。
 *
 * 计数器给「每秒发生几次」类指标用:消息气泡重渲染、store produce、long task…
 * 面板每秒读一次差值。
 */

export type DevEvent = { t: number; kind: string; msg: string };

export const DEV_EVENT_CAP = 200;
const MSG_CAP = 2000;

const ring: DevEvent[] = [];
const listeners = new Set<() => void>();
let seq = 0;

function notify() {
  for (const l of listeners) l();
}

/** 记一条事件。kind 是短标签(error / slide / commits / log / ...)。 */
export function devEvent(kind: string, msg: string, t: number = Date.now()): void {
  ring.push({ t, kind, msg: msg.length > MSG_CAP ? `${msg.slice(0, MSG_CAP)}…` : msg });
  if (ring.length > DEV_EVENT_CAP) ring.splice(0, ring.length - DEV_EVENT_CAP);
  seq++;
  notify();
}

/**
 * client.log 一行 → 事件环的 kind:`[tag] …` 的 tag 就是 kind(shell / pwa / commits / slide…);
 * 壳与 PWA 的运行时错误(`[pwa] error …` / `[shell] unhandledrejection …`)归为 error,面板标红。
 */
export function devEventFromLog(msg: string): void {
  const m = msg.match(/^\[([\w-]+)\]\s*([\s\S]*)$/);
  if (!m) {
    devEvent("log", msg);
    return;
  }
  const tag = m[1].toLowerCase();
  const isError = (tag === "shell" || tag === "pwa") && /^(error|unhandledrejection)\b/.test(m[2]);
  devEvent(isError ? "error" : tag, isError ? `${tag} ${m[2]}` : m[2]);
}

/** 最新的 n 条(最新在后)。 */
export function recentDevEvents(n = 50): DevEvent[] {
  return ring.slice(-n);
}

export function clearDevEvents(): void {
  ring.length = 0;
  seq++;
  notify();
}

/** 单调递增的版本号,给 useSyncExternalStore 当快照(数组本身是可变的)。 */
export function devEventsVersion(): number {
  return seq;
}

export function subscribeDevEvents(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

// ── 计数器 ──

const counters = new Map<string, number>();

/** 累加一个计数器(热路径可调:一次 Map.get + set)。 */
export function bumpCounter(name: string, by = 1): void {
  counters.set(name, (counters.get(name) ?? 0) + by);
}

export function readCounter(name: string): number {
  return counters.get(name) ?? 0;
}

export function allCounters(): Record<string, number> {
  return Object.fromEntries(counters);
}

export function resetCounters(): void {
  counters.clear();
}

/**
 * 「每秒速率」采样器:记住上次读数,返回两次采样之间的差 / 经过的秒数。
 * 面板每个 tick 调一次。
 */
export function makeRateSampler(name: string) {
  let lastV = readCounter(name);
  let lastT: number | null = null;
  return (now: number): number => {
    const v = readCounter(name);
    const dt = lastT === null ? 0 : (now - lastT) / 1000;
    const rate = dt > 0 ? (v - lastV) / dt : 0;
    lastV = v;
    lastT = now;
    return rate;
  };
}

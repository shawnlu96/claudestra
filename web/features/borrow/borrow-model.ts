/**
 * 借入面板的纯函数（tests/web-borrow-model.test.ts）：hello 年龄与分档、peer 三态、排序、按钮能不能点。
 * 年龄由调用方传入的 tick 算，渲染里不读时钟；服务端与本机的时钟差靠「服务端 now + 拿到之后过了多久」抵掉。
 */
import type { BorrowView, PeerView, RemoteRow } from "./borrow-api";

/** 与 bridge 的 HELLO_FRESH_MS 同值：超过它 peerCapacity 就按 0 位算 */
export const HELLO_FRESH_SEC = 180;
export const POLL_MS = 15_000;

/** hello 距今几秒；没有 hello → null。now 是拿到数据时服务端的时间，receivedAt / tick 是本机时间 */
export function helloAgeSec(helloAt: number | null, serverNow: number, receivedAt: number, tick: number): number | null {
  if (helloAt === null) return null;
  return Math.max(0, Math.floor((serverNow + Math.max(0, tick - receivedAt) - helloAt) / 1000));
}

export type AgeBand = "none" | "fresh" | "aging" | "stale";
export function ageBand(sec: number | null): AgeBand {
  if (sec === null) return "none";
  if (sec >= HELLO_FRESH_SEC) return "stale";
  return sec >= HELLO_FRESH_SEC / 2 ? "aging" : "fresh";
}

/** 年龄的显示单位：秒 / 分 / 时（字典里各一条） */
export function ageParts(sec: number): { n: number; unit: "s" | "m" | "h" } {
  if (sec < 60) return { n: sec, unit: "s" };
  if (sec < 3600) return { n: Math.floor(sec / 60), unit: "m" };
  return { n: Math.floor(sec / 3600), unit: "h" };
}

/**
 * push = proto 2 且此刻能放；poll = proto 1（只轮询，按老规则只在本机满时接审查，不参与平均分配，不是故障）；
 * down = proto 2 但此刻 0 位（why 说明原因）；unknown = 台账里还没有 lend 表
 */
export type PeerState = "push" | "poll" | "down" | "unknown";
export function peerState(p: Pick<PeerView, "capacity">): PeerState {
  const c = p.capacity;
  if (!c) return "unknown";
  if (c.proto < 2) return "poll";
  return c.why === null ? "push" : "down";
}

const STATE_ORDER: Record<PeerState, number> = { push: 0, poll: 1, down: 2, unknown: 3 };
export function sortPeers(peers: readonly PeerView[]): PeerView[] {
  return [...peers].sort((a, b) => STATE_ORDER[peerState(a)] - STATE_ORDER[peerState(b)] || a.peer.localeCompare(b.peer));
}

const STATUS_ORDER: Record<string, number> = { claimed: 0, pooled: 1, unknown: 2 };
export function sortRemote(rows: readonly RemoteRow[]): RemoteRow[] {
  return [...rows].sort((a, b) => a.peer.localeCompare(b.peer) || (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) || a.orderId.localeCompare(b.orderId));
}

/** 上报的空闲位（total − busy）；没有 hello → null */
export function reportedFree(p: Pick<PeerView, "reported">, f: "codex" | "claude"): number | null {
  const s = p.reported?.[f];
  return s ? Math.max(0, s.total - s.busy) : null;
}

/** 切换一个项目：至少留一个（borrow set 不收空列表），留下的按可选项目的顺序排 */
export function toggleProject(cur: readonly string[], id: string, order: readonly string[]): string[] {
  const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
  return order.filter((x) => next.includes(x)).concat(next.filter((x) => !order.includes(x)));
}
export const canToggleOff = (cur: readonly string[], id: string): boolean => !cur.includes(id) || cur.length > 1;

export const clampMaxOpen = (n: number, limit: number): number => Math.min(limit, Math.max(1, Math.round(n)));

/** 还没借入、可以加的联系人 */
export function addableContacts(v: Pick<BorrowView, "borrow">): string[] {
  const used = new Set(v.borrow.declared.map((e) => e.peer));
  return v.borrow.contacts.filter((c) => !used.has(c));
}

/** 新加一条能不能提交：选了至少一个项目、maxOpen 在范围内 */
export const canSubmitNew = (projects: readonly string[], maxOpen: number, limit: number): boolean =>
  projects.length > 0 && Number.isInteger(maxOpen) && maxOpen >= 1 && maxOpen <= limit;

/** 输入框里的上限：全角数字也认；空 / 非整数 → null（退回原值、不存）；越界夹到 1..limit 并标 clamped（界面抖一下） */
export function parseMaxOpen(raw: string, limit: number): { value: number; clamped: boolean } | null {
  const s = raw.trim().replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  const value = clampMaxOpen(n, limit);
  return { value, clamped: value !== n };
}

/** 对方能同时接的总单数：各家族上报的 total 相加（我方上限管派给这个 peer 的总单数，不分家族）；没上报 → null */
export function grantedSlots(p: Pick<PeerView, "reported">): number | null {
  const r = p.reported;
  return r ? Object.values(r).reduce((sum, s) => sum + s.total, 0) : null;
}

/** 「对方只开了 M 个」：对方名额小于我方上限才给 M；不小于或没上报 → null（不显示） */
export function lenderCap(p: Pick<PeerView, "reported">, maxOpen: number): number | null {
  const m = grantedSlots(p);
  return m !== null && m < maxOpen ? m : null;
}

type TimerId = ReturnType<typeof setTimeout>;
export interface Timers { set: (fn: () => void, ms: number) => TimerId; clear: (id: TimerId) => void }
const REAL_TIMERS: Timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (id) => clearTimeout(id) };

/**
 * 连点合并成一次保存：每次 push 重新计时，停手 ms 后只把最后一个值交给 fire。
 * flush 立刻交出还没交的值（卸载、改用输入框前），cancel 丢掉。timers 可换成假时钟（tests/web-borrow-model.test.ts）。
 */
export interface Coalescer<T> { push: (v: T) => void; flush: () => void; cancel: () => void }
export function coalescer<T>(ms: number, fire: (v: T) => void, timers: Timers = REAL_TIMERS): Coalescer<T> {
  let pending: { v: T } | null = null;
  let id: TimerId | null = null;
  const stop = () => {
    if (id !== null) timers.clear(id);
    id = null;
  };
  const run = () => {
    stop();
    const p = pending;
    pending = null;
    if (p) fire(p.v);
  };
  return {
    push(v: T) {
      pending = { v };
      stop();
      id = timers.set(run, ms);
    },
    flush: run,
    cancel() {
      stop();
      pending = null;
    },
  };
}

/**
 * 同一 peer 的保存串行：一次只在飞一个，后提交的等前一个写完再写；还在排队就被更新的值顶掉的直接跳过。
 * 所以 lend.json 里最后落下的一定是最后提交的值（微调 flush 出的旧值不会盖掉随后输入的新值）。
 * write 自己处理失败；isLatest() 告诉它此刻是否仍是最后一次提交（只有最后一次收尾时清 draft / busy）。
 */
export function serialLatest<T>(write: (v: T, isLatest: () => boolean) => Promise<void>): (v: T) => Promise<void> {
  let tail: Promise<void> = Promise.resolve();
  let seq = 0;
  return (v) => {
    const my = ++seq;
    const isLatest = () => my === seq;
    // write 抛出也不能让队列断掉，否则之后的保存永远不跑；失败反馈由 write 自己做（抖动 + 回弹）
    tail = tail.then(() => (isLatest() ? write(v, isLatest) : undefined)).catch((e) => console.warn("[borrow] 保存失败", e));
    return tail;
  };
}

/** 把带 {box} 的整句拆成框前、框后两段：数字框嵌在句中，语序随语言变（英文的框在句中间） */
export const BOX = "\u0000";
export function splitAtBox(text: string): [string, string] {
  const i = text.indexOf(BOX);
  return i < 0 ? [text, ""] : [text.slice(0, i).trimEnd(), text.slice(i + 1).trimStart()];
}

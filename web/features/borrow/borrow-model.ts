/**
 * 借入面板的纯函数（tests/web-borrow-model.test.ts）：hello 年龄与分档、peer 三态、排序、按钮能不能点。
 * 年龄由调用方传入的 tick 算，渲染里不读时钟；服务端与本机的时钟差靠「服务端 now + 拿到之后过了多久」抵掉。
 */
import type { BorrowView, DroppedCode, Family, PeerView, PlacementView, Priority, QuotaReport, RemoteRow, Role } from "./borrow-api";

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

export const clampMaxOpen = (n: number, limit: number, min = 1): number => Math.min(limit, Math.max(min, Math.round(n)));

/** 失效原因：整条的（联系人删了 / 禁用 / 换实例）沿用 bridge 的码；联系人还在、声明的项目全失效 = projects_gone */
export type StaleReason = Exclude<DroppedCode, "project_gone" | "personal"> | "projects_gone";
export interface StalePeer { peer: string; reason: StaleReason; maxOpen: number; canRepick: boolean }

/**
 * 声明了、但没有生效的借入：一条不漏（effective 里没有它就算），每条都能删；联系人仍有效的还能重选项目。
 * 按声明顺序；tests/web-borrow-model.test.ts 覆盖「全部项目失效」
 */
export function stalePeers(v: Pick<BorrowView, "borrow">): StalePeer[] {
  const live = new Set(v.borrow.effective.map((e) => e.peer));
  return v.borrow.declared.filter((e) => !live.has(e.peer)).map((e) => {
    const whole = v.borrow.dropped.find((d) => d.peer === e.peer && !d.project);
    const reason: StaleReason = whole ? (whole.code as StaleReason) : "projects_gone";
    return { peer: e.peer, reason, maxOpen: e.maxOpen, canRepick: !whole && v.borrow.contacts.includes(e.peer) };
  });
}

/** 放置结果的形态：local 本机 / peer 挂给对方 / wait 等着 / none 这一阶段不放置；算不出或老 bridge → null（不显示） */
export type PlacementKind = "local" | "peer" | "wait" | "none";
export function placementKind(p: PlacementView | undefined): PlacementKind | null {
  if (!p || "error" in p) return null;
  if (p.where === "-") return "none";
  if (p.reason.startsWith("等：")) return "wait";
  return p.where === "local" ? "local" : "peer";
}

/** 还没借入、可以加的联系人 */
export function addableContacts(v: Pick<BorrowView, "borrow">): string[] {
  const used = new Set(v.borrow.declared.map((e) => e.peer));
  return v.borrow.contacts.filter((c) => !used.has(c));
}

/** 新加一条能不能提交：选了至少一个项目、maxOpen 在范围内 */
export const canSubmitNew = (projects: readonly string[], maxOpen: number, limit: number): boolean =>
  projects.length > 0 && Number.isInteger(maxOpen) && maxOpen >= 1 && maxOpen <= limit;

/** 输入框里的上限：全角数字也认；空 / 非整数 → null（退回原值、不存）；越界夹到 1..limit 并标 clamped（界面抖一下） */
export function parseMaxOpen(raw: string, limit: number, min = 1): { value: number; clamped: boolean } | null {
  const s = raw.trim().replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  const value = clampMaxOpen(n, limit, min);
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

/**
 * 一张卡同时只做一件写（存 / 删）：在途时再来的直接忽略（返回 false），不排队、不合并，返回后由调用方用服务端的值刷新。
 * 按钮在 busy 时已禁用，这里再挡一次同一帧里的连击。tests/web-borrow-machine.test.ts
 */
export function oneAtATime(onBusy: (busy: boolean) => void): (job: () => Promise<void>) => Promise<boolean> {
  let busy = false;
  return async (job) => {
    if (busy) return false;
    busy = true;
    onBusy(true);
    try {
      await job();
    } finally {
      busy = false;
      onBusy(false);
    }
    return true;
  };
}

/** 把带 {box} 的整句拆成框前、框后两段：数字框嵌在句中，语序随语言变（英文的框在句中间） */
export const BOX = "\u0000";
export function splitAtBox(text: string): [string, string] {
  const i = text.indexOf(BOX);
  return i < 0 ? [text, ""] : [text.slice(0, i).trimEnd(), text.slice(i + 1).trimStart()];
}

/* ---- 分配表（i28-Q1，tests/web-borrow-alloc.test.ts） ---- */

/** 本机项目上限的范围（scheduler.json maxActiveWorkers 0..32；0 = 本机不接） */
export const LOCAL_MAX = 32;

/** 老 bridge 没有 priority / roles：按缺省（平分、只审查）显示 */
export const peerPriority = (p: Pick<PeerView, "priority">): Priority => p.priority ?? "balance";
export const peerRoles = (p: Pick<PeerView, "roles">): Role[] => (p.roles ?? ["review"]).filter((r): r is Role => r === "review" || r === "write");

/** 勾 / 取消一个角色：至少留一个（borrow set 不收空列表）→ 留空返回 null；顺序固定审查在前 */
export function toggleRole(cur: readonly Role[], r: Role): Role[] | null {
  const next = cur.includes(r) ? cur.filter((x) => x !== r) : [...cur, r];
  if (!next.length) return null;
  return (["review", "write"] as const).filter((x) => next.includes(x));
}

/** 哪些项目的 reviewFirst 点名了这台 peer：审查单先给它，压过档位（scheduler-placement.ts），面板标出来 */
export function reviewFirstFor(view: Pick<BorrowView, "projects">, peer: string): boolean {
  return view.projects.some((p) => p.reviewFirst?.includes(peer));
}

/** 一家的本周已用；没有 / 已过重置时刻 = null（显示「—」） */
export function weekUsed(q: QuotaReport | null | undefined, f: Family, now: number): { pct: number; resetAt: number } | null {
  const w = q?.[f];
  return w && w.resetAt > now ? { pct: w.weekUsedPct, resetAt: w.resetAt } : null;
}

/** 重置还有多久：≥ 1 天按天，否则按小时（至少 1） */
export function resetIn(resetAt: number, now: number): { n: number; unit: "d" | "h" } {
  const h = Math.max(1, Math.ceil((resetAt - now) / 3_600_000));
  return h >= 24 ? { n: Math.floor(h / 24), unit: "d" } : { n: h, unit: "h" };
}

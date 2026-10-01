/**
 * 出借方管理面的纯函数（tests/web-lend-model.test.ts）：表单缺省与上限、请求体、授权状态、借出单状态（含收回后的「停止中」与 70 秒告警）、
 * notices → 时间线。规则（until 上限、名额范围、write）由 bridge 转给 W1 的 CLI 判，这里只决定界面怎么摆、请求体长什么样。
 * 「已停」只认 journal 的终态：收回后单子还 live、或这一轮列表里找不到，都还是停止中。
 */

export interface GrantView {
  peer: string; repos: string[]; roles: string[]; families: Record<string, number>; ordersPerDay: number;
  until: string | null; grantedAt: string | null; paused: string | null; problem: string | null;
}
export interface NoticesView { start?: number; end?: { kind: string; why: string | null; sentAt: number | null } }
export interface OrderView {
  orderId: string; peer: string; family: string; state: string; repo: string | null; pr: number | null; taskId: string | null; step: string | null;
  agent: string | null; startedAt: number | null; updatedAt: number; reason: string | null; notices: NoticesView | null;
  /** bridge 按 W1 的 LIVE_STATES 判好的；这里不再抄一份状态表 */
  live: boolean;
}
export interface LendData {
  writeOpen: boolean; maxDays: number; shellSentence: string; grants: GrantView[]; peers: { name: string; fp: string }[]; orders: OrderView[];
}

export const DEFAULT_CODEX = 5;
export const DEFAULT_PER_DAY = 200;
export const DAY_CHOICES = [1, 3, 7] as const;
/** 收回后这么久还 live = 两个调度 pass 加看门狗都没停下来，换告警图标 */
export const STUCK_MS = 70_000;
export const STOPPING_POLL_MS = 2_000;

export const isLive = (o: Pick<OrderView, "live">): boolean => o.live;

export interface GrantForm { peer: string; repos: string[]; codex: number; ordersPerDay: number; days: number }

/** 到期档位：1 / 3 / 7 天里不超过服务端 maxDays 的；maxDays 比 1 还小就只给 maxDays 一档 */
export function dayChoices(maxDays: number): number[] {
  const ok = DAY_CHOICES.filter((d) => d <= maxDays);
  return ok.length ? ok : [Math.max(1, Math.floor(maxDays))];
}

/** 新表单缺省（codex 5、每日 200、最长那一档）；从暂停条目「重新授权」时预填原值，到期仍取缺省档 */
export function formDefaults(maxDays: number, peers: readonly { name: string }[], from?: GrantView): GrantForm {
  const days = dayChoices(maxDays);
  return {
    peer: from?.peer ?? peers[0]?.name ?? "",
    repos: from ? [...from.repos] : [],
    codex: from?.families.codex ?? DEFAULT_CODEX,
    ordersPerDay: from?.ordersPerDay ?? DEFAULT_PER_DAY,
    days: days[days.length - 1],
  };
}

/** 加一个仓库：去空白、去重；逗号 / 空白分隔的一次加多个 */
export function addRepos(list: readonly string[], input: string): string[] {
  const out = [...list];
  for (const r of input.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean)) if (!out.includes(r)) out.push(r);
  return out;
}

/** 请求体：角色不带（bridge 固定 review），write 无从出现；到期按「N 天」交给 CLI 以它的时钟算 */
export function grantBody(f: GrantForm, maxDays: number): { peer: string; repos: string[]; codex: number; ordersPerDay: number; until: string } {
  const days = Math.min(f.days, Math.max(1, Math.floor(maxDays)));
  return { peer: f.peer, repos: [...f.repos], codex: f.codex, ordersPerDay: f.ordersPerDay, until: `${days}d` };
}

export const canSubmit = (f: GrantForm): boolean => !!f.peer && f.repos.length > 0 && f.codex > 0 && f.ordersPerDay > 0;

export type GrantStatus = "ok" | "paused" | "expired" | "invalid";
export function grantStatus(g: GrantView, now: number): GrantStatus {
  if (g.paused) return "paused";
  if (g.until && Date.parse(g.until) <= now) return "expired";
  return g.problem ? "invalid" : "ok";
}

/** 剩余时间（毫秒，≥0）；没写到期时间 = null */
export const remainingMs = (g: Pick<GrantView, "until">, now: number): number | null =>
  g.until ? Math.max(0, Date.parse(g.until) - now) : null;

export function splitRemaining(ms: number): { d: number; h: number; m: number } {
  const mins = Math.floor(ms / 60_000);
  return { d: Math.floor(mins / 1440), h: Math.floor((mins % 1440) / 60), m: mins % 60 };
}

export type OrderPhase = "waiting" | "running" | "stopping" | "stuck" | "stopped" | "done";

/**
 * stopping：orderId → 点下收回的时刻。journal 进了终态才算停；还 live 的按时长分「停止中」与告警。
 * acked 是正常交付；其余终态（stopped / released / declined / cancelled）都显示「已停」。
 */
export function orderPhase(o: OrderView, stopping: ReadonlyMap<string, number>, now: number): OrderPhase {
  if (!isLive(o)) return o.state === "acked" ? "done" : "stopped";
  const since = stopping.get(o.orderId);
  if (since !== undefined) return now - since >= STUCK_MS ? "stuck" : "stopping";
  return o.state === "asked" ? "waiting" : "running";
}

/** 点下收回就调（快照为空）、成功回包后带快照再调一次：这个 peer 的在跑单从此刻起算停止中（已在停的保留原起点） */
export function markStopping(stopping: ReadonlyMap<string, number>, peer: string | null, snapshot: readonly OrderView[],
  current: readonly OrderView[], now: number): Map<string, number> {
  const next = new Map(stopping);
  for (const o of [...snapshot, ...current]) {
    if (!isLive(o) || (peer !== null && o.peer !== peer) || next.has(o.orderId)) continue;
    next.set(o.orderId, now);
  }
  return next;
}

/** bridge 明确说没收回：撤掉这次点击加上的停止标记（别的收回加的不动） */
export function unmarkStopping(stopping: ReadonlyMap<string, number>, ids: Iterable<string>): Map<string, number> {
  const next = new Map(stopping);
  for (const id of ids) next.delete(id);
  return next;
}

/**
 * 新一轮 GET 回来后合并：列表里看得到的单用新行；收回后在跑、这一轮列表里找不到的单（journal 读到时已过了 7 天窗、或 50 张截断）
 * 保留上一份行——不能凭「不见了」就显示已停。进了终态的停止标记清掉。
 */
export function mergeOrders(prev: readonly OrderView[], fresh: readonly OrderView[], stopping: ReadonlyMap<string, number>):
  { orders: OrderView[]; stopping: Map<string, number> } {
  const seen = new Set(fresh.map((o) => o.orderId));
  const kept = prev.filter((o) => !seen.has(o.orderId) && stopping.has(o.orderId) && isLive(o));
  const orders = [...fresh.filter(isLive), ...kept, ...fresh.filter((o) => !isLive(o))];
  const next = new Map<string, number>();
  for (const o of orders) if (isLive(o) && stopping.has(o.orderId)) next.set(o.orderId, stopping.get(o.orderId)!);
  return { orders, stopping: next };
}

/** 还有停止中的单就每 2 秒拉一次 */
export const needsFastPoll = (stopping: ReadonlyMap<string, number>): boolean => stopping.size > 0;

export type TimelineKind = "start" | "delivered" | "stopped";
export interface TimelineItem { kind: TimelineKind; at: number | null; pending: boolean; why: string | null }

/** notices → 时间线：开跑（play）、交付（check）、停止（square）；end.sentAt 为 null = 通知还没发出、待补发（clock） */
export function timeline(n: NoticesView | null): TimelineItem[] {
  const out: TimelineItem[] = [];
  if (!n) return out;
  if (typeof n.start === "number") out.push({ kind: "start", at: n.start, pending: false, why: null });
  if (n.end) out.push({ kind: n.end.kind === "acked" ? "delivered" : "stopped", at: n.end.sentAt, pending: n.end.sentAt === null, why: n.end.why });
  return out;
}

/** repo#pr；只有 repo 就 repo；都没有 = taskId 或 orderId */
export const orderTitle = (o: OrderView): string => (o.repo ? (o.pr !== null ? `${o.repo}#${o.pr}` : o.repo) : (o.taskId ?? o.orderId));

/** 收回回包里的在跑单并进当前列表（同 orderId 用回包的新行），让它们立刻以「停止中」出现 */
export function withSnapshot(orders: readonly OrderView[], snapshot: readonly OrderView[]): OrderView[] {
  const byId = new Map(snapshot.map((o) => [o.orderId, o]));
  const rest = orders.map((o) => byId.get(o.orderId) ?? o);
  const fresh = snapshot.filter((o) => !orders.some((x) => x.orderId === o.orderId));
  return [...fresh, ...rest];
}

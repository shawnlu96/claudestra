/**
 * 写单发布链的订单守卫：推送 → 开 PR → 落交付正文 → 转给 A，每一步发出前都按这张单现核一次，不沿用本轮开头的结论——
 * 前一步的 await（git / gh / 网络）可能很长，出借方随时可能收回，本机租约截止也可能就在这段工夫里过去。
 * 核三样：授权此刻仍在（lend-grant.ts liveGrant，现读 lend.json 与联系人）、journal 这一行还是开始发布时的那张单
 * （状态、租约代、订单、worker 交的活、交付正文都没变）、本机租约截止没过。顺序是先 await 授权、之后同步读 journal 和时钟，
 * 所以守卫放行到调用方发出动作之间没有别的 I/O。读不到按 unknown 拦：不能把「不知道」当成「仍有权」。
 * 放行的同时把「这个动作已发出」记进 lend_meta（publish-facts:<单号>），端口返回后再记结果；发出之后的收回撤不回已发的请求，
 * 所以这份记录只增不改回：停单原因带上它（publishedNote），交 A / PM 对账。结果不明的推送下一轮先读远端再决定推不推（lend-push.ts）。
 * 记两样、分开存：push / pr 是这个 head 至今最强的那条事实（确认成了 > 发出过结果不明 > 被拒），只升不降——后一次重试被拒或超时
 * 证明不了前一次没成；pushLast / prLast 是最近一次请求自己的结果，和前者不一样时停单原因里另写一句。
 * 已转过一次的交付正文重发取回执不看授权 / 租约（A 可能已入账，lend-drive.ts heartbeat），只核 journal 没变。
 * 结果只记在「这一次调用里确实发出去的那个请求」上：这一轮停在本机准备（取分支、核 head / 祖先）没发出请求，失败再确定也不动
 * 以前记下的「已发出、结果不明」。端口失败之后的收尾同样先核这一行没变（drifted）：旧一代请求的失败不能去停新一代的单。
 * tests/lend-audit-publish.test.ts、tests/lend-audit-publish-ports.test.ts。
 */
import type { Database } from "bun:sqlite";
import type { LendDeps } from "./lend-drive.js";
import { liveGrant } from "./lend-grant.js";
import { getMeta, getOrder, setMeta, type LendRow } from "./lend-journal.js";
import { ensurePr, probePush, pushWork, type BeforeEffect, type EffectGate, type PublishDenial, type PublishEffect, type PushOpts } from "./lend-push.js";
import { SchedulerStopped } from "./scheduler-maintenance.js";

type GuardDeps = Pick<LendDeps, "db" | "now" | "readLend" | "context">;
/** issued = 请求已发出、结果还不知道；done = 确认成了；refused = 确认没成（远端明确拒了） */
type Mark = "issued" | "done" | "refused";
interface PublishFacts { head: string; branch: string; push?: Mark; pr?: Mark; pushLast?: Mark; prLast?: Mark; prNumber?: number | null; result?: string; at: number }
const RANK: Record<Mark, number> = { refused: 1, issued: 2, done: 3 };
/** 已记下的事实和这一次的结果取强的那个：done 不会被后来的 issued / refused 盖掉，issued 不会被后来的 refused 盖掉 */
const stronger = (kept: Mark | undefined, now: Mark): Mark => (kept && RANK[kept] > RANK[now] ? kept : now);
const live = (m: Mark | undefined): boolean => m === "done" || m === "issued";
/** 最近一次重试的结果和留着的事实不一样（重试被拒 / 结果不明）才另说一句 */
const again = (kept: Mark | undefined, last: Mark | undefined): string =>
  !last || last === kept || last === "done" ? "" : `（最近一次重试${last === "refused" ? "被远端拒绝" : "结果不明"}）`;
type Outcome = { ok: true; pr?: number | null } | { ok: false; retry: boolean; denied?: PublishDenial };

const key = (orderId: string): string => `publish-facts:${orderId}`;

/** 这张单当前这个 head 的发布记录；没有、坏值、是别的 head 的 = null（当没发过：重发前的远端核对和首发核权都照做，只严不松） */
function publishFacts(db: Database, row: Pick<LendRow, "orderId" | "work">): PublishFacts | null {
  const raw = getMeta(db, key(row.orderId));
  if (!raw || !row.work) return null;
  try {
    const f = JSON.parse(raw) as PublishFacts;
    return f && f.head === row.work.head ? f : null;
  } catch { return null; /* 坏值当没发过：见上 */ }
}

function note(d: Pick<GuardDeps, "db" | "now">, row: LendRow, patch: Partial<PublishFacts>): void {
  if (!row.work) return;
  const base = publishFacts(d.db, row) ?? { head: row.work.head, branch: row.wire?.write?.branch ?? "", at: d.now() };
  setMeta(d.db, key(row.orderId), JSON.stringify({ ...base, ...patch, at: d.now() }));
}

/** 停单原因后面带上已经发生的远端事实（没有 = 原样）：推过的分支、开了的 PR 不回滚，也不因为之后失权就当没发生 */
export function publishedNote(db: Database, row: LendRow, why: string | null): string | null {
  const f = publishFacts(db, row);
  if (!f || (!live(f.push) && !live(f.pr) && !f.result)) return why;
  const at = `${f.head.slice(0, 12)} → ${f.branch}`;
  // 推送、PR、交付各说各的：哪一样的事实都不靠另一样最近一次成没成才输出
  const push = `${f.push === "done" ? "已推送" : f.push === "issued" ? "推送已发出、结果不明" : "没推上"} ${at}${again(f.push, f.pushLast)}`;
  const pr = (f.pr === "done" && f.prNumber ? `，PR #${f.prNumber} 已开` : f.pr === "issued" ? "，开 PR 的请求已发出、结果不明" : "，没开新 PR") + again(f.pr, f.prLast);
  const sent = f.result ? "，交付已转过" : "，没转交付";
  return `${why ?? ""}（远端已有的不回滚：${push}${pr}${sent}）`;
}

/** 这一行和开始发布时比变了什么：null = 还是那张单。只比决定「发什么、凭什么发」的字段，心跳时刻这类不比 */
function drift(was: LendRow, cur: LendRow | null, effect: PublishEffect): string | null {
  if (!cur) return "journal 里这一行不见了";
  if (cur.state !== "result_pending") return `状态已是 ${cur.state}`;
  if (cur.leaseGen !== was.leaseGen) return `租约代从 ${was.leaseGen} 变成了 ${cur.leaseGen}`;
  if (cur.peer !== was.peer || cur.fp !== was.fp || cur.sessionId !== was.sessionId) return "订单的对方 / 指纹 / 会话变了";
  if (JSON.stringify(cur.wire) !== JSON.stringify(was.wire)) return "订单内容变了";
  if (JSON.stringify(cur.work) !== JSON.stringify(was.work)) return "worker 交的内容变了";
  if (effect !== "result") return cur.payloadSha === null && cur.payload === null ? null : "交付正文已经另有一份";
  return cur.payloadSha === was.payloadSha && JSON.stringify(cur.payload) === JSON.stringify(was.payload) ? null : "交付正文变了";
}

const made = new WeakSet<BeforeEffect>();
/** 是不是 publishGuard 造出来的守卫：生产端口只认这种，手写一个永远放行的函数不算核过权 */
export const isPublishGuard = (g: unknown): g is BeforeEffect => typeof g === "function" && made.has(g as BeforeEffect);

export interface PublishGuard {
  /** 只核不记：端口返回之后、下一步之前用 */
  check: BeforeEffect;
  /** 核过就记「已发出」再放行：交给端口，在真正发出的那条命令之前调 */
  before: BeforeEffect;
  /** 交给推送 / PR 端口的那一份 */
  gate(): EffectGate;
  /** 端口返回后记结果：成了 / 这一次发出的请求被远端明确拒了（只记在这一次头上，不降级以前的事实）；可重试的失败（超时、断网）和这一次根本没发出请求的失败都不改记录 */
  settle(effect: "push" | "pr", r: Outcome): void;
  /** 同步核 journal 这一行还是不是开始发布时的那张单（不看授权 / 租约）：端口失败后记账、停单之前用；null = 没变 */
  drifted(): string | null;
}

/** row = 开始发布时从 journal 读到的这一行；之后每次核对都和它比 */
export function publishGuard(row: LendRow, d: GuardDeps): PublishGuard {
  const check: BeforeEffect = async (effect) => {
    try {
      // 写单的交付正文已经转过一次：重发同一份取回执不再看授权 / 租约；审查单的结论由 worker 自己落的，转交规则不归这里管
      const replay = effect === "result" && (!row.work || publishFacts(d.db, row)?.result === row.payloadSha);
      const grant = replay ? null : await liveGrant(row, d);
      // —— 最后一次 await 之后：以下全是同步读 ——
      const cur = getOrder(d.db, row.orderId);
      const changed = drift(row, cur, effect);
      if (changed) return { kind: "changed", reason: changed };
      if (!grant) return null;
      if (!grant.ok) return { kind: "revoked", reason: grant.problem };
      if (cur!.leaseUntil === null) return { kind: "unknown", reason: "journal 里没有本机租约截止" };
      return d.now() < cur!.leaseUntil ? null : { kind: "expired", reason: "本机租约截止已过" };
    } catch (e) {
      if (e instanceof SchedulerStopped) throw e; // 服务停了 / 失租：照旧往外抛，这一轮整个停
      return { kind: "unknown", reason: `读不到授权或 journal：${(e as Error).message}`.slice(0, 300) };
    }
  };
  const sent = new Set<PublishEffect>(); // 这个守卫（= 这一轮）放行过、确实发出去了的动作
  const prior: { push?: Mark; pr?: Mark } = {}; // 这一轮发出请求之前已经记下的事实：这一轮的结果只能往上盖，不能把它降级
  const outcome = (effect: "push" | "pr", m: Mark, more: Partial<PublishFacts> = {}) =>
    note(d, row, { ...more, [effect]: stronger(prior[effect], m), [`${effect}Last`]: m });
  const before: BeforeEffect = async (effect) => {
    const no = await check(effect);
    if (no) return no;
    sent.add(effect);
    // 先记后发（写不进 = 失租，抛出去，动作不发）；记的是「发出」这件事，结果由 settle 补
    if (effect === "push" || effect === "pr") {
      prior[effect] = publishFacts(d.db, row)?.[effect];
      outcome(effect, "issued");
    } else if (effect === "result" && row.work && row.payloadSha) note(d, row, { result: row.payloadSha });
    return null;
  };
  made.add(before);
  return {
    check, before,
    gate: () => ({ beforeEffect: before, unsettled: publishFacts(d.db, row)?.push === "issued" }),
    settle: (effect, r) => {
      if (r.ok) return outcome(effect, "done", effect === "pr" ? { prNumber: r.pr ?? null } : {});
      // 明确拒绝只算在这一次发出的请求头上：没发出（停在准备阶段）的失败不记；发出了被拒的，也盖不掉以前已确认 / 结果不明的那一次
      if (!r.denied && !r.retry && sent.has(effect)) outcome(effect, "refused");
    },
    drifted: () => drift(row, getOrder(d.db, row.orderId), "push"),
  };
}

type Owned = <T>(fn: () => Promise<T>) => Promise<T>;
const unguarded = () => ({ ok: false as const, retry: false, reason: "发布端口没接到这张单的守卫（lend-publish-guard.ts），不推送、不开 PR" });

/** 生产的推送 / PR 端口（lend-deps.ts）：没带 publishGuard 造的守卫就什么都不做，连推送目录都不建 */
export function publishPorts(owned: Owned, o: PushOpts = {}): LendDeps["push"] {
  const guarded = (gate: EffectGate | undefined): PushOpts | null =>
    isPublishGuard(gate?.beforeEffect) ? { ...o, beforeEffect: gate.beforeEffect, unsettled: gate.unsettled === true } : null;
  return {
    probe: (t) => owned(() => probePush(t, o)),
    work: async (t, gate) => { const g = guarded(gate); return g ? owned(() => pushWork(t, g)) : unguarded(); },
    pr: async (p, gate) => { const g = guarded(gate); return g ? owned(() => ensurePr(p, g)) : unguarded(); },
  };
}

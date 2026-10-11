/**
 * 写单发布链的订单守卫：推送 → 开 PR → 落交付正文 → 转给 A，每一步发出前都按这张单现核一次，不沿用本轮开头的结论——
 * 前一步的 await（git / gh / 网络）可能很长，出借方随时可能收回，本机租约截止也可能就在这段工夫里过去。
 * 核三样：授权此刻仍在（lend-grant.ts liveGrant，现读 lend.json 与联系人）、journal 这一行还是开始发布时的那张单
 * （状态、租约代、订单、worker 交的活、交付正文都没变）、本机租约截止没过。顺序是先 await 授权、之后同步读 journal 和时钟，
 * 所以守卫放行到调用方发出动作之间没有别的 I/O。读不到按 unknown 拦：不能把「不知道」当成「仍有权」。
 * 放行的同时把「这个动作已发出」记进 lend_meta（publish-facts:<单号>），端口返回后再记结果；发出之后的收回撤不回已发的请求，
 * 所以这份记录只增不改回：停单原因带上它（publishedNote），交 A / PM 对账。结果不明的推送下一轮先读远端再决定推不推（lend-push.ts）。
 * 已转过一次的交付正文重发取回执不看授权 / 租约（A 可能已入账，lend-drive.ts heartbeat），只核 journal 没变。
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
interface PublishFacts { head: string; branch: string; push?: Mark; pr?: Mark; prNumber?: number | null; result?: string; at: number }
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
  if (!f?.push || f.push === "refused") return why;
  const at = `${f.head.slice(0, 12)} → ${f.branch}`;
  const pr = f.pr === "done" && f.prNumber ? `，PR #${f.prNumber} 已开` : f.pr === "issued" ? "，开 PR 的请求已发出、结果不明" : "，没开新 PR";
  const sent = f.result ? "，交付已转过" : "，没转交付";
  return `${why ?? ""}（远端已有的不回滚：${f.push === "done" ? "已推送" : "推送已发出、结果不明"} ${at}${pr}${sent}）`;
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
  /** 端口返回后记结果：成了 / 远端明确拒了；可重试的失败（超时、断网）保持「已发出、结果不明」 */
  settle(effect: "push" | "pr", r: Outcome): void;
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
  const before: BeforeEffect = async (effect) => {
    const no = await check(effect);
    if (no) return no;
    // 先记后发（写不进 = 失租，抛出去，动作不发）；记的是「发出」这件事，结果由 settle 补
    if (effect === "push") note(d, row, { push: "issued" });
    else if (effect === "pr") note(d, row, { pr: "issued" });
    else if (effect === "result" && row.work && row.payloadSha) note(d, row, { result: row.payloadSha });
    return null;
  };
  made.add(before);
  return {
    check, before,
    gate: () => ({ beforeEffect: before, unsettled: publishFacts(d.db, row)?.push === "issued" }),
    settle: (effect, r) => {
      if (r.ok) return note(d, row, effect === "push" ? { push: "done" } : { pr: "done", prNumber: r.pr ?? null });
      if (!r.denied && !r.retry && publishFacts(d.db, row)?.[effect] === "issued") note(d, row, { [effect]: "refused" });
    },
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

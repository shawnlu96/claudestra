/**
 * 额度停下的出借单什么时候、按什么顺序重挂（QSTOP，纯函数）：输入是 lend-quota-resume-facts 核过的停止事实加调用方现读的观察，
 * 输出 wait / manual / consumed / plan。plan 只是步骤与 CAS 前提，真正的撤旧单、重排池由 QSTOPW 的正式写锁 + 审计入口执行；
 * 本模块不写库、不联网。同一旧单同一租约代只有一个恢复资格（key），执行入口按 key 去重，重启、重复 tick 算出的还是同一个 key。
 * 结果优先：旧单已有结论、出借方有待转交结果、worker 还活着或不知道，都不出新单。tests/lend-quota-resume-plan*.test.ts。
 */
import { roleOfStep } from "./lend-git.js";
import { HELLO_FRESH_MS, type HelloRequest } from "./lend-wire-v2.js";
import { hasRef, type OrderSnap, type VerifiedQuotaStop } from "./lend-quota-resume-facts.js";

/** 一次带来源的观察；source 空白、observedAt 缺失 / 在未来 / 比 HELLO_FRESH_MS 旧 / 早于停止事件都按不知道 */
interface Observed<T> { value: T; source: string; observedAt: number | null }

export interface ResumeInput {
  stop: VerifiedQuotaStop;
  /** A 侧此刻的旧单（现读，不用核事实时那份） */
  order: OrderSnap;
  /** 卡此刻的 head / spec / round：任何一个变了，旧恢复资格不用也不消费 */
  task: { head: string; specRev: number; round: number };
  worker: Observed<"alive" | "stopped" | "unknown"> | null;
  /** 出借方或转交通道里还没入账的结果；null = 不知道 */
  pendingResult: Observed<boolean | null> | null;
  /**
   * 出借方对旧单（同 orderId 同 gen）的收尾是否已结清：停止通知、关卡、结束通知、收据都做完（B 侧 settle 已清空）。
   * 停止通知送到不等于结清——收尾任何一步失败都会留着 settle，此时不出新单。null / false = 不知道或没结清
   */
  settlement: Observed<{ orderId: string; gen: number; settled: boolean | null }> | null;
  /** 停止之后的新 hello（出借方授权、暂停、额度） */
  hello: Observed<Pick<HelloRequest, "grant" | "paused" | "quota">> | null;
  /** 写 / 修单的写租约；审查单不看 */
  writeLease: { peer: string; state: "held" | "ended" } | null;
  /** 审计里已消费的恢复资格 */
  consumed: ReadonlySet<string>;
}

type ResumeStep =
  | { op: "cas"; orderId: string; expect: { status: "unknown"; leaseGen: number; resultSha: null; peer: string; head: string; specRev: number; round: number } }
  /** 执行入口在写锁内重新确认同单同代已结清（带原观察来源）；确认不到就整份计划作废，不撤单 */
  | { op: "settle"; orderId: string; gen: number; peer: string; require: "settled"; evidence: string }
  | { op: "cancel"; orderId: string; reason: "quota_stop_resume"; evidence: string[] }
  | { op: "repool"; taskId: string; peer: string; family: OrderSnap["family"]; step: OrderSnap["step"]; head: string; specRev: number; round: number;
      supersedes: string; keepWriteLease: boolean };

export type ResumePlan =
  | { kind: "wait"; why: string; until: number | null }
  | { kind: "manual"; why: string; evidence: string[] }
  | { kind: "consumed"; key: string }
  | { kind: "plan"; key: string; steps: ResumeStep[] };

/** 恢复资格：旧单 + 租约代。新单有新 orderId、新 gen，消费不到这一个 */
export const resumeKey = (s: Pick<VerifiedQuotaStop, "orderId" | "gen">): string => `qstop:${s.orderId}:g${s.gen}`;

/** 新鲜且带来源；after = 停止事件时刻，同一份观察（同 beat）里报的状态也算「停止之后」 */
const fresh = (o: Observed<unknown> | null, now: number, after: number): boolean =>
  !!o && hasRef(o.source) && typeof o.observedAt === "number" && Number.isFinite(o.observedAt) && o.observedAt <= now &&
  now - o.observedAt <= HELLO_FRESH_MS && o.observedAt >= after;

/** 旧单与卡是否还是停下那一刻的样子；不是就交 PM，不重挂 */
function staleness(i: ResumeInput): string | null {
  const { stop: s, order: o, task: t } = i;
  if (o.orderId !== s.orderId || o.peer !== s.peer || o.family !== s.family || o.step !== s.step) return "旧单身份与停止事实不符";
  if (o.resultSha !== null || o.status === "done") return "旧单已有结论，结果优先";
  if (o.status !== "unknown") return `旧单已不在 unknown（${o.status}）`;
  if (o.leaseGen !== s.gen) return `租约代变了（${s.gen} → ${o.leaseGen}）`;
  if (o.head !== s.head || o.specRev !== s.specRev || o.round !== s.round) return "旧单 head / spec / round 与停止事实不符";
  if (t.head !== s.head || t.specRev !== s.specRev || t.round !== s.round) return "卡已推进到新 head / spec / round，旧恢复资格不适用";
  return null;
}

/** 新 hello 里的授权与暂停；null = 可以重挂 */
function helloBlock(i: ResumeInput, now: number): ResumePlan | null {
  const h = i.hello;
  if (!h || !fresh(h, now, i.stop.stoppedAt)) return { kind: "wait", why: "没有停止之后的新 hello", until: null };
  const { grant, paused, quota } = h.value;
  if (!grant || grant.until <= now) return { kind: "manual", why: "出借方授权已收回或过期", evidence: [...i.stop.evidence, h.source] };
  const role = roleOfStep(i.stop.step);
  if (!role || !grant.roles.includes(role) || !grant.repos.includes(i.stop.repo)) {
    return { kind: "manual", why: "出借方授权不再包含这个仓库或角色", evidence: [...i.stop.evidence, h.source] };
  }
  if (grant.ordersLeftToday <= 0) return { kind: "wait", why: "出借方今日单量已用完", until: null };
  if (paused && paused.until > now) return { kind: "wait", why: `出借方仍暂停：${paused.reason}`, until: paused.until };
  const q = quota?.[i.stop.family];
  if (q && q.weekUsedPct >= 100 && q.resetAt > now) return { kind: "wait", why: "出借方该家族额度仍满", until: q.resetAt };
  return null;
}

/** 计划一单额度停止后的恢复。顺序：资格 → 旧单与卡 → 结果优先 → 旧单结清 → 截止 → 出借方现状 → 写租约 → 步骤 */
export function planQuotaResume(i: ResumeInput, now: number): ResumePlan {
  const s = i.stop, key = resumeKey(s);
  if (i.consumed.has(key)) return { kind: "consumed", key };
  const stale = staleness(i);
  if (stale) return { kind: "manual", why: stale, evidence: s.evidence };
  const pr = i.pendingResult;
  if (pr && fresh(pr, now, -Infinity) && pr.value === true) return { kind: "wait", why: "有待转交的结果，结果优先", until: null };
  if (!pr || !fresh(pr, now, s.stoppedAt) || pr.value !== false) return { kind: "wait", why: "不知道有没有待转交的结果", until: null };
  const w = i.worker;
  if (!w || !fresh(w, now, s.stoppedAt) || w.value !== "stopped") return { kind: "wait", why: "worker 还活着或不知道", until: null };
  const st = i.settlement;
  if (st && fresh(st, now, s.stoppedAt) && (st.value.orderId !== s.orderId || st.value.gen !== s.gen)) {
    return { kind: "manual", why: "结清事实不是这张旧单 / 这一租约代", evidence: [...s.evidence, st.source] };
  }
  if (!st || !fresh(st, now, s.stoppedAt) || st.value.settled !== true) return { kind: "wait", why: "旧单出借方收尾未结清或不知道", until: null };
  if (now < s.deadline) return { kind: "wait", why: `等额度重置（${s.deadlineFrom}）`, until: s.deadline };
  const blocked = helloBlock(i, now);
  if (blocked) return blocked;
  const write = roleOfStep(s.step) === "write";
  if (write && (!i.writeLease || i.writeLease.state !== "held" || i.writeLease.peer !== s.peer)) {
    return { kind: "manual", why: "写租约不在原出借方手里", evidence: s.evidence };
  }
  return { kind: "plan", key, steps: [
    { op: "cas", orderId: s.orderId, expect: { status: "unknown", leaseGen: s.gen, resultSha: null, peer: s.peer, head: s.head, specRev: s.specRev, round: s.round } },
    { op: "settle", orderId: s.orderId, gen: s.gen, peer: s.peer, require: "settled", evidence: st.source },
    { op: "cancel", orderId: s.orderId, reason: "quota_stop_resume", evidence: s.evidence },
    { op: "repool", taskId: s.taskId, peer: s.peer, family: s.family, step: s.step, head: s.head, specRev: s.specRev, round: s.round,
      supersedes: s.orderId, keepWriteLease: write },
  ] };
}

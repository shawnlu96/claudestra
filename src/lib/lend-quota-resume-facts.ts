/**
 * 出借方「撞额度停下」这件事能不能当真（QSTOP，纯函数，不读库不联网）：只认调用方带来源与观察时刻的结构化事实，
 * 不从 A 侧 resultSha 为空、也不从 release reason / detail 里的「额度」字样推断——现有 `release stopped` 只有自由文本，
 * 要把 cause / stopped / result 这些字段带过来需要另报协议字段（QSTOPW），这里先定好它们的形状与判据。
 * 结论只有三种：verified（可进 lend-quota-resume-plan）、wait（再看）、manual（交 PM，原证据原样带回）；
 * auth / 内容拒绝 / 普通 error / 副作用不明一律 manual 且不可恢复，不换家族或会话绕开提供方保护。tests/lend-quota-resume-plan*.test.ts。
 */
import type { LendFamily } from "./lend-config.js";
import type { LendOrder } from "./ledger-lend.js";
import { PAUSE_FALLBACK_MS } from "./lend-health.js";

/** 停止原因只收这几类；quota 以外都不走自动恢复 */
type QuotaStopCause = "quota" | "auth" | "provider_refusal" | "error" | "unknown";

/** 一条停止事实。null = 来源没说，按不知道处理，不能当 false */
export interface QuotaStopFact {
  /** 认证来源：ledger 事件序号（lease 端点记的那条）或已验签的 beat；authenticated 由调用方按验签 / 租约端点结果填 */
  source: { kind: "lease_release" | "beat"; ref: string; peer: string; authenticated: boolean };
  orderId: string; peer: string; gen: number; family: LendFamily;
  /** 这条事实被观察到的时刻（来源侧时间）；缺失 / 非有限 / 晚于 now = 不可信 */
  observedAt: number | null;
  cause: QuotaStopCause;
  /** worker 已确认停下（不是「租约过期」那种推测） */
  stopped: boolean | null;
  /** 已提交的结论 / 已推送待转交的结果；有任一个就结果优先 */
  resultCommitted: boolean | null; resultPending: boolean | null;
  /** 停之前有没有对外副作用（推送、评论…）；unknown = 不恢复 */
  sideEffects: "none" | "unknown" | null;
  /** 额度停止事实自带的重置时刻（ms）；只认这一处，不现读额度 */
  resetAt: number | null;
}

export type OrderSnap = Pick<LendOrder, "orderId" | "taskId" | "peer" | "family" | "step" | "specRev" | "round" | "head" | "status" |
  "leaseGen" | "resultSha" | "repo">;

export interface VerifiedQuotaStop {
  orderId: string; taskId: string; peer: string; family: LendFamily; gen: number;
  step: OrderSnap["step"]; specRev: number; round: number; head: string; repo: string;
  observedAt: number;
  /** 恢复截止：事实里的重置时刻，缺失才是 observedAt + PAUSE_FALLBACK_MS；由事实算出，不随 tick 变 */
  deadline: number; deadlineFrom: "reset" | "fallback";
  /** 原证据引用，原样带给计划与审计 */
  evidence: string[];
}

export type FactVerdict =
  | { kind: "verified"; stop: VerifiedQuotaStop }
  | { kind: "wait"; why: string; evidence: string[] }
  | { kind: "manual"; why: string; evidence: string[]; recoverable: boolean };

const refOf = (f: QuotaStopFact): string => `${f.source.kind}:${f.source.ref}@${f.observedAt ?? "?"}`;
const finite = (n: number | null): n is number => typeof n === "number" && Number.isFinite(n);

/** 两条事实说的是不是同一件事（字段任何一处不同就是矛盾） */
function sameClaim(a: QuotaStopFact, b: QuotaStopFact): boolean {
  return a.orderId === b.orderId && a.peer === b.peer && a.gen === b.gen && a.family === b.family && a.cause === b.cause &&
    a.stopped === b.stopped && a.resultCommitted === b.resultCommitted && a.resultPending === b.resultPending &&
    a.sideEffects === b.sideEffects && a.resetAt === b.resetAt;
}

/** 来源与身份：只认认证来源、同 peer、同 order、同 gen；不符的事实不参与判断但留在证据里 */
function ownFacts(facts: readonly QuotaStopFact[], o: OrderSnap): { own: QuotaStopFact[]; foreignGen: boolean } {
  const own = facts.filter((f) => f.source.authenticated && f.source.peer === o.peer && f.peer === o.peer && f.orderId === o.orderId &&
    f.gen === o.leaseGen && f.family === o.family);
  const foreignGen = facts.some((f) => f.source.authenticated && f.orderId === o.orderId && f.peer === o.peer && f.gen !== o.leaseGen);
  return { own, foreignGen };
}

/**
 * 判一单的额度停止事实。o 是 A 侧此刻的单（调用方现读）；只在 o 停在 unknown（对方报停、交 PM）时才可能 verified。
 * 停止事实是已发生的历史，不按年龄过期（截止常在数小时后）；会变的观察（hello、worker 存活、待转交结果）由计划层按新鲜度判。
 * 晚到的结果、并发的正式结果由计划层再看一次，这里只看事实本身。
 */
export function verifyQuotaStop(facts: readonly QuotaStopFact[], o: OrderSnap, now: number): FactVerdict {
  const evidence = facts.map(refOf);
  const wait = (why: string): FactVerdict => ({ kind: "wait", why, evidence });
  const manual = (why: string, recoverable = true): FactVerdict => ({ kind: "manual", why, evidence, recoverable });
  if (o.resultSha !== null || o.status === "done") return manual("结论已入账，结果优先，不恢复", false);
  if (o.status !== "unknown") return manual(`单不在 unknown（${o.status}），不是报停待核对的单`);
  const { own, foreignGen } = ownFacts(facts, o);
  if (!own.length) return foreignGen ? manual(`只有别的租约代的停止事实，当前 gen ${o.leaseGen}`) : wait("没有认证来源的停止事实");
  const first = own[0];
  if (own.some((f) => !sameClaim(f, first))) return manual("同一单的停止事实互相矛盾");
  if (first.cause !== "quota") return manual(`停止原因是 ${first.cause}，不走额度恢复`, false);
  if (first.sideEffects !== "none") return manual(first.sideEffects === "unknown" ? "副作用不明" : "没说有没有副作用", false);
  if (first.resultCommitted === true || first.resultPending === true) return manual("出借方有已提交或待转交的结果，结果优先", false);
  const observed = own.map((f) => f.observedAt);
  if (!observed.every(finite) || observed.some((t) => t > now)) return manual("观察时刻缺失或在未来");
  const observedAt = Math.max(...observed);
  if (first.stopped !== true) return wait(first.stopped === false ? "worker 还没停" : "不知道 worker 停没停");
  if (first.resultCommitted !== false || first.resultPending !== false) return wait("不知道有没有已提交 / 待转交的结果");
  const reset = finite(first.resetAt) && first.resetAt > Math.min(...(observed as number[])) ? first.resetAt : null;
  // 截止取最早那条事实的观察时刻：同一事实被重复观察（每 tick 一次）也不会往后推兜底截止
  const deadline = reset ?? Math.min(...(observed as number[])) + PAUSE_FALLBACK_MS;
  return { kind: "verified", stop: {
    orderId: o.orderId, taskId: o.taskId, peer: o.peer, family: o.family, gen: o.leaseGen, step: o.step, specRev: o.specRev,
    round: o.round, head: o.head, repo: o.repo, observedAt, deadline, deadlineFrom: reset === null ? "fallback" : "reset", evidence,
  } };
}

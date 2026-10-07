/**
 * 「现在谁在接这个任务」——编排班子（docs 10-ledger「附：编排班子」）从台账推导，不另存状态：
 * 协作视图靠它显示当前一环，T29 巡检靠它判断「交到某一环之后没人接」。纯函数，tests/ledger-handler.test.ts。
 *
 * 规则：先按当前阶段定默认的一环，再按进入当前阶段之后的事件往后推：
 *   deliver → 调度助理（没配就是 PM）；dispatch → 审查员；review 没带阶段移动 → 通过归 PM、否则回调度助理，
 *   但通过了而还欠对抗式（owesAdversarial：规格卡要对抗式，当前 head 上还没有对抗式 pass 或 PM 豁免）仍归调度助理；
 *   策略取调用方读的规格卡（specPolicy）和派审记录里更严的，读不到、或说不清这轮是谁审的（没有对得上轮次与 head 的派审）= 不知道，也归调度助理；
 *   escalate → PM（data.to = owner 时归 owner；硬规则的自动升级 data.auto 不改处理人）；升级给 owner 之后 owner 记了 decision → 回到 PM。进入新阶段（stage 事件）重新从默认值算起。
 */
import type { LedgerEvent, LedgerTask, Stage } from "./ledger-stages.js";
import { nextReview, type LastReview, type NextReview } from "./review-pack.js";

type HandlerRole = "executor" | "dispatcher" | "reviewer" | "pm" | "owner";

export interface Handler {
  role: HandlerRole;
  /** 具体是谁（registry 键）；审查员是子 agent、owner 是人，都为 null；PM 在任务上没记时取名单里第一个非调度助理 */
  agent: string | null;
  /** 从什么时候开始归它接（那条事件的 ts） */
  since: number;
  /** 推出这一环的那条事件 seq；只有建任务事件、没有别的时为建任务事件的 seq */
  seq: number;
}

export interface HandlerTeam {
  /** 项目 PM 名单（ledger meta pms） */
  pms: readonly string[];
  /** 班子里的调度助理；没开班子或没配调度助理 = null */
  dispatcher: string | null;
}

/** 阶段默认归谁：写规格、放行复述、合并上线、阻塞都归 PM；干活归执行者；review 刚进来还没交付事件时算调度助理 */
const STAGE_ROLE: Record<Stage, HandlerRole | null> = {
  spec: "pm",
  restate: "pm",
  build: "executor",
  fix: "executor",
  review: "dispatcher",
  merge: "pm",
  live: "pm",
  verified: "pm",
  blocked: "pm",
  done: null,
  cancelled: null,
};

/** PM 是谁：任务上记的 pm 优先，其次名单里第一个不是调度助理的 */
export function pmOf(task: Pick<LedgerTask, "pm">, team: HandlerTeam): string | null {
  return task.pm || team.pms.find((p) => p !== team.dispatcher) || null;
}

function resolve(role: HandlerRole, task: Pick<LedgerTask, "agent" | "pm">, team: HandlerTeam): { role: HandlerRole; agent: string | null } {
  if (role === "dispatcher") return team.dispatcher ? { role, agent: team.dispatcher } : { role: "pm", agent: pmOf(task, team) };
  if (role === "executor") return { role, agent: task.agent };
  if (role === "pm") return { role, agent: pmOf(task, team) };
  return { role, agent: null };
}

const num = (v: unknown): number => (typeof v === "number" ? v : 0);

/** 规格卡的审查策略：string =「审查」那一行；null = 规格卡在但没写；undefined = 不知道（没读 / 找不到规格卡） */
export type SpecPolicy = string | null | undefined;

/** seq 之前最近一次交付的 head：deliver 带的 headSHA，或建任务 / task-set 写的 headSHA（清空为 null）；都没有为 null */
function headAt(events: readonly LedgerEvent[], seq: number): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.seq >= seq) continue;
    if (e.kind === "deliver" && typeof e.data.headSHA === "string" && e.data.headSHA) return e.data.headSHA;
    const patch = e.kind === "task" ? (e.data.patch as Record<string, unknown> | undefined) : undefined;
    if (patch && "headSHA" in patch) return typeof patch.headSHA === "string" && patch.headSHA ? patch.headSHA : null;
  }
  return null;
}

/** 同一个 commit：短 sha 前缀也认；两边都没记 head 算同一个（此时靠轮次和「之后没再交付」约束） */
function sameHead(a: string | null, b: string | null): boolean {
  if (!a || !b) return !a && !b;
  return a.startsWith(b) || b.startsWith(a);
}

/** a 之后、b 之前（都不含）有没有交付事件 */
const deliveredBetween = (events: readonly LedgerEvent[], a: number, b: number): LedgerEvent[] =>
  events.filter((e) => e.kind === "deliver" && e.seq > a && e.seq < b);

/**
 * 这条 review（第 round 轮、seq 之前的 head）是哪种审查员审的：取 seq 之前最近一次派审，它记的 round 与 head 都对得上、
 * 并且派审之后没有再交付过（交付不带 head 时说不清换没换代码，一律算换了），才算；否则 null（这一轮没派审，或者派审之后又交付了）。
 * 一次派审只算一次：派审之后、这条 review 之前已有别的 review 也是 null——否则续派没记上时，下一条结论会套用上一位审查员的种类。
 * 种类取 dispatch.reviewer（代码写的）；review 的 reviewer 是自由文本，不作数。
 */
function dispatchKindFor(events: readonly LedgerEvent[], seq: number, round: unknown): LastReview["kind"] {
  const d = events.findLast((e) => e.kind === "dispatch" && e.seq < seq);
  if (!d || d.data.round !== round || deliveredBetween(events, d.seq, seq).length) return null;
  if (events.some((e) => e.kind === "review" && e.seq > d.seq && e.seq < seq)) return null;
  if (!sameHead(typeof d.data.head === "string" ? d.data.head : null, headAt(events, seq))) return null;
  return d.data.reviewer === "adversarial" ? "adversarial" : d.data.reviewer === "regular" ? "regular" : null;
}

/** 一条 review 的「上一轮」画像（给 nextReview 用）。events = 同一任务的事件（seq 升序） */
export function lastReviewOf(review: LedgerEvent, events: readonly LedgerEvent[]): LastReview {
  const verdict = typeof review.data.verdict === "string" ? review.data.verdict : null;
  return { kind: dispatchKindFor(events, review.seq, review.data.round), verdict, p0: num(review.data.p0), p1: num(review.data.p1) };
}

/** 作者家族：最近一次流程设置（scheduler workflow 事件）记的 authorFamily；没记为 null */
const authorFamily = (events: readonly LedgerEvent[]): string | null => {
  const w = events.findLast((e) => e.kind === "scheduler" && e.data.op === "workflow" && typeof e.data.authorFamily === "string");
  return w ? String(w.data.authorFamily) : null;
};

/**
 * 调度器派的跨族对抗审查单交回的结论（自动卡不写 dispatch 事件）：data.orderId 是本轮的 adversarial_review 单、
 * 审查员与作者不同家族（sameFamily=false；没记或记 null 时比 reviewerFamily 与作者家族），且审的 head 就是当时卡上的 head。
 * 同家族豁免轮（sameFamily=true）不算，否则 MODELX 豁免会被当成跨族对抗式放进 merge（tests/ledger-handler.test.ts）
 */
function schedulerAdversarial(e: LedgerEvent, events: readonly LedgerEvent[]): boolean {
  const m = typeof e.data.orderId === "string" ? /:r(\d+):adversarial_review:a\d+$/.exec(e.data.orderId) : null;
  if (!m || Number(m[1]) !== e.data.round) return false;
  const { sameFamily, reviewerFamily } = e.data;
  const author = authorFamily(events);
  const cross = sameFamily === false || (sameFamily == null && typeof reviewerFamily === "string" && !!author && reviewerFamily !== author);
  return cross && typeof e.data.head === "string" && !!e.data.head && sameHead(e.data.head, headAt(events, e.seq));
}

/**
 * 这条 review 还清了第 round 轮的对抗式：对抗式轮（dispatch 记的，或调度器的跨族对抗审查单）的 pass 或 PM 的豁免（review --waive adversarial），并且
 * ① 就在第 round 轮；② 之后的每次交付都带着同一个非空 head（不带 head 的交付说不清换没换代码，算重新欠）；
 * ③ 当前 head（之后 task-set 改过也算）还是它审的那个。
 */
function settles(e: LedgerEvent, events: readonly LedgerEvent[], round: number): boolean {
  if (e.kind !== "review" || e.data.verdict !== "pass" || e.data.round !== round) return false;
  const adversarial = e.data.waive === "adversarial" || dispatchKindFor(events, e.seq, e.data.round) === "adversarial" || schedulerAdversarial(e, events);
  if (!adversarial) return false;
  const head = headAt(events, e.seq);
  const later = deliveredBetween(events, e.seq, Infinity);
  if (later.some((d) => !head || typeof d.data.headSHA !== "string" || !d.data.headSHA || !sameHead(d.data.headSHA, head))) return false;
  return sameHead(head, headAt(events, Infinity));
}

/** 正要记、还没入库的那条结论（review --to merge） */
export interface PendingReview {
  verdict: string;
  waive?: string;
}

/**
 * 还欠不欠对抗式（第 round 轮 = 任务当前轮次）。路由、currentHandler、`review --to merge` 共用这一个判定：
 * 还清的条件见 settles——对抗式 pass / 豁免只对它那一轮、那个 head 有效；正要记的 pending 判通过，且这一轮最后一次交付之后
 * 派的是对抗式（或带豁免），也算还清。策略取规格卡（lib/task-spec.ts）和派审记录里更严的（strictPolicy）：都读不到、或提到对抗式却读不出「审查：」= unknown。
 */
export function owesAdversarial(spec: SpecPolicy, events: readonly LedgerEvent[], round: number, pending?: PendingReview): boolean | "unknown" {
  const policy = strictPolicy(spec, events);
  if (events.some((e) => settles(e, events, round))) return false;
  if (pending?.verdict === "pass" && (pending.waive === "adversarial" || dispatchKindFor(events, Infinity, round) === "adversarial")) return false;
  if (policy === undefined) return "unknown";
  return !!policy?.includes("对抗");
}

/**
 * 规格卡和本任务派审事件记下的策略（dispatch data.policy）取更严的：派审时卡上要对抗式，事后把卡改松不算数，
 * 否则改一行规格卡就能让常规 pass 进 merge（tests/ledger-merge-gate.test.ts）。卡上已经要对抗式、或没有派审记录要过，原样返回
 */
export function strictPolicy<P extends SpecPolicy>(spec: P, events: readonly LedgerEvent[]): P | string {
  if (spec?.includes("对抗")) return spec;
  const recorded = events.find((e) => e.kind === "dispatch" && typeof e.data.policy === "string" && e.data.policy.includes("对抗"));
  return recorded ? String(recorded.data.policy) : spec;
}

/**
 * 这条 review 之后下一轮是什么；null = 审查走完（nextReview，与 review-pack 同一算法）。
 * pass 时：还清了（或不要对抗式）= 走完；还欠而这轮没有对得上的派审记录（说不清它是不是对抗式）、或读不到策略 = unknown，交调度助理核对。
 */
export function nextAfterReview(review: LedgerEvent, events: readonly LedgerEvent[], spec: SpecPolicy): NextReview | "unknown" {
  const specPolicy = strictPolicy(spec, events);
  const last = lastReviewOf(review, events);
  if (last.verdict !== "pass") return specPolicy === undefined ? "unknown" : nextReview(specPolicy, last);
  const owes = owesAdversarial(specPolicy, events.filter((e) => e.seq <= review.seq), num(review.data.round));
  if (owes === "unknown") return "unknown";
  if (!owes) return null;
  return last.kind === null ? "unknown" : nextReview(specPolicy ?? null, last);
}

/** 事件把接手的一环推到哪；null = 这条不改变谁在接（note 等） */
function roleAfter(e: LedgerEvent, cur: HandlerRole, events: readonly LedgerEvent[], specPolicy: SpecPolicy): HandlerRole | null {
  switch (e.kind) {
    case "deliver":
      return "dispatcher";
    case "dispatch":
      return "reviewer";
    case "review":
      return e.data.verdict === "pass" && nextAfterReview(e, events, specPolicy) === null ? "pm" : "dispatcher";
    case "escalate":
      // 硬规则的自动升级只是抄送 PM，任务仍在原处理人手上（比如 P0 推回 fix 后仍是执行者在修）
      if (e.data.auto === true) return null;
      return e.data.to === "owner" ? "owner" : "pm";
    case "decision":
      // 等 owner 拍板时，owner（或 PM 转录的 owner 原话）一记 decision 就回到 PM 去执行
      return cur === "owner" ? "pm" : null;
    default:
      return null;
  }
}

/** 当前阶段是从哪条事件开始的：最后一条 stage 事件，没有就是建任务事件 */
function stageStart(events: readonly LedgerEvent[]): number {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.kind === "stage" || (e.kind === "task" && e.data.op === "new")) return i;
  }
  return -1;
}

/**
 * events = 这个任务自己的事件（target = task.id），按 seq 升序。终态（done / cancelled）返回 null。
 * specPolicy = 规格卡的审查策略（lib/task-spec.ts specPolicyOf）；不传 = 不知道，pass 之后除非当前 head 已还清对抗式，都归调度助理。
 * 同一事务里 review 事件在 stage 事件之前写（recordReview 先记结论再推阶段），所以 review→fix 之后是执行者在接，符合预期。
 */
export function currentHandler(
  task: Pick<LedgerTask, "stage" | "agent" | "pm" | "createdAt">,
  events: readonly LedgerEvent[],
  team: HandlerTeam,
  specPolicy?: SpecPolicy,
): Handler | null {
  const base = STAGE_ROLE[task.stage];
  if (!base) return null;
  const start = stageStart(events);
  const startEvent = start >= 0 ? events[start] : undefined;
  let role: HandlerRole = base;
  let since = startEvent?.ts ?? task.createdAt;
  let seq = startEvent?.seq ?? 0;
  for (const e of events.slice(start + 1)) {
    const next = roleAfter(e, role, events, specPolicy);
    if (!next) continue;
    role = next;
    since = e.ts;
    seq = e.seq;
  }
  return { ...resolve(role, task, team), since, seq };
}

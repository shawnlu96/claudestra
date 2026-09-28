/**
 * 「现在谁在接这个任务」——编排班子（docs 10-ledger「附：编排班子」）从台账推导，不另存状态：
 * 协作视图靠它显示当前一环，T29 巡检靠它判断「交到某一环之后没人接」。纯函数，tests/ledger-handler.test.ts。
 *
 * 规则：先按当前阶段定默认的一环，再按进入当前阶段之后的事件往后推：
 *   deliver → 调度助理（没配就是 PM）；dispatch → 审查员；review 没带阶段移动 → 通过归 PM、否则回调度助理，
 *   但通过了而下一轮还要审（nextReview：规格卡要对抗式、这轮不是）仍归调度助理；审查策略只取调用方读的规格卡（specPolicy），
 *   读不到、或说不清这轮是不是对抗式（没有派审记录）= 不知道，也归调度助理（宁可多问一句，不替它判走完）；
 *   escalate → PM（data.to = owner 时归 owner；硬规则的自动升级 data.auto 不改处理人）；升级给 owner 之后 owner 记了 decision → 回到 PM。
 *   进入新阶段（stage 事件）重新从默认值算起。
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

/** seq 之前最近一次派审的种类：取 dispatch.reviewer（代码写的）；review 的 reviewer 字段是自由文本，不作数；没派审记录为 null */
function dispatchKindBefore(events: readonly LedgerEvent[], seq: number): LastReview["kind"] {
  const d = events.findLast((e) => e.kind === "dispatch" && e.seq < seq);
  return d?.data.reviewer === "adversarial" ? "adversarial" : d?.data.reviewer === "regular" ? "regular" : null;
}

/** 一条 review 的「上一轮」画像（给 nextReview 用）。events = 同一任务的事件（seq 升序） */
export function lastReviewOf(review: LedgerEvent, events: readonly LedgerEvent[]): LastReview {
  const verdict = typeof review.data.verdict === "string" ? review.data.verdict : null;
  return { kind: dispatchKindBefore(events, review.seq), verdict, p0: num(review.data.p0), p1: num(review.data.p1) };
}

/** 台账里有没有对抗式轮的 pass（那条 review 之前最近的派审是对抗式） */
function adversarialPassed(events: readonly LedgerEvent[]): boolean {
  return events.some((e) => e.kind === "review" && e.data.verdict === "pass" && dispatchKindBefore(events, e.seq) === "adversarial");
}

/**
 * 还欠不欠对抗式：规格卡要对抗式，台账里还没有对抗式轮的 pass。路由、currentHandler、`review --to merge` 共用这一个判定；
 * pending = 正要记、还没入库的那条结论（--to merge 时），它前面最近的派审是对抗式且判通过就算还清。
 * 策略只认规格卡（lib/task-spec.ts，与 review-pack 同一来源）；读不到规格卡 = unknown。
 */
export function owesAdversarial(policy: SpecPolicy, events: readonly LedgerEvent[], pending?: { verdict: string }): boolean | "unknown" {
  if (policy === undefined) return "unknown";
  if (!policy?.includes("对抗") || adversarialPassed(events)) return false;
  return !(pending?.verdict === "pass" && dispatchKindBefore(events, Infinity) === "adversarial");
}

/**
 * 这条 review 之后下一轮是什么；null = 审查走完（nextReview，与 review-pack 同一算法）。
 * unknown = 读不到规格卡，或者规格卡要对抗式、台账里还没有对抗式 pass、这轮又没有派审记录（说不清它是不是对抗式）：交调度助理核对。
 */
export function nextAfterReview(review: LedgerEvent, events: readonly LedgerEvent[], specPolicy: SpecPolicy): NextReview | "unknown" {
  if (specPolicy === undefined) return "unknown";
  const last = lastReviewOf(review, events);
  const upto = events.filter((e) => e.seq <= review.seq);
  if (last.verdict === "pass" && last.kind === null && owesAdversarial(specPolicy, upto) === true) return "unknown";
  return nextReview(specPolicy, last);
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
 * specPolicy = 规格卡的审查策略（lib/task-spec.ts specPolicyOf）；不传时没有 dispatch 的 pass 归调度助理（见 lastReviewOf）。
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

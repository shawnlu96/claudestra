/**
 * 「现在谁在接这个任务」——编排班子（docs/team/orchestration-team.md）从台账推导，不另存状态：
 * 协作视图靠它显示当前一环，T29 巡检靠它判断「交到某一环之后没人接」。纯函数，tests/ledger-handler.test.ts。
 *
 * 规则：先按当前阶段定默认的一环，再按进入当前阶段之后的事件往后推：
 *   deliver → 调度助理（没配就是 PM）；dispatch → 审查员；review 没带阶段移动 → 通过归 PM、否则回调度助理；
 *   escalate → PM（data.to = owner 时归 owner）。进入新阶段（stage 事件）重新从默认值算起。
 */
import type { LedgerEvent, LedgerTask, Stage } from "./ledger-stages.js";

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

/** 事件把接手的一环推到哪；null = 这条不改变谁在接（note、decision 等） */
function roleAfter(e: LedgerEvent): HandlerRole | null {
  switch (e.kind) {
    case "deliver":
      return "dispatcher";
    case "dispatch":
      return "reviewer";
    case "review":
      return e.data.verdict === "pass" ? "pm" : "dispatcher";
    case "escalate":
      return e.data.to === "owner" ? "owner" : "pm";
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
 * 同一事务里 review 事件在 stage 事件之前写（recordReview 先记结论再推阶段），所以 review→fix 之后是执行者在接，符合预期。
 */
export function currentHandler(task: Pick<LedgerTask, "stage" | "agent" | "pm" | "createdAt">, events: readonly LedgerEvent[], team: HandlerTeam): Handler | null {
  const base = STAGE_ROLE[task.stage];
  if (!base) return null;
  const start = stageStart(events);
  const startEvent = start >= 0 ? events[start] : undefined;
  let role: HandlerRole = base;
  let since = startEvent?.ts ?? task.createdAt;
  let seq = startEvent?.seq ?? 0;
  for (const e of events.slice(start + 1)) {
    const next = roleAfter(e);
    if (!next) continue;
    role = next;
    since = e.ts;
    seq = e.seq;
  }
  return { ...resolve(role, task, team), since, seq };
}

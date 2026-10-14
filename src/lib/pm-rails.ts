/**
 * PMR-2（docs/design/pm-intervention-rails.md §5 P0）：自动卡上 PM / master 的手工写入，事件统一补 `manual:true` + `intervention`。
 * 只标不拦。标记点是 ledger-tx.ts insertEvent（唯一落事件的口子），所以新写命令自动覆盖，不靠逐条列命令。
 * 作用域由 `ledger` CLI（manager/pm-rails-cmds.ts withPmRails）开：命令名、各项目开关、命令开始时各卡的流程模式；
 * 不在 CLI 里的写入（调度服务、bridge 直调、单测直调 lib）没有作用域，行为和以前逐字一致。tests/pm-rails.test.ts。
 */
import type { Database } from "bun:sqlite";
import { AsyncLocalStorage } from "node:async_hooks";
import { getWorkflow } from "./ledger-scheduler.js";
import { isAskEvent, roleOf, type EventKind } from "./ledger-stages.js";
import { getMeta, getTask } from "./ledger-store.js";

export type PmRailsMode = "on" | "observe" | "off";

export interface PmRailsScope {
  /** ledger 子命令名，记进 intervention.cmd */
  cmd: string;
  mode(project: string): PmRailsMode;
  /** 命令开始时每张有流程的卡的 mode：判「本来是 auto」靠它，同一事务里先改模式后写事件也认得出（workflow-set manual、merge-resolve） */
  modesAtStart: ReadonlyMap<string, string>;
}

export const pmRailsScope = new AsyncLocalStorage<PmRailsScope>();

/** 卡的流程模式快照；没有流程表（老库 / 只读库还没建）就是空表 */
export function workflowModes(db: Database): Map<string, string> {
  const t = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'task_workflows'").get();
  if (!t) return new Map();
  return new Map((db.query("SELECT taskId, mode FROM task_workflows").all() as { taskId: string; mode: string }[]).map((r) => [r.taskId, r.mode]));
}

/** 项目级的写：冻结 / 解冻合并队列管的是整条自动合并线 */
const PROJECT_KINDS: ReadonlySet<EventKind> = new Set(["freeze", "unfreeze"]);

/**
 * 不算干预的事件：ask 一族（开 ask、作答、记忆）、纯备注（没有 op 的 note）、escalate（只是喊人）。
 * 执行者交自己的单、绑定审查员交结论、peer 回写不在这里豁免——它们的 actor 不是 PM / master，roleOf 本来就不给 manager 角色。
 */
function exempt(e: { kind: EventKind; data: Record<string, unknown> }): boolean {
  if (isAskEvent(e)) return true;
  if (e.kind === "escalate") return true;
  return e.kind === "note" && e.data.op === undefined;
}

/** 这张卡当过 auto：设过 auto 的流程事件，或交回过自动（workflow-resume）。走 events(project, target, seq) 索引 */
function everAuto(db: Database, project: string, taskId: string): boolean {
  return !!db.query(`SELECT 1 FROM events WHERE project = ? AND target = ? AND kind = 'scheduler'
    AND (json_extract(data, '$.op') = 'workflow_resume' OR (json_extract(data, '$.op') = 'workflow' AND json_extract(data, '$.mode') = 'auto')) LIMIT 1`).get(project, taskId);
}

/**
 * 命令开始时有流程，且开始 / 现在是 auto，或这张卡以前当过 auto（PM 切 manual 接管、引擎退回人工之后的手工推进照标）。
 * 首次把 spec 卡设成 auto（start_node 开卡）不算：开始时没有流程；从没 auto 过的原生 manual 卡也不算。
 */
function governed(db: Database, s: PmRailsScope, project: string, taskId: string): boolean {
  const before = s.modesAtStart.get(taskId);
  if (before === undefined) return false;
  return before === "auto" || getWorkflow(db, taskId)?.mode === "auto" || everAuto(db, project, taskId);
}

export function markIntervention(
  db: Database, actor: string, e: { project: string; target: string; kind: EventKind; data: Record<string, unknown> },
): Record<string, unknown> {
  const s = pmRailsScope.getStore();
  const mode = s && !exempt(e) ? s.mode(e.project) : "off";
  if (!s || mode === "off") return e.data;
  const pms = getMeta(db, e.project).pms;
  let role: string | null;
  if (PROJECT_KINDS.has(e.kind)) role = roleOf(actor, { agent: null }, pms);
  else {
    const task = e.target ? getTask(db, e.target) : null;
    if (!task || !governed(db, s, e.project, task.id)) return e.data;
    role = roleOf(actor, task, pms);
  }
  if (role !== "pm" && role !== "master") return e.data;
  // mode 记打标时的档位：只有 on 期间的干预会推给 owner（单次推送和每日汇总都按它筛），observe 期的切 on 后也不补推
  return { ...e.data, manual: true, intervention: { cmd: s.cmd, by: actor, role, mode } };
}

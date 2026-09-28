/**
 * `ledger` 的写子命令（docs 10-ledger §3 动作表）：参数 → lib/ledger-write.ts。角色：阶段与 meta 由库判，其余在这里（LedgerCli.require*）。
 * task-new / task-set 改执行者时经 T4 的派发规则联动 registry 的 parent / task（manager/team.ts），台账先写、registry 后写。
 */
import { STAGES, TASK_KINDS, type Stage, type TaskKind } from "../lib/ledger-stages.js";
import { LedgerError } from "../lib/ledger-store.js";
import {
  appendEvent,
  createItem,
  createTask,
  deliver,
  moveStage,
  recordReview,
  setFrozen,
  setItem,
  setTask,
  type AppendableKind,
} from "../lib/ledger-write.js";
import type { LedgerCli, Result } from "./ledger-context.js";
import { agentKey, intFlag, jsonObjectFlag } from "./ledger-identity.js";
import { MASTER_PARENT, TASK_MAX, validateParent, validateTask } from "./team.js";

const ITEM_FLAGS: Record<string, string> = { title: "title", status: "status", priority: "priority", "owner-words": "ownerWords", "one-line": "oneLine", next: "next" };
const TASK_FLAGS: Record<string, string> = { title: "title", item: "itemId", agent: "agent", pm: "pm", branch: "branch", pr: "pr", head: "headSHA", spec: "spec", model: "model" };
const ITEM_VALUED = [...Object.keys(ITEM_FLAGS), "extra", "project", "dedup"];
const TASK_VALUED = [...Object.keys(TASK_FLAGS), "extra", "dedup"];

/** 旗标 → 字段 patch；agent / pm 归一成 registry 键 */
function fieldsFrom(c: LedgerCli, map: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [flag, field] of Object.entries(map)) {
    const v = c.p.flags[flag];
    if (v !== undefined) out[field] = field === "agent" || field === "pm" ? (v ? agentKey(v) : null) : v;
  }
  const extra = jsonObjectFlag(c.p, "extra");
  if (extra) out.extra = extra;
  return out;
}

function stageFlag(c: LedgerCli, name: string): Stage {
  const v = c.need(name);
  if (!STAGES.includes(v as Stage)) throw new LedgerError("invalid", `--${name} 不是阶段：${v}（${STAGES.join(" / ")}）`);
  return v as Stage;
}

/**
 * 执行者挂到派活的人下面、任务名写进 registry（与 T4 team-link 同一套校验）。registry 里没有这个 agent（还没派人）就只写台账。
 * parent 不合法（自己派给自己、成环）或任务名含控制字符就跳过那一项并在输出里说明，不让整条命令失败——台账已经写了。
 */
async function linkRegistry(c: LedgerCli, agent: string, title: string): Promise<Result> {
  const reg = await c.deps.loadRegistry();
  const info = reg.agents[agent];
  if (!info) return { registryLinked: false, registryNote: `registry 里没有 ${agent}，只记了台账` };
  const out: Result = { registryLinked: true };
  const actor = c.deps.actor;
  const parent = actor === "master" ? MASTER_PARENT : actor.startsWith("agent-") ? actor : undefined;
  if (parent) {
    const err = validateParent(reg.agents, agent, parent);
    if (err) out.parentSkipped = err;
    else info.parent = parent;
  }
  let task = title.trim();
  if (task.length > TASK_MAX) {
    task = task.slice(0, TASK_MAX);
    out.taskTruncated = true;
  }
  const taskErr = validateTask(task);
  if (taskErr) out.taskSkipped = taskErr;
  else info.task = task;
  await c.deps.saveRegistry(reg);
  return out;
}

async function itemNew(c: LedgerCli): Promise<Result> {
  const project = c.project();
  c.requireManager(project, "建事项");
  const fields = fieldsFrom(c, ITEM_FLAGS);
  const r = createItem(c.db, c.ctx(), { ...fields, project, id: c.p.pos[1] ?? "", title: c.need("title") } as never);
  return { ok: true, item: r.row, duplicate: r.duplicate };
}

async function itemSet(c: LedgerCli): Promise<Result> {
  const project = c.project();
  c.requireManager(project, "改事项");
  const rev = intFlag(c.p, "rev");
  if (rev === undefined) throw new LedgerError("invalid", "改事项要带 --rev（show 里看当前 rev）");
  const r = setItem(c.db, c.ctx(), { project, id: c.p.pos[1] ?? "", rev, patch: fieldsFrom(c, ITEM_FLAGS) as never });
  return { ok: true, item: r.row, duplicate: r.duplicate };
}

async function taskNew(c: LedgerCli): Promise<Result> {
  const project = c.project();
  c.requireManager(project, "建任务");
  const kind = c.need("kind") as TaskKind;
  if (!TASK_KINDS.includes(kind)) throw new LedgerError("invalid", `--kind 只能是 ${TASK_KINDS.join(" / ")}`);
  const fields = fieldsFrom(c, TASK_FLAGS);
  const r = createTask(c.db, c.ctx(), { ...fields, project, id: c.p.pos[1] ?? "", title: c.need("title"), kind } as never);
  const link = r.row.agent && !r.duplicate ? await linkRegistry(c, r.row.agent, r.row.title) : {};
  return { ok: true, task: r.row, duplicate: r.duplicate, ...link };
}

async function taskSet(c: LedgerCli): Promise<Result> {
  const cur = c.task(c.p.pos[1]);
  c.requireOwnOrManager(cur, "改任务字段");
  const rev = intFlag(c.p, "rev");
  if (rev === undefined) throw new LedgerError("invalid", "改任务要带 --rev（show 里看当前 rev）");
  const r = setTask(c.db, c.ctx(), { id: cur.id, rev, patch: fieldsFrom(c, TASK_FLAGS) as never });
  const relink = !r.duplicate && r.row.agent && r.row.agent !== cur.agent;
  return { ok: true, task: r.row, duplicate: r.duplicate, ...(relink ? await linkRegistry(c, r.row.agent as string, r.row.title) : {}) };
}

function stage(c: LedgerCli): Result {
  const r = moveStage(c.db, c.ctx(), { taskId: c.task(c.p.pos[1]).id, from: stageFlag(c, "from"), to: stageFlag(c, "to"), text: c.p.flags.text });
  return { ok: true, task: r.row, event: r.event, duplicate: r.duplicate };
}

/** note：任务上执行者本人也能写；事项与项目级只有 PM / master / owner */
function note(c: LedgerCli): Result {
  const t = c.target(c.p.pos[1]);
  if (t.task) c.requireOwnOrManager(t.task, "写进展");
  else c.requireManager(t.project, "写事项 / 项目级进展");
  const r = appendEvent(c.db, c.ctx(), { project: t.project, target: t.target, kind: "note", text: c.text(2) });
  return { ok: true, event: r.event, duplicate: r.duplicate };
}

function deliverCmd(c: LedgerCli): Result {
  const task = c.task(c.p.pos[1]);
  c.requireOwnOrManager(task, "交付");
  const moveFrom = c.p.flags.from === undefined ? undefined : stageFlag(c, "from");
  const r = deliver(c.db, c.ctx(), { taskId: task.id, headSHA: c.p.flags.head, evidence: c.p.flags.evidence, text: c.p.flags.text, moveFrom });
  return { ok: true, task: r.row, event: r.event, duplicate: r.duplicate };
}

function review(c: LedgerCli): Result {
  const task = c.task(c.p.pos[1]);
  c.requireManager(task.project, "记审查结论");
  const counts = { p0: intFlag(c.p, "p0"), p1: intFlag(c.p, "p1"), p2: intFlag(c.p, "p2") };
  if (Object.values(counts).some((v) => v === undefined)) throw new LedgerError("invalid", "要带 --p0 --p1 --p2（没有就写 0）");
  const move = c.p.flags.to === undefined ? undefined : { from: "review" as const, to: stageFlag(c, "to") };
  const r = recordReview(c.db, c.ctx(), {
    taskId: task.id, reviewer: c.need("reviewer"), verdict: c.need("verdict") as never, ...(counts as { p0: number; p1: number; p2: number }),
    path: c.p.flags.path, text: c.p.flags.text, move,
  });
  return { ok: true, task: r.row, event: r.event, duplicate: r.duplicate };
}

/** decision / deploy / verify / rollback：PM / master / owner；data 由各自的旗标组成 */
function managerEvent(kind: AppendableKind, build: (c: LedgerCli) => { target: string; text?: string; data: Record<string, unknown> }) {
  return (c: LedgerCli): Result => {
    const b = build(c);
    const t = c.target(b.target);
    c.requireManager(t.project, `记 ${kind}`);
    const r = appendEvent(c.db, c.ctx(), { project: t.project, target: t.target, kind, text: b.text, data: b.data });
    return { ok: true, event: r.event, duplicate: r.duplicate };
  };
}

/** owner 本人写的是原话；别人（PM 转述 owner 的话）一律标「转录」 */
const decision = managerEvent("decision", (c) => ({
  target: c.p.pos[1],
  text: c.text(2),
  data: { transcribed: c.deps.actor !== "owner" || c.p.bools.has("transcribed") },
}));
const deploy = managerEvent("deploy", (c) => ({
  target: c.task(c.p.pos[1]).id,
  text: c.p.flags.text,
  data: { version: c.need("version"), rollbackPoint: c.p.flags["rollback-point"] ?? null },
}));
const verify = managerEvent("verify", (c) => {
  const result = c.need("result");
  if (result !== "pass" && result !== "fail") throw new LedgerError("invalid", "--result 只能是 pass / fail");
  return { target: c.task(c.p.pos[1]).id, text: c.p.flags.text, data: { result, evidence: c.p.flags.evidence ?? null } };
});
const rollback = managerEvent("rollback", (c) => ({ target: c.task(c.p.pos[1]).id, text: c.p.flags.text, data: { to: c.p.flags.to ?? null } }));

function freeze(frozen: boolean) {
  return (c: LedgerCli): Result => {
    const project = c.project();
    c.requireManager(project, frozen ? "冻结合并队列" : "解冻合并队列");
    const reason = frozen ? c.need("reason") : c.p.flags.text;
    const r = setFrozen(c.db, c.ctx(), { project, frozen, reason });
    return { ok: true, meta: r.row, event: r.event, duplicate: r.duplicate };
  };
}

export interface CommandSpec {
  valued: string[];
  bools?: string[];
  usage: string;
  run(c: LedgerCli): Result | Promise<Result>;
}

export const WRITE_CMDS: Record<string, CommandSpec> = {
  "item-new": { valued: ITEM_VALUED, usage: "item-new <id> --title <t> [--status --priority --owner-words --one-line --next --extra <json>]", run: itemNew },
  "item-set": { valued: [...ITEM_VALUED, "rev"], usage: "item-set <id> --rev <n> [--title --status --priority --owner-words --one-line --next --extra]", run: itemSet },
  "task-new": {
    valued: [...TASK_VALUED, "kind", "project"],
    usage: "task-new <id> --title <t> --kind code|investigate|ops [--item --agent --pm --branch --pr --head --spec --model --extra]",
    run: taskNew,
  },
  "task-set": { valued: [...TASK_VALUED, "rev"], usage: "task-set <id> --rev <n> [--title --item --agent --pm --branch --pr --head --spec --model --extra]", run: taskSet },
  stage: { valued: ["from", "to", "text", "dedup"], usage: "stage <task> --from <当前阶段> --to <阶段> [--text]", run: stage },
  note: { valued: ["project", "dedup"], usage: "note <task|item|-> <正文>", run: note },
  deliver: { valued: ["head", "evidence", "from", "text", "dedup"], usage: "deliver <task> [--head <sha>] [--evidence <path>] [--from build|fix] [--text]", run: deliverCmd },
  review: {
    valued: ["reviewer", "verdict", "p0", "p1", "p2", "path", "text", "to", "dedup"],
    usage: "review <task> --reviewer <r> --verdict pass|changes|block --p0 N --p1 N --p2 N [--path <md>] [--text] [--to fix|merge|done|spec]",
    run: review,
  },
  decision: { valued: ["project", "dedup"], bools: ["transcribed"], usage: "decision <task|item|-> <原话> [--transcribed]", run: decision },
  deploy: { valued: ["version", "rollback-point", "text", "dedup"], usage: "deploy <task> --version <v> [--rollback-point <x>] [--text]", run: deploy },
  verify: { valued: ["result", "evidence", "text", "dedup"], usage: "verify <task> --result pass|fail [--evidence <path>] [--text]", run: verify },
  rollback: { valued: ["to", "text", "dedup"], usage: "rollback <task> [--to <version>] [--text]", run: rollback },
  freeze: { valued: ["reason", "project", "dedup"], usage: "freeze --reason <原因>", run: freeze(true) },
  unfreeze: { valued: ["text", "project", "dedup"], usage: "unfreeze [--text]", run: freeze(false) },
};

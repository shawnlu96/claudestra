/**
 * `ledger` 的写子命令（docs 10-ledger §3 动作表）：参数 → lib/ledger-write.ts。角色：阶段与 meta 由库判，其余在这里（LedgerCli.require*）。
 * task-new / task-set 改执行者时经 T4 的派发规则联动 registry 的 parent / task（manager/team.ts），台账先写、registry 后写。
 */
import { normalizePeerAgent } from "../lib/ledger-checks.js";
import { workStage } from "../lib/ledger-deps.js";
import { parseExtraChecks, parseExtraRepo } from "../lib/ledger-probes.js";
import { STAGES, TASK_KINDS, type LedgerTask, type Stage, type TaskKind } from "../lib/ledger-stages.js";
import { reopenAssignment } from "../lib/ledger-human.js";
import { getMeta, LedgerError } from "../lib/ledger-store.js";
import { pathLike } from "../lib/quote-text.js";
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
import { checkMergeGate, checkTaskRefs } from "./ledger-field-checks.js";
import { agentKey, intFlag, jsonObjectFlag } from "./ledger-identity.js";
import { MASTER_PARENT, TASK_MAX, validateParent, validateTask } from "./team.js";
import { structuredReviewFlags } from "./ledger-scheduler-observe-cmds.js";
import { autoReviewWriter } from "../lib/scheduler-auto-review.js";
import { witnessMismatch } from "../lib/caller-witness.js";
import { ensureReviewScope } from "../lib/order-deliver-scope.js";
import { grantResume } from "../lib/ledger-autostart-resume.js";

const ITEM_FLAGS: Record<string, string> = { title: "title", status: "status", priority: "priority", "owner-words": "ownerWords", "one-line": "oneLine", next: "next" };
const TASK_FLAGS: Record<string, string> = {
  title: "title", item: "itemId", agent: "agent", "assignee-kind": "assigneeKind", assignee: "assignee", pm: "pm", branch: "branch", pr: "pr", head: "headSHA", spec: "spec", model: "model",
};
const ITEM_VALUED = [...Object.keys(ITEM_FLAGS), "extra", "project", "dedup"];
const TASK_VALUED = [...Object.keys(TASK_FLAGS), "extra", "brief", "dedup"];
const BRIEF_MAX = 600;

/** assignee 按类型归一：本机 agent → registry 键；peer_agent 的指纹转小写、agent 部分 NFKC + 小写；human 原样。格式由库校验 */
function normalizeAssignee(v: string, kind: string | null): string | null {
  if (!v) return null;
  if (kind === "agent") return agentKey(v);
  const slash = v.indexOf("/");
  return kind === "peer_agent" && slash > 0 ? `${v.slice(0, slash).toLowerCase()}/${normalizePeerAgent(v.slice(slash + 1))}` : v;
}

/** 旗标 → 字段 patch；agent / pm 归一成 registry 键，空串 = 清空 */
function fieldsFrom(c: LedgerCli, map: Record<string, string>, curKind: string | null = null): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [flag, field] of Object.entries(map)) {
    const v = c.p.flags[flag];
    if (v === undefined) continue;
    if (field === "assignee") out[field] = normalizeAssignee(v, c.p.flags["assignee-kind"] ?? curKind);
    else out[field] = field === "agent" || field === "pm" ? (v ? agentKey(v) : null) : field === "assigneeKind" ? v || null : v;
  }
  const extra = jsonObjectFlag(c.p, "extra");
  if (extra) {
    // 写进去的时候就拦：等到 verify 才报错，PM 早就以为检查单 / 仓库声明配好了
    try {
      parseExtraChecks(extra.checks);
      parseExtraRepo(extra.repo);
    } catch (e) {
      throw new LedgerError("invalid", (e as Error).message);
    }
  }
  if (extra) out.extra = extra;
  return out;
}

function stageFlag(c: LedgerCli, name: string): Stage {
  const v = c.need(name);
  if (!STAGES.includes(v as Stage)) throw new LedgerError("invalid", `--${name} 不是阶段：${v}（${STAGES.join(" / ")}）`);
  return v as Stage;
}

/** 按码点截到 TASK_MAX 个 UTF-16 单位以内（registry 的 task 按 .length 限长），不把 emoji 截成半个 */
export function truncateTask(title: string): { task: string; truncated: boolean } {
  let out = "";
  for (const ch of title) {
    if (out.length + ch.length > TASK_MAX) return { task: out, truncated: true };
    out += ch;
  }
  return { task: out, truncated: false };
}

/**
 * 执行者挂到派活的人下面、任务名写进 registry（与 T4 team-link 同一套校验）。registry 里没有这个 agent（还没派人）就只写台账。
 * 台账已经写成功了，所以这里任何失败都不让命令变 ok:false：parent 不合法 / 任务名不合法跳过那一项，读写 registry 出错返回 registryError。
 * 重复执行是安全的（同样的值再写一遍），dedup 重试时也会再跑一次，把上次没挂上的补上。
 */
async function linkRegistry(c: LedgerCli, agent: string, title: string): Promise<Result> {
  try {
    return await writeLink(c, agent, title);
  } catch (e) {
    return { registryLinked: false, registryError: (e as Error).message };
  }
}

async function writeLink(c: LedgerCli, agent: string, title: string): Promise<Result> {
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
  const { task, truncated } = truncateTask(title.trim());
  if (truncated) out.taskTruncated = true;
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
  checkTaskRefs(c.p.flags);
  const fields = withBrief(c, fieldsFrom(c, TASK_FLAGS), {});
  const r = createTask(c.db, c.ctx(), { ...fields, project, id: c.p.pos[1] ?? "", title: c.need("title"), kind } as never);
  const link = r.row.agent ? await linkRegistry(c, r.row.agent, r.row.title) : {};
  return { ok: true, task: r.row, duplicate: r.duplicate, ...link };
}
/**
 * --brief：PM 给 human 节点写的几句背景，存 extra.brief，bridge 开指派 ask 时放进正文（规格卡原文不截取、不外发）。
 * 空串 = 清掉；和 --extra 同给时并进 --extra，否则并进任务现有的 extra（setTask 整列替换 extra）。
 */
function withBrief(c: LedgerCli, fields: Record<string, unknown>, curExtra: Record<string, unknown>): Record<string, unknown> {
  const raw = c.p.flags.brief;
  if (raw === undefined) return fields;
  const brief = raw.trim();
  if (brief.length > BRIEF_MAX) throw new LedgerError("invalid", `--brief 最多 ${BRIEF_MAX} 字`);
  const { brief: _old, ...rest } = (fields.extra as Record<string, unknown> | undefined) ?? curExtra;
  return { ...fields, extra: brief ? { ...rest, brief } : rest };
}

/** 合并之后 PR / 分支 / head 就是完成检查单的依据，执行者不能再改（PM 纠错仍可） */
const SHIPPED: readonly string[] = ["merge", "live", "verified", "done"];
/** blocked 按进 blocked 前的阶段算：merge → blocked 期间照样不许换 head（tests/ledger-merge-gate.test.ts） */
const shipped = (t: LedgerTask) => SHIPPED.includes(workStage(t));

/**
 * merge 及以后换成不同的 head = 没审过的代码顶替审过的（阶段不动，合并门不会再跑），deliver / task-set 谁来都拒，PM 也一样；
 * 相同的 head、只补 --pr / --branch 照常放行（PM verify 前常这样补字段）
 */
function checkShippedHead(task: LedgerTask, head: string | undefined): void {
  if (!shipped(task) || head === undefined || head === task.headSHA) return;
  const at = task.stage === "blocked" ? `blocked（之前在 ${task.stageBefore}）` : task.stage;
  // 退回 review 换不了 head（ledger-steps-write.ts checkReviewHead），要退到 fix 再带 --from fix 交付；blocked(merge) 只能先回 review
  const how = task.stage === "blocked" ? `（stage --from blocked --to review，再 --from review --to fix）` : workStage(task) === "merge" ? `（stage --from merge --to fix）` : "";
  throw new LedgerError("conflict", `任务 ${task.id} 已在 ${at}，head ${head} 跟台账的 ${task.headSHA ?? "（空）"} 不一样：先由 PM 退回 fix${how}，再 deliver --from fix --head ${head}、派审`);
}

/** 执行者只能改自己任务的这几项；标题、事项、规格、extra、执行者、PM 要 PM / master / owner */
const EXECUTOR_TASK_FLAGS = new Set(["rev", "dedup", "branch", "pr", "head", "model"]);

async function taskSet(c: LedgerCli): Promise<Result> {
  const cur = c.task(c.p.pos[1]);
  c.requireOwnOrManager(cur, "改任务字段");
  const extraFlags = Object.keys(c.p.flags).filter((f) => !EXECUTOR_TASK_FLAGS.has(f));
  if (extraFlags.length && c.role(cur.project, cur) === "executor") {
    throw new LedgerError("forbidden", `执行者只能改 --branch / --pr / --head / --model，${extraFlags.map((f) => `--${f}`).join(" ")} 要 PM 改`);
  }
  if (c.role(cur.project, cur) === "executor" && shipped(cur) && ["pr", "branch", "head"].some((f) => c.p.flags[f] !== undefined)) {
    throw new LedgerError("forbidden", `任务 ${cur.id} 已在 ${cur.stage}，执行者不能再改 --pr / --branch / --head（完成检查单按它们核对上线）`);
  }
  checkShippedHead(cur, c.p.flags.head);
  const rev = intFlag(c.p, "rev");
  if (rev === undefined) throw new LedgerError("invalid", "改任务要带 --rev（show 里看当前 rev）");
  checkTaskRefs(c.p.flags);
  const r = setTask(c.db, c.ctx(), { id: cur.id, rev, patch: withBrief(c, fieldsFrom(c, TASK_FLAGS, cur.assigneeKind), cur.extra) as never });
  // dedup 重试：上次是否改了执行者看不出来，只要这次带了 --agent / --assignee 就再挂一次（幂等）
  const relink = r.row.agent && (r.duplicate ? c.p.flags.agent !== undefined || c.p.flags.assignee !== undefined : r.row.agent !== cur.agent);
  return { ok: true, task: r.row, duplicate: r.duplicate, ...(relink ? await linkRegistry(c, r.row.agent as string, r.row.title) : {}) };
}

function stage(c: LedgerCli): Result {
  const task = c.task(c.p.pos[1]);
  const from = stageFlag(c, "from");
  const to = stageFlag(c, "to");
  // review → merge 手动推（不记审查结论）只给 PM，也要过合并闸门：还欠对抗式就拦，跳过对抗式统一走 review --waive
  if (from === "review" && to === "merge") {
    c.requireRealPm(task.project, "不记审查结论直接 review → merge ");
    checkMergeGate(c, task);
  }
  // blocked 回 merge 同样过门：blocked 期间欠下的（或修这条之前换过的 head）不能借解除 blocked 进 merge
  if (from === "blocked" && to === "merge") checkMergeGate(c, task);
  const r = moveStage(c.db, c.ctx(), { taskId: task.id, from, to, text: c.p.flags.text });
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

const PATH_ONLY = (flag: string) => `${flag} 只收文件路径：字母数字和 ASCII 路径标点，不含空白、全角标点、控制或不可见字符`;

async function deliverCmd(c: LedgerCli): Promise<Result> {
  const task = c.task(c.p.pos[1]);
  c.requireOwnOrManager(task, "交付");
  // mcp-deliver: 键只属于执行者本人的正式单交付（bridge 以调用方身份写），PM / 别人不能借它冒充本人交付去触发自动交回
  if (c.p.flags.dedup?.startsWith("mcp-deliver:") && c.deps.actor !== task.agent) throw new LedgerError("forbidden", "正式单交付只能是卡的执行者本人");
  const moveFrom = c.p.flags.from === undefined ? undefined : stageFlag(c, "from");
  // 证据 / 结论只收路径：它们会进 bridge 通知和审查员 prompt（lib/quote-text.ts pathLike）
  if (c.p.flags.evidence !== undefined && !pathLike(c.p.flags.evidence)) throw new LedgerError("invalid", PATH_ONLY("--evidence"));
  checkTaskRefs({ head: c.p.flags.head });
  checkShippedHead(task, c.p.flags.head);
  const expect = { rev: intFlag(c.p, "rev"), branch: c.p.flags.branch };
  const r = deliver(c.db, c.ctx(), { taskId: task.id, headSHA: c.p.flags.head, evidence: c.p.flags.evidence, text: c.p.flags.text, moveFrom, pr: c.p.flags.pr, expect, disputes: c.p.flags.disputes });
  await ensureReviewScope(c.db, task.id); // 规格外文件在交付事务外登记，本机 take_review 只读（i28-ASK2）
  // routed：项目开了编排班子，bridge 会自动通知调度助理 / PM，执行者不用再发消息（roles/executor.md）
  return { ok: true, task: r.row, event: r.event, duplicate: r.duplicate, routed: getMeta(c.db, task.project).team !== null };
}

/** 一次性「本人交付后自动交回派审」资格：只给真 PM（调度助理 / 调度服务 / 执行者都不行），事务在 lib/ledger-autostart-resume.ts、前置在 lib/order-local-deliver.ts */
function resumeGrantCmd(c: LedgerCli): Result {
  const task = c.task(c.p.pos[1]);
  c.requireRealPm(task.project, "授予自动交回资格");
  const need = (f: string): number => {
    const v = intFlag(c.p, f);
    if (v === undefined) throw new LedgerError("invalid", `要带 --${f}`);
    return v;
  };
  const r = grantResume(c.db, c.ctx(), { taskId: task.id, taskRev: need("rev"), workflowRev: need("workflow-rev"), reason: c.need("reason"), ttlHours: intFlag(c.p, "ttl-h") });
  return { ok: true, grant: r.grant, event: r.event, duplicate: r.duplicate };
}

async function review(c: LedgerCli): Promise<Result> {
  const task = c.task(c.p.pos[1]);
  const bound = autoReviewWriter(c.db, task, c.deps, c.p.flags);
  if (!bound) c.requireManager(task.project, "记审查结论");
  const counts = { p0: intFlag(c.p, "p0"), p1: intFlag(c.p, "p1"), p2: intFlag(c.p, "p2") };
  if (Object.values(counts).some((v) => v === undefined)) throw new LedgerError("invalid", "要带 --p0 --p1 --p2（没有就写 0）");
  if (c.p.flags.path !== undefined && !pathLike(c.p.flags.path)) throw new LedgerError("invalid", PATH_ONLY("--path"));
  const move = c.p.flags.to === undefined ? undefined : { from: "review" as const, to: stageFlag(c, "to") };
  const verdict = c.need("verdict");
  const waive = waiveFlag(c, task, verdict);
  if (move?.to === "merge") checkMergeGate(c, task, { verdict, waive });
  const w = bound && c.deps.callerWitness ? await c.deps.callerWitness() : null;
  const witness = w && bound ? { ...w, mismatch: witnessMismatch(w, bound) } : undefined;
  const r = recordReview(c.db, c.ctx(), {
    taskId: task.id, reviewer: c.need("reviewer"), verdict: verdict as never, ...(counts as { p0: number; p1: number; p2: number }),
    path: c.p.flags.path, text: c.p.flags.text, move, ...(waive ? { waive } : {}), ...structuredReviewFlags(c), ...(witness ? { witness } : {}),
  });
  return { ok: true, task: r.row, event: r.event, duplicate: r.duplicate };
}

/** human 节点的指派 ask 过期了、或 blocked 回到 build 而 round 没变：重开一条（角色与阶段由 ledger-human.ts 判） */
function askReopen(c: LedgerCli): Result {
  const r = reopenAssignment(c.db, c.ctx(), c.task(c.p.pos[1]).id);
  return { ok: true, task: r.row, event: r.event, seq: r.event.data.seq, duplicate: r.duplicate };
}

/**
 * `--waive adversarial --text <理由>`：PM 看过对抗式之后的小增量、决定不再派对抗式就合时的显式豁免，只对当前 head 有效
 * （之后再交付新 head 又欠，lib/ledger-handler.ts owesAdversarial）。只给 PM（调度助理除外），要判通过、要写理由（记在事件正文）。
 */
function waiveFlag(c: LedgerCli, task: LedgerTask, verdict: string): "adversarial" | undefined {
  const w = c.p.flags.waive;
  if (w === undefined) return undefined;
  if (w !== "adversarial") throw new LedgerError("invalid", "--waive 只能是 adversarial");
  c.requireRealPm(task.project, "豁免对抗式");
  if (verdict !== "pass") throw new LedgerError("invalid", "--waive adversarial 只能配 --verdict pass");
  if (!c.p.flags.text?.trim()) throw new LedgerError("invalid", "--waive adversarial 要用 --text 写明理由");
  return w;
}

/** decision / deploy / rollback：PM / master / owner；data 由各自的旗标组成（verify 在 ledger-verify.ts，由系统核对） */
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
    usage:
      "task-new <id> --title <t> --kind code|investigate|ops [--item --agent | --assignee-kind agent|human|peer_agent " +
      "--assignee <agent 名 | local:<principalId> | <fp>/<agent>>] [--pm --branch --pr --head --spec --model --extra --brief <给人的背景>]",
    run: taskNew,
  },
  "task-set": {
    valued: [...TASK_VALUED, "rev"],
    usage: "task-set <id> --rev <n> [--title --item --agent | --assignee-kind --assignee] [--pm --branch --pr --head --spec --model --extra --brief]",
    run: taskSet,
  },
  stage: { valued: ["from", "to", "text", "dedup"], usage: "stage <task> --from <当前阶段> --to <阶段> [--text]（进 verified 用 ledger verify）", run: stage },
  note: { valued: ["project", "dedup"], usage: "note <task|item|-> <正文>", run: note },
  "ask-reopen": { valued: ["dedup"], usage: "ask-reopen <task>（指给人的 ask 过期了、或点了做不了之后要再派一次时重开一条；旧的由 bridge 撤掉）", run: askReopen },
  deliver: {
    valued: ["head", "evidence", "from", "text", "dedup", "rev", "branch", "pr", "disputes"],
    usage: "deliver <task> [--head <sha>] [--evidence <path>] [--from build|fix] [--text] [--disputes JSON] [--rev <n> --branch <b>：前置条件，卡已不是这个 rev / 分支就拒]" +
      " [--pr <完整 PR URL>：卡上空或非完整时同一事务写入，已是另一个完整 URL 就拒]",
    run: deliverCmd,
  },
  "resume-grant": {
    valued: ["rev", "workflow-rev", "reason", "ttl-h", "dedup"],
    usage: "resume-grant <task> --rev N --workflow-rev N --reason <r> [--ttl-h 1–72，默认 24]（真 PM：执行者本人经正式单交了新 head 后自动交回派审，只一次）",
    run: resumeGrantCmd,
  },
  review: {
    valued: ["reviewer", "verdict", "p0", "p1", "p2", "path", "text", "to", "waive", "dedup", "head", "session", "family", "findings"],
    usage: "review <task> --reviewer <r> --verdict pass|changes|block --p0 N --p1 N --p2 N [--path <md>] [--text] [--to fix|merge|done|spec] [--waive adversarial]" +
      " [--head <完整 sha> --session <审查 session id> --family claude|codex --findings <逐项结论.json>]",
    run: review,
  },
  decision: { valued: ["project", "dedup"], bools: ["transcribed"], usage: "decision <task|item|-> <原话> [--transcribed]", run: decision },
  deploy: { valued: ["version", "rollback-point", "text", "dedup"], usage: "deploy <task> --version <v> [--rollback-point <x>] [--text]", run: deploy },
  rollback: { valued: ["to", "text", "dedup"], usage: "rollback <task> [--to <version>] [--text]", run: rollback },
  freeze: { valued: ["reason", "project", "dedup"], usage: "freeze --reason <原因>", run: freeze(true) },
  unfreeze: { valued: ["text", "project", "dedup"], usage: "unfreeze [--text]", run: freeze(false) },
};

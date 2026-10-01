/**
 * 内置台账写入前的纯校验与输入类型（ledger-write.ts 用）：字段白名单、枚举、引用存在、id 不撞名、导入口权限、写入上下文。
 * 只读不写——写事件的入口只在 ledger-write.ts，这里拆出来只为让它守住 400 行。
 */
import type { Database } from "bun:sqlite";
import {
  ASSIGNEE_KINDS,
  isStageOfKind,
  ITEM_STATUSES,
  isManagerRole,
  roleOf,
  STAGES,
  TASK_KINDS,
  type AssigneeKind,
  type ItemStatus,
  type LedgerEvent,
  type LedgerItem,
  type LedgerTask,
  type ReviewVerdict,
  type Stage,
  type TaskKind,
} from "./ledger-stages.js";
import { getItem, getMeta, getTask, LedgerError } from "./ledger-store.js";
import { AGENT_NAME_BLOCKLIST_RE, invisibleNameError } from "./registry.js";
import { FP_RE } from "./relay-protocol.js";

/** specRev 不在里面：它只由阶段机（回退到 spec）维护 */
export const ITEM_FIELDS = ["title", "ownerWords", "priority", "status", "oneLine", "next", "extra"] as const;
export const TASK_FIELDS = ["title", "itemId", "agent", "assigneeKind", "assignee", "pm", "branch", "pr", "headSHA", "spec", "model", "extra"] as const;

export type ItemPatch = Partial<Pick<LedgerItem, (typeof ITEM_FIELDS)[number]>>;
export type TaskPatch = Partial<Pick<LedgerTask, (typeof TASK_FIELDS)[number]>>;

export function pick<K extends string>(patch: Record<string, unknown>, allowed: readonly K[], what: string): Partial<Record<K, unknown>> {
  const bad = Object.keys(patch).filter((k) => !(allowed as readonly string[]).includes(k));
  if (bad.length) throw new LedgerError("invalid", `${what} 不能改这些字段：${bad.join(", ")}`);
  if (!Object.keys(patch).length) throw new LedgerError("invalid", `${what} 没有要改的字段`);
  return patch as Partial<Record<K, unknown>>;
}

export function checkStatus(status: unknown): void {
  if (!ITEM_STATUSES.includes(status as ItemStatus)) throw new LedgerError("invalid", `事项状态只能是 ${ITEM_STATUSES.join(" / ")}，收到 ${String(status)}`);
}

export function checkItemRef(db: Database, project: string, itemId: unknown): void {
  if (itemId == null) return;
  if (!getItem(db, project, String(itemId))) throw new LedgerError("not_found", `项目 ${project} 没有事项 ${String(itemId)}`);
}

/** 指标按 target 取事件：事项 id 与任务 id 撞了，事项的事件会被算进任务 */
export function checkIdFree(db: Database, id: string, as: "item" | "task"): void {
  const taken = as === "item" ? getTask(db, id) : db.prepare("SELECT 1 FROM items WHERE id = ?").get(id);
  if (taken) throw new LedgerError("conflict", `id ${id} 已被${as === "item" ? "任务" : "事项"}占用，事项与任务不能同名`);
}

function isCount(v: unknown): boolean {
  return Number.isInteger(v) && (v as number) >= 0;
}

export function mustTask(db: Database, id: string): LedgerTask {
  const t = getTask(db, id);
  if (!t) throw new LedgerError("not_found", `没有任务 ${id}`);
  return t;
}

/** 自由追加事件的目标：本项目的任务或事项，"" 为项目级 */
export function checkTarget(db: Database, project: string, target: string): void {
  if (!target) return;
  const task = getTask(db, target);
  if (task?.project === project || getItem(db, project, target)) return;
  throw new LedgerError("not_found", `项目 ${project} 里没有任务或事项 ${target}`);
}

export interface NewItem {
  project: string;
  id: string;
  title: string;
  status?: ItemStatus;
  ownerWords?: string;
  priority?: string;
  oneLine?: string;
  next?: string;
  extra?: Record<string, unknown>;
}

export interface NewTask {
  project: string;
  id: string;
  title: string;
  kind: TaskKind;
  itemId?: string | null;
  agent?: string | null;
  assigneeKind?: AssigneeKind | null;
  assignee?: string | null;
  pm?: string | null;
  branch?: string | null;
  pr?: string | null;
  headSHA?: string | null;
  spec?: string | null;
  specRev?: number;
  model?: string | null;
  extra?: Record<string, unknown>;
  /** 默认 spec / 0；只有 owner 能带别的值（导入历史任务直接落在当时的阶段），事件记 imported */
  stage?: Stage;
  round?: number;
}

/** 校验新任务，返回是不是导入（非默认的 stage / round）；导入口只给 owner，否则任何人都能建一个直接在 live 的任务绕过阶段机 */
export function checkNewTask(db: Database, actor: string, input: NewTask): boolean {
  if (!input.id || !input.title) throw new LedgerError("invalid", "任务要有 id 和 title");
  if (!TASK_KINDS.includes(input.kind)) throw new LedgerError("invalid", `任务 kind 只能是 ${TASK_KINDS.join(" / ")}`);
  const stage = input.stage ?? "spec";
  if (!STAGES.includes(stage) || !isStageOfKind(input.kind, stage)) throw new LedgerError("invalid", `${input.kind} 任务不能落在阶段 ${stage}`);
  for (const k of ["round", "specRev"] as const) {
    if (input[k] !== undefined && !isCount(input[k])) throw new LedgerError("invalid", `${k} 要是非负整数`);
  }
  const imported = stage !== "spec" || (input.round ?? 0) !== 0;
  if (imported && !isOwnerLike(actor)) throw new LedgerError("forbidden", "只有 owner 能直接建在非 spec 阶段或带 round 的任务（导入用）");
  if (getTask(db, input.id)) throw new LedgerError("conflict", `任务 ${input.id} 已存在（任务 id 全局唯一）`);
  checkIdFree(db, input.id, "task");
  checkItemRef(db, input.project, input.itemId);
  return imported;
}

type Assignment = Pick<LedgerTask, "agent" | "assigneeKind" | "assignee">;
/** registry 键的长度上限：manager 裸名 ≤ 48，加上 agent- 前缀留余量 */
const AGENT_NAME_MAX = 64;
/** 本机的人：owner 或 guest principal（lib/devices.ts 的 id 形状）；token principal 可能是 peer，不算人 */
const HUMAN_RE = /^local:(owner:self|guest:[0-9a-f]{1,64})$/;

/** 本机 agent 名：与 manager 建 agent 同一份黑名单（lib/registry.ts），owner 是身份保留名（master 就是大总管本人，可以） */
function isAgentName(name: string): boolean {
  return name.length > 0 && [...name].length <= AGENT_NAME_MAX && !AGENT_NAME_BLOCKLIST_RE.test(name) && name !== "owner";
}

/**
 * assignee 的三种格式（docs 28-human-collab 附录 B-2）：agent = 本机 agent 名；human = local:<principalId>；
 * peer_agent = <fp>/<agent>，fp 是对方实例的指纹——peer 的名字能改、会重名，不能当键。
 * peer 的 agent 部分要求已归一（NFKC + 小写，CLI 负责归一），否则 fp/Agent-X 与 fp/agent-x 会被当成两个人。返回错误原因，合格为 null。
 */
export function assigneeFormatError(kind: AssigneeKind, who: string): string | null {
  if (kind === "agent") return isAgentName(who) ? null : "本机 agent 名（不含空白、点号 .、引号、/ \\ : ~ 等，不能是 owner）";
  if (kind === "human") return HUMAN_RE.test(who) ? null : "local:<principalId>，如 local:owner:self、local:guest:1a2b3c4d";
  const slash = who.indexOf("/");
  const agent = who.slice(slash + 1);
  const ok = slash > 0 && FP_RE.test(who.slice(0, slash)) && isAgentName(agent) && agent === normalizePeerAgent(agent);
  return ok ? null : "<fp>/<agent>，fp 是对方指纹（xxxx-xxxx-xxxx-xxxx 小写十六进制），agent 小写";
}

/** peer agent 名的归一：NFKC（全角 → 半角等）+ 小写 */
export function normalizePeerAgent(name: string): string {
  return name.normalize("NFKC").toLowerCase();
}

function checkAssignee(kind: unknown, who: string): void {
  if (!ASSIGNEE_KINDS.includes(kind as AssigneeKind)) throw new LedgerError("invalid", `assigneeKind 只能是 ${ASSIGNEE_KINDS.join(" / ")}，收到 ${String(kind)}`);
  const invisible = kind === "human" ? null : invisibleNameError(who);
  if (invisible) throw new LedgerError("invalid", `${invisible}：${JSON.stringify(who)}`);
  const err = assigneeFormatError(kind as AssigneeKind, who);
  if (err) throw new LedgerError("invalid", `${String(kind)} 的 assignee 格式不对（要 ${err}）：${who}`);
}

/**
 * 负责人三列的联动（改 / 建任务都经这里）：agent 列仍是执行者角色的依据（roleOf），所以 kind=agent 时 agent 与 assignee 同值，
 * 人 / 别的实例上的 agent 在本机没有执行者身份，agent 置空。patch 里 agent 与 assignee* 不能同时出现（两个来源会打架）。
 * 返回要写的列；patch 不涉及负责人时为空对象。
 */
export function resolveAssignee(cur: Assignment, patch: Record<string, unknown>): Partial<Assignment> {
  const byAgent = "agent" in patch;
  const byAssignee = "assignee" in patch || "assigneeKind" in patch;
  if (byAgent && byAssignee) throw new LedgerError("invalid", "agent 与 assigneeKind / assignee 不能同时改：本机 agent 用其一即可");
  if (byAgent) {
    const agent = (patch.agent as string | null) || null;
    if (agent) {
      checkAssignee("agent", agent);
      return { agent, assigneeKind: "agent", assignee: agent };
    }
    return cur.assigneeKind === "agent" || cur.assigneeKind === null ? { agent: null, assigneeKind: null, assignee: null } : { agent: null };
  }
  if (!byAssignee) return {};
  const kind = ("assigneeKind" in patch ? patch.assigneeKind : cur.assigneeKind) as AssigneeKind | null;
  const who = (("assignee" in patch ? patch.assignee : cur.assignee) as string | null) || null;
  if (!who) {
    if ("assigneeKind" in patch && patch.assigneeKind) throw new LedgerError("invalid", "给了 assigneeKind 就要同时给 assignee");
    return { agent: null, assigneeKind: null, assignee: null };
  }
  if (!("assignee" in patch)) {
    // 只给了类型：同类型等于没改（不拿旧 assignee 反推 agent——新旧代码混写过的行两列可能不一致），换类型必须带 assignee
    if (kind === cur.assigneeKind) return {};
    throw new LedgerError("invalid", "换负责人类型要同时给 assignee");
  }
  checkAssignee(kind, who);
  return { agent: kind === "agent" ? who : null, assigneeKind: kind, assignee: who };
}

export interface WriteCtx {
  /** 写入者：agent 名 / "master" / "owner" / "import"（身份推导在 CLI） */
  actor: string;
  /** 事件时间（epoch ms），默认 Date.now()；测试注入 */
  now?: number;
  dedupKey?: string;
  /** 只对导入身份生效：这次的事件时间是推断的，事件标 approxTime（事项的创建时间老台账里没有） */
  approxTime?: boolean;
  /** 自动开卡的 claim 授权：只由 ledger-autostart-step.ts 在同一事务里核过 claim 后放入，钩子见 ledger-autostart-grant.ts autostartGrant */
  autostart?: { claim: number; featureId: string; key: string; taskId: string };
}

export interface WriteResult<T> {
  row: T;
  /** 本次动作的主事件（带 dedupKey 的那条） */
  event: LedgerEvent;
  duplicate: boolean;
}

export function toColumn(k: string, v: unknown): unknown {
  return k === "extra" ? JSON.stringify(v ?? {}) : (v ?? null);
}

/** actor 在这个任务上是不是 PM / master / owner（项目 PM 名单现查） */
export function isManager(db: Database, actor: string, task: Pick<LedgerTask, "agent" | "project">): boolean {
  return isManagerRole(roleOf(actor, task, getMeta(db, task.project).pms));
}

export interface StageMove {
  /** 调用方以为的当前阶段（CAS） */
  from: Stage;
  to: Stage;
  /** 交付（build / fix → review）那一步自报的模型：跨实例只能凭声明，和推阶段同一个事务记进那一步的 claims */
  model?: string;
}

const REVIEW_VERDICTS: readonly ReviewVerdict[] = ["pass", "changes", "block"];

export interface ReviewInput {
  taskId: string;
  /** 审查者（PM 的子 agent / Claude 审查员 / agent-codex），由 PM 代写 */
  reviewer: string;
  verdict: ReviewVerdict;
  p0: number;
  p1: number;
  p2: number;
  /** 结论全文路径 */
  path?: string;
  text?: string;
  /** 同一事务推阶段（review → fix / merge / done / spec） */
  move?: StageMove;
  /** 审查方自报的模型（跨实例只能凭声明，记进那一步的 claims） */
  model?: string;
  /** PM 豁免对抗式（review --waive adversarial，权限在 CLI 层判），只对当时的 head 有效（ledger-handler.ts owesAdversarial） */
  waive?: "adversarial";
  /** 自动卡结论的旁证与比对结果（caller-witness.ts），巡检 review_witness_mismatch 读它 */
  witness?: Record<string, unknown>;
  /** T68 结构化结论：四项同给或都不给（scheduler-review.ts checkStructuredReview），规划器只认这些字段 */
  head?: string;
  reviewerSessionId?: string;
  reviewerFamily?: "claude" | "codex";
  findings?: { findingId: string; family: string; severity: "P0" | "P1" | "P2"; probe: string }[];
  /** M3 submit_verdict（lib/review-verdict.ts）：对应的审查单、作者与审查员同家族（调度器据此不让安全 / 并发卡凭它合并）、来路 */
  orderId?: string;
  sameFamily?: boolean | null;
  via?: "mcp";
}

export function checkReview(input: ReviewInput, task: LedgerTask): void {
  if (!REVIEW_VERDICTS.includes(input.verdict)) throw new LedgerError("invalid", `verdict 只能是 ${REVIEW_VERDICTS.join(" / ")}`);
  for (const k of ["p0", "p1", "p2"] as const) {
    if (!isCount(input[k])) throw new LedgerError("invalid", `${k} 要是非负整数`);
  }
  if (task.stage !== "review") throw new LedgerError("invalid", `任务 ${task.id} 在 ${task.stage}，不在 review，不能记审查结论`, { stage: task.stage });
}

/**
 * 调用方可直接追加的事件；stage / item / task / meta / freeze 由对应写函数产生，verify 只由 recordVerify 写（否则能伪造一条「检查通过」）；
 * dispatch / escalate 由 `ledger dispatch` / `ledger escalate` 追加（编排班子）
 */
export const APPENDABLE_KINDS = ["note", "decision", "deploy", "rollback", "dispatch", "escalate"] as const;
export type AppendableKind = (typeof APPENDABLE_KINDS)[number];

/**
 * 导入专用身份：只有 CLI 的 import（已确认是 owner 在跑）会用它。它写的事件一律强制 imported:true（insertEvent），
 * 网页上能和 owner 的真实操作区分开；owner 专属项（导入口、PM 名单）对它放行。registry 键都带 agent- 前缀，撞不上。
 */
export const IMPORT_ACTOR = "import";

export function isOwnerLike(actor: string): boolean {
  return actor === "owner" || actor === IMPORT_ACTOR;
}

/** 导入口能合成的事件种类；建任务事件由 importTask 自己写，item / meta / freeze 不经导入口 */
const IMPORT_EVENT_KINDS = ["stage", "review", "deploy", "note", "decision", "verify", "rollback"] as const;

export interface ImportTaskInput {
  /** 行的最终状态（stage / round 可带，导入口只给 owner） */
  task: NewTask;
  /** 建任务事件记的起始阶段，默认与行相同 */
  initialStage?: Stage;
  /** 建任务事件的时间 */
  createdTs: number;
  /** 建任务时间是推断的（源数据没有派发时间），建任务事件标 approxTime */
  createdApprox?: boolean;
  /** 时间线指纹（建任务时间 + 合成事件），记在建任务事件上：映射改了时间重跑时，调用方拿它判断「值变了」 */
  fingerprint?: string;
  events: { kind: (typeof IMPORT_EVENT_KINDS)[number]; ts: number; text?: string; data?: Record<string, unknown> }[];
}

/** 合成事件：种类在白名单里、ts 是数；stage 事件从 initial 起首尾相接，最后落在 final（没有 stage 事件则 initial 必须就是 final） */
export function checkImportChain(initial: Stage, final: Stage, events: ImportTaskInput["events"]): void {
  let at = initial;
  for (const e of events) {
    if (!IMPORT_EVENT_KINDS.includes(e.kind)) throw new LedgerError("invalid", `导入不能合成 ${String(e.kind)} 事件`);
    if (!Number.isFinite(e.ts)) throw new LedgerError("invalid", `导入事件缺时间：${e.kind}`);
    if (e.kind !== "stage") continue;
    const { from, to } = (e.data ?? {}) as { from?: Stage; to?: Stage };
    if (from !== at || !to || !STAGES.includes(to)) throw new LedgerError("invalid", `导入的阶段事件接不上：当前 ${at}，事件是 ${String(from)}→${String(to)}`);
    at = to;
  }
  if (at !== final) throw new LedgerError("invalid", `导入的阶段事件最后停在 ${at}，任务行是 ${final}`);
}

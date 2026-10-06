/**
 * 项目记忆的三个 MCP 工具 record_memory / mark_memory / show_memory 与 deliver.memoryRefs（设计稿 docs/design/project-memory.md §2.2、§3.4、§4.2）。
 * 身份只取 verified 会话：工具参数里不收 actor / role / author（严格解析，多给就拒）。bridge 侧只解析参数、签一次性票据
 * （lib/verdict-ticket.ts，绑定 actor 与整份参数 + 会话），再以调用方频道跑 `ledger memory-record / memory-mark`；
 * manager 在写连接上认票据、按会话重算角色（memoryRole）、过 memoryLint、再按 §4.2 权限表（canMark）放行——bridge 自己不写台账。
 * 没票据的 CLI 调用（owner 终端、PM 在 Bash 里）只认 owner / master / PM 名单三种角色；执行者 / 审查员角色只能来自 verified 会话 + 当前的单。
 * 出借 worker 走不到这里（bridge/order-tools.ts 先把 agent-lend-* 分给 lend-tools，lend 档白名单里没有这三个工具，PM 定 lend-memory-read）。
 * tests/memory-tools.test.ts、tests/memory-tools-perms.test.ts。
 */
import type { Database } from "bun:sqlite";
import { withOneShot } from "./caller-cred.js";
import { getMemory, listMarks, markMemory, memoryState, recordMemory, type Memory, type MemoryInput, type MemoryMark } from "./ledger-memory.js";
import type { MemoryState } from "./ledger-memory-fold.js";
import type { MemoryAuthorRole, MemoryMarkKind } from "./ledger-memory-schema.js";
import { getMeta, getTask, LedgerError } from "./ledger-store.js";
import type { LedgerTask } from "./ledger-stages.js";
import { memoryLint, sameMemoryWrite, type MemoryLintDeps } from "./memory-lint.js";
import { TOOL_MARKS, WIRE_V } from "./memory-tools-defs.js";
import { MEMORY_ID } from "./memory-tools-wire.js";
import { ledgerWrite, type LedgerRun } from "./order-ledger-exit.js";
import { currentOrders } from "./order-take.js";
import { refuse, type OrderToolHandler, type OrderToolResult, type VerifiedCall } from "./order-tool-route.js";
import { slotByOrderId } from "./review-order.js";
import { issueVerdictTicket } from "./verdict-ticket.js";

export type MemoryRole = MemoryAuthorRole;

/** 调用方：verified = 身份来自 bridge 认过的会话（票据核过）；CLI 直接跑的是 false */
export interface MemoryCaller { actor: string; sessionId: string | null; family: string | null; verified: boolean }

/** 记忆锚在哪张卡上（record_memory 带 orderId 时） */
interface OrderAnchor { task: LedgerTask; head: string | null }

/** 作者撤回自己写的记忆的窗口（§4.2） */
export const AUTHOR_RETRACT_MS = 24 * 3600_000;

// ── 角色 ──

/** 不看单的角色：owner / master（按 PM 一档）/ 调度服务 / 项目 PM 名单 */
function standingRole(db: Database, actor: string, project: string): MemoryRole | null {
  if (actor === "owner") return "owner";
  if (actor === "master") return "pm";
  if (actor === "scheduler") return "system";
  return getMeta(db, project).pms.includes(actor) ? "pm" : null;
}

/** orderId → 卡：调度意图表里的单号，或手动单 `<task>:<step>:r<n>` */
function taskOfOrder(db: Database, orderId: string): LedgerTask | null {
  const has = !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'scheduler_intents'").get();
  const viaIntent = has ? (db.query("SELECT taskId FROM scheduler_intents WHERE id = ?").get(orderId) as { taskId: string } | null)?.taskId : undefined;
  return getTask(db, viaIntent ?? orderId.split(":")[0]);
}

export type RoleResult = { ok: true; role: MemoryRole; project: string; anchor: OrderAnchor | null } | { ok: false; code: string; error: string };

/**
 * 调用方在这件事上的角色。带 orderId：verified 会话的当前写单 → executor，当前审查单 → reviewer（会话 / 家族只取身份），
 * 否则看卡所在项目的 PM 名单 / owner / master；不带 orderId：只看项目上的身份。
 */
export function memoryRole(db: Database, caller: MemoryCaller, opts: { project?: string; orderId?: string }): RoleResult {
  if (opts.orderId) {
    if (caller.verified) {
      const call: VerifiedCall = { agent: caller.actor, sessionId: caller.sessionId, family: caller.family, channelId: "" };
      const cur = currentOrders(db, call).find((o) => o.orderId === opts.orderId);
      if (cur) return { ok: true, role: "executor", project: cur.task.project, anchor: { task: cur.task, head: cur.intent?.head ?? cur.task.headSHA } };
      const slot = slotByOrderId(db, opts.orderId, call);
      if (slot) return { ok: true, role: "reviewer", project: slot.task.project, anchor: { task: slot.task, head: slot.head } };
    }
    const task = taskOfOrder(db, opts.orderId);
    const role = task ? standingRole(db, caller.actor, task.project) : null;
    if (task && role) return { ok: true, role, project: task.project, anchor: { task, head: task.headSHA } };
    return { ok: false, code: "not_current_order", error: `${opts.orderId} 不是你当前的写单 / 审查单，你也不是那张卡项目的 PM / owner` +
      (caller.verified ? "" : "（执行者 / 审查员请用 MCP 工具，CLI 不认会话）") };
  }
  if (!opts.project) return { ok: false, code: "invalid", error: "不带 orderId 时要给 project（项目级记忆只有 PM / owner 能写）" };
  const role = standingRole(db, caller.actor, opts.project);
  return role ? { ok: true, role, project: opts.project, anchor: null }
    : { ok: false, code: "forbidden", error: `你（${caller.actor}）不是项目 ${opts.project} 的 PM / owner；执行者 / 审查员带上当前的 orderId` };
}

// ── §4.2 权限表 ──

/** 人能打的 mark 与谁能打（fixed / reopen 只给调度器身份：人不能手标「已修」） */
export const MARK_PERMISSIONS: Readonly<Record<MemoryMarkKind, readonly MemoryRole[]>> = {
  dispute: ["executor", "reviewer", "pm", "owner", "system"],
  confirm: ["pm", "owner", "reviewer"],
  retract: ["pm", "owner"],
  supersede: ["pm", "owner"],
  link_fix: ["pm", "owner"],
  unlink_fix: ["pm", "owner"],
  fixed: ["system"],
  reopen: ["system"],
};

export interface MarkPermissionCtx { memory: Pick<Memory, "kind" | "author" | "createdAt">; actor: string; now: number }

/** null = 可以；否则是拒绝理由。审查员的 confirm 只对坑；retract 另许作者在 24 小时内撤自己写的 */
export function canMark(role: MemoryRole | null, mark: MemoryMarkKind, ctx: MarkPermissionCtx): string | null {
  if (mark === "retract" && ctx.memory.author === ctx.actor && ctx.now - ctx.memory.createdAt <= AUTHOR_RETRACT_MS) return null;
  if (!role) return mark === "retract" ? "retract 只有 PM / owner，或作者本人在写入后 24 小时内" : `你（${ctx.actor}）在这条记忆的项目上没有角色`;
  if (!MARK_PERMISSIONS[mark].includes(role)) {
    if (mark === "fixed" || mark === "reopen") return `${mark} 只有调度器能标（修复卡上线 / 回滚时自动记），人不能手标`;
    if (mark === "retract") return "retract 只有 PM / owner，或作者本人在写入后 24 小时内";
    return `${mark} 要 ${MARK_PERMISSIONS[mark].join(" / ")}（你是 ${role}）`;
  }
  if (mark === "confirm" && role === "reviewer" && ctx.memory.kind !== "pitfall") return "审查员只能 confirm 坑";
  return null;
}

// ── 参数（严格：多给的字段、身份字段一律拒）──

type Args = Record<string, unknown>;
type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };
const obj = (v: unknown): v is Args => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

function shape(raw: unknown, allowed: readonly string[], required: readonly string[]): string | null {
  if (!obj(raw)) return "参数要是对象";
  const extra = Object.keys(raw).filter((k) => !allowed.includes(k));
  if (extra.length) return `不认识的字段 ${extra.slice(0, 3).join(", ")}（身份只取 verified 会话，不收 actor / role / author）`;
  const missing = required.filter((k) => !(k in raw));
  if (missing.length) return `缺字段 ${missing.join(", ")}`;
  return raw.v === WIRE_V ? null : `v 只认 ${WIRE_V}`;
}

export interface RecordArgs {
  kind: "pitfall" | "summary";
  title: string;
  symptom?: string;
  rule?: string;
  body?: string;
  files: string[];
  family?: string;
  fixable?: boolean;
  orderId?: string;
  project?: string;
}

export function parseRecordArgs(raw: unknown): Parsed<RecordArgs> {
  const bad = shape(raw, ["v", "kind", "title", "symptom", "rule", "body", "files", "family", "fixable", "orderId", "project"], ["v", "kind", "title"]);
  if (bad) return { ok: false, error: bad };
  const a = raw as Args;
  if (a.kind !== "pitfall" && a.kind !== "summary") return { ok: false, error: "kind 只认 pitfall / summary（决定由 decision 事件索引，不经工具）" };
  for (const k of ["title", "symptom", "rule", "body", "family", "orderId", "project"]) if (k in a && !str(a[k])) return { ok: false, error: `${k} 要是非空字符串` };
  if ("files" in a && (!Array.isArray(a.files) || !a.files.every(str))) return { ok: false, error: "files 要是字符串数组" };
  if ("fixable" in a && typeof a.fixable !== "boolean") return { ok: false, error: "fixable 要是布尔" };
  if (a.kind === "pitfall" && (!("symptom" in a) || !("rule" in a) || !("fixable" in a) || "body" in a)) return { ok: false, error: "坑要给 symptom、rule、fixable，不收 body" };
  if (a.kind === "summary" && (!("body" in a) || "symptom" in a || "rule" in a || "fixable" in a || !("orderId" in a))) {
    return { ok: false, error: "总结补充要给 body 与 orderId（锚在卡上），不收 symptom / rule / fixable" };
  }
  if ("orderId" in a && "project" in a) return { ok: false, error: "orderId 与 project 只给一个（带 orderId 时项目取那张卡的）" };
  const { v: _v, ...rest } = a;
  return { ok: true, value: { ...(rest as unknown as RecordArgs), files: (a.files as string[] | undefined) ?? [] } };
}

export interface MarkArgs { memoryId: string; mark: (typeof TOOL_MARKS)[number]; reason?: string; by?: string; taskId?: string; orderId?: string }

export function parseMarkArgs(raw: unknown): Parsed<MarkArgs> {
  const bad = shape(raw, ["v", "memoryId", "mark", "reason", "by", "taskId", "orderId"], ["v", "memoryId", "mark"]);
  if (bad) return { ok: false, error: bad };
  const a = raw as Args;
  if (a.mark === "fixed" || a.mark === "reopen") return { ok: false, error: `${a.mark} 只有调度器能标（修复卡上线 / 回滚时自动记），人不能手标` };
  if (!TOOL_MARKS.includes(a.mark as MarkArgs["mark"])) return { ok: false, error: `mark 只认 ${TOOL_MARKS.join(" / ")}` };
  if (typeof a.memoryId !== "string" || !MEMORY_ID.test(a.memoryId)) return { ok: false, error: "memoryId 格式不对（如 ab12-m6）" };
  for (const k of ["reason", "by", "taskId", "orderId"]) if (k in a && !str(a[k])) return { ok: false, error: `${k} 要是非空字符串` };
  const { v: _v, ...rest } = a;
  return { ok: true, value: rest as unknown as MarkArgs };
}

function parseShowArgs(raw: unknown): Parsed<{ id: string }> {
  const bad = shape(raw, ["v", "id"], ["v", "id"]);
  if (bad) return { ok: false, error: bad };
  const id = (raw as Args).id;
  return typeof id === "string" && MEMORY_ID.test(id) ? { ok: true, value: { id } } : { ok: false, error: "id 格式不对（如 ab12-m6）" };
}

// ── 写（manager 在写连接上调）──

/** 卡上最近一条非 memory 事件：执行者 / 审查员从单上记的坑以它为来源（§2.3 第 5 条：坑要有来源） */
function latestTaskEvent(db: Database, taskId: string): MemoryInput["sources"] {
  const r = db.query("SELECT seq, origin, originSeq FROM events WHERE target = ? AND kind <> 'memory' ORDER BY seq DESC LIMIT 1")
    .get(taskId) as { seq: number; origin: string | null; originSeq: number | null } | null;
  if (!r) return [];
  return [r.origin && r.originSeq ? { origin: r.origin, originSeq: r.originSeq } : { seq: r.seq }];
}

export type MemoryWriteResult = Record<string, unknown> & { ok: true };

/** record_memory / ledger memory-record：角色 → 锚点 → memoryLint → recordMemory。同作者、正文、锚点全一致的重试回已写的那条（duplicate），同类 / 近邻照样拒 */
export function recordAs(db: Database, caller: MemoryCaller, args: RecordArgs, now: number, lintDeps: MemoryLintDeps = {}): MemoryWriteResult {
  const who = memoryRole(db, caller, { project: args.project, orderId: args.orderId });
  if (!who.ok) throw new LedgerError(who.code === "invalid" ? "invalid" : "forbidden", who.error);
  if (who.role === "system") throw new LedgerError("forbidden", "调度器的自动写走 M3 的写入口，不经工具");
  const a = who.anchor;
  const anchored = !!a && !!a.head; // 卡还没有 head（首轮开工前）就只锚 feature，来源事件照带
  const input: MemoryInput = {
    project: who.project, kind: args.kind, title: args.title, symptom: args.symptom, rule: args.rule, body: args.body, files: args.files,
    family: args.family ?? null, ...(args.kind === "pitfall" ? { fixable: args.fixable } : {}),
    taskId: anchored ? a.task.id : null, featureId: a && !anchored ? (a.task.featureId ?? null) : null,
    head: anchored ? a.head : null, specRev: anchored ? a.task.specRev : null,
    sources: a ? latestTaskEvent(db, a.task.id) : [], via: "tool", authorRole: who.role,
  };
  const lint = memoryLint(db, input, lintDeps);
  if (!lint.ok) {
    const prev = lint.duplicateOf ? getMemory(db, lint.duplicateOf) : null;
    if (prev && sameMemoryWrite(prev, caller.actor, input)) return { ok: true, duplicate: true, memoryId: prev.id, status: memoryState(db, prev.id)?.status };
    throw new LedgerError("invalid", lint.error, { lintRule: lint.rule, ...(lint.duplicateOf ? { duplicateOf: lint.duplicateOf } : {}) });
  }
  const w = recordMemory(db, { actor: caller.actor, now }, input);
  return { ok: true, duplicate: w.duplicate, memoryId: w.memory.id, role: who.role, status: memoryState(db, w.memory.id)?.status,
    visibility: w.memory.visibility, ...(w.homeReason ? { homeReason: w.homeReason } : {}), event: w.event };
}

/**
 * mark_memory / ledger memory-mark：角色（按记忆所在项目，带 orderId 可认执行者 / 审查员）→ §4.2 权限 → markMemory。
 * 重试 = 这条记忆最新的一条 mark 就是同人同内容的（中间没人动过状态）；之后有别人标过（如执行者 dispute），同一动作是新的一次，照写（PM 再 confirm 清争议）。
 */
export function markAs(db: Database, caller: MemoryCaller, args: MarkArgs, now: number): MemoryWriteResult {
  const memory = getMemory(db, args.memoryId);
  if (!memory) throw new LedgerError("not_found", `没有记忆 ${args.memoryId}`);
  const who = memoryRole(db, caller, { project: memory.project, orderId: args.orderId });
  if (who.ok && who.project !== memory.project) throw new LedgerError("forbidden", `${args.orderId} 不在记忆 ${memory.id} 的项目里`);
  const denied = canMark(who.ok ? who.role : null, args.mark, { memory, actor: caller.actor, now });
  if (denied) throw new LedgerError("forbidden", denied);
  const last = listMarks(db, memory.id).pop();
  if (last && last.actor === caller.actor && last.mark === args.mark && last.taskId === (args.taskId ?? null) && last.by === (args.by ?? null) && last.reason === (args.reason ?? null)) {
    return { ok: true, duplicate: true, memoryId: memory.id, mark: args.mark, ...memoryState(db, memory.id) };
  }
  const w = markMemory(db, { actor: caller.actor, now }, { memoryId: memory.id, mark: args.mark, taskId: args.taskId, by: args.by, reason: args.reason });
  const { memory: _m, ...state } = memoryState(db, memory.id) as MemoryState & { memory: Memory };
  return { ok: true, duplicate: w.duplicate, memoryId: memory.id, mark: args.mark, ...state, event: w.event };
}

// ── 读 ──

export interface MemoryView extends MemoryState { memory: Memory; marks: MemoryMark[] }

/** show_memory / ledger memory-show：全文 + 当前状态 + marks 历史（单子里只放摘要） */
export function showMemory(db: Database, id: string): MemoryView | null {
  const s = memoryState(db, id);
  return s ? { ...s, marks: listMarks(db, id) } : null;
}

// ── bridge handlers（bridge/order-tools.ts 展开进 HANDLERS）──

/** 票据绑定的内容：参数 + 会话 + 家族（manager 只认这一份，换参数 / 换会话都对不上） */
export const ticketBody = (wire: string, session: string, family: string): string => JSON.stringify({ wire, session, family });

async function viaManager(call: VerifiedCall, run: LedgerRun, sub: string, wire: string, dedup: string): Promise<OrderToolResult> {
  const session = call.sessionId ?? "", family = call.family ?? "";
  const ticket = issueVerdictTicket(call.agent, ticketBody(wire, session, family));
  return withOneShot(ticket.file, () =>
    ledgerWrite(call, run, sub, "-", { wire, session, family, "ticket-file": ticket.file, ticket: ticket.proof }, dedup));
}

const dedupOf = (tool: string, wire: string) => `mcp-${tool}:${Bun.hash(wire).toString(36)}`;

export function memoryToolHandlers(run: LedgerRun, db: () => Database | null): Record<string, OrderToolHandler> {
  return {
    async record_memory(call, args) {
      const p = parseRecordArgs(args);
      if (!p.ok) return refuse("invalid_wire", p.error);
      const wire = JSON.stringify(p.value);
      return viaManager(call, run, "memory-record", wire, dedupOf("record", wire));
    },
    async mark_memory(call, args) {
      const p = parseMarkArgs(args);
      if (!p.ok) return refuse("invalid_wire", p.error);
      const wire = JSON.stringify(p.value);
      return viaManager(call, run, "memory-mark", wire, dedupOf("mark", wire));
    },
    async show_memory(_call, args) {
      const p = parseShowArgs(args);
      if (!p.ok) return refuse("invalid_wire", p.error);
      const d = db();
      if (!d) return refuse("no_ledger", "台账库打不开");
      const v = showMemory(d, p.value.id);
      return v ? { ok: true, ...v } : refuse("not_found", `没有记忆 ${p.value.id}`);
    },
  };
}

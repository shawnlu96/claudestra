/**
 * 本人正式交付后的受控自动派审（dispatch-recovery-DEL，设计 docs/design/local-delivery-flow.md §3）：
 * 普通 manual 卡照旧归 PM；只有真 PM 用 `ledger resume-grant` 明确授予一次资格（G，绑定此刻的执行者 / 会话 / spec / 分支 / 正式单号 / 轮次），
 * 之后执行者本人经 MCP deliver（dedup 键 = 那张单 + head）交了新 head、紧邻 stage→review，调度服务才把卡交回 auto，由原审查派单接着走。
 * 授予与交回各自在一个事务里先查后写（CAS，写入在 ledger-autostart-resume.ts），G 不另记「已用」：交回本身是更晚的 mode 事件，G 不再是最近一条，重复 / 重启不会再交回。
 * 开关来自注入的恢复策略 port（CFG 的 recoveryPolicy，mechanism=localDelivery）；缺 port = observe（只记日志），坏值 / 抛错 = off。
 * tests/order-local-deliver*.test.ts。
 */
import type { Database } from "bun:sqlite";
import { getIntent, type TaskWorkflow } from "./ledger-scheduler.js";
import type { LedgerEvent, LedgerTask } from "./ledger-stages.js";
import { getMeta, LedgerError, type LedgerErrorCode } from "./ledger-store.js";
import { isRealPmRole } from "./ledger-team-config.js";
import { listAsks } from "./ledger-asks.js";
import { deliverDedupKey } from "./memory-tools-refs.js";
import { currentOrders } from "./order-take.js";
import { HOLD_OP } from "./scheduler-review-swap.js";
import { getSchedulerSession } from "./scheduler-sessions.js";

type RecoveryMode = "on" | "observe" | "off";
export interface RecoveryPolicy { mode: RecoveryMode; manualAfterMs: number | null }
/** CFG 的 recoveryPolicy(project, mechanism) 窄到本机制；接受全部 RecoveryKey 的函数也能赋给它 */
export type LocalDeliveryPolicyPort = (project: string, mechanism: "localDelivery") => RecoveryPolicy;

const MODES: readonly RecoveryMode[] = ["on", "observe", "off"];

/** 缺 port → observe；port 抛错或答非所问 → off，原因留给日志 */
export function localDeliveryPolicy(port: LocalDeliveryPolicyPort | undefined, project: string): RecoveryPolicy & { diag: string | null } {
  if (!port) return { mode: "observe", manualAfterMs: null, diag: "没有注入恢复策略（CFG 未接线），按 observe" };
  try {
    const p = port(project, "localDelivery");
    const ms = p?.manualAfterMs;
    if (!p || !MODES.includes(p.mode) || !(ms === null || (typeof ms === "number" && Number.isFinite(ms) && ms >= 0))) {
      return { mode: "off", manualAfterMs: null, diag: "恢复策略返回值不合法，按 off" };
    }
    return { mode: p.mode, manualAfterMs: ms, diag: null };
  } catch (e) {
    return { mode: "off", manualAfterMs: null, diag: `读恢复策略失败，按 off：${(e as Error).message}`.slice(0, 300) };
  }
}

export const RESUME_GRANT_OP = "resume_grant";
const TTL_DEFAULT_H = 24, TTL_MAX_H = 72;

/** 授予时记下的事实；判定只认这些，不按交付时的卡重算 */
export interface ResumeGrant {
  agent: string; session: string; family: string; specRev: number; branch: string; priorHead: string | null;
  workRound: number; stage: "build" | "fix"; step: "write" | "fix"; stageSeq: number;
  orderId: string; orderKind: "dispatch" | "manual"; expiresAt: number;
}

const grantId = (t: Pick<LedgerEvent, "target" | "seq">): string => `grant:${t.target}:${t.seq}`;

export function grantOf(e: LedgerEvent): ResumeGrant | null {
  if (e.kind !== "scheduler" || e.data.op !== RESUME_GRANT_OP) return null;
  const g = e.data.resumeGrant as ResumeGrant | undefined;
  return g && typeof g === "object" && typeof g.orderId === "string" ? g : null;
}

const hasTable = (db: Database, t: string): boolean => !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);

/** 进入当前阶段那条 stage 事件（与 order-take.ts 选单同口径）：它之前的派单不属于这一阶段 */
function stageEnteredSeq(db: Database, task: LedgerTask): number {
  const r = db.query("SELECT MAX(seq) AS s FROM events WHERE target = ? AND kind = 'stage' AND json_extract(data, '$.to') = ?").get(task.id, task.stage) as { s: number | null };
  return r?.s ?? 0;
}

function liveLendOrders(db: Database, taskId: string): string[] {
  if (!hasTable(db, "lend_orders")) return [];
  return (db.query("SELECT orderId FROM lend_orders WHERE taskId = ? AND status IN ('pooled','claimed','unknown')").all(taskId) as { orderId: string }[]).map((r) => r.orderId);
}

function openIntents(db: Database, taskId: string): string[] {
  if (!hasTable(db, "scheduler_intents")) return [];
  return (db.query("SELECT id, status FROM scheduler_intents WHERE taskId = ? AND status IN ('pending','submitted','unknown')").all(taskId) as { id: string; status: string }[])
    .map((r) => `${r.id}:${r.status}`);
}

/** 当前未退役的作者绑定（retiring 也不算：交接 / 退役进行中） */
function activeAuthor(db: Database, taskId: string) {
  const s = getSchedulerSession(db, taskId, "author");
  return s && s.state === "active" ? s : null;
}

export interface GrantInput { taskId: string; taskRev: number; workflowRev: number; reason: string; ttlHours?: number }

/** 授予的前置与要记的事实（调用方已在事务里、已核过真 PM）；不改阶段、不派单、不改任何派单行 */
export function grantFacts(db: Database, task: LedgerTask, wf: TaskWorkflow | null, input: GrantInput, now: number): ResumeGrant {
  const bad = (code: LedgerErrorCode, msg: string) => new LedgerError(code, `${task.id} 不能授予自动交回：${msg}`);
  if (!input.reason.trim()) throw bad("invalid", "要带 --reason");
  const ttl = input.ttlHours ?? TTL_DEFAULT_H;
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > TTL_MAX_H) throw bad("invalid", `--ttl-h 只收 1–${TTL_MAX_H} 的整数`);
  if (task.kind !== "code") throw bad("invalid", "只给 code 卡");
  if (task.stage !== "build" && task.stage !== "fix") throw bad("invalid", `卡在 ${task.stage}：先按现有命令退回 fix 再授予`);
  if (!wf || wf.mode !== "manual") throw bad("invalid", "流程不是 manual（先接管）");
  if (task.rev !== input.taskRev || wf.rev !== input.workflowRev) throw new LedgerError("conflict", "任务或流程已被改过，先重读再授予", { taskRev: task.rev, workflowRev: wf.rev });
  if (!task.agent || !task.branch) throw bad("invalid", "卡上没有执行者或分支");
  const author = activeAuthor(db, task.id);
  if (!author || author.agent !== task.agent) throw bad("invalid", "没有与执行者一致的 active 作者会话绑定（换会话要先走交接）");
  if (author.family !== wf.authorFamily) throw bad("invalid", `作者绑定家族 ${author.family} 与流程 ${wf.authorFamily} 不一致，先对账`);
  const open = openIntents(db, task.id);
  if (open.length) throw bad("conflict", `还有未结的调度意图（${open.join("，")}）`);
  const lent = liveLendOrders(db, task.id);
  if (lent.length) throw bad("conflict", `还有未结的出借单（${lent.join("，")}）`);
  // 与 take_order 同一选单逻辑：执行者本人本会话此刻拿到的那张单，拿不到就不授予
  const order = currentOrders(db, { agent: task.agent, sessionId: author.sessionId, family: null, channelId: "" }).find((o) => o.task.id === task.id);
  if (!order) throw bad("invalid", "执行者本人本会话此刻没有这张卡的正式单（步骤执行者不是他 / 借出去了）");
  return {
    agent: task.agent, session: author.sessionId, family: wf.authorFamily, specRev: task.specRev, branch: task.branch, priorHead: task.headSHA ?? null,
    workRound: task.round, stage: task.stage, step: order.step, stageSeq: stageEnteredSeq(db, task), orderId: order.orderId,
    orderKind: order.intent ? "dispatch" : "manual", expiresAt: now + ttl * 3_600_000,
  };
}

interface GrantFacts { grant: string; trigger: number; deliver: number; head: string; prior: string | null }
export type GrantVerdict = { ok: true; facts: GrantFacts } | { ok: false; why: string };

const no = (why: string): GrantVerdict => ({ ok: false, why });

/** 授予时是真 PM，判定时再核一次（名单可能变了） */
function stillRealPm(db: Database, task: LedgerTask, actor: string): boolean {
  if (actor === "master" || actor === "owner") return true;
  const meta = getMeta(db, task.project);
  return meta.pms.includes(actor) && isRealPmRole("pm", actor, meta.team);
}

/** 未答的 blocker ask（含没写 class 的旧版）：执行者在等人 / 拒做，不自动恢复 */
function openBlocker(db: Database, task: LedgerTask, agent: string): boolean {
  return listAsks(db, { project: task.project, fromAgent: agent })
    .some((a) => a.taskId === task.id && a.state === "open" && a.extra?.class !== "design" && a.extra?.class !== "scope");
}

/** `events` 是本卡全部事件（升序），`t` 是最近一条 mode 事件且为 resume_grant；开关、调度服务、origin 核对由调用方判 */
export function grantVerdict(db: Database, task: LedgerTask, wf: TaskWorkflow | null, events: LedgerEvent[], t: LedgerEvent, now: number): GrantVerdict {
  const g = grantOf(t);
  if (!g) return no("授予事件缺资格内容");
  if (wf?.mode !== "manual") return no("workflow 不是 manual");
  if (task.stage !== "review") return no(`卡在 ${task.stage}，不在 review`);
  if (!stillRealPm(db, task, t.actor)) return no(`授予人 ${t.actor} 已不是真 PM`);
  if (!(now < g.expiresAt)) return no("资格已过期");
  if (task.specRev !== g.specRev || task.branch !== g.branch || task.agent !== g.agent) return no("卡的 spec / 分支 / 执行者已不是授予时的");
  if (wf.authorFamily !== g.family) return no("作者家族已不是授予时的");
  const author = activeAuthor(db, task.id);
  if (!author || author.agent !== g.agent || author.sessionId !== g.session) return no("作者会话绑定已不是授予时的");
  if (task.round !== g.workRound + 1) return no(`轮次 ${task.round} 不是授予时工作轮次 ${g.workRound} 的下一轮`);
  const after = events.filter((e) => e.seq > t.seq);
  const delivers = after.filter((e) => e.kind === "deliver");
  if (!delivers.length) return no("授予后还没有交付");
  if (delivers.some((e) => e.actor !== g.agent)) return no("授予后有别人的交付（PM 代交不算）");
  const d = delivers.at(-1) as LedgerEvent;
  const head = typeof d.data.headSHA === "string" ? d.data.headSHA : null;
  if (!head || d.dedupKey !== deliverDedupKey(g.orderId, head)) return no("最近的交付不是经授予那张正式单的 MCP deliver");
  if (d.data.round !== g.workRound + 1) return no("交付轮次不符");
  if (head === g.priorHead) return no("交付的还是授予时的 head");
  if (task.headSHA !== head) return no("卡上的 head 不是这次交付的");
  const stages = after.filter((e) => e.kind === "stage");
  const s = stages[0];
  if (stages.length !== 1 || s.seq !== d.seq - 1 || s.data.from !== g.stage || s.data.to !== "review" || s.actor !== d.actor) return no("授予后阶段不是由这次交付紧邻推到 review");
  if (g.orderKind === "dispatch") {
    const i = getIntent(db, g.orderId);
    if (!i || i.taskId !== task.id || i.node !== g.step || i.specRev !== g.specRev || i.status === "cancelled" || !(i.eventSeq > g.stageSeq)) return no("授予绑定的派单已不成立");
  }
  if (after.some((e) => e.kind === "scheduler" && e.data.op === HOLD_OP)) return no("授予后有模型安全拒绝挂起");
  if (openBlocker(db, task, g.agent)) return no("执行者有未答的 blocker ask");
  const open = openIntents(db, task.id).filter((x) => !x.endsWith(":pending"));
  if (open.length) return no(`有结果未定的调度意图（${open.join("，")}）`);
  const lent = liveLendOrders(db, task.id);
  if (lent.length) return no(`有未结的出借单（${lent.join("，")}）`);
  return { ok: true, facts: { grant: grantId(t), trigger: t.seq, deliver: d.seq, head, prior: g.priorHead } };
}

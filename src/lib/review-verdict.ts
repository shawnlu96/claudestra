/**
 * M3 交结论（T97）：submit_verdict 的 VerdictWire → recordReview 的结构化记账。只记结论、从不推阶段（修 / 合 / 升级由调度器或 PM 定）。
 * 顺序即判定：身份已验证 → wire 严格校验（计数与逐项对得上）→ 同单重试按幂等键认 → 按 orderId 现算调用方的单（不是本步骤审查员、
 * 单已过期都拒）→ head 等于派单时的 head → 不是作者 → 报告在 ledger/reviews/ 下且非空 → 自动卡再过 CLI 同一道门（autoReviewWriter）。
 * head / session / family 取身份与单子，参数里的只用来比对；同家族照收，只标 sameFamily。tests/review-verdict.test.ts。
 */
import type { Database } from "bun:sqlite";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, sep } from "node:path";
import type { CallerIdentity } from "./caller-identity.js";
import { getWorkflow, type AuthorFamily } from "./ledger-scheduler.js";
import type { LedgerEvent } from "./ledger-stages.js";
import { getEventByDedup, LedgerError, listEvents } from "./ledger-store.js";
import { authorOf, stepsOf, type TaskStep } from "./ledger-steps.js";
import { recordReview } from "./ledger-write.js";
import { parseVerdictWire, type VerdictWire } from "./order-wire.js";
import { agentRuntime, type RegistryAgent } from "./registry.js";
import { reviewCallerOf, reviewsDir, slotByOrderId, type ReviewSlot } from "./review-order.js";
import { autoReviewWriter, runtimeFamily } from "./scheduler-auto-review.js";
import type { ReviewFinding } from "./scheduler-review.js";
import { getSchedulerSession } from "./scheduler-sessions.js";

export type VerdictResult =
  | { ok: true; duplicate: boolean; taskId: string; eventSeq: number; sameFamily: boolean | null }
  | { ok: false; error: string; message: string };

export interface VerdictDeps {
  /** 作者的 runtime（算 sameFamily）；bridge 传 readRegistryAgentsSync() */
  registry: readonly Pick<RegistryAgent, "name" | "runtime">[];
  reviewsDir?: string;
  now?: number;
  /** 自动卡那道门（scheduler-auto-review.ts）的 IO，测试注入 */
  registryPath?: string;
  gitHead?(dir: string): string | null;
  gitDirty?(dir: string): string | null;
}

const refuse = (error: string, message: string): VerdictResult => ({ ok: false, error, message });

/** 一张单一个幂等键：同单同 head 只能有一个结论 */
const verdictKey = (w: Pick<VerdictWire, "orderId" | "head">): string => `verdict:${w.orderId}@${w.head}`;

/** 事件里存的逐项结论：四个字段，与 PM 用 `ledger review --findings` 代记的同构（说明文字在报告里） */
const storedFindings = (w: VerdictWire): ReviewFinding[] => w.findings.map(({ findingId, family, severity, probe }) => ({ findingId, family, severity, probe }));

/** 重试是不是同一个结论：结论、计数、逐项、报告路径都一样 */
function sameVerdict(prev: LedgerEvent, w: VerdictWire): boolean {
  const d = prev.data;
  return d.verdict === w.verdict && d.p0 === w.p0 && d.p1 === w.p1 && d.p2 === w.p2 && d.path === w.reportPath &&
    JSON.stringify(d.findings) === JSON.stringify(storedFindings(w));
}

/** 报告：绝对路径、解析符号链接后仍在 reviews 目录下、是非空普通文件；只看元数据，不读内容 */
function checkReport(path: string, dir: string): string | null {
  if (!isAbsolute(path)) return "reportPath 要是绝对路径";
  let real: string, root: string;
  try {
    root = realpathSync(dir);
    real = realpathSync(path);
  } catch {
    return `报告 ${path} 不存在`; // realpath 失败只可能是路径（或 reviews 目录）不在：原因就是这句话本身
  }
  if (!real.startsWith(root + sep)) return `报告要放在 ${dir} 下`;
  const st = statSync(real);
  if (!st.isFile() || st.size === 0) return `报告 ${path} 要是非空文件`;
  return null;
}

/** 这张卡上写过 / 修过代码的本机 agent：交付了这个 head 的那一步、所有写 / 修步骤（含按负责人推出来的）、自动卡的作者 session */
function authorsOf(db: Database, slot: ReviewSlot, steps: TaskStep[]): Set<string> {
  const out = new Set<string>();
  const hit = authorOf(steps, slot.head);
  if (hit && hit.executorKind === "agent") out.add(hit.executor);
  for (const s of steps) if ((s.step === "write" || s.step === "fix") && s.executorKind === "agent") out.add(s.executor);
  const bound = getSchedulerSession(db, slot.task.id, "author");
  if (bound) out.add(bound.agent);
  return out;
}

/** 作者的模型家族：自动卡按绑定的作者 session / 工作流，其它按作者 agent 的 registry runtime；查不出 null */
function authorFamily(db: Database, slot: ReviewSlot, steps: TaskStep[], registry: VerdictDeps["registry"]): AuthorFamily | null {
  if (slot.auto) return getSchedulerSession(db, slot.task.id, "author")?.family ?? getWorkflow(db, slot.task.id)?.authorFamily ?? null;
  const author = authorOf(steps, slot.head) ?? steps.filter((s) => s.step === "write" || s.step === "fix").at(-1) ?? null;
  if (!author || author.executorKind !== "agent") return null;
  const row = registry.find((a) => a.name === author.executor);
  return row ? runtimeFamily(agentRuntime(row)) : null;
}

/** 同一轮、同一 head、同一审查员已经由别的路子（CLI / PM 代记）记过结论：不再叠一条，交 PM */
const recordedElsewhere = (db: Database, slot: ReviewSlot, agent: string): boolean =>
  listEvents(db, { project: slot.task.project, target: slot.task.id })
    .some((e) => e.kind === "review" && e.data.round === slot.task.round && e.data.head === slot.head && e.data.reviewer === agent);

export function submitVerdict(db: Database, identity: CallerIdentity, raw: unknown, deps: VerdictDeps): VerdictResult {
  const who = reviewCallerOf(identity);
  if ("error" in who) return refuse(who.error, `${who.message}；什么都没记`);
  const parsed = parseVerdictWire(raw);
  if (!parsed.ok) return refuse("invalid_wire", parsed.error);
  const w = parsed.value;
  const { caller, family } = who;
  const key = verdictKey(w);
  const prev = getEventByDedup(db, key);
  if (prev) {
    if (prev.kind === "review" && prev.actor === caller.agent && sameVerdict(prev, w)) {
      return { ok: true, duplicate: true, taskId: prev.target, eventSeq: prev.seq, sameFamily: (prev.data.sameFamily as boolean | null) ?? null };
    }
    return refuse("conflict", `审查单 ${w.orderId} 已经交过一个不同的结论；要改由 PM 处理（ledger review 代记），这次没记`);
  }
  const slot = slotByOrderId(db, w.orderId, caller);
  if (!slot) return refuse("no_order", `${w.orderId} 不是你现在手上的审查单（卡已离开 review、换了审查员、换了 head 或单号不对）；先 take_review`);
  if (w.head !== slot.head) return refuse("stale_head", `审的是旧 head ${w.head}：这张单要审 ${slot.head}，结论没记`);
  const steps = stepsOf(db, slot.task);
  if (authorsOf(db, slot, steps).has(caller.agent)) return refuse("self_review", `${caller.agent} 写过 ${slot.task.id} 的代码，不能审它`);
  const bad = checkReport(w.reportPath, deps.reviewsDir ?? reviewsDir());
  if (bad) return refuse("bad_report", bad);
  if (recordedElsewhere(db, slot, caller.agent)) return refuse("conflict", `${slot.task.id} 第 ${slot.task.round} 轮已经有 ${caller.agent} 对这个 head 的结论，交 PM 处理`);
  const aFamily = authorFamily(db, slot, steps, deps.registry);
  const sameFamily = aFamily ? aFamily === family : null;
  try {
    if (slot.auto) {
      autoReviewWriter(db, slot.task, { actor: caller.agent, callerSession: caller.sessionId, registryPath: deps.registryPath, gitHead: deps.gitHead, gitDirty: deps.gitDirty },
        { reviewer: caller.agent, session: caller.sessionId, family, head: slot.head });
    }
    const r = recordReview(db, { actor: caller.agent, now: deps.now, dedupKey: key }, {
      taskId: slot.task.id, reviewer: caller.agent, verdict: w.verdict, p0: w.p0, p1: w.p1, p2: w.p2, path: w.reportPath,
      head: slot.head, reviewerSessionId: caller.sessionId, reviewerFamily: family, findings: storedFindings(w),
      orderId: w.orderId, sameFamily, via: "mcp",
    });
    return { ok: true, duplicate: r.duplicate, taskId: slot.task.id, eventSeq: r.event.seq, sameFamily };
  } catch (e) {
    if (e instanceof LedgerError) return refuse(e.code, e.message);
    throw e;
  }
}

/**
 * dispatch-recovery-MODELXP1：出借池里的单遭提供方策略拒审，按 owner 规矩 A（decision 42710）换家族——识别与计划，纯函数，只读台账。
 * 识别（recognizePoolRefusal）：吃出借方的失败事实（结构化类别 provider_policy / usage / auth / network / other + sessionId + failedAt，
 * 来源标明）。只有「出借方声明」的 provider_policy、带会话与失败时刻、出借方没报疑点、单在已领单状态（claimed / started）、
 * head / specRev / 轮次与卡此刻相符 → confirmed；是拒审但任一条证明不了（含只有 release 原因文本）→ suspected，报警正文带
 * 「疑似池单拒审，未能确认：<原因>」，不撤单不换人；其余类别 → none，照旧。出借方按 turnFailureDoubt 归单、在 release 里带类别是 MODELXP2。
 * 计划（planPoolRefusal）：首次被拒 → 撤单（provider_policy_refusal，原件不删）→ 记模型结果 → 换另一家族重放（池里有空位的 peer 优先，
 * 其次本机，都没有就等并告知一次）；审查单带豁免标记、开 refusal epoch，写单 / 修复单不带豁免、下一轮审查跟着换家族；豁免单或本窗口
 * 已换过家族的单再被拒 → manual（MODELX 的 model_safety_hold），通知 PM，不做同模型重试。owner 告知每卡每类一次（informKey）。
 * observe 只给计划事件，不撤单不派单；off 什么都不做。写入不在这里：一律经 scheduler-only 台账子命令。tests/scheduler-refusal-pool*.test.ts。
 */
import type { Database } from "bun:sqlite";
import { isCyberPolicy } from "./agent-supervisor-policy.js";
import type { AuthorFamily } from "./ledger-scheduler.js";
import type { LedgerEvent } from "./ledger-stages.js";
import { listEvents } from "./ledger-store.js";
import { classifyModelOutcome, EXEMPTION_TEXT } from "./scheduler-model-outcome.js";
import { informKey, refusalKind } from "./scheduler-model-wiring.js";

type PoolStep = "review" | "write" | "fix";
type RefusalKind = "cyber_policy" | "usage_policy";

/** 撤单原因码（与 PMDIR1 手工撤单 #50973 同一个） */
const POOL_REFUSAL_CANCEL = "provider_policy_refusal";
/** 本卡写的计划事件 op；同窗口里有它 = 已换过一次家族 */
export const POOL_REFUSAL_OP = "pool_refusal_plan";
const POOL_SUSPECT_PREFIX = "疑似池单拒审，未能确认：";
const poolSuspectNote = (why: string): string => `${POOL_SUSPECT_PREFIX}${why}`;
/** 计划事件按单去重：同一单的同一次拒审重放只认第一条 */
export const poolRefusalKey = (orderId: string, mode: "on" | "observe"): string => `pool-refusal:${orderId}:${mode}`;

/** 提供方策略拒审：监护认的 cyber_policy，或 MODEL 归为 safety 的（含 Claude usage_policy）；同 scheduler-refusal-unclaimed.ts */
export const isPoolPolicyRefusal = (message: string): boolean =>
  isCyberPolicy(message) || classifyModelOutcome({ failure: { kind: "error", message } })?.cls === "safety";

/** 出借单此刻的样子：借入方台账的 status 或出借方 journal 的 state，二者都按「已领单」读 claimed / started */
export interface PoolOrderFacts {
  orderId: string; taskId: string; step: PoolStep; family: AuthorFamily; peer: string;
  state: string; head: string; specRev: number; round: number;
  /** 这一单是不是豁免审查单（派单时带了 EXEMPTION_TEXT） */
  exempt: boolean;
}
export interface CardNow { headSHA: string | null; specRev: number; round: number }

/** 出借方失败类别：provider_policy = 提供方策略拒审（cyber / usage_policy），usage = 额度，auth = 登录，network = 网络，other = 其余 */
type LenderFailureCategory = "provider_policy" | "usage" | "auth" | "network" | "other";

/** 出借方识别事实。source：lender_declared = 出借方结构化声明（MODELXP2 起 release 带来）；release_text = 借入方只从 release 原因文本推出 */
export interface LenderFailureFacts {
  source: "lender_declared" | "release_text";
  category: LenderFailureCategory;
  sessionId: string | null;
  failedAt: number | null;
  /** 出借方按 turnFailureDoubt 报的疑点（null / 缺 = 没报） */
  doubt?: string | null;
  /** 原文或原因文本，只用来分 cyber / usage_policy 告知键 */
  message: string;
}

/** 借入方现在只拿得到 release 原因文本：推出类别，来源标 release_text（最多 suspected） */
export function lenderFactsFromReleaseText(reason: string): LenderFailureFacts {
  const policy = isPoolPolicyRefusal(reason) || reason.includes("内容策略拦截");
  return { source: "release_text", category: policy ? "provider_policy" : "other", sessionId: null, failedAt: null, message: reason };
}

export type PoolRecognition =
  | { kind: "none" }
  | { kind: "suspected"; note: string }
  | { kind: "confirmed"; refusal: RefusalKind; message: string };

const CLAIMED = new Set(["claimed", "started"]);
const SETTLED = new Set(["done", "cancelled", "released", "acked", "stopped", "declined"]);

/** 验收线 1 / 5：全部证明了才 confirmed；是拒审但证明不了 → suspected；不是拒审 → none（照旧走现有路径） */
export function recognizePoolRefusal(order: PoolOrderFacts, card: CardNow, f: LenderFailureFacts): PoolRecognition {
  if (f.category !== "provider_policy") return { kind: "none" };
  const why = f.source !== "lender_declared" ? "只有 release 原因文本，没有出借方的结构化声明"
    : SETTLED.has(order.state) ? `单已结清（${order.state}）`
    : !CLAIMED.has(order.state) ? `单不在已领单状态（${order.state}）`
    : !f.sessionId || typeof f.failedAt !== "number" || !Number.isFinite(f.failedAt) ? "出借方声明缺会话或失败时刻"
    : f.doubt ? f.doubt
    : order.head !== card.headSHA || order.specRev !== card.specRev || order.round !== card.round ? "head / specRev / 轮次和本单不符"
    : null;
  if (why) return { kind: "suspected", note: poolSuspectNote(why) };
  return { kind: "confirmed", refusal: refusalKind(f.message), message: f.message };
}

/** 一个可放的去处：池里的 peer（machine = peer 名）或本机（"local"）；free = 此刻还有空位 */
interface PoolPlacement { machine: string; family: AuthorFamily; free: boolean }

/** 本窗口（head / specRev / 轮次）里已记过的池单拒审计划 */
interface PriorPoolRefusal { seq: number; orderId: string; step: PoolStep; family: AuthorFamily; plan: PoolPlan["kind"] }

export interface PlanFacts {
  mode: "on" | "observe" | "off";
  order: PoolOrderFacts;
  /** 只收 recognizePoolRefusal 确认了的：只靠 release 文本（suspected）在类型上就进不来，出不了执行计划 */
  confirmed: Extract<PoolRecognition, { kind: "confirmed" }>;
  /** 写当前 head 的作者家族（审查豁免时记下是否仍跨模型） */
  authorFamily: AuthorFamily;
  /** security 卡：审查只在本机 */
  security: boolean;
  /** 池里的 peer 在前（调用方按现有放置顺序给），本机在后 */
  placements: readonly PoolPlacement[];
  prior: readonly PriorPoolRefusal[];
  /** 已写过的 owner 告知键（scheduler-model-inform 每键一次） */
  informed: ReadonlySet<string>;
}

interface Inform { key: string; first: boolean }
type PoolPlan =
  | { kind: "off" }
  | { kind: "replace"; cancel: typeof POOL_REFUSAL_CANCEL; step: PoolStep; from: { machine: string; family: AuthorFamily };
      to: { machine: string; family: AuthorFamily } | null; epoch: boolean; exemption: typeof EXEMPTION_TEXT | null;
      crossModel: boolean; nextReviewFamily: AuthorFamily | null; inform: Inform; reason: string }
  | { kind: "manual"; code: "model_safety_hold"; notifyPm: true; inform: Inform; reason: string };

export type PoolDecision = { kind: "off" } | { kind: "plan"; mode: "on" | "observe"; plan: Exclude<PoolPlan, { kind: "off" }>; key: string };

const other = (f: AuthorFamily): AuthorFamily => f === "claude" ? "codex" : "claude";
const STEP_LABEL: Record<PoolStep, string> = { review: "审查单", write: "写单", fix: "修复单" };

/** 验收线 2–4、6：一次确认了的池单拒审的下一步。纯函数：不读库、不写库 */
export function planPoolRefusal(f: PlanFacts): PoolDecision {
  if (f.mode === "off") return { kind: "off" };
  const o = f.order, key = informKey(o.taskId, f.confirmed.refusal);
  const inform = { key, first: !f.informed.has(key) };
  const label = STEP_LABEL[o.step];
  const again = o.exempt ? "豁免审查单再被拒" : f.prior.some((p) => p.plan === "replace" && p.orderId !== o.orderId) ? `本窗口已换过一次家族的${label}再被拒` : null;
  const plan: Exclude<PoolPlan, { kind: "off" }> = again
    ? { kind: "manual", code: "model_safety_hold", notifyPm: true, inform,
        reason: `模型安全策略拒绝：${again}，不再换提供方、不做同模型重试，交 PM / owner 人工处置` }
    : replacePlan(f, inform);
  return { kind: "plan", mode: f.mode, plan, key: poolRefusalKey(o.orderId, f.mode) };
}

function replacePlan(f: PlanFacts, inform: Inform): Extract<PoolPlan, { kind: "replace" }> {
  const o = f.order, family = other(o.family), review = o.step === "review";
  const fits = (p: PoolPlacement) => p.free && p.family === family && !(p.machine === o.peer && p.family === o.family) &&
    !(review && f.security && p.machine !== "local");
  // 池里另一家族有空位的 peer 优先，其次本机；placements 已按这个顺序给，这里只把本机挪到最后
  const to = f.placements.find((p) => fits(p) && p.machine !== "local") ?? f.placements.find((p) => fits(p) && p.machine === "local") ?? null;
  const where = to ? `${to.machine === "local" ? "本机" : to.machine}（${to.family}）` : `暂无 ${family} 空位，等空位`;
  return { kind: "replace", cancel: POOL_REFUSAL_CANCEL, step: o.step, from: { machine: o.peer, family: o.family },
    to: to ? { machine: to.machine, family: to.family } : null, epoch: review, exemption: review ? EXEMPTION_TEXT : null,
    crossModel: review ? family !== f.authorFamily : true, nextReviewFamily: review ? null : other(family), inform,
    reason: `${STEP_LABEL[o.step]} ${o.orderId} 在 ${o.peer}（${o.family}）遭提供方策略拒审（${f.confirmed.refusal}）：撤单（${POOL_REFUSAL_CANCEL}，原件保留），` +
      `换 ${where}${review ? `；${EXEMPTION_TEXT}，材料与提示不改` : `；下一轮审查换到 ${other(family)}`}` };
}

/** 窗口 = 单的 specRev / head / 轮次；不同窗口的记录互不计数 */
const sameWindow = (e: LedgerEvent, o: Pick<PoolOrderFacts, "head" | "specRev" | "round">): boolean =>
  e.data.head === o.head && e.data.specRev === o.specRev && e.data.round === o.round;

/** 只读：本卡本窗口里 scheduler 写过的池单拒审计划（mode 相同的才算；observe 的记录不让 on 以为已换过） */
function priorPoolRefusals(events: readonly LedgerEvent[], o: PoolOrderFacts, mode: "on" | "observe"): PriorPoolRefusal[] {
  return events.filter((e) => e.actor === "scheduler" && e.target === o.taskId && e.data.op === POOL_REFUSAL_OP && e.data.mode === mode && sameWindow(e, o))
    .map((e) => ({ seq: e.seq, orderId: String(e.data.orderId), step: e.data.step as PoolStep, family: e.data.family as AuthorFamily,
      plan: (e.data.plan as { kind: PoolPlan["kind"] }).kind }));
}

/** 只读：本卡已有的 owner 告知键 */
function informedKeys(events: readonly LedgerEvent[], taskId: string): Set<string> {
  const keys = new Set([informKey(taskId, "cyber_policy"), informKey(taskId, "usage_policy")]);
  return new Set(events.filter((e) => e.dedupKey && keys.has(e.dedupKey)).map((e) => e.dedupKey as string));
}

/** 只读句柄上收齐 planPoolRefusal 要的台账事实（生产的 LedgerReader 只读，这里不写一行） */
export function poolLedgerFacts(db: Database, project: string, o: PoolOrderFacts, mode: "on" | "observe"): Pick<PlanFacts, "prior" | "informed"> {
  const events = listEvents(db, { project, target: o.taskId });
  return { prior: priorPoolRefusals(events, o, mode), informed: informedKeys(events, o.taskId) };
}

/** 计划事件的 data（写口照抄，不另算）：撤单 / 记结果 / epoch / 告知各自走现有子命令 */
export function poolPlanEventData(d: Extract<PoolDecision, { kind: "plan" }>, o: PoolOrderFacts, evidence: string): Record<string, unknown> {
  return { op: POOL_REFUSAL_OP, mode: d.mode, orderId: o.orderId, step: o.step, family: o.family, peer: o.peer,
    head: o.head, specRev: o.specRev, round: o.round, exempt: o.exempt, plan: d.plan, evidence: evidence.slice(0, 600) };
}

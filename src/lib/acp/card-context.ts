/**
 * CTXA：ACP 卡片会话的上下文边界（纯函数）。宿主一侧的状态与原子受理在 card-context-host.ts，bridge 一头的调用在 bridge/acp-link.ts。
 * - 线：闲置线 20 万 + 闲置满 3 分钟、卡片硬线 30 万；都按 ctx-boundary-decision.ts 的 policyBoundary 收到实际模型窗口以内（小窗口模型先到）。
 * - 申请（card_compact）必须带上查询（card_context）时看到的强身份：expectedSessionId + hostId + attachGen（适配器接线代次）
 *   + turnGen / slotGen（回合与独占槽代次）+ card。宿主在受理动作的同一段同步代码里逐项核对，任何一项对不上都拒、给出原因，
 *   不重放、不降级成不带 opId 的普通 slash。
 * - usage 只认当前会话、当前接线代次、当前回合代次之内报的、且之后没发生过压缩的那一份；否则 unknown / stale，一律拒。
 * - 忙时：ACP 没有回合中途的预算能力（runtime budget），回合中途超线只能 blocked-capability；新回合受理边界由宿主先压缩再放行（hardLineGate）。
 * - 模式 on / observe / off，缺省 observe：observe 只算结论（wouldFire），不动会话。单测 tests/acp-card-context.test.ts。
 */
import { policyBoundary } from "../ctx-boundary-decision.js";

export type CardCtxMode = "on" | "observe" | "off";
const CARD_CTX_DEFAULT_MODE: CardCtxMode = "observe";
export const CARD_COMPACT_CAP = "card_compact_v1";
const CARD_IDLE_LINE = 200_000;
const CARD_HARD_LINE = 300_000;
const CARD_IDLE_MS = 3 * 60_000;
/** 卡片会话发给适配器的压缩命令（codex-acp / pi 适配器都认 /compact） */
export const CARD_COMPACT_TEXT = "/compact";

export const parseCardCtxMode = (v: unknown): CardCtxMode => (v === "on" || v === "observe" || v === "off" ? v : CARD_CTX_DEFAULT_MODE);

/** 启动时由生命周期上下文给的强身份（card = 卡号；expectedSessionId = 启动时登记的会话） */
export interface CardIdentity {
  card: string;
  expectedSessionId: string;
}

export interface UsageSample {
  used: number;
  size: number | null;
  sessionId: string;
  attachGen: number;
  turnGen: number;
  at: number;
  /** 这份 usage 之后发生过压缩（边界到过）：作废 */
  compacted?: true;
}

/** 宿主此刻的状态：受理与查询共用这一份，必须在同一段同步代码里取 */
export interface CardCtxSnapshot {
  mode: CardCtxMode;
  identity: CardIdentity | null;
  hostId: string;
  attachGen: number;
  /** 当前接上的会话；没接上是 "" */
  sessionId: string;
  turnGen: number;
  slotGen: number;
  registered: boolean;
  /** 运行时能发 /compact、能看到压缩完成（接上了线程、协议没被拒） */
  capable: boolean;
  rotating: boolean;
  compacting: boolean;
  running: boolean;
  queued: number;
  idleSince: number | null;
  usage: UsageSample | null;
}

export interface CardCompactRequest {
  opId: string;
  card: string;
  expectedSessionId: string;
  hostId: string;
  attachGen: number;
  turnGen: number;
  slotGen: number;
}

export type CardReject =
  | "mode-off" | "bad-request" | "no-capability" | "startup-mismatch" | "card-mismatch" | "not-registered" | "old-host" | "old-attach"
  | "old-session" | "turn-drift" | "rotating" | "compacting" | "running" | "queued" | "usage-unknown" | "usage-stale" | "under" | "idle-wait"
  | "observe";

export const CARD_REJECT_TEXT: Record<CardReject, string> = {
  "mode-off": "卡片上下文边界已关（off）",
  "bad-request": "申请缺字段或格式不对",
  "no-capability": "宿主 / 运行时没有卡片压缩能力（没接上线程、协议被拒或没给卡片身份）",
  "startup-mismatch": "启动登记的会话和宿主实际接上的会话不一致",
  "card-mismatch": "申请的卡和宿主启动时登记的卡不一致",
  "not-registered": "宿主此刻没在 bridge 登记",
  "old-host": "宿主进程已换（hostId 对不上）",
  "old-attach": "适配器重起过（接线代次对不上）",
  "old-session": "会话已换（expectedSessionId 对不上）",
  "turn-drift": "查询之后又开过回合 / 排过独占槽（代次对不上）",
  rotating: "正在清上下文（/clear 轮换）",
  compacting: "正在压缩",
  running: "有回合在跑",
  queued: "还有排着的消息 / 槽",
  "usage-unknown": "没有本会话的 usage",
  "usage-stale": "usage 陈旧（之后开过回合、压缩过或换过接线）",
  under: "没过线",
  "idle-wait": "过了闲置线但闲置还没满 3 分钟",
  observe: "observe 模式：只记结论，不压缩",
};

type CardKind = "idle" | "hard";
export type CardVerdict = { ok: true; kind: CardKind } | { ok: false; reason: CardReject; wouldFire?: CardKind };

/** 卡片的两条线，按实际窗口收（policyBoundary 的 85% / 93%）；limits 只给单测压低，不能抬过卡片线 */
export function cardLines(size: number | null, limits: { idle?: number; hard?: number } = {}): { idle: number; hard: number } {
  const idle = Math.min(limits.idle ?? CARD_IDLE_LINE, CARD_IDLE_LINE);
  const hard = Math.max(idle, Math.min(limits.hard ?? CARD_HARD_LINE, CARD_HARD_LINE));
  const policy = { id: "card", projects: [], names: [], window: idle, idleMinutes: CARD_IDLE_MS / 60_000, hardCap: hard, action: "compact" as const, ccWindow: null, keep: null };
  const b = policyBoundary({ policy, via: "name" }, size && size > 0 ? size : null);
  return { idle: b.window, hard: b.hardCap ?? hard };
}

/** usage 有没有效：同一会话、同一接线、同一回合代次，之后没压缩过 */
export function usageState(s: Pick<CardCtxSnapshot, "usage" | "sessionId" | "attachGen" | "turnGen">): "fresh" | "unknown" | "stale" {
  const u = s.usage;
  if (!u || !(u.used > 0)) return "unknown";
  if (u.sessionId !== s.sessionId) return "unknown";
  return u.attachGen === s.attachGen && u.turnGen === s.turnGen && !u.compacted ? "fresh" : "stale";
}

/** 过线情况（不看忙闲）：null = usage 不可用 */
function overLine(s: CardCtxSnapshot, limits?: { idle?: number; hard?: number }): { kind: CardKind | "under"; used: number; idle: number; hard: number } | null {
  if (usageState(s) !== "fresh") return null;
  const u = s.usage!;
  const l = cardLines(u.size, limits);
  return { kind: u.used >= l.hard ? "hard" : u.used >= l.idle ? "idle" : "under", used: u.used, ...l };
}

/** 身份核对：申请带的每一项都要和此刻的宿主一致 */
function identityReject(s: CardCtxSnapshot, r: CardCompactRequest): CardReject | null {
  if (!s.capable || !s.identity) return "no-capability";
  if (s.identity.expectedSessionId !== s.sessionId) return "startup-mismatch";
  if (r.card !== s.identity.card) return "card-mismatch";
  if (!s.registered) return "not-registered";
  if (r.hostId !== s.hostId) return "old-host";
  if (r.attachGen !== s.attachGen) return "old-attach";
  if (r.expectedSessionId !== s.sessionId) return "old-session";
  if (r.turnGen !== s.turnGen || r.slotGen !== s.slotGen) return "turn-drift";
  return null;
}

/** 忙闲：轮换 → 压缩中 → 在跑 → 排队 */
function busyReject(s: CardCtxSnapshot): CardReject | null {
  if (s.rotating) return "rotating";
  if (s.compacting) return "compacting";
  if (s.running) return "running";
  if (s.queued > 0) return "queued";
  return null;
}

/**
 * 受理判定（宿主在受理动作的同一段同步代码里调）。按顺序：模式 off → 身份 → 忙闲 → usage → 线 → 闲置时长 → observe。
 * 硬线不看闲置时长，但同样要求此刻空闲：在跑的回合不取消、不插队（忙时的处理见 hardLineGate）。
 */
export function cardCompactVerdict(s: CardCtxSnapshot, r: CardCompactRequest, now: number, limits?: { idle?: number; hard?: number }): CardVerdict {
  if (s.mode === "off") return { ok: false, reason: "mode-off" };
  const reject = identityReject(s, r) ?? busyReject(s);
  if (reject) return { ok: false, reason: reject };
  const st = usageState(s);
  if (st !== "fresh") return { ok: false, reason: st === "unknown" ? "usage-unknown" : "usage-stale" };
  const line = overLine(s, limits)!;
  if (line.kind === "under") return { ok: false, reason: "under" };
  if (line.kind === "idle" && (s.idleSince === null || now - s.idleSince < CARD_IDLE_MS)) return { ok: false, reason: "idle-wait" };
  if (s.mode === "observe") return { ok: false, reason: "observe", wouldFire: line.kind };
  return { ok: true, kind: line.kind };
}

/** 新回合受理边界：硬线以上、usage 有效、身份一致时，先压缩再开这一轮。返回要做的事；observe 只报不做 */
export function hardLineGate(s: CardCtxSnapshot, limits?: { idle?: number; hard?: number }): "compact-first" | "observe" | null {
  if (s.mode === "off" || !s.capable || !s.identity || s.identity.expectedSessionId !== s.sessionId || s.rotating || s.compacting) return null;
  if (overLine(s, limits)?.kind !== "hard") return null;
  return s.mode === "on" ? "compact-first" : "observe";
}

const OP_ID = /^[\w:.-]{1,128}$/;
const isGen = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;

/** acp_call 里的 card_compact 申请；缺任何一项 = null（宿主回 bad-request） */
export function parseCardCompactRequest(m: Record<string, unknown>): CardCompactRequest | null {
  const { opId, card, expectedSessionId, hostId, attachGen, turnGen, slotGen } = m;
  if (typeof opId !== "string" || !OP_ID.test(opId)) return null;
  if (typeof card !== "string" || !card || typeof expectedSessionId !== "string" || !expectedSessionId || typeof hostId !== "string" || !hostId) return null;
  if (!isGen(attachGen) || !isGen(turnGen) || !isGen(slotGen)) return null;
  return { opId, card, expectedSessionId, hostId, attachGen, turnGen, slotGen };
}

/** 一次已受理的压缩：受理、槽结局、压缩是否真的完成分开记 */
export interface CardOpRecord {
  opId: string;
  kind: CardKind | "gate";
  acceptedAt: number;
  hostId: string;
  attachGen: number;
  sessionId: string;
  /** 槽结局：null = 还在排 / 在跑 */
  outcome: "done" | "cancelled" | "failed" | "revoked" | null;
  /** 这一槽期间到过压缩完成边界 */
  compacted: boolean;
}

/** 查询回包里给 bridge 的那一份（申请要原样带回的身份 + 结论） */
export interface CardCtxStatus {
  cap: typeof CARD_COMPACT_CAP;
  mode: CardCtxMode;
  card: string | null;
  hostId: string;
  attachGen: number;
  sessionId: string;
  turnGen: number;
  slotGen: number;
  usage: { state: "fresh" | "unknown" | "stale"; used: number | null; size: number | null; idle: number | null; hard: number | null };
  idleMs: number | null;
  /** 回合中途的预算：ACP 没有这项能力，固定 blocked-capability（验收缺口照实报） */
  busyBudget: "blocked-capability";
  verdict: CardVerdict;
  op?: CardOpRecord | null;
}

export function cardStatus(s: CardCtxSnapshot, now: number, limits?: { idle?: number; hard?: number }, op?: CardOpRecord | null): CardCtxStatus {
  const st = usageState(s);
  const line = s.usage ? cardLines(s.usage.size, limits) : null;
  const probe = { opId: "probe", card: s.identity?.card ?? "", expectedSessionId: s.sessionId, hostId: s.hostId, attachGen: s.attachGen, turnGen: s.turnGen, slotGen: s.slotGen };
  return {
    cap: CARD_COMPACT_CAP, mode: s.mode, card: s.identity?.card ?? null, hostId: s.hostId, attachGen: s.attachGen, sessionId: s.sessionId,
    turnGen: s.turnGen, slotGen: s.slotGen,
    usage: { state: st, used: s.usage?.used ?? null, size: s.usage?.size ?? null, idle: line?.idle ?? null, hard: line?.hard ?? null },
    idleMs: s.idleSince === null ? null : Math.max(0, now - s.idleSince),
    busyBudget: "blocked-capability",
    verdict: cardCompactVerdict(s, probe, now, limits),
    ...(op === undefined ? {} : { op }),
  };
}

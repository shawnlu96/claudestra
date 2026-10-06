/**
 * CTXA：ACP 卡片会话的上下文边界（纯函数）。宿主一侧的状态与原子受理在 card-context-host.ts，bridge 一头的调用在 bridge/acp-link.ts。
 * - 线：闲置线 20 万 + 闲置满 3 分钟、卡片硬线 30 万；都按 ctx-boundary-decision.ts 的 policyBoundary 收到实际模型窗口以内（小窗口模型先到）。
 * - 申请（card_compact）必须带上查询（card_context）时看到的强身份：expectedSessionId + hostId + attachGen（适配器接线代次）
 *   + turnGen / slotGen（回合与独占槽代次）+ card。宿主在受理动作的同一段同步代码里逐项核对，任何一项对不上都拒、给出原因，
 *   不重放、不降级成不带 opId 的普通 slash。
 * - 现行登记：申请还要带 bridge 在发出前那一刻按 agent-lifecycle-store.ts cardWorkerIndex（唯一读取方）取的本 agent 当前链接
 *   （binding = 卡号 + 链接记录的会话；bridge/acp-link.ts 填，调用方给不了）。没有链接 = 已退休 / 不是卡片 worker → not-bound；
 *   卡号或会话和宿主启动身份 / 此刻会话对不上 = 换绑 → binding-revoked。宿主不读台账。
 *   两段受理——card_compact 核过一切后先占住调度器（prepared），bridge 收到回包后在同一段同步代码里重读登记、发 card_commit；
 *   宿主把登记和全部受理条件重核一遍才放行 /compact（prepare 之后变了的一律作废）。这只把窗口缩到「确认帧在途」那一段：
 *   台账的撤销 / 换绑和宿主受理之间没有共同可核验的序列 / 租约（agent-lifecycle-store.ts 没有这个 port，PM 未批），
 *   确认帧发出后才撤销的登记宿主看不到。所以现行登记照实报 blocked-capability（快照 / 状态里 liveBinding），并且 fail-closed：
 *   port 接上（liveBinding = atomic）之前，申请判到最后一律 live-binding-blocked、硬线前也不自动压缩（拒开），不执行任何 /compact。
 * - opId 永不重放：完整记录只留最近 50 个，更早的只留 opId，再来回 op-expired（不当新申请）。
 * - usage 只认当前会话、当前接线代次、当前回合代次之内报的、且之后没发生过压缩的那一份；否则 unknown / stale，一律拒。
 * - 忙时：ACP 没有回合中途的预算能力（runtime budget），回合中途超线只能 blocked-capability。新回合受理边界（hardLineGate）：
 *   任何还没开、会进模型的一轮之前，当前接线里最新一份 usage 过硬线就先压缩一次；压过仍过线（失败 / 取消 / 没到压缩完成边界、
 *   且之后没有线下的 usage）就拒开这一轮、给明确原因，直到预算恢复（线下 usage、压缩完成边界、换会话 / 换接线）。
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
  /**
   * 受理与台账撤销 / 换绑有没有共同可核验的序列 / 租约。atomic 只能由那个 port 接上后给；现在没有这个 port（PM 未批），
   * 宿主固定 blocked-capability，任何压缩动作（申请、硬线前先压）一律 fail-closed，只报结论（wouldFire）
   */
  liveBinding: "atomic" | "blocked-capability";
}

/** bridge 按 cardWorkerIndex 取的本 agent 当前链接；null = 台账里没有（已退休 / 不是卡片 worker） */
export interface CardBinding {
  card: string;
  sessionId: string;
}

export interface CardCompactRequest {
  opId: string;
  binding: CardBinding | null;
  card: string;
  expectedSessionId: string;
  hostId: string;
  attachGen: number;
  turnGen: number;
  slotGen: number;
}

export type CardReject =
  | "mode-off" | "bad-request" | "op-expired" | "no-capability" | "startup-mismatch" | "card-mismatch" | "not-bound" | "binding-revoked" | "not-registered" | "old-host" | "old-attach"
  | "old-session" | "turn-drift" | "rotating" | "compacting" | "running" | "queued" | "usage-unknown" | "usage-stale" | "under" | "idle-wait"
  | "observe" | "not-prepared" | "commit-timeout" | "live-binding-blocked";

export const CARD_REJECT_TEXT: Record<CardReject, string> = {
  "mode-off": "卡片上下文边界已关（off）",
  "bad-request": "申请缺字段或格式不对",
  "op-expired": "这个 opId 以前受理过、记录已淘汰：不重放，换新 opId 重新查询后再申请",
  "not-bound": "台账里这个 agent 没有当前卡片登记（已退休或不是卡片 worker）",
  "binding-revoked": "台账里这个 agent 的当前登记已换卡 / 换会话，和宿主启动身份对不上",
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
  "not-prepared": "这个 opId 没有等确认的受理（没受理过、已确认或已作废）",
  "commit-timeout": "受理后没等到 bridge 按现行登记确认：已作废，不压缩",
  "live-binding-blocked": "受理和台账撤销 / 换绑之间没有共同序列 / 租约（blocked-capability）：不压缩，只报结论",
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

/** 现行登记核对：台账里有这个 agent 的链接，且卡号 = 启动身份的卡、会话 = 此刻接上的会话 */
export function bindingReject(s: Pick<CardCtxSnapshot, "identity" | "sessionId">, binding: CardBinding | null): CardReject | null {
  if (!binding) return "not-bound";
  return binding.card !== s.identity?.card || binding.sessionId !== s.sessionId ? "binding-revoked" : null;
}

/** 帧里的 binding：缺 / null = null；形状不对 = undefined（bad-request） */
export function parseBinding(b: unknown): CardBinding | null | undefined {
  if (b == null) return null;
  const x = b as Record<string, unknown>;
  return typeof b === "object" && typeof x.card === "string" && x.card && typeof x.sessionId === "string" && x.sessionId ? { card: x.card, sessionId: x.sessionId } : undefined;
}

/** 身份核对：申请带的每一项都要和此刻的宿主一致 */
function identityReject(s: CardCtxSnapshot, r: CardCompactRequest): CardReject | null {
  if (!s.capable || !s.identity) return "no-capability";
  if (s.identity.expectedSessionId !== s.sessionId) return "startup-mismatch";
  if (r.card !== s.identity.card) return "card-mismatch";
  const bound = bindingReject(s, r.binding);
  if (bound) return bound;
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
 * 受理判定（宿主在受理动作的同一段同步代码里调）。按顺序：模式 off → 身份 → 忙闲 → usage → 线 → 闲置时长 → observe → 现行登记租约。
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
  if (s.liveBinding !== "atomic") return { ok: false, reason: "live-binding-blocked", wouldFire: line.kind };
  return { ok: true, kind: line.kind };
}

/**
 * 新回合受理边界看的超线：当前会话、当前接线里最新的一份 usage（不看回合代次——回合结束后它就是这一刻的预算），之后没到过压缩完成边界。
 * 返回过线的那份；null = 没过线或不知道（usage 缺失 / 换过会话或接线：不知道就没法挡，等新的 usage）。
 */
export function hardOver(s: CardCtxSnapshot, limits?: { idle?: number; hard?: number }): { used: number; hard: number } | null {
  const u = s.usage;
  if (!u || !(u.used > 0) || u.sessionId !== s.sessionId || u.attachGen !== s.attachGen || u.compacted) return null;
  const { hard } = cardLines(u.size, limits);
  return u.used >= hard ? { used: u.used, hard } : null;
}

/** 新回合受理边界：硬线以上、身份一致时要不要管；observe 只报不做。具体压一次还是拒开由宿主按这一段超线的尝试记录定 */
export function hardLineGate(s: CardCtxSnapshot, limits?: { idle?: number; hard?: number }): "enforce" | "observe" | null {
  if (s.mode === "off" || !s.capable || !s.identity || s.identity.expectedSessionId !== s.sessionId || s.rotating || s.compacting) return null;
  if (!hardOver(s, limits)) return null;
  return s.mode === "on" ? "enforce" : "observe";
}

const OP_ID = /^[\w:.-]{1,128}$/;
const isGen = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;

/** acp_call 里的 card_compact 申请；缺任何一项 = null（宿主回 bad-request） */
export function parseCardCompactRequest(m: Record<string, unknown>): CardCompactRequest | null {
  const { opId, card, expectedSessionId, hostId, attachGen, turnGen, slotGen } = m;
  const binding = parseBinding(m.binding);
  if (binding === undefined) return null;
  if (typeof opId !== "string" || !OP_ID.test(opId)) return null;
  if (typeof card !== "string" || !card || typeof expectedSessionId !== "string" || !expectedSessionId || typeof hostId !== "string" || !hostId) return null;
  if (!isGen(attachGen) || !isGen(turnGen) || !isGen(slotGen)) return null;
  return { opId, card, expectedSessionId, hostId, attachGen, turnGen, slotGen, binding };
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
  /**
   * 两段受理（只有 card_compact 申请有；宿主自己的 gate 压缩不经 bridge）：pending = 已占住调度器、等 bridge 按现行登记确认；
   * committed = 确认、/compact 已放行；其它 = 作废原因（登记撤销 / 换绑 / 等确认超时 / 状态变了），不压缩
   */
  commit?: "pending" | "committed" | CardReject;
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
  /** 受理与台账撤销 / 换绑的共同序列 / 租约：台账没有这个 port，现为 blocked-capability（验收缺口照实报，压缩一律不执行） */
  liveBinding: CardCtxSnapshot["liveBinding"];
  verdict: CardVerdict;
  op?: CardOpRecord | null;
}

/** binding：查询时 bridge 带来的现行登记，结论按它算（不带 = not-bound） */
export function cardStatus(s: CardCtxSnapshot, now: number, limits?: { idle?: number; hard?: number }, op?: CardOpRecord | null, binding: CardBinding | null = null): CardCtxStatus {
  const st = usageState(s);
  const line = s.usage ? cardLines(s.usage.size, limits) : null;
  const probe = { opId: "probe", binding, card: s.identity?.card ?? "", expectedSessionId: s.sessionId, hostId: s.hostId, attachGen: s.attachGen, turnGen: s.turnGen, slotGen: s.slotGen };
  return {
    cap: CARD_COMPACT_CAP, mode: s.mode, card: s.identity?.card ?? null, hostId: s.hostId, attachGen: s.attachGen, sessionId: s.sessionId,
    turnGen: s.turnGen, slotGen: s.slotGen,
    usage: { state: st, used: s.usage?.used ?? null, size: s.usage?.size ?? null, idle: line?.idle ?? null, hard: line?.hard ?? null },
    idleMs: s.idleSince === null ? null : Math.max(0, now - s.idleSince),
    busyBudget: "blocked-capability",
    liveBinding: s.liveBinding,
    verdict: cardCompactVerdict(s, probe, now, limits),
    ...(op === undefined ? {} : { op }),
  };
}

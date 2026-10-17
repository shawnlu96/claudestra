/**
 * 入站路由的运行时（判定规则在 lib/inbound-route.ts）：开关、取数（忙闲 / 在做什么 / 排队摘要 / 目标运行时插不插得进）、调 Jev、观察日志。
 * deliverToLocal 在抢占之前调 routeInbound 一次：开关 on 且 Jev 判得出来，结论记在信封上（meta.inboundRoute，随押后队列落盘），
 * 之后 deliverToLocal / held-flush / check_inbox 都经下面几个绑好开关的判定读它；observe 只记日志、不等 Jev、不改投递。
 * Chat Guard 开着时路由问题并进守门那一次 Jev 请求（routeProbeFor），不另发。单测 tests/inbound-route-*.test.ts；设计 docs/architecture/inbound-route.md
 */
import { readConfigSync } from "../lib/config-store.js";
import { jevAsk, type JevQuestion, type JevText } from "../lib/jev.js";
import { appendLogLine } from "../lib/log-paths.js";
import { statePath } from "../lib/paths.js";
import { ownerStopOf } from "../lib/stop-words.js";
import { holdsUntilIdle, type TurnState } from "../lib/turn-state.js";
import {
  admitsWhileBusy, buildRouteState, decideRoute, holdsWhileBusy, insertsWhileBusy, insertVia, mayInsert, mergeDue, mergeOrder, parseRouteMode, pullable, QUEUE_KEEP, queueEntry,
  ROUTE_TIMEOUT_MS, routeEligible, routeQuestions, routeRole, ruleAction, senderName, type InsertVia, type QueueEntry, type RouteEnv, type RouteMode,
} from "../lib/inbound-route.js";
import { controlFor } from "../lib/runtimes/index.js";
import { readRegistryAgents } from "../lib/registry.js";
import { noteInsert } from "./steer-insert.js";
import { isHeldIdleCarrier } from "../lib/held-idle-batch.js";
import { heldAgentBatchOn, isAgentBatchable } from "../lib/held-agent-batch.js";
import { leaseActive, type HeldItem, type HeldQueue } from "./held-queue.js";
import { isHumanRequest, type Envelope, type LocalEndpoint } from "./router.js";
import { turnBrief } from "./turn-brief.js";
import { probeTurn, resolveTurnWindow } from "./turn-probe.js";

/** 每条判定一行（observe / on 都记）：「Jev 会怎么判 / 实际怎么做」，给 owner 对照；正文只留开头 */
const ROUTE_LOG_PATH = statePath("inbound-route.jsonl");
const MODE_TTL_MS = 2_000;
const PREVIEW = 80;

interface Deps {
  ask: typeof jevAsk;
  probe: (channelId: string, agent: string) => Promise<TurnState>;
  /** 这个频道押着的消息（排队摘要）；没接线 = 空 */
  queue: (channelId: string) => readonly HeldItem[] | undefined;
  doing: (agent: string, channelId: string) => Promise<string>;
  /**
   * 目标运行时的插法（RuntimeControl.insertVia）。declared = 只是声明值、bridge 核实不了：ACP 宿主支不支持 steering 只有宿主自己知道
   * （不支持时它原位改回 prompt，不丢），日志记 steer(declared)
   */
  insertDecl: (channelId: string) => Promise<{ via?: "steer"; declared?: boolean }>;
  /** 发送方频道是不是 registry 里登记着的 agent（插队只给它们） */
  senderRegistered: (channelId: string) => Promise<boolean>;
  readMode: () => RouteMode;
  log: (entry: Record<string, unknown>) => void;
  now: () => number;
}
const control = () => process.env.CONTROL_CHANNEL_ID || "";
let deps: Deps = {
  ask: jevAsk,
  probe: (ch, agent) => probeTurn(ch, agent, control()),
  queue: () => undefined,
  doing: async (agent, ch) => turnBrief(agent, ch, (await resolveTurnWindow(ch, control())).runtime),
  insertDecl: async (ch) => {
    const w = await resolveTurnWindow(ch, control());
    return { via: controlFor(w.runtime, w.transport).insertVia, declared: w.transport === "acp" };
  },
  senderRegistered: async (ch) => (await readRegistryAgents()).some((a) => a.channelId === ch && a.status === "active"),
  readMode: () => parseRouteMode(readConfigSync().inboundRoute?.mode),
  log: (e) => void appendLogLine(ROUTE_LOG_PATH, JSON.stringify(e)),
  now: () => Date.now(),
};
/** bridge.ts 启动时接押后队列；单测注入假 Jev / 忙闲 / 时钟 */
export function configureInboundRoute(d: Partial<Deps>): void {
  deps = { ...deps, ...d };
  modeAt = -Infinity;
}

let cachedMode: RouteMode = "off";
let modeAt = -Infinity;
/** 当前档位：manager / 设置接口写进 config.json，这里最多 2 秒后跟上（不用重启 bridge）；读坏了按 off */
function routeMode(): RouteMode {
  const now = deps.now();
  if (now - modeAt < MODE_TTL_MS) return cachedMode;
  try {
    cachedMode = deps.readMode();
  } catch (e) {
    console.error(`⚠️ 入站路由：读开关失败，按 off: ${(e as Error).message}`);
    cachedMode = "off";
  }
  modeAt = now;
  return cachedMode;
}

// ── 三处共用的判定，绑好当前档位 ─────────────────────────────────────────────
type Human = (env: Envelope) => boolean;
export const routeAdmitsWhileBusy = (env: Envelope, human: Human = isHumanRequest): boolean => admitsWhileBusy(env, routeMode(), human as (e: RouteEnv) => boolean);
/**
 * 本次投递尝试已按插队放行（routeHolds 判定那一刻冻结）：afterInsertSend 只认它、不再重读档位——判定到 ws.send 之间有好几个 await，
 * 中途热切到 off / observe 也不能丢押回、漏记确认账。每次 routeHolds 先清再判：重投 / 押后放出的空闲投递不继承上一次的插队决定
 */
const insertAttempt = new WeakSet<Envelope>();
/** deliverToLocal 的押后判据：原有规则（压缩中 / agent 消息忙时）之外，Jev 判了排队 / 合并的忙时也押；判了 insert 的忙时不押、直接送进回合（压缩中照押） */
export const routeHolds = (env: Envelope, turn: TurnState): boolean => {
  insertAttempt.delete(env);
  if (turn.main === "busy" && insertsWhileBusy(env, routeMode())) return void insertAttempt.add(env), false;
  return holdsUntilIdle(env.from.kind, env.meta.waitForIdle, turn) || (turn.main === "busy" && holdsWhileBusy(env, routeMode()));
};
/**
 * 回合中插队 ws.send 之后（bridge.ts deliverToLocal 一行）：没送到（回 0 = 连接已断、这条被丢了）→ 退回押后队列，回合结束 / 重连后照常投，
 * 返回 true = 已押回；送到了 → 记一笔「没确认」：目标明确回给插队方之前不把它别的输出当答复（bridge/steer-insert.ts）。
 * 只管 insert 这条路——改动前 agent 消息忙时根本不 ws.send，空闲投递的老行为不动。认的是 routeHolds 判定时冻结的放行（insertAttempt），turn 只为签名留着
 */
export function afterInsertSend(env: Envelope, _turn: TurnState, sent: unknown, held: Pick<HeldQueue, "holdEnv">): boolean {
  if (!insertAttempt.delete(env)) return false; // 这次投递没按插队放行（空闲 / 不是 insert / 判定时不是 on）
  if (sent === 0) {
    console.warn(`⚠️ 入站路由：插队送出失败（连接已断），${env.meta.messageId} 退回押后队列，${held.holdEnv(env)} 条`);
    return true;
  }
  noteInsert(env, (env.to as LocalEndpoint).channelId);
  return false;
}
export const routeOrder = <T extends HeldItem>(items: readonly T[]): T[] => mergeOrder(items, routeMode());
/** 押满时限放出：判了排队 / 合并的结论记成「回合中直接送、不抢占」（没有结论的不动，按原规则） */
export function routeRelease(env: Envelope): void {
  const r = env.meta.inboundRoute;
  if (r && r.action !== "interrupt") env.meta.inboundRoute = { ...r, release: true };
}
export const routeDue = <T extends HeldItem>(due: readonly T[], queue: readonly T[]): T[] => mergeDue(due, queue, routeMode());
export const routePullable = (item: HeldItem, queue: readonly HeldItem[], base: (i: HeldItem) => boolean): boolean => pullable(item, queue, base, routeMode());

/** 已经判过（守门那次带着判了 / 本次投递判过）的信封：同一次投递不再问 */
const decided = new WeakSet<Envelope>();

export interface RouteProbe {
  state: JevText;
  questions: Record<string, JevQuestion>;
  /** 拿到答案（或失败 = null）之后：on 记结论，两档都记日志 */
  settle: (answers: Record<string, unknown> | null, info: { ms?: number; error?: string; via: "solo" | "guard" }) => void;
}

/** 排队摘要：同一目标押着的、最近 QUEUE_KEEP 条（批次载体不算） */
function queueOf(channelId: string, incoming: Envelope): { items: HeldItem[]; entries: QueueEntry[] } {
  const items = (deps.queue(channelId) ?? []).filter((i) => !isHeldIdleCarrier(i) && i.env.meta.messageId !== incoming.meta.messageId).slice(-QUEUE_KEEP);
  // 新来的这条也得进得了合批载体（带附件的不行）、开关开着，才谈得上和谁一起投
  const canBatch = heldAgentBatchOn() && isAgentBatchable({ env: incoming, to: incoming.to as LocalEndpoint });
  // 已被 check_inbox 领走（租约中）的不当合并目标：跟着它的那条要押到确认 / 租约过期（最长 15 分钟）才放得出来
  return { items, entries: items.map((i) => queueEntry(i.env, incoming.from, canBatch && isAgentBatchable(i) && !leaseActive(i))) };
}

/**
 * 这一条要不要问 Jev、问什么：开关 off、不该问（lib routeEligible）、目标不是主回合在跑（空闲直接投、压缩中照旧押）→ null。
 * Chat Guard 也调它：返回的问题并进守门那一次请求
 */
export async function routeProbeFor(env: Envelope, to: LocalEndpoint, agent: string): Promise<RouteProbe | null> {
  const mode = routeMode();
  if (mode === "off" || decided.has(env) || !routeEligible(env, ownerStopOf(env).stop && !env.meta.forwarded)) return null;
  const turn = await deps.probe(to.channelId, agent);
  if (turn.main !== "busy") return null;
  decided.add(env);
  const { entries } = queueOf(to.channelId, env);
  const doing = await deps.doing(agent, to.channelId).catch((e: Error) => (console.warn(`⚠️ 入站路由：取「在做什么」失败，按不知道: ${e.message}`), ""));
  const actual = ruleAction(isHumanRequest(env), holdsUntilIdle(env.from.kind, env.meta.waitForIdle, turn));
  const role = routeRole(env);
  const ins = await insertCtx(env, to.channelId);
  let settled = false;
  const base = { msg: env.meta.messageId, agent, from: senderName(env.from), role, preview: env.content.slice(0, PREVIEW), queued: entries.length, rule: actual };
  return {
    state: buildRouteState({ env, agent, doing, queue: entries }),
    questions: routeQuestions(entries.length, ins.agentSender),
    settle: (answers, info) => {
      if (settled) return; // 守门那次拿到答案后自己判定又抛错，会再报一次失败：只认第一次
      settled = true;
      settle(env, mode, { entries, ...ins }, answers, { ...base, via: info.via, ms: info.ms, ...(info.error ? { error: info.error } : {}) });
    },
  };
}

interface InsertCtx { insert: InsertVia; agentSender: boolean; senderQueued: boolean; declared?: boolean }
/**
 * 插队的前提：发送方是登记过的本机 agent（才给 Jev 这个选项）、目标运行时插得进（取不到按插不进：insert 退成排队，就是改动前的行为）、
 * 同一发送方在这个目标的押后队列里没有排着的（不然后发的先到）
 */
async function insertCtx(env: Envelope, target: string): Promise<InsertCtx> {
  const warn = (what: string) => (e: Error) => (console.warn(`⚠️ 入站路由：${what}失败，按不能插队: ${e.message}`), undefined);
  const ch = env.from.kind === "local" ? env.from.channelId : "";
  const agentSender = mayInsert(env) && !!(await deps.senderRegistered(ch).catch(warn("查发送方登记")));
  if (!agentSender) return { insert: null, agentSender, senderQueued: false };
  const senderQueued = (deps.queue(target) ?? []).some((i) => i.env.from.kind === "local" && i.env.from.channelId === ch);
  const decl = await deps.insertDecl(target).catch(warn("取目标运行时"));
  return { insert: insertVia(decl?.via), agentSender, senderQueued, declared: decl?.declared };
}

function settle(env: Envelope, mode: RouteMode, ctx: { entries: QueueEntry[] } & InsertCtx, answers: Record<string, unknown> | null, base: Record<string, unknown>): void {
  const ts = new Date(deps.now()).toISOString();
  if (!answers) return deps.log({ ts, mode, ...base, jev: "error", actual: base.rule });
  let d: ReturnType<typeof decideRoute>;
  try {
    d = decideRoute(answers, { env, queue: ctx.entries, insert: ctx.insert, agentSender: ctx.agentSender, senderQueued: ctx.senderQueued });
  } catch (e) {
    return deps.log({ ts, mode, ...base, jev: "error", error: (e as Error).message, actual: base.rule });
  }
  if (!d.ok) return deps.log({ ts, mode, ...base, jev: "unsure", actual: base.rule });
  const applied = mode === "on";
  if (applied) env.meta.inboundRoute = d.route;
  // pick = Jev 原本选的、jev = 代码兜底之后的结论；插队相关的行带 insertVia（目标运行时怎么插 / none = 插不进），对照报表用
  const pick = (answers.route_action as { choice?: string }).choice;
  const aboutInsert = pick === "insert" || d.route.action === "insert" || (pick === "interrupt" && d.downgraded === "not_owner");
  deps.log({ ts, mode, ...base, pick, jev: d.route.action, p: +d.route.p.toFixed(2), ...(d.route.mergeWith ? { mergeWith: d.route.mergeWith } : {}),
    ...(d.downgraded ? { downgraded: d.downgraded } : {}), ...(aboutInsert ? { insertVia: insertLabel(ctx) } : {}), actual: applied ? d.route.action : base.rule });
  if (applied) console.log(`🧭 入站路由：${base.agent} 忙，${base.from} 的消息（${env.meta.messageId}）按 Jev 判 ${d.route.action}${d.downgraded ? `（代码兜底：${d.downgraded}）` : ""}`);
}

const insertLabel = (c: InsertCtx): string => (!c.insert ? "none" : c.declared ? `${c.insert}(declared)` : c.insert);

async function askSolo(p: RouteProbe): Promise<void> {
  const t0 = deps.now();
  try {
    const r = await deps.ask(p.state, p.questions, { timeoutMs: ROUTE_TIMEOUT_MS, retries: 0 });
    p.settle(r.answers as Record<string, unknown>, { ms: r.latencyMs, via: "solo" });
  } catch (e) {
    // 没 key / 超时 / 挂了：按现有规则投，记一行日志就够（判定是锦上添花，不能挡投递）
    p.settle(null, { ms: deps.now() - t0, error: (e as Error).message, via: "solo" });
  }
}

/**
 * deliverToLocal 抢占之前调（bridge.ts 一行）：on 档等 Jev（≤1.5 秒）把结论记到信封上；observe 档不等、照现有规则投，判完记日志。
 * 守门那次已经带着判过的直接返回
 */
export async function routeInbound(env: Envelope, to: LocalEndpoint, agent: string): Promise<void> {
  const p = await routeProbeFor(env, to, agent);
  if (!p) return;
  if (routeMode() === "on") await askSolo(p);
  else void askSolo(p);
}

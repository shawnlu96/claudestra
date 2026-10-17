/**
 * bridge 这一头的 ACP 宿主接线（T60，宿主在 src/acp-host.ts）。宿主发来的帧（bridge.ts 一行分派到 onAcpFrame）：
 * - acp_entries：CC 形状的流式条目 → jsonl-watcher 的推送模式，工具 / 正文 / 状态事件和尾读 rollout 时一样发。每批带 hostId +
 *   条目序号，处理完回 true 宿主才出队；watcher 还没挂好（注册后要查 registry）回 false，宿主退避重送，这里按序号跳过处理过的前缀；
 * - acp_config：会话的 configOptions，存一份给设置页（不重启切模型 / 推理强度）和额度卡用；
 * - acp_failure：额度 → 「待你处理」卡，带原文 / 重置时间，第一个选项是「等重置」，后面只列真能走通的模型（acp-quota.ts）；
 *   点了才经宿主调 set_config_option，只有配了备用链 on 档才自动切（docs/architecture/acp-quota.md）；没登录 → 「需要 owner 登录」卡，宿主接上线程后自动结掉；适配器说能重试的失败只有条目，
 *   不能重试的（策略拦截、请求被拒等）开「<运行时> 回合失败」卡（extra.failure = error），调度器据此交 PM，
 *   同时记下来，这一轮 Stop 时告诉开这一轮的请求方（turn-failure.ts）；
 * - acp_permission：权限请求按频道排队，一次出一张卡。宿主超时 / 适配器退出发 gone 撤卡，宿主断线（onAcpHostGone）撤它挂着的。
 * 权限卡、额度卡的按钮都带这张卡的代际（每张新卡新生成，不复用）：作答先按代际原子认领，旧卡、认领过的一律 409、零授权；
 * 权限还要经宿主确认它仍在等才算答上。只认这个频道当前登记的那条连接发来的帧。tests/acp-link.test.ts。
 */
import { randomBytes } from "node:crypto";
import type { Client } from "discord.js";
import { parseConfigOptions, quotaCardChoices, type ConfigOption, type QuotaChoice } from "../lib/acp/config.js";
import type { AcpFailure } from "../lib/acp/failures.js";
import type { PermissionCard } from "../lib/acp/permissions.js";
import { parseSlotReply, SLOT_OPS, type CancelSlotResult, type HostSlotState } from "../lib/acp/turn.js";
import { planAcpQuota } from "./acp-quota.js";
import { quotaCardText } from "../lib/acp/quota-fallback.js";
import { apiJson } from "./api-respond.js";
import { openRuntimeAsk, settleRuntimeAsk } from "./ask-runtime.js";
import { agentNameForChannel, pushEntries } from "./jsonl-watcher.js";
import { extensionSocketOf } from "./pi-abort.js";
import { rebindAcpWatcher } from "./acp-rebind.js";
import { isAcpChannel } from "./acp-state.js";
import { cyberFailureCardQuiet } from "../lib/agent-supervisor-bridge.js";
import { dispatchedFailureQuiet, type FailureAt } from "../lib/runtime-failure-audience.js";
import { isTransientAcpFailure } from "../lib/transient-error.js";
import { noteTurnFailure } from "./turn-failure.js";

type Socket = { send(data: string): void };
type Who = { principal?: string; device?: string };
type Answer = { status: number; body: Record<string, unknown> };
type Perm = { gen: string; permId: string; ws: Socket; card: PermissionCard; claimed?: true };
type Quota = { gen: string; ws: Socket; failureKey: string; message: string; choices: QuotaChoice[]; claimed?: true; auto?: true; autoTried?: true };

const configs = new Map<string, ConfigOption[]>();
const quotaCards = new Map<string, Quota>();
const authCards = new Set<string>();
/** 频道 → 排着的权限请求；队首就是卡上显示的那个 */
const permQueues = new Map<string, Perm[]>();
/** 频道 → 已处理到的条目序号（按宿主进程区分：宿主重起序号从 1 开始） */
const entrySeqs = new Map<string, { hostId: string; last: number; lost: number }>();
const bridgeEpoch = randomBytes(6).toString("hex");
/** 同频道的批次处理完才看下一批的序号；ws 消息处理器本身不会等上一个 async 回调。 */
const entryTurns = new Map<string, Promise<void>>();
type CallResult = { ok: boolean; error?: string; sessionId?: string; uncertain?: true; busy?: boolean; slot?: HostSlotState; cancel?: CancelSlotResult };
type Call = { channelId: string; ws: Socket; op: unknown; opId?: string; gen?: number; resolve: (r: CallResult) => void; timer: ReturnType<typeof setTimeout> };
const calls = new Map<string, Call>();
let nextCall = 0;
const CALL_TIMEOUT_MS = 15_000;
const TURN_QUERY_MS = 5_000;

const QUOTA_PREFIX = "acp_quota_";
const PERM_PREFIX = "acp_perm_";
const QUOTA_RE = /^acp_quota_([0-9a-f]{12})_(\d+)$/;
const PERM_RE = /^acp_perm_([0-9a-f]{12})_(.+)$/;
const newGen = () => randomBytes(6).toString("hex");
const stale = (error: string): Answer => ({ status: 409, body: { ok: false, code: "ask_stale", error } });

export const acpConfigOf = (channelId: string): ConfigOption[] => configs.get(channelId) ?? [];

/** 这个频道此刻还开着的额度卡 / 权限卡（队首）的按钮 id：排查用，单测拿它按真实代际作答 */
export function liveAcpButtons(channelId: string): { quota: string[]; permission: string[] } {
  const q = quotaCards.get(channelId);
  const p = permQueues.get(channelId)?.[0];
  return {
    quota: q && !q.claimed ? q.choices.map((_, i) => `${QUOTA_PREFIX}${q.gen}_${i}`) : [],
    permission: p && !p.claimed ? p.card.options.map((o) => `${PERM_PREFIX}${p.gen}_${o.id}`) : [],
  };
}

export async function onAcpFrame(msg: Record<string, any>, ws: Socket, discord: Client): Promise<void> {
  const channelId = String(msg.channelId ?? "");
  if (!channelId || extensionSocketOf(channelId) !== ws) return void console.warn(`⚠️ 丢掉一帧 ${msg.type}：不是频道 ${channelId || "?"} 当前登记的宿主发的`);
  switch (msg.type) {
    case "acp_entries": {
      const previous = entryTurns.get(channelId) ?? Promise.resolve();
      const current = previous.then(() => extensionSocketOf(channelId) === ws && acceptEntries(channelId, msg, discord));
      const settled = current.then(() => {}, () => {});
      entryTurns.set(channelId, settled);
      void settled.then(() => { if (entryTurns.get(channelId) === settled) entryTurns.delete(channelId); });
      const ok = await current;
      if (typeof msg.requestId === "string") ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, result: ok }));
      return;
    }
    case "acp_rebind": {
      const result = await rebindAcpWatcher(channelId, String(msg.sessionId ?? ""), discord, String(msg.previousSessionId ?? "")).catch((e) => ({ ok: false, error: String(e) }));
      if (typeof msg.requestId === "string") ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, result: result.ok }));
      if (!result.ok) console.warn(`⚠️ ACP watcher 换代未就绪：${result.error}`);
      return;
    }
    case "acp_config":
      configs.set(channelId, parseConfigOptions(msg.configOptions));
      if (authCards.delete(channelId)) settleRuntimeAsk("codex", channelId); // 登好了、接上线程了：登录卡结掉
      return;
    case "acp_failure":
      return onFailure(channelId, ws, msg.failure as AcpFailure, msg.configOptions, typeof msg.label === "string" && msg.label ? msg.label : "Codex", {
        sessionId: typeof msg.sessionId === "string" && msg.sessionId ? msg.sessionId : undefined,
        failedAt: Number.isFinite(msg.failedAt) ? Number(msg.failedAt) : undefined,
      });
    case "acp_permission":
      return onPermission(channelId, ws, msg);
    case "acp_call_result": {
      const id = String(msg.id);
      const c = calls.get(id);
      if (!c || c.channelId !== channelId || c.ws !== ws) return;
      calls.delete(id);
      clearTimeout(c.timer);
      if (msg.ok === true && c.opId !== undefined) return void c.resolve(slotResult(msg, c));
      c.resolve(msg.ok ? { ok: true, sessionId: msg.sessionId, ...(msg.ok === true && typeof msg.busy === "boolean" ? { busy: msg.busy } : {}) } : {
        ok: false, error: String(msg.error ?? "宿主拒绝"),
        ...(c.op === "clear" && typeof msg.sessionId === "string" ? { uncertain: true as const, sessionId: msg.sessionId } : {}),
      });
      if (msg.ok && msg.configOptions) configs.set(channelId, parseConfigOptions(msg.configOptions));
      return;
    }
  }
}

/** 一批条目：跳过这个宿主已经处理过的前缀（上次回包丢了、宿主重送），剩下的交 watcher；watcher 不在回 false，宿主会重送 */
async function acceptEntries(channelId: string, msg: Record<string, any>, discord: Client): Promise<boolean | { ok: true; lost: number; bridgeEpoch: string }> {
  const entries: object[] = Array.isArray(msg.entries) ? msg.entries : [];
  const hostId = typeof msg.hostId === "string" ? msg.hostId : "";
  const first = Number(msg.firstSeq);
  if (!hostId || !Number.isInteger(first) || first < 1 || !entries.length) return false;
  const seen = entrySeqs.get(channelId);
  // bridge 重启后去重表是空的，但仍在跑的宿主会从未确认的较大序号接着送；这一轮由宿主标记为不确定收尾。
  const last = seen?.hostId === hostId ? seen.last : first - 1;
  const gap = first > last + 1 ? first - last - 1 : 0;
  if (gap) console.warn(`⚠️ ACP 条目缺口：${channelId} 宿主 ${hostId} 已收至 ${last}，重送从 ${first} 开始；按丢失确认`);
  const fresh = entries.slice(Math.max(0, last - first + 1));
  const sessionId = typeof msg.sessionId === "string" ? msg.sessionId : undefined;
  const result = await pushEntries(channelId, fresh, discord, sessionId);
  if (!result.ok) return false;
  if (!fresh.length) return seen?.lost ? { ok: true, lost: seen.lost, bridgeEpoch } : true;
  const lost = (seen?.hostId === hostId ? seen.lost : 0) + gap + result.lost;
  entrySeqs.set(channelId, { hostId, last: first + entries.length - 1, lost });
  return lost ? { ok: true, lost, bridgeEpoch } : true;
}

/** label：宿主报的运行时称呼（Codex / Pi，老宿主不带 = Codex），只进卡片标题；at：失败发生在哪个会话、什么时刻（老宿主不带），回合失败卡记进 extra，派单会话据此认归属 */
function onFailure(channelId: string, ws: Socket, f: AcpFailure, rawConfig: unknown, label: string, at: FailureAt = {}): Promise<void> | void {
  const agentName = agentNameForChannel(channelId) ?? channelId;
  if (f?.kind === "quota") {
    return showQuotaCard(channelId, ws, agentName, f, rawConfig, label);
  } else if (f?.kind === "auth") {
    authCards.add(channelId);
    const context = label === "Pi"
      ? "在这台机器上给 Pi 配好这个模型 provider 的凭据（终端里开一次 `pi` 用 /login，或设好对应的 API key），再重发消息。"
      : "在这台机器的终端里跑一次 `codex login`（或设好 API key）。登好之后宿主每分钟自动重试，接上线程后这张卡自己结掉。";
    void openRuntimeAsk({ source: "codex", channelId, agentName, kind: "owner_action", title: `${label} 需要 owner 登录`, context, options: [] });
  } else if (f?.kind === "error" && f.retry !== true) {
    let routed: boolean | undefined;
    const dispatched = (): boolean => (routed ??= dispatchedFailureQuiet(channelId, at));
    // 这一轮 Stop 时告诉开这一轮的请求方（stop-settle）。网络类也告诉：回程槽可能早被一句「收到」消化了，续跑用完时的升级只发到它自己频道
    noteTurnFailure(channelId, { key: f.key, message: f.message, label, agent: agentName, ...(isTransientAcpFailure(f) ? { retrying: true } : {}) });
    // 网络类（断网 / 代理抖 / 5xx）：失败条目照样触发续跑，按退避续、用完才在频道报一次（api-error-resume.ts）；派单会话照旧开卡交派活方
    if (isTransientAcpFailure(f) && !dispatched()) return void console.log(`🌐 ACP 网络类失败（${agentName}）：${f.message} → 不开卡，退避续跑`);
    // 策略拦截（cyber_policy）、请求被拒、上下文耗尽：回合已经停了，不会自己续跑。开卡留痕，调度器据此把这张单交 PM（scheduler-auto-ports.ts）
    console.log(`⚠️ ACP 回合失败（${agentName}）：${f.message}`);
    const quiet = cyberFailureCardQuiet(agentName, f.message, Date.now(), at, dispatched); // 监护在处置 / 派活方接手：不推 owner
    void openRuntimeAsk({ source: "codex", channelId, agentName, kind: "owner_action", title: `${label} 回合失败`, context: f.message, options: [],
      failure: "error", instance: f.key, ...at, ...(f.deliveryUnknown ? { deliveryUnknown: true as const } : {}), ...(quiet ? { quiet: true as const } : {}) });
  }
}

/**
 * 额度卡：选项 / 正文由 acp-quota.ts 定；备用链 on 档先切，切成了出通知卡（附「切回」），没切成照常出额度卡、同一个失败不再试。
 * ws = 报这次失败的宿主。中间有 await（读额度快照、等宿主回切换结果），期间频道可能换了宿主：每次 await 之后都核一次，
 * 换了就整件作废——退役会话的额度失败不能把新会话的模型切走，也不能给它出卡（tests/acp-quota-link.test.ts「宿主替换」）
 */
async function showQuotaCard(channelId: string, ws: Socket, agentName: string, f: AcpFailure, rawConfig: unknown, label: string): Promise<void> {
  const retired = (step: string) => extensionSocketOf(channelId) !== ws && (console.log(`⏭ 额度卡作废（${agentName}）：${step}时宿主已换`), true);
  const prev = quotaCards.get(channelId);
  const tried = prev?.failureKey === f.key && prev.autoTried;
  if (tried && prev.auto) return; // 同一个失败重报：已经切过了，再切一次只会把卡顶掉
  const opts = parseConfigOptions(rawConfig);
  const config = opts.length ? opts : acpConfigOf(channelId);
  const plan = await planAcpQuota(channelId, agentName, f, config, label).catch((e) => void console.error(`⚠️ 额度卡凑不齐（照出原文卡）：${(e as Error).message}`));
  if (retired("凑卡")) return;
  if (!plan) return openQuotaCard(channelId, ws, agentName, f, { title: `${label} 额度用完了`, context: f.message, choices: quotaCardChoices(config), quota: true });
  let context = plan.context;
  if (plan.autoSwitch && plan.switched && !tried) {
    // 上面刚核过、到这里没有 await：acpSetConfig 同步取到的就是报失败的那个宿主
    const r = await acpSetConfig(channelId, "model", plan.autoSwitch);
    if (retired("切换")) return;
    if (r.ok) return void openQuotaCard(channelId, ws, agentName, f, { ...plan.switched, quota: false });
    context = quotaCardText({ ...plan.facts, switchError: r.error ?? "宿主没说原因" });
  }
  openQuotaCard(channelId, ws, agentName, f, { title: `${label} 额度用完了`, context, choices: plan.choices, quota: true }, !!plan.autoSwitch);
}

/** autoTried：这个失败已经按备用链试过切换（成没成都算），重报不再试 */
function openQuotaCard(channelId: string, ws: Socket, agentName: string, f: AcpFailure, card: { title: string; context: string; choices: QuotaChoice[]; quota: boolean }, autoTried = !card.quota): void {
  // 同一个失败又报一次（原文、选项值都没变、卡还没人答）：沿用这张卡和它的代际，否则是新卡、旧卡的按钮作废。
  // 只比选项值：「等重置」按钮上的时刻文字会随时间变（「2 小时后」晚一分钟重报就不一样），按文字比会把还有效的卡换掉
  const values = (cs: QuotaChoice[]) => JSON.stringify(cs.map((c) => c.value));
  const prev = quotaCards.get(channelId);
  const same = prev && !prev.claimed && prev.ws === ws && prev.failureKey === f.key && prev.message === f.message && values(prev.choices) === values(card.choices);
  const q: Quota = same ? prev : { gen: newGen(), ws, failureKey: f.key, message: f.message, choices: card.choices, ...(card.quota ? {} : { auto: true as const }) };
  if (autoTried) q.autoTried = true;
  quotaCards.set(channelId, q);
  const buttons = q.choices.map((c, i) => ({ id: `${QUOTA_PREFIX}${q.gen}_${i}`, label: c.label, style: c.value === null ? "secondary" : "primary" }));
  // 额度卡：原文进 context（openRuntimeAsk 存进 extra.raw、按它算过期），卡面换成 quotaText；自动切换的通知卡不带 quota，调度器 / 监护不把它当失败（scheduler-auto-ports.ts codexFailure）
  void openRuntimeAsk({
    source: "codex", channelId, agentName, kind: "decide", title: card.title, acp: true, instance: q.gen, options: [{ type: "buttons", buttons }],
    ...(card.quota ? { quota: true as const, context: f.message, quotaText: card.context } : { context: card.context }),
  });
}

/** 宿主的权限帧：新请求排队（队首出卡）；同一个 permId 重发 = 宿主重连后补发，卡和按钮不变；gone = 宿主那边不等了，撤卡 */
function onPermission(channelId: string, ws: Socket, msg: Record<string, any>): void {
  const permId = String(msg.permId ?? "");
  if (!permId) return;
  const q = permQueues.get(channelId) ?? [];
  const known = q.find((p) => p.permId === permId);
  if (msg.gone) return void (known && dropPerm(channelId, known, `宿主撤回：${String(msg.gone)}`));
  if (known) return void (known.ws = ws);
  const card = msg.card as PermissionCard;
  if (!card?.options?.length) return;
  q.push({ gen: newGen(), permId, ws, card });
  permQueues.set(channelId, q);
  if (q.length === 1) showPerm(channelId);
}

function showPerm(channelId: string): void {
  const head = permQueues.get(channelId)?.[0];
  if (!head) return;
  const buttons = head.card.options.map((o) => ({ id: `${PERM_PREFIX}${head.gen}_${o.id}`, label: o.label, style: o.style }));
  const agentName = agentNameForChannel(channelId) ?? channelId;
  void openRuntimeAsk({
    source: "permission", channelId, agentName, kind: "authorize", title: head.card.title, context: head.card.detail, acp: true, instance: head.gen,
    options: [{ type: "buttons", buttons }],
  });
}

/** 一个权限请求结束（答了 / 宿主撤回 / 断线）：出队；是卡上那张就结卡（答了记作答人），再出下一张 */
function dropPerm(channelId: string, p: Perm, why: string, answered?: { label: string; who: Who }): void {
  const q = permQueues.get(channelId) ?? [];
  const i = q.indexOf(p);
  if (i < 0) return;
  q.splice(i, 1);
  if (!q.length) permQueues.delete(channelId);
  if (i !== 0) return;
  if (answered) settleRuntimeAsk("permission", channelId, "interact", answered.label, answered.who);
  else console.log(`🔐 撤掉 ${channelId} 的权限卡：${why}`), settleRuntimeAsk("permission", channelId);
  showPerm(channelId);
}

/** 宿主的连接断了（bridge.ts 的 ws close）：它挂着的权限卡撤掉；宿主重连后会把还在等的补发上来，出新卡 */
export function onAcpHostGone(channelId: string, ws: Socket): void {
  for (const p of [...(permQueues.get(channelId) ?? [])]) if (p.ws === ws && !p.claimed) dropPerm(channelId, p, "宿主断线");
  for (const [id, c] of calls) {
    if (c.channelId !== channelId || c.ws !== ws) continue;
    calls.delete(id);
    clearTimeout(c.timer);
    c.resolve({ ok: false, uncertain: true, error: "宿主连接断开，结果未确认；请先查看当前会话，再决定是否重试" });
  }
}

/** 经宿主调 session/set_config_option（设置页的模型 / 推理强度、额度卡的「切到 X」）：不重启 */
export const acpSetConfig = (channelId: string, configId: string, value: string) => acpCall(channelId, { op: "set_config", configId, value });

/**
 * 斜杠命令（/compact 等）原样当一轮 prompt 交给宿主：不包 <channel>，适配器自己认（lib/runtimes/codex-control.ts）。
 * 带 opId = 独占命令槽：回包的 slot 带宿主 hostId + 槽代次 gen，之后查 / 撤都带上它们（旧宿主、旧代次的槽一律 gone）。
 */
export const acpSlash = (channelId: string, text: string, opId?: string) => acpCall(channelId, { op: "slash", text, ...(opId === undefined ? {} : { opId }) });

/** 编排器的一轮普通 prompt（保存交接用）：独占一轮，不和相邻入站拼 */
export const acpOpTurn = (channelId: string, text: string, opId: string) => acpCall(channelId, { op: "op_turn", text, opId });

type SlotRef = { hostId?: string; gen?: number };
/** 槽状态；waitMs 有值 = 宿主等槽结束（或被撤）才回，结局 {opId, gen, outcome} 是宿主按这一槽的实际结局报的 */
export const acpSlotStatus = (channelId: string, opId: string, ref: SlotRef = {}, waitMs?: number) =>
  acpCall(channelId, { op: "slot_status", opId, ...ref, ...(waitMs ? { wait: true } : {}) }, waitMs);

/** 按 op 撤槽：排着的删掉（revoked），在跑的 uncancellable，不认识 / 已结束 gone；宿主从不因此发 session/cancel */
export const acpCancelSlot = (channelId: string, opId: string, ref: SlotRef = {}) => acpCall(channelId, { op: "cancel_slot", opId, ...ref });

/** 槽回包只信形状、opId（及请求带的 gen）都对得上的；对不上当宿主答错，不当结局 */
function slotResult(msg: Record<string, any>, c: Call): CallResult {
  const r = parseSlotReply(msg, c.opId!, c.gen);
  return r ? { ok: true, ...r } : { ok: false, error: "宿主回的槽信息和请求对不上" };
}

/** 清上下文要新建并引导线程、持久化 registry；比普通配置调用等得久。then = 换代成功后新会话的第一轮（宿主排在恢复入站之前，lib/acp/clear.ts） */
export const acpClear = (channelId: string, then?: { text: string; opId: string }) => acpCall(channelId, { op: "clear", ...(then ? { then } : {}) }, 225_000);

/**
 * 宿主此刻有没有回合在途（AcpTurnLoop.busy，含排着没开的）。不是 ACP 宿主登记的频道、宿主不答、旧宿主不认这个调用 = null（调用方当未知）。
 * busy 只在回包 ok 严格为 true 时才带上来（acp_call_result 那里）：ok 是 "false" / 1 之类的怪值不能被当成「成功 + 空闲」放行升级。
 */
export async function acpHostTurnBusy(channelId: string): Promise<boolean | null> {
  if (!isAcpChannel(channelId)) return null;
  const r = await acpCall(channelId, { op: "turn" }, TURN_QUERY_MS);
  return r.ok && typeof r.busy === "boolean" ? r.busy : null;
}

function acpCall(channelId: string, body: Record<string, unknown>, timeoutMs: number = CALL_TIMEOUT_MS): Promise<CallResult> {
  const ws = extensionSocketOf(channelId);
  if (!ws) return Promise.resolve({ ok: false, error: "ACP 宿主不在线" });
  const id = `acpcall_${bridgeEpoch}_${++nextCall}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      calls.delete(id);
      resolve({ ok: false, uncertain: true, error: "宿主未在期限内回应，结果未确认；请先查看当前会话，再决定是否重试" });
    }, timeoutMs);
    const slot = SLOT_OPS.has(String(body.op)) && typeof body.opId === "string" ? { opId: body.opId, ...(Number.isInteger(body.gen) ? { gen: body.gen as number } : {}) } : {};
    calls.set(id, { channelId, ws, op: body.op, ...slot, resolve, timer });
    try {
      ws.send(JSON.stringify({ type: "acp_call", id, ...body }));
    } catch (e) {
      calls.delete(id);
      clearTimeout(timer);
      resolve({ ok: false, error: `无法发送给 ACP 宿主：${e instanceof Error ? e.message : e}` });
    }
  });
}

/** POST /agents/:name/answer {kind:"acp", action} 的响应（作答人记凭据，和权限卡一样） */
export async function answerAcpResponse(channelId: string, body: any, principal: { id: string; credential?: string }): Promise<Response> {
  const r = await answerAcp(channelId, String(body?.action || ""), { principal: principal.id, device: principal.credential });
  return apiJson(r.status, r.body);
}

/** Discord 的原按钮直接走同一条代际 / 宿主确认闸；不能转成一条发给 agent 的普通消息。 */
export async function answerAcpDiscord(
  channelId: string, action: string, userId: string,
  ui: { edit(content: string): Promise<unknown>; whisper(content: string): Promise<unknown> }, original: string,
): Promise<Answer> {
  const r = await answerAcp(channelId, action, { principal: `discord:${userId}` });
  if (r.status === 200) await ui.edit(`${original}\n\n✅ 已处理`);
  else await ui.whisper(String(r.body.error ?? "这张卡已经不能作答了"));
  return r;
}

/** discord-interactions.ts 只留一行调用；UI 回执也在这里完成，避免旧按钮落进普通投递。 */
export async function answerAcpDiscordInteraction(i: {
  customId: string; user: { id: string }; message?: { content?: string } | null;
  editReply(o: { content: string; components: never[] }): Promise<unknown>;
  followUp(o: { content: string; ephemeral: boolean }): Promise<unknown>;
}, channelId: string): Promise<void> {
  await answerAcpDiscord(channelId, i.customId, i.user.id, {
    edit: (content) => i.editReply({ content, components: [] }),
    whisper: (content) => i.followUp({ content, ephemeral: true }),
  }, i.message?.content || "");
}

/** 卡上的按钮（id 里带卡的代际）：返回 HTTP 状态 + 响应体 */
export async function answerAcp(channelId: string, action: string, who: Who): Promise<Answer> {
  const qm = QUOTA_RE.exec(action);
  if (qm) return answerQuota(channelId, qm[1]!, Number(qm[2]), who);
  const pm = PERM_RE.exec(action);
  if (pm) return answerPermission(channelId, pm[1]!, pm[2]!, who);
  if (action.startsWith(QUOTA_PREFIX) || action.startsWith(PERM_PREFIX)) return stale("按钮不属于任何一张还开着的卡");
  return { status: 400, body: { ok: false, error: `不认识的操作 ${action}` } };
}

async function answerQuota(channelId: string, gen: string, idx: number, who: Who): Promise<Answer> {
  const q = quotaCards.get(channelId);
  const choice = q?.choices[idx];
  if (!q || q.gen !== gen || q.claimed || !choice) return stale("这张额度卡已经处理过或过期了");
  // 出卡的宿主已经换了：卡上的模型选择是给退役会话的，不切新会话的模型；「等重置」照常结卡
  if (choice.value !== null && extensionSocketOf(channelId) !== q.ws) {
    quotaCards.delete(channelId);
    settleRuntimeAsk("codex", channelId);
    return stale("出这张卡的宿主已经换了，新会话没有撞这次额度；要换模型请在设置页里选");
  }
  q.claimed = true; // 认领在第一个 await 之前：同一张卡的第二下、旧卡都到不了下面
  if (choice.value !== null) {
    const r = await acpSetConfig(channelId, "model", choice.value);
    if (!r.ok) return delete q.claimed, { status: 409, body: { ok: false, error: `没切成：${r.error}` } };
  }
  // 等宿主的时候又来了一次失败、出了新卡：旧卡已被新卡顶掉结案，不能把作答记到新卡上
  if (quotaCards.get(channelId) === q) quotaCards.delete(channelId), settleRuntimeAsk("codex", channelId, "interact", choice.label, who);
  return { status: 200, body: { ok: true, model: choice.value } };
}

/** 窗口输入行作答（bridge/acp-terminal.ts）：按 permId 认卡上那张，之后和点按钮同一个认领闸，网页 / 终端谁先到算谁的 */
export function answerAcpPermissionById(channelId: string, permId: string, optionId: string, who: Who): Promise<Answer> {
  const p = permQueues.get(channelId)?.[0];
  return p?.permId === permId ? answerPermission(channelId, p.gen, optionId, who) : Promise.resolve(stale("这个权限请求已经不在了（或已经答过）"));
}

async function answerPermission(channelId: string, gen: string, optionId: string, who: Who): Promise<Answer> {
  const p = permQueues.get(channelId)?.[0];
  const opt = p?.card.options.find((o) => o.id === optionId);
  if (!p || p.gen !== gen || p.claimed || !opt) return stale("这个权限请求已经不在了（或已经答过）");
  if (extensionSocketOf(channelId) !== p.ws) return dropPerm(channelId, p, "宿主换了连接"), stale("出这张卡的宿主连接已经断了");
  p.claimed = true; // 认领在第一个 await 之前；等宿主确认期间新来的请求排在它后面
  const r = await acpCall(channelId, { op: "permission", permId: p.permId, optionId });
  if (!r.ok) return dropPerm(channelId, p, `宿主不认：${r.error}`), stale(`宿主那边这个请求已经不在等了：${r.error}`);
  dropPerm(channelId, p, "已作答", { label: opt.label, who });
  return { status: 200, body: { ok: true } };
}

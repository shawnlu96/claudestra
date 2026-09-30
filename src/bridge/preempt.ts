/**
 * 打断的两个入口：人类消息抢占（deliverToLocal，Discord / Web / API 同一条路）和手动停止（Discord ⚡ 按钮、/interrupt、API 端点）。
 * 发键都经 interruptGate（按频道串行、冷却）；这里负责打断前后的收拾：记 cut（砍在哪、做到哪、在处理谁的什么）、
 * 给送达的那条消息加抬头、「停」压掉续做提醒、手动停止后把回合状态收尾成 done。
 */
import { recordMetric } from "../lib/metrics.js";
import { controlFor } from "../lib/runtimes/index.js";
import { readRegistryAgents } from "../lib/registry.js";
import { ownerStopOf } from "../lib/stop-words.js";
import { windowWallWait, type WallWait } from "../lib/wall-screen.js";
import { heldAcrossStopNote, preemptHeadline, staleStopNote, staleStopReply, stopHeadline, stopWaitReply, withInterruptNote } from "../lib/turn-cuts.js";
import { isAfter, type Order } from "../lib/arrival-order.js";
import { stopTyping } from "./components.js";
import { clearSafetyTimer } from "./discord-adapter.js";
import { emitEvent, inflightTools } from "./event-bus.js";
import type { PreemptResult } from "../lib/interrupt-gate.js";
import { interruptGate } from "./interrupt-gate.js";
import { holdStopWait, lastAbortResult } from "./pi-abort.js";
import type { HeldItem, HeldQueue } from "./held-queue.js";
import type { Envelope } from "./router.js";
import { resolveTurnWindow } from "./turn-probe.js";
import { agentWindow, turnCuts } from "./turn-cuts.js";

const controlChannelId = () => process.env.CONTROL_CHANNEL_ID || "";
/** bridge.ts 接的线：清掉这个频道上 agent 间的待回账（看门狗、回程槽、在飞的 peer 调用；bridge.ts clearInterAgentPendingsForChannel） */
let clearAgentPendings: (channelId: string) => unknown = () => undefined;
export const setStopHooks = (h: { clearAgentPendings: typeof clearAgentPendings }) => void (clearAgentPendings = h.clearAgentPendings);

/** 这封信到达 bridge 时领的号（请求入口领，bridge/arrival-stamp.ts；bridge.ts deliverLocalInOrder 补领；单测直调、没领过的现领） */
const arrivalOf = (env: Envelope): Order => ({ seq: (env.meta.arrivalSeq ??= turnCuts.arrivals.take()) });

/**
 * 叫停之前到、叫停之后才投给 agent 的（先到的「继续」在传图 / 下载附件，后到的停先走完；答卡片走得慢）：号比频道最近一次叫停早。
 * 加「停之前发的，先别照做」抬头，不再当开口去抢占——不然 owner 最后一句是停，agent 收到的最后一句却是继续，接着干（tests/preempt-stop.test.ts）。
 * 查的地方：preemptForHuman 入口、发键那一刻（wanted）、记抢占 cut 之前，ws.send 前一刻（noteAtSend）。bridge 的通知和停字本身不算
 */
function sentBeforeStop(env: Envelope, channelId: string): boolean {
  const m = env.meta;
  if (m.sentBeforeStop) return true;
  const stop = turnCuts.stopMark(channelId);
  if (!stop || m.arrivalSeq === undefined || env.from.kind === "bridge" || (!m.forwarded && ownerStopOf(env).stop)) return false;
  if (!isAfter(stop.order, { seq: m.arrivalSeq })) return false;
  [m.interruptNote, m.sentBeforeStop] = [heldAcrossStopNote(undefined, stop.at), true];
  return true;
}

/**
 * deliverToLocal 判忙押后用（lib/turn-state.ts holdsUntilIdle 的 waitForIdle）：停之前到的人类消息不抢占，目标忙时也得押到空闲——
 * 人类消息本来靠先打断才不在回合中途投；CC 回合起始的推理流里收到的 channel 通知会被静默丢掉（git log -S heldLocalMsgs）
 */
export const waitsForIdle = (env: Envelope, channelId: string): boolean => !!env.meta.waitForIdle || sentBeforeStop(env, channelId);

/** ws.send 前一刻（和发送之间没有 await）：再查一次叫停，拼上最终的抬头；bare = 不带抬头渲染好的正文（bridge.ts deliverToLocal） */
export function noteAtSend(env: Envelope, channelId: string, bare: string, meta: Record<string, string>): string {
  sentBeforeStop(env, channelId);
  const note = env.meta.interruptNote;
  if (note) meta.interrupt_note = "true"; // 历史只剥真由 bridge 加的抬头(lib/inbound-body.ts),用户手写的同样开头不剥
  return note ? withInterruptNote(bare, note) : bare;
}

function senderName(env: Envelope): string {
  return env.from.kind === "user" ? (env.from.username ?? "用户") : env.from.kind === "api" ? env.from.name : "用户";
}

/**
 * 打断那一刻「砍在哪」的快照（发键之前取：打断后 CC 会给被砍的工具写一条出错结果，快照就看不出了）。
 * Codex 的会话记录只在命令跑完才有一条，跑着的看不到：只取最后跑完的一条（lib/turn-cuts.ts completedOnlyFrom）。
 */
const toolsAt = (agent: string, runtime: string | undefined) => inflightTools(agent, runtime === "codex");

/**
 * owner 的停字被押在撞墙等待画面上（bridge/quota-wall-wiring.ts holdAtWallWait，一个键都不发）：当场记下这次「停」——清 agent 间
 * 待回账、记「停」类 cut（Autopilot 让位、不提醒续做），抬头照实写「停在等待画面、没有在跑」。之后投出去时 preemptForHuman
 * 再按那一刻的画面判一次（到点自动续跑了就打断），抬头随之改写（T24 wf3 delivery-hold-4）。
 */
/** 先记停（在 envelope 上打标）再入队：标记跟着落盘，bridge 重启后同一条停字不会再记一遍、再清一次槽（tests/preempt-stop.test.ts） */
export function holdNotingStop(
  held: Pick<HeldQueue, "holdEnv" | "rewrite">, env: Envelope, to: { channelId: string }, agent: string, runtime: string | undefined, reason?: HeldItem["reason"],
): number {
  const was = env.meta.heldStopNoted === true;
  noteHeldStop(env, to.channelId, agent, runtime);
  const n = held.holdEnv(env, reason);
  // 老版本落盘、没打标的那一条已在队里：holdEnv 认出同一封不落盘，新打的标要单独写回，不然再重启又丢（T24 复核 P2）
  if (!was && env.meta.heldStopNoted) held.rewrite(env);
  return n;
}

export function noteHeldStop(env: Envelope, channelId: string, agent: string, runtime?: string): void {
  if (env.meta.forwarded || !ownerStopOf(env).stop || env.meta.heldStopNoted) return; // 转交来的停字不算 owner 在这里叫停（见 preemptForHuman）
  const stopOrder = arrivalOf(env);
  if (turnCuts.spokeAfter(channelId, stopOrder)) return; // 押下之前 owner 已经又开过口：不记，投出去时 preemptForHuman 按作废处理
  env.meta.heldStopNoted = true;
  clearAgentPendings(channelId);
  const cut = turnCuts.record({
    channelId, agent, runtime, cause: "stopword", byMessageId: env.meta.messageId, byName: senderName(env), tools: { inflight: [] }, interrupted: false, stopOrder,
  });
  env.meta.interruptNote = stopHeadline(cut, "wall_wait");
  console.log(`⏹ 停字押在撞墙等待画面上（没发键）：${agent} 已记叫停`);
}

/**
 * 人类 request 到达、投递之前调：目标主回合在跑就打断（CC / Codex；Pi steer 不打断），停字三种运行时都打断。
 * 真打断了（键发出、画面确认停下）才记 cut、加「这条消息打断了你」的抬头；「停」不管打没打断都记一条「停」类 cut
 * （压掉续做提醒、Autopilot 不推进），抬头照实写打断没打断。发键失败只记日志，消息照常投递。
 * 停字和「解除叫停」只认 owner：外源（非 owner 的 API 用户）的「停」按普通消息处理，也解不开 owner 的「停」。
 * agent 转交过来的 owner 原话（meta.forwarded）也不算 owner 在这里开口：什么时候转、转给谁是 agent 定的，只保留抢占（wf2 stop-semantics-6）。
 * 返回 "wall_wait" = 复核时画面刚变成撞墙等待（一个键都没发）：调用方改为押住（holdAtWallWait），不照常投递。
 */
export async function preemptForHuman(env: Envelope, channelId: string, agent: string): Promise<"wall_wait" | void> {
  const { owner, stop } = env.meta.forwarded ? { owner: false, stop: false } : ownerStopOf(env);
  const order = arrivalOf(env);
  if (owner) turnCuts.noteHuman(channelId, stop, order);
  if (sentBeforeStop(env, channelId)) return; // 停之前到的：不打断、不写「处理完接着做被打断的事」，抬头照实写停之前发的
  // 「停」的先后按到达序号（押过的沿用原号，不按投递时刻）：它之后 owner 又开过口（答卡片、说话）= 作废——不发键、不挂起，只给 agent 一句提示。
  // 入口、发键那一刻（wanted：esc-guard / C-c / Pi·ACP 中止帧前同步再问）、记停之前各查一次，三处和各自的动作之间都没有 await
  const held = stop && env.meta.heldStopNoted === true;
  const stale = () => stop && turnCuts.spokeAfter(channelId, order);
  const staleNote = (fired: boolean) => staleStopNote(Date.parse(env.meta.ts) || Date.now(), fired, held);
  if (stale()) return void (env.meta.interruptNote = staleNote(false));
  // owner 的停 = 接管：发键之前就清 agent 间的待回账。Pi 停下马上报 Stop，等打断返回再清就晚了，看门狗已拿旧账把它催起一轮（adv5 P1）。
  // 押在撞墙画面上时已经清过（noteHeldStop）：最终送达不再清，否则停之后才来的回程槽也一起没了
  if (stop && !held) clearAgentPendings(channelId);
  const { runtime, transport } = await resolveTurnWindow(channelId, controlChannelId());
  const stopWait = stop && runtime === "pi" ? holdStopWait(env, channelId, agent) : undefined;
  const tools = toolsAt(agent, runtime);
  const queuedBefore = stop && runtime === "codex" ? turnCuts.codexQueuedBefore(channelId) : [];
  let r: PreemptResult = { fired: false, why: "not_allowed" };
  try {
    // 普通消息发键那一刻也再问：入口之后、键发出之前 owner 叫了停（终端 Esc、停止按钮），它就成了停之前到的，一个键都不发
    r = await interruptGate.preempt(channelId, agent, { stop, wanted: () => !(stop ? stale() : sentBeforeStop(env, channelId)) });
  } catch (e) {
    // 等锁 / 节流期间 Codex 菜单弹出来了，Esc 没发（lib/codex-key-guard.ts）：按停在菜单处理，这条押住
    if ((e as Error).name === "KeysBlockedError") r = { fired: false, why: "wall_wait" };
    else console.log(`⚠️ 抢占打断失败,按常规投递: ${(e as Error).message}`);
  }
  if (!r.fired && r.why === "wall_wait") return "wall_wait";
  // 键发出之后 owner 才开口的，也不再挂起（作答那边已按序号解除），抬头照实写打断了没有
  if (stale()) return void (stopWait?.(staleStopReply(agent, r.fired)), (env.meta.interruptNote = staleNote(r.fired)));
  // 键发出后收尾那一拍里才叫停的：不记抢占 cut（会盖掉停的 cut、回合结束还提醒「接着做」），抬头已改写成停之前发的
  if (!stop && (!r.fired || sentBeforeStop(env, channelId))) return;
  const cut = turnCuts.record({
    channelId, agent, runtime, cause: stop ? "stopword" : "preempt",
    byMessageId: env.meta.messageId, byName: senderName(env), tools: r.fired ? tools : { inflight: [] }, interrupted: r.fired, ...(stop ? { stopOrder: order } : {}),
  });
  if (!stop) {
    env.meta.interruptNote = preemptHeadline(cut);
    return;
  }
  // Pi 的中止靠扩展里的 abort()：有回执 = 真停了，等不到回执如实写「已请求」；扩展回「本来就空闲」= 没有在跑的回合
  const pi = runtime === "pi" ? lastAbortResult(channelId) : undefined;
  const outcome = r.fired ? (runtime === "pi" && pi?.result !== "aborted" ? "requested" : "fired")
    : r.why === "not_busy" || (controlFor(runtime, transport).abortVia === "extension" && r.why === "no_keys") ? "not_busy" : "failed"; // 扩展 / ACP 宿主回的「本来就空闲」
  env.meta.interruptNote = stopHeadline(cut, outcome, queuedBefore, r.fired ? (pi?.inEditor ?? 0) : 0);
  stopWait?.(stopWaitReply(agent, outcome));
  console.log(`⏹ 停字${r.fired ? "打断" : `（没发键：${r.why}）`} ${agent}（${runtime ?? "claude-code"}）`);
}

/** 手动停止的结果：keys 空 = 空闲 / 刚按过（deduped）/ 停在撞墙画面上（wall，一个键都没发） */
type StopResult = { keys: readonly string[]; deduped?: true; wall?: WallWait };

/**
 * 手动停止（Discord ⚡ 按钮 / /interrupt / API）：按运行时发键，owner 按的记一条「停」类 cut（不提醒续做、Autopilot 等 owner 再开口）、
 * 记指标、停 typing，并把回合状态收尾成 done——被打断的 CC 回合不发 Stop hook，不收尾的话 web 黄点常驻、busy 补锁复活。
 * 非 owner（外源 / peer 的 API token）按的照样打断，但不记成 owner 的「停」：不挂起 Autopilot、不清续做链（wf2 stop-semantics-2）。
 * 发键出错原样抛给调用方回报；keys 为空 = 空闲 / 刚按过一次停，调用方各自回执。刚自动抢占过就等够最小间隔再发，不丢这次停。
 */
export async function manualInterrupt(
  channelId: string, win: string, runtime: string | undefined, agent: string, trigger: "button" | "slash" | "api", by: { owner: boolean; name?: string; peer?: string } = { owner: true },
  stopOrder: Order = turnCuts.arrivals.order(), // 按下时的号（入口领，bridge/arrival-stamp.ts）：之后 owner 又开的口排在它后面，记停时带上解除
): Promise<StopResult> {
  const tools = toolsAt(agent, runtime);
  if (by.owner) clearAgentPendings(channelId); // 同停字：发键之前清，Pi 停下报的 Stop 不再被看门狗拿去催
  const r = await interruptGate.manual(channelId, win, runtime).catch((e: Error) => {
    if (e.name === "KeysBlockedError") return { keys: [] as readonly string[], wall: true as const, deduped: undefined }; // 等待期间菜单弹出来了：同停在菜单
    throw e;
  });
  if (r.deduped) return { keys: r.keys, deduped: true }; // 刚按过一次停：那一次已经记过、收过尾
  // 停在撞墙画面上：一个键都没发；owner 的停照样记下（Autopilot 让位），回报时说清是哪种画面（再抓一次屏，只为措辞）
  if (r.wall && by.owner) {
    turnCuts.record({ channelId, agent, runtime, cause: "manual", byName: by.name, tools: { inflight: [] }, interrupted: false, stopOrder });
  }
  if (r.wall) return { keys: [], wall: (await windowWallWait(win, runtime)) ?? "countdown" };
  // 空闲也记：owner 按了停，续做提醒和 Autopilot 都该停下
  if (by.owner) turnCuts.record({ channelId, agent, runtime, cause: "manual", byName: by.name, tools: r.keys.length ? tools : { inflight: [] }, interrupted: r.keys.length > 0, stopOrder });
  else console.log(`⏹ ${by.name ?? "非 owner"} 按停止${r.keys.length ? "打断了" : "（空闲，没发键）"} ${agent}：只打断这一回合，不记成 owner 的「停」、不挂起 Autopilot`);
  if (r.keys.length) recordMetric("agent_interrupt", { channelId, agent, meta: { trigger, owner: String(by.owner), ...(by.name ? { by: by.name } : {}) } }); // 记下实际按的人
  stopTyping(channelId);
  clearSafetyTimer(channelId);
  // 空闲时也发 done：前端误判忙时借此解锁
  emitEvent({ agent, chatId: channelId, type: "agent_status", data: { status: "done", trigger: "interrupt", cause: "manual", ...(by.peer ? { peer: by.peer } : {}) } });
  return { keys: r.keys };
}

/** 按 agent 名手动打断（API 端点）：大总管（"master" / "0"）不在 registry 的普通条目里，按 Claude Code 的 master:0 处理 */
export async function interruptAgentByName(name: string, channelId: string, by?: { owner: boolean; name?: string; peer?: string }, stopOrder?: Order): Promise<StopResult> {
  const isMaster = name === "master" || name === "0";
  const regs = isMaster ? [] : await readRegistryAgents().catch(() => []); // 读不到就按 CC 的打断键发：人要停，宁可发
  const runtime = regs.find((a) => a.name === name)?.runtime;
  return manualInterrupt(channelId, agentWindow(name), runtime, isMaster ? "master" : name, "api", by, stopOrder);
}

/**
 * Codex 的 Interrupt hook（typing-hook 报成 StopFailure + interrupt，Esc 后约 0.5 秒到）：bridge 刚发过键的是回声，抢占那边会记；
 * 别的进程发的键（manager 重启清场的 C-c、tmux-send-keys）也不算；否则是有人在终端里自己按了 Esc——记一条「停」类 cut，只留档不提醒。
 */
export async function onCodexInterrupt(channelId: string, agent: string, stopOrder: Order = turnCuts.arrivals.order()): Promise<void> {
  const now = Date.now(); // stopOrder = hook 请求进 bridge 时领的号：查程序发键的 await 途中 owner 又开的口排在它后面
  if (turnCuts.keySentWithin(channelId, now) || (await turnCuts.programKeyNear(agent, now))) return;
  turnCuts.record({ channelId, agent, runtime: "codex", cause: "codex_interrupt", tools: toolsAt(agent, "codex"), stopOrder });
}

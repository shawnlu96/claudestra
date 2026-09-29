/**
 * 打断的两个入口：人类消息抢占（deliverToLocal，Discord / Web / API 同一条路）和手动停止（Discord ⚡ 按钮、/interrupt、API 端点）。
 * 发键都经 interruptGate（按频道串行、冷却）；这里负责打断前后的收拾：记 cut（砍在哪、做到哪、在处理谁的什么）、
 * 给送达的那条消息加抬头、「停」压掉续做提醒、手动停止后把回合状态收尾成 done。
 */
import { recordMetric } from "../lib/metrics.js";
import { readRegistryAgents } from "../lib/registry.js";
import { ownerStopOf } from "../lib/stop-words.js";
import { windowWallWait, type WallWait } from "../lib/wall-screen.js";
import { preemptHeadline, stopHeadline, stopWaitReply } from "../lib/turn-cuts.js";
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
  if (!ownerStopOf(env).stop || env.meta.heldStopNoted) return;
  env.meta.heldStopNoted = true;
  clearAgentPendings(channelId);
  const cut = turnCuts.record({
    channelId, agent, runtime, cause: "stopword", byMessageId: env.meta.messageId, byName: senderName(env), tools: { inflight: [] }, interrupted: false,
  });
  env.meta.interruptNote = stopHeadline(cut, "wall_wait");
  console.log(`⏹ 停字押在撞墙等待画面上（没发键）：${agent} 已记叫停`);
}

/**
 * 人类 request 到达、投递之前调：目标主回合在跑就打断（CC / Codex；Pi steer 不打断），停字三种运行时都打断。
 * 真打断了（键发出、画面确认停下）才记 cut、加「这条消息打断了你」的抬头；「停」不管打没打断都记一条「停」类 cut
 * （压掉续做提醒、Autopilot 不推进），抬头照实写打断没打断。发键失败只记日志，消息照常投递。
 * 停字和「解除叫停」只认 owner：外源（非 owner 的 API 用户）的「停」按普通消息处理，也解不开 owner 的「停」。
 * 返回 "wall_wait" = 复核时画面刚变成撞墙等待（一个键都没发）：调用方改为押住（holdAtWallWait），不照常投递。
 */
export async function preemptForHuman(env: Envelope, channelId: string, agent: string): Promise<"wall_wait" | void> {
  const { owner, stop } = ownerStopOf(env);
  if (owner) turnCuts.noteHuman(channelId, stop);
  // owner 的停 = 接管：发键之前就清 agent 间的待回账。Pi 停下马上报 Stop，等打断返回再清就晚了，看门狗已拿旧账把它催起一轮（adv5 P1）。
  // 押在撞墙画面上时已经清过（noteHeldStop）：最终送达不再清，否则停之后才来的回程槽也一起没了
  if (stop && !env.meta.heldStopNoted) clearAgentPendings(channelId);
  const { runtime } = await resolveTurnWindow(channelId, controlChannelId());
  const stopWait = stop && runtime === "pi" ? holdStopWait(env, channelId, agent) : undefined;
  const tools = toolsAt(agent, runtime);
  const queuedBefore = stop && runtime === "codex" ? turnCuts.codexQueuedBefore(channelId) : [];
  let r: PreemptResult = { fired: false, why: "not_allowed" };
  try {
    r = await interruptGate.preempt(channelId, agent, { stop });
  } catch (e) {
    console.log(`⚠️ 抢占打断失败,按常规投递: ${(e as Error).message}`);
  }
  if (!r.fired && r.why === "wall_wait") return "wall_wait";
  if (!r.fired && !stop) return;
  const cut = turnCuts.record({
    channelId, agent, runtime, cause: stop ? "stopword" : "preempt",
    byMessageId: env.meta.messageId, byName: senderName(env), tools: r.fired ? tools : { inflight: [] }, interrupted: r.fired,
  });
  if (!stop) {
    env.meta.interruptNote = preemptHeadline(cut);
    return;
  }
  // Pi 的中止靠扩展里的 abort()：有回执 = 真停了，等不到回执如实写「已请求」；扩展回「本来就空闲」= 没有在跑的回合
  const pi = runtime === "pi" ? lastAbortResult(channelId) : undefined;
  const outcome = r.fired ? (runtime === "pi" && pi?.result !== "aborted" ? "requested" : "fired")
    : r.why === "not_busy" || (runtime === "pi" && r.why === "no_keys") ? "not_busy" : "failed";
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
): Promise<StopResult> {
  const tools = toolsAt(agent, runtime);
  if (by.owner) clearAgentPendings(channelId); // 同停字：发键之前清，Pi 停下报的 Stop 不再被看门狗拿去催
  const r = await interruptGate.manual(channelId, win, runtime);
  if (r.deduped) return { keys: r.keys, deduped: true }; // 刚按过一次停：那一次已经记过、收过尾
  // 停在撞墙画面上：一个键都没发；owner 的停照样记下（Autopilot 让位），回报时说清是哪种画面（再抓一次屏，只为措辞）
  if (r.wall && by.owner) {
    turnCuts.record({ channelId, agent, runtime, cause: "manual", byName: by.name, tools: { inflight: [] }, interrupted: false });
  }
  if (r.wall) return { keys: [], wall: (await windowWallWait(win, runtime)) ?? "countdown" };
  // 空闲也记：owner 按了停，续做提醒和 Autopilot 都该停下
  if (by.owner) turnCuts.record({ channelId, agent, runtime, cause: "manual", byName: by.name, tools: r.keys.length ? tools : { inflight: [] }, interrupted: r.keys.length > 0 });
  else console.log(`⏹ ${by.name ?? "非 owner"} 按停止${r.keys.length ? "打断了" : "（空闲，没发键）"} ${agent}：只打断这一回合，不记成 owner 的「停」、不挂起 Autopilot`);
  if (r.keys.length) recordMetric("agent_interrupt", { channelId, agent, meta: { trigger, owner: String(by.owner), ...(by.name ? { by: by.name } : {}) } }); // 记下实际按的人
  stopTyping(channelId);
  clearSafetyTimer(channelId);
  // 空闲时也发 done：前端误判忙时借此解锁
  emitEvent({ agent, chatId: channelId, type: "agent_status", data: { status: "done", trigger: "interrupt", ...(by.peer ? { peer: by.peer } : {}) } });
  return { keys: r.keys };
}

/** 按 agent 名手动打断（API 端点）：大总管（"master" / "0"）不在 registry 的普通条目里，按 Claude Code 的 master:0 处理 */
export async function interruptAgentByName(name: string, channelId: string, by?: { owner: boolean; name?: string; peer?: string }): Promise<StopResult> {
  const isMaster = name === "master" || name === "0";
  const regs = isMaster ? [] : await readRegistryAgents().catch(() => []); // 读不到就按 CC 的打断键发：人要停，宁可发
  const runtime = regs.find((a) => a.name === name)?.runtime;
  return manualInterrupt(channelId, agentWindow(name), runtime, isMaster ? "master" : name, "api", by);
}

/**
 * Codex 的 Interrupt hook（typing-hook 报成 StopFailure + interrupt，Esc 后约 0.5 秒到）：bridge 刚发过键的是回声，抢占那边会记；
 * 别的进程发的键（manager 重启清场的 C-c、tmux-send-keys）也不算；否则是有人在终端里自己按了 Esc——记一条「停」类 cut，只留档不提醒。
 */
export async function onCodexInterrupt(channelId: string, agent: string): Promise<void> {
  const now = Date.now();
  if (turnCuts.keySentWithin(channelId, now) || (await turnCuts.programKeyNear(agent, now))) return;
  turnCuts.record({ channelId, agent, runtime: "codex", cause: "codex_interrupt", tools: toolsAt(agent, "codex") });
}

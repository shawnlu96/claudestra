/**
 * 打断的两个入口：人类消息抢占（deliverToLocal，Discord / Web / API 同一条路）和手动停止（Discord ⚡ 按钮、/interrupt、API 端点）。
 * 发键都经 interruptGate（按频道串行、冷却）；这里负责打断前后的收拾：记 cut（砍在哪、做到哪、在处理谁的什么）、
 * 给送达的那条消息加抬头、「停」压掉续做提醒、手动停止后把回合状态收尾成 done。
 */
import { recordMetric } from "../lib/metrics.js";
import { readRegistryAgents } from "../lib/registry.js";
import { matchStopWord } from "../lib/stop-words.js";
import { MASTER_SESSION, windowTarget } from "../lib/tmux-helper.js";
import { preemptHeadline, stopHeadline } from "../lib/turn-cuts.js";
import { stopTyping } from "./components.js";
import { clearSafetyTimer } from "./discord-adapter.js";
import { emitEvent, inflightTools } from "./event-bus.js";
import type { PreemptResult } from "../lib/interrupt-gate.js";
import { interruptGate } from "./interrupt-gate.js";
import type { Envelope } from "./router.js";
import { resolveTurnWindow } from "./turn-probe.js";
import { turnCuts } from "./turn-cuts.js";

const controlChannelId = () => process.env.CONTROL_CHANNEL_ID || "";

function senderName(env: Envelope): string {
  return env.from.kind === "user" ? (env.from.username ?? "用户") : env.from.kind === "api" ? env.from.name : "用户";
}

/**
 * 人类 request 到达、投递之前调：目标主回合在跑就打断（CC / Codex；Pi steer 不打断），停字三种运行时都打断。
 * 真打断了（键发出、画面确认停下）才记 cut、加「这条消息打断了你」的抬头；「停」不管打没打断都记一条「停」类 cut
 * （压掉续做提醒、Autopilot 不推进），抬头照实写打断没打断。发键失败只记日志，消息照常投递。
 */
export async function preemptForHuman(env: Envelope, channelId: string, agent: string): Promise<void> {
  const stop = matchStopWord(env.content).stop;
  turnCuts.noteHuman(channelId, stop);
  const tools = inflightTools(agent); // 发键之前取：打断后 CC 会给被砍的工具写一条出错结果，快照就看不出砍在哪了
  let r: PreemptResult = { fired: false, why: "not_allowed" };
  try {
    r = await interruptGate.preempt(channelId, agent, { stop });
  } catch (e) {
    console.log(`⚠️ 抢占打断失败,按常规投递: ${(e as Error).message}`);
  }
  if (!r.fired && !stop) return;
  const { runtime } = await resolveTurnWindow(channelId, controlChannelId());
  const cut = turnCuts.record({
    channelId, agent, runtime, cause: stop ? "stopword" : "preempt",
    byMessageId: env.meta.messageId, byName: senderName(env), tools: r.fired ? tools : { inflight: [] },
  });
  if (!stop) return void (env.meta.interruptNote = preemptHeadline(cut));
  env.meta.interruptNote = stopHeadline(cut, r.fired ? "fired" : r.why === "not_busy" ? "not_busy" : "failed");
  console.log(`⏹ 停字${r.fired ? "打断" : `（没发键：${r.why}）`} ${agent}（${runtime ?? "claude-code"}）`);
}

/**
 * 手动停止（Discord ⚡ 按钮 / /interrupt / API）：按运行时发键，真发出了就记一条「停」类 cut（不提醒续做）、
 * 记指标、停 typing，并把回合状态收尾成 done——被打断的 CC 回合不发 Stop hook，不收尾的话 web 黄点常驻、busy 补锁复活。
 * 发键出错原样抛给调用方回报；keys 为空 = 空闲 / 刚打断过，调用方各自回执。
 */
export async function manualInterrupt(
  channelId: string, win: string, runtime: string | undefined, agent: string, trigger: "button" | "slash" | "api",
): Promise<{ keys: readonly string[]; deduped?: true }> {
  const tools = inflightTools(agent);
  const r = await interruptGate.manual(channelId, win, runtime);
  if (r.deduped) return r; // 1.5 秒内刚发过键（多半是抢占，新消息正在投）：别把正在开始的回合收成 done
  // 空闲时也记：人按了停，续做提醒和 Autopilot 都该停下
  turnCuts.record({ channelId, agent, runtime, cause: "manual", tools: r.keys.length ? tools : { inflight: [] } });
  if (r.keys.length) recordMetric("agent_interrupt", { channelId, agent, meta: { trigger } });
  stopTyping(channelId);
  clearSafetyTimer(channelId);
  // 空闲时也发 done：前端误判忙时借此解锁
  emitEvent({ agent, chatId: channelId, type: "agent_status", data: { status: "done", trigger: "interrupt" } });
  return r;
}

/** 按 agent 名手动打断（API 端点）：大总管（"master" / "0"）不在 registry 的普通条目里，按 Claude Code 的 master:0 处理 */
export async function interruptAgentByName(name: string, channelId: string): Promise<{ keys: readonly string[]; deduped?: true }> {
  const isMaster = name === "master" || name === "0";
  const regs = isMaster ? [] : await readRegistryAgents().catch(() => []); // 读不到就按 CC 的打断键发：人要停，宁可发
  const runtime = regs.find((a) => a.name === name)?.runtime;
  return manualInterrupt(channelId, isMaster ? `${MASTER_SESSION}:0` : windowTarget(name), runtime, isMaster ? "master" : name, "api");
}

/**
 * Codex 的 Interrupt hook（typing-hook 报成 StopFailure + interrupt，Esc 后约 0.5 秒到）：bridge 刚发过键的是回声，抢占那边会记；
 * 否则是有人在终端里自己按了 Esc——记一条「停」类 cut，只留档不提醒。
 */
export function onCodexInterrupt(channelId: string, agent: string): void {
  if (turnCuts.keySentWithin(channelId, Date.now())) return;
  turnCuts.record({ channelId, agent, runtime: "codex", cause: "codex_interrupt", tools: inflightTools(agent) });
}

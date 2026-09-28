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
 * 打断了就记 cut，并把抬头写进 env.meta.interruptNote。发键失败只记日志，消息照常投递。
 */
export async function preemptForHuman(env: Envelope, channelId: string, agent: string): Promise<void> {
  const stop = matchStopWord(env.content);
  const tools = inflightTools(agent); // 发键之前取：打断后 CC 会给被砍的工具写一条出错结果，快照就看不出砍在哪了
  let fired = false;
  try {
    fired = await interruptGate.preempt(channelId, agent, { stop: stop.stop });
  } catch (e) {
    console.log(`⚠️ 抢占打断失败,按常规投递: ${(e as Error).message}`);
  }
  if (!fired) {
    if (!stop.stop) return;
    const open = turnCuts.get(channelId)?.state === "open";
    turnCuts.stop(channelId);
    if (open) env.meta.interruptNote = stopHeadline(undefined, stop.rest);
    return;
  }
  const { runtime } = await resolveTurnWindow(channelId, controlChannelId());
  const cut = turnCuts.record({
    channelId, agent, runtime, cause: stop.stop ? "stopword" : "preempt",
    byMessageId: env.meta.messageId, byName: senderName(env), tools,
  });
  env.meta.interruptNote = stop.stop ? stopHeadline(cut, stop.rest) : preemptHeadline(cut);
  if (stop.stop) console.log(`⏹ 停字打断 ${agent}（${runtime ?? "claude-code"}）`);
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
  if (r.keys.length) {
    turnCuts.record({ channelId, agent, runtime, cause: "manual", tools });
    recordMetric("agent_interrupt", { channelId, agent, meta: { trigger } });
  }
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
 * Codex 的 Interrupt hook（typing-hook 报成 StopFailure + interrupt）：我们刚发过 Esc 的是回声，已经记过；
 * 否则是有人在终端里自己按了 Esc——记一条「停」类 cut，只留档不提醒。返回 true = 回声（调用方据此不把回合收成 done）。
 */
export function onCodexInterrupt(channelId: string, agent: string): boolean {
  if (turnCuts.recentlyCut(channelId, 15_000)) return true;
  turnCuts.record({ channelId, agent, runtime: "codex", cause: "codex_interrupt", tools: inflightTools(agent) });
  return false;
}

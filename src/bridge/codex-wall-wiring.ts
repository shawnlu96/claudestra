/**
 * Codex 额度墙（T78）的 bridge 接线：生产依赖（状态文件、registry、额度调度器视图、押后队列、#control 通知）在这里拼好，
 * bridge.ts 只留一行启动；投递路径问「押不押、按哪道闸押」走 wallHoldOf / wallGateOf（CC 闸先问、结果不变，两道闸的频道互斥）。
 * 进墙信号：watcher 标成 rateLimited 的 Codex ⛔ 条目（ACP 的额度失败与 tmux Codex 的 rollout 都走这里），不碰 lib/acp/*。
 */
import { existsSync, unlinkSync } from "fs";
import { CODEX_WALL_CLEAR_PATH, CODEX_WALL_PATH, CODEX_WALL_TIMING, emptyCodexWallState, isCodexWallState, type CodexWallState } from "../lib/codex-wall.js";
import { readJsonStateSync, reportCorrupt, writeJsonAtomicSync } from "../lib/state-file.js";
import { agentMsgMustWait } from "../lib/turn-state.js";
import { createCodexWall, type CodexWallRuntime } from "./codex-wall.js";
import { subscribeEvents } from "./event-bus.js";
import type { HeldQueue, WallReason } from "./held-queue.js";
import { quotaWall, startQuotaWall, type WallBridgeDeps } from "./quota-wall-wiring.js";
import { newMessageId, newThreadId, type Delivery, type Envelope } from "./router.js";
import { senderTrigger, turnCallers } from "./stop-settle.js";
import { probeTurn, resolveTurnWindow } from "./turn-probe.js";

const REASON: WallReason = "codex_quota_wall";
const LABEL = "codex-wall";

/** 墙；bridge 还没启动完 = null（投递路径按「不押」走） */
let wall: CodexWallRuntime | null = null;

/**
 * 这条消息此刻按哪道闸押：CC 额度闸 → "quota_wall"（和以前一样先问它），Codex 额度墙 → "codex_quota_wall"，都不押 = null。
 * CC 闸只闸 CC 窗口、Codex 墙只闸 Codex agent，同一个频道不会两道都押
 */
export async function wallHoldOf(env: Envelope, channelId: string): Promise<WallReason | null> {
  if (await quotaWall()?.holds(env, channelId)) return "quota_wall";
  return (await wall?.holds(env, channelId)) ? REASON : null;
}

/** 押后补投（held-flush 的 walled）：CC 闸里 = true（同以前），Codex 墙里 = 它的押后原因，都不在 = false */
export async function wallGateOf(channelId: string): Promise<boolean | WallReason> {
  if (await quotaWall()?.gates(channelId)) return true;
  return (await wall?.gates(channelId)) ? REASON : false;
}

/** 按闸押后（deliverToLocal 问过 wallHoldOf 之后）：对调用方同样是「已受理、排队中」，出闸时由那道闸的恢复流程按序补投 */
export function holdForQuotaWall(held: HeldQueue, env: Envelope, agent: string, from: string | undefined, reason: WallReason): Delivery {
  console.log(`⏸ 消息押后(${agent} ${reason === "quota_wall" ? "额度闸" : "Codex 额度墙"}): 来自 ${from ?? "?"},队列 ${held.holdEnv(env, reason)} 条`);
  return { envelope: env, outcome: { kind: "sent", note: "queued", heldBy: reason } };
}

/** 回程簿 / 押后老化的暂停：Codex 墙在时，Codex agent 的回程不按 2 小时扫、它发出的押后不提醒（提醒会唤醒一个注定失败的回合） */
export const codexWallPaused = (runtime: string | undefined): boolean => runtime === "codex" && !!wall?.active();

function loadState(): CodexWallState {
  const r = readJsonStateSync(CODEX_WALL_PATH, isCodexWallState);
  if (r.status === "ok") return r.data as CodexWallState;
  if (r.status === "corrupt") reportCorrupt(CODEX_WALL_PATH, r.error, "codex-wall", false);
  return emptyCodexWallState();
}

const quotaSvc = async () => (await import("./quota-service.js")).quotaService();

/** 发一条 bridge 通知到本机 agent 频道（续跑 / 告诉 caller）：返回投递结果 */
async function sendLocal(b: WallBridgeDeps, cid: string, agent: string | undefined, text: string, waitForIdle: boolean) {
  const c = b.clients.get(cid);
  if (!c) return null;
  b.markAgentSource(cid);
  return b.deliver({
    from: { kind: "bridge", label: LABEL },
    to: { kind: "local", channelId: cid, agentName: agent, ws: c.ws, cwd: c.cwd },
    intent: "notification",
    content: text,
    meta: { messageId: newMessageId("codex_wall"), triggerKind: "bridge_synth", ts: new Date().toISOString(), threadId: newThreadId(), waitForIdle },
  });
}

async function dismissCards(): Promise<number> {
  const dropped = (await import("./acp-link.js")).dropQuotaCards();
  const closed = (await import("./ask-runtime.js")).closeCodexQuotaAsks();
  if (dropped.length || closed) console.log(`🎴 Codex 额度墙：收起额度卡 ${closed} 张（作废按钮 ${dropped.length} 个频道）`);
  return closed;
}

function productionWall(b: WallBridgeDeps): CodexWallRuntime {
  const isCodex = async (cid: string) => (await resolveTurnWindow(cid, b.controlChannelId)).runtime === "codex";
  const insider = (i: { env: Envelope }) => senderTrigger(i.env.from) !== "stranger"; // 自己人（agent / bridge / owner）的消息补投会叫醒它
  return createCodexWall({
    now: Date.now,
    newId: () => newMessageId("cxwall"),
    load: loadState,
    save: (s) => writeJsonAtomicSync(CODEX_WALL_PATH, s),
    isCodex,
    usage: async (refresh) => (await quotaSvc())?.codexWall(refresh) ?? null,
    held: {
      count: () => b.held.wallCount(() => false, REASON).agent,
      channels: () => b.held.wallChannels(undefined, REASON),
      wakers: () => b.held.wallChannels(insider, REASON),
      queuedFor: (cid) => !!b.held.get(cid)?.some(insider),
      release: (now) => b.held.releaseWall(now, REASON),
    },
    flush: (cid) => b.flush(cid, "codex_wall"),
    mainTurnBusy: async (cid, agent) => agentMsgMustWait(await probeTurn(cid, agent, b.controlChannelId)),
    resume: async (cid, agent, text, afterTurn) => {
      const d = await sendLocal(b, cid, agent, text, !!afterTurn);
      if (!d) return (console.log(`⚠️ Codex 额度恢复续跑 ${agent}：不在线，跳过`), false);
      return d.outcome.kind !== "sent" ? false : d.outcome.heldBy ? "held" : true;
    },
    dismissCards,
    tellCaller: async (cid, text) => (await sendLocal(b, cid, undefined, text, true))?.outcome.kind === "sent",
    notifyOwner: async (text) => (await import("./quota-service.js")).controlChannelSender((env) => b.deliver(env))(text),
    takeClearRequest: () => {
      if (!existsSync(CODEX_WALL_CLEAR_PATH)) return false;
      try { unlinkSync(CODEX_WALL_CLEAR_PATH); } catch (e) { console.error(`Codex 额度墙：删 clear 请求失败（下一拍再取，出墙是幂等的）: ${(e as Error).message}`); }
      return true;
    },
    log: (m) => console.log(m),
  });
}

/**
 * Codex ⛔ 条目 → 墙。在等它答复的 caller 先同步拍下来（回程簿 + 这一轮是谁开的）：之后 ⛔ 被推给 caller、回程随 StopFailure 结掉，
 * 再取就没了。只认 Codex 频道（CC 的撞墙走 api_error_turn 进 CC 闸）
 */
function onRateLimited(b: WallBridgeDeps, w: CodexWallRuntime, chatId: string, agent: string, text: string, at: number): void {
  const callers = [...new Set([...b.calls.forTarget(chatId).map((c) => c.callerChannelId), ...turnCallers(chatId)])];
  void (async () => {
    if ((await resolveTurnWindow(chatId, b.controlChannelId)).runtime !== "codex") return;
    if (!(await w.noteHit({ channelId: chatId, agent, at, text, callers }))) console.log(`ℹ️ ${agent} 撞的是单个模型的额度，不进 Codex 额度墙`);
  })().catch((e) => console.error(`Codex 额度墙记撞墙出错（下一次 ⛔ 再记）: ${(e as Error).message}`));
}

/** 起墙、接 ⛔ 事件、15 秒一拍 */
function startCodexWall(b: WallBridgeDeps): CodexWallRuntime {
  const w = (wall = productionWall(b));
  subscribeEvents({}, (evt) => {
    const data = (evt.data ?? {}) as { rateLimited?: unknown; text?: unknown };
    if (evt.type !== "assistant_text" || data.rateLimited !== true) return;
    onRateLimited(b, w, evt.chatId, evt.agent, String(data.text ?? ""), Date.parse(evt.ts) || Date.now());
  });
  setInterval(() => void w.tick(), CODEX_WALL_TIMING.tickMs);
  return w;
}

/** bridge 启动时调一次：CC 额度闸（行为不变）+ Codex 额度墙，同一份依赖 */
export function startWalls(b: WallBridgeDeps): void {
  startQuotaWall(b);
  startCodexWall(b);
}

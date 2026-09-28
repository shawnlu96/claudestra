/**
 * 额度闸与 API 错误续跑的 bridge 接线：生产依赖（状态文件、tmux、registry、T2b-2 用量、#control 通知）在这里拼好，
 * bridge.ts 只留一行启动。api-error-resume（lib/api-error-resume.ts）从 bridge.ts 搬来，前面加一道「闸先接手」：
 * 撞墙原文 → 进闸；闸内任何 API 错误 → 记进续跑名单、出闸再续；其余照旧 60 秒续跑一次、再撞升级到频道。
 */
import { existsSync, unlinkSync } from "fs";
import { countsAsActivity, dueForResume, markResumed, noteActivity, noteApiError, resumeText, type ApiErrorState } from "../lib/api-error-resume.js";
import { isModelLimitHit, paneShowsWallWait } from "../lib/quota-wall-text.js";
import { recordMetric } from "../lib/metrics.js";
import { countsAsWallActivity, emptyWallState, isHumanSender, isWallState, QUOTA_WALL_CLEAR_PATH, QUOTA_WALL_PATH, type WallState } from "../lib/quota-wall.js";
import { readRegistryAgents } from "../lib/registry.js";
import { DEFAULT_RUNTIME } from "../lib/runtimes/index.js";
import { readJsonStateSync, reportCorrupt, writeJsonAtomicSync } from "../lib/state-file.js";
import { ensurePaneInteractive, tmuxCapture, tmuxSendEscape, windowTarget } from "../lib/tmux-helper.js";
import { agentMsgMustWait } from "../lib/turn-state.js";
import { readUsageCache } from "../lib/usage-cache.js";
import type { AgentCallBook } from "./agent-calls.js";
import { subscribeEvents } from "./event-bus.js";
import type { HeldQueue } from "./held-queue.js";
import { createQuotaWall, type QuotaWall, type WallWindow } from "./quota-wall.js";
import { newMessageId, newThreadId, type Delivery, type Envelope, type LocalEndpoint } from "./router.js";
import { probeTurn, resolveTurnWindow } from "./turn-probe.js";

const TICK_MS = 15_000;

export interface WallBridgeDeps {
  held: HeldQueue;
  calls: AgentCallBook;
  clients: { get(channelId: string): { ws: LocalEndpoint["ws"]; cwd?: string } | undefined };
  deliver(env: Envelope): Promise<Delivery>;
  flush(channelId: string, reason: string): Promise<void>;
  /** 续跑消息投出去后，这个频道下一次 Stop 不 @ 用户（同 api-error-resume） */
  markAgentSource(channelId: string): void;
  /** 连续两次 API 错误的升级通知（Discord 频道） */
  escalate(channelId: string, text: string): Promise<void>;
  controlChannelId: string;
}

let wall: QuotaWall | null = null;
let bridge: WallBridgeDeps | null = null;
/** 闸（T14 调度器 / 本地 API / 回程簿清扫用）；bridge 还没启动完 = null */
export const quotaWall = (): QuotaWall | null => wall;
const earlyExitListeners: ((via: string) => void)[] = [];
/** 出闸回调，闸还没建好时先记着（Autopilot 的 initMission 与起闸的先后不固定） */
export function onQuotaWallExit(cb: (via: string) => void): void {
  if (wall) wall.onExit(cb);
  else earlyExitListeners.push(cb);
}

function loadState(): WallState {
  const r = readJsonStateSync(QUOTA_WALL_PATH, isWallState);
  if (r.status === "ok") return r.data as WallState;
  if (r.status === "corrupt") reportCorrupt(QUOTA_WALL_PATH, r.error, "quota-wall", false);
  return emptyWallState();
}

async function claudeWindows(controlChannelId: string): Promise<WallWindow[]> {
  const regs = await readRegistryAgents().catch(() => []); // 读不到就只扫 master：少扫几个窗口只会晚一点发现回显
  const master = controlChannelId ? (await resolveTurnWindow(controlChannelId, controlChannelId)).win : null; // master 固定是 0 号窗口
  const out: WallWindow[] = master ? [{ channelId: controlChannelId, agent: "master", win: master }] : [];
  for (const a of regs) {
    if (a.status === "active" && a.channelId && (a.runtime ?? DEFAULT_RUNTIME) === DEFAULT_RUNTIME) out.push({ channelId: a.channelId, agent: a.name, win: windowTarget(a.name) });
  }
  return out;
}

async function quotaSvc() {
  return (await import("./quota-service.js")).quotaService();
}

function productionWall(b: WallBridgeDeps): QuotaWall {
  return createQuotaWall({
    now: Date.now,
    newId: () => newMessageId("wall"),
    load: loadState,
    save: (s) => writeJsonAtomicSync(QUOTA_WALL_PATH, s),
    isClaudeCode: async (cid) => ((await resolveTurnWindow(cid, b.controlChannelId)).runtime ?? DEFAULT_RUNTIME) === DEFAULT_RUNTIME,
    windows: () => claudeWindows(b.controlChannelId),
    capture: (win) => tmuxCapture(win, 30),
    prepare: (win) => ensurePaneInteractive(win),
    sendEsc: (win) => tmuxSendEscape(win),
    mainTurnBusy: async (cid, agent) => {
      const { win } = await resolveTurnWindow(cid, b.controlChannelId);
      if (win && paneShowsWallWait(await tmuxCapture(win, 30))) return false; // 停在撞墙菜单 / 自动续跑倒计时：带「esc to cancel」，判忙会漏续跑
      return agentMsgMustWait(await probeTurn(cid, agent, b.controlChannelId));
    },
    held: {
      wallCount: () => b.held.wallCount(),
      queuedFor: (cid) => !!b.held.get(cid)?.length,
      wallChannels: () => b.held.wallChannels(),
      release: (now) => b.held.releaseWall(now),
    },
    flush: (cid) => b.flush(cid, "quota_wall"),
    resume: async (cid, agent, text) => {
      const c = b.clients.get(cid);
      if (!c) return (console.log(`⚠️ 额度恢复续跑 ${agent}：不在线，跳过`), false);
      b.markAgentSource(cid);
      await b.deliver({
        from: { kind: "bridge", label: "quota-wall" },
        to: { kind: "local", channelId: cid, agentName: agent, ws: c.ws, cwd: c.cwd },
        intent: "notification",
        content: text,
        meta: { messageId: newMessageId("wall_resume"), triggerKind: "bridge_synth", ts: new Date().toISOString(), threadId: newThreadId() },
      });
      return true;
    },
    notifyOwner: async (text) => {
      const q = await import("./quota-service.js");
      return q.controlChannelSender((env) => b.deliver(env))(text);
    },
    probe: async () => (await quotaSvc())?.claudeWall(true) ?? null,
    credits: async () => (await (await quotaSvc())?.claudeWall(false))?.credits ?? null,
    readCache: () => readUsageCache(),
    takeClearRequest: () => {
      if (!existsSync(QUOTA_WALL_CLEAR_PATH)) return false;
      try { unlinkSync(QUOTA_WALL_CLEAR_PATH); } catch (e) { console.error(`额度闸：删 clear 请求失败（下一拍会再取一次，出闸是幂等的）: ${(e as Error).message}`); }
      return true;
    },
    sleep: (ms) => Bun.sleep(ms),
    log: (m) => console.log(m),
  });
}

const MENU_NOTICE_EVERY_MS = 10 * 60_000;
const menuNoticeAt = new Map<string, number>();

/**
 * 目标窗口停在额度菜单 / 撞墙等待画面（paneShowsWallWait）：这条消息一个键都不发——不抢占、不 C-c（菜单里有「Switch to usage
 * credits」，按错一下就花钱，PM 09-29）——押住：闸开着按额度闸押（出闸关菜单后补投），没闸按普通押后（菜单关了就投）。
 * 人发的在 Discord 频道里说一声（10 分钟一次），agent / API 调用方从 heldBy 知道。不是这种画面返回 null，照常投。
 * 停止按钮、「停」字两条发键路径不走这里（T41 / T13e 收口）。deliverToLocal 在抢占之前调。
 */
export async function holdAtWallWait(env: Envelope, to: LocalEndpoint, agent: string): Promise<Delivery | null> {
  const b = bridge;
  if (!b) return null;
  const { win, runtime } = await resolveTurnWindow(to.channelId, b.controlChannelId);
  if (!win || (runtime ?? DEFAULT_RUNTIME) !== DEFAULT_RUNTIME) return null;
  if (!paneShowsWallWait(await tmuxCapture(win, 30).catch(() => ""))) return null; // 抓不到画面：认不出，照常投（不因此卡住消息）
  const walled = !!wall?.active();
  console.log(`⏸ 消息押后(${agent} 停在额度菜单 / 撞墙等待，没发任何键): 队列 ${b.held.holdEnv(env, walled ? "quota_wall" : undefined)} 条`);
  const now = Date.now();
  if (isHumanSender(env.from) && /^\d+$/.test(to.channelId) && now - (menuNoticeAt.get(to.channelId) ?? 0) > MENU_NOTICE_EVERY_MS) {
    menuNoticeAt.set(to.channelId, now);
    const when = walled ? "出闸后" : "菜单关掉后";
    await b.escalate(to.channelId, `⏸ ${agent} 停在额度菜单（撞墙等待），bridge 没有发任何键；你的消息先押着，${when}送达。要马上处理请在它的窗口里自己操作。`)
      .catch((e) => console.error("额度菜单押后提示发送失败（消息照样押着）:", (e as Error).message));
  }
  return { envelope: env, outcome: { kind: "sent", note: "queued", heldBy: "wall_menu" } };
}

/** 被「它又动了」取消掉的续跑（60 秒续跑 / 闸的续跑名单）：那一轮要是外人触发的、不算接着做，stop-settle 调 rearmResume 放回去 */
const cancelledResume = new Map<string, { agent: string; error: string }>();
let rearm: ((cid: string) => void) | null = null;
export const rearmResume = (cid: string): void => rearm?.(cid);

/** bridge 启动时调一次：起闸、接 api_error_turn、15 秒一拍（续跑到期 + 闸的 tick） */
export function startQuotaWall(b: WallBridgeDeps): QuotaWall {
  bridge = b;
  const w = (wall = productionWall(b));
  for (const cb of earlyExitListeners.splice(0)) w.onExit(cb);
  // 闸内回程簿不按 2 小时扫（撞周额度一等一两天）；出闸时整本失效钟重新起算，等它们的真实答复
  w.onExit(() => {
    for (const c of [...b.calls.values()]) b.calls.touch(c.targetChannelId ?? "", c.callerChannelId);
  });
  const states = new Map<string, ApiErrorState>();
  const agentOf = new Map<string, string>(); // 到期续跑时交给闸要带名字
  subscribeEvents({}, (evt) => {
    const ts = Date.parse(evt.ts) || Date.now();
    if (evt.type === "api_error_turn") {
      const data = evt.data as { error?: unknown; text?: unknown };
      const err = String(data.error ?? "");
      agentOf.set(evt.chatId, evt.agent);
      cancelledResume.delete(evt.chatId);
      const r = noteApiError(states, evt.chatId, err, ts); // 同步先记：之后几毫秒内的活动事件要能对上它
      void (async () => {
        if (await w.noteApiError({ channelId: evt.chatId, agent: evt.agent, at: ts, error: err, text: String(data.text ?? "") })) {
          states.delete(evt.chatId);
          recordMetric("api_error_turn", { agent: evt.agent, meta: { error: err, action: "quota_wall" } });
          return;
        }
        const model = isModelLimitHit(err, String(data.text ?? "")); // 模型额度：续跑只会再撞，直接告诉人换模型
        if (model) states.delete(evt.chatId);
        const act = model ? "model_limit" : r;
        console.log(`⚠️ 回合以 API 错误结束: ${evt.agent}（${err || "API Error"}）→ ${act === "track" ? "60s 后自动续跑" : act === "model_limit" ? "模型额度，不续跑" : "续跑后再撞，升级到频道"}`);
        recordMetric("api_error_turn", { agent: evt.agent, meta: { error: err, action: act } });
        const why = model
          ? `撞了单个模型的额度（${String(data.text ?? "").split("\n")[0].slice(0, 120)}），bridge 不自动续跑。在它的窗口里用 /model 换个模型（或 /usage-credits）后发一句继续。`
          : `连续两次因 API 错误中断（自动续跑一次已用完，不再续）：${err || "API Error"}。需要人看一眼网络/代理后手动发一句继续。`;
        if (act !== "track" && /^\d+$/.test(evt.chatId)) {
          await b.escalate(evt.chatId, `⛔ ${evt.agent} ${why}`).catch((e) => console.error("api-error 升级通知失败:", (e as Error).message));
        }
      })();
      return;
    }
    const gone = countsAsActivity(evt.type, evt.data) ? noteActivity(states, evt.chatId, ts) : undefined;
    if (gone) cancelledResume.set(evt.chatId, { agent: agentOf.get(evt.chatId) ?? evt.agent, error: gone.error });
    const hit = countsAsWallActivity(evt.type, evt.data as Record<string, unknown>) ? w.noteActivity(evt.chatId, ts) : null;
    if (hit) cancelledResume.set(evt.chatId, hit);
  });
  rearm = (cid) => {
    const c = cancelledResume.get(cid);
    if (!c) return;
    cancelledResume.delete(cid);
    const now = Date.now();
    console.log(`🔁 ${c.agent} 那一轮是外人触发的，回程还等着：续跑重新排上`);
    if (w.active()) void w.noteApiError({ channelId: cid, agent: c.agent, at: now, error: c.error, text: "" }); // 闸内：放回续跑名单，出闸续
    else {
      agentOf.set(cid, c.agent);
      states.set(cid, { errorAt: now, error: c.error }); // 重新计 60 秒
    }
  };
  setInterval(() => {
    void resumeDue(b, w, states, agentOf);
    void w.tick();
  }, TICK_MS);
  return w;
}

async function resumeDue(b: WallBridgeDeps, w: QuotaWall, states: Map<string, ApiErrorState>, agentOf: Map<string, string>): Promise<void> {
  const now = Date.now();
  for (const cid of dueForResume(states, now)) {
    const st = states.get(cid);
    const target = b.clients.get(cid);
    if (!st || !target) { states.delete(cid); continue; }
    // 60 秒里闸开了（别的 agent 撞墙）：这一次也交给闸，出闸再续
    if (w.active() && (await w.noteApiError({ channelId: cid, agent: agentOf.get(cid) ?? cid, at: st.errorAt, error: st.error, text: "" }))) {
      states.delete(cid);
      continue;
    }
    markResumed(states, cid, now);
    b.markAgentSource(cid);
    void b.deliver({
      from: { kind: "bridge", label: "api-error-resume" },
      to: { kind: "local", channelId: cid, ws: target.ws, cwd: target.cwd },
      intent: "notification",
      content: resumeText(st.error, st.errorAt),
      meta: { messageId: newMessageId("api_resume"), triggerKind: "bridge_synth", ts: new Date(now).toISOString(), threadId: newThreadId() },
    }).then(() => {
      console.log(`🔁 api-error-resume → ${cid}`);
      recordMetric("api_error_resume", { channelId: cid, meta: { error: st.error } });
    }).catch((e) => console.error("api-error-resume 投递失败:", (e as Error).message));
  }
}

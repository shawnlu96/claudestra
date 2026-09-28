/**
 * 额度闸与 API 错误续跑的 bridge 接线：生产依赖（状态文件、tmux、registry、T2b-2 用量、#control 通知）在这里拼好，
 * bridge.ts 只留一行启动。api-error-resume（lib/api-error-resume.ts）从 bridge.ts 搬来，前面加一道「闸先接手」：
 * 撞墙原文 → 进闸；闸内任何 API 错误 → 记进续跑名单、出闸再续；其余照旧 60 秒续跑一次、再撞升级到频道。
 */
import { existsSync, unlinkSync } from "fs";
import { countsAsActivity, dueForResume, markResumed, noteActivity, noteApiError, resumeText, type ApiErrorState } from "../lib/api-error-resume.js";
import { isModelLimitHit } from "../lib/quota-wall-text.js";
import { recordMetric } from "../lib/metrics.js";
import { emptyWallState, isWallState, QUOTA_WALL_CLEAR_PATH, QUOTA_WALL_PATH, type WallState } from "../lib/quota-wall.js";
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
    mainTurnBusy: async (cid, agent) => agentMsgMustWait(await probeTurn(cid, agent, b.controlChannelId)),
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

/** bridge 启动时调一次：起闸、接 api_error_turn、15 秒一拍（续跑到期 + 闸的 tick） */
export function startQuotaWall(b: WallBridgeDeps): QuotaWall {
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
    if (countsAsActivity(evt.type, evt.data)) {
      noteActivity(states, evt.chatId, ts);
      w.noteActivity(evt.chatId, ts);
    }
  });
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

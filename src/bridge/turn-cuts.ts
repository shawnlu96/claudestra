/**
 * 打断记录簿（lib/turn-cuts.ts 的接线）：按频道存最近一条 cut，落盘 turn-cuts.json（bridge 重启后插话那一回合的 Stop 还能提醒）；
 * 记每个频道最后一条入站（被打断的回合在处理谁的什么）、agent 往各地址 reply 的时刻（收尾提醒列「还没回复」）、bridge 发键的时刻
 * （认出 Codex 打断回报的回声、认出人在终端里自己按的打断）、人最后一次「停」与之后有没有再说话（Autopilot 据此不推进）。
 * 订阅 event-bus：打断后又跑了同名同内容的工具 = 那一段续上了；打断后几秒内出错收尾的工具补进 inflight；会话记录里的打断标记。
 * Codex 的「打断后 queue 卡住」相关状态也在这里（能不能打字投递、下一条要不要打字），见 lib/codex-tui-submit.ts。
 */
import { statePath } from "../lib/paths.js";
import {
  CUT_TTL_MS, lateInflight, makeCut, onStop, resumeBy, resumeNotice,
  type Cut, type CutCause, type CutEvent, type CutTool, type ReplyState, type TurnTrigger,
} from "../lib/turn-cuts.js";
import { emitEvent, inflightTools, subscribeEvents } from "./event-bus.js";
import { PersistedMap } from "./persisted-map.js";
import { newMessageId, newThreadId, type Envelope, type LocalEndpoint } from "./router.js";

const isCut = (v: unknown) => !!v && typeof v === "object" && typeof (v as Cut).id === "string" && Array.isArray((v as Cut).inflight);
/** 收尾提醒自己也是一条入站：不能被记成「被打断的回合在处理它」 */
const CUT_NOTICE_LABEL = "turn-cuts";
const REPLY_KEEP = 20;
const START_KEEP = 50;
/** 会话记录里的打断标记离 bridge 发键这么近 = 是我们发的键（CC 在键到之后几百毫秒内写这一行） */
const OWN_KEY_WINDOW_MS = 5_000;

export interface RecordCutInput {
  channelId: string;
  agent: string;
  runtime?: string;
  cause: CutCause;
  byMessageId?: string;
  byName?: string;
  tools: { inflight: CutTool[]; lastDone?: { name: string; summary: string } };
}

export class TurnCuts {
  private readonly cuts: PersistedMap<Cut>;
  private readonly lastInbound = new Map<string, TurnTrigger>();
  /** 频道 → 最后一次 ws.send 投递的时刻（终端打断之后有没有新消息进来） */
  private readonly deliveredAt = new Map<string, number>();
  /** `${channelId}\n${chatId}` → agent 往这个地址 reply 的时刻（最近几次） */
  private readonly replies = new Map<string, number[]>();
  /** 最近的 tool_start（lateInflight 要拿 tool_done 对回它的 start） */
  private readonly starts = new Map<string, CutEvent>();
  private readonly keySentAt = new Map<string, number>();
  /** 频道 → 人最后一次说的不是「停」的时刻（和 cut 里的「停」比先后） */
  private readonly lastGoAt = new Map<string, number>();
  /** 提醒已生成、还押在队列里没投出去的频道（这期间 agent 续上了 / 又被打断，提醒就作废） */
  private readonly noticePending = new Set<string>();
  // ── Codex（以下只在内存：bridge 重启丢了，最坏是那一条又卡在 queue 里，和改之前一样） ──
  /** channel-server 注册时声明会打字投递的频道（老版本不声明：对它们不主动抢占，否则消息无声卡死） */
  private readonly codexTypeIn = new Set<string>();
  /** 上次 Stop 之后被打断过：下一条入站要打进 TUI */
  private readonly codexPaused = new Set<string>();
  /** 上次 Stop 之后 bridge 抢占过：先到的还在 queue 里排着，再抢占会让后来的插到它前面 */
  private readonly codexCutSinceStop = new Set<string>();

  constructor(path: string | null = statePath("turn-cuts.json"), private readonly now: () => number = Date.now) {
    this.cuts = new PersistedMap<Cut>(path, "打断记录", isCut, []);
  }

  get(channelId: string): Cut | undefined {
    return this.cuts.get(channelId);
  }

  /** 消息真正 ws.send 出去之后调：记「这个频道最后在处理什么」；打断它的那条送达了，插话回合从此开始 */
  noteDelivered(env: Envelope, channelId: string): void {
    const at = this.now();
    this.deliveredAt.set(channelId, at);
    const cut = this.cuts.get(channelId);
    if (cut && cut.byMessageId === env.meta.messageId && cut.deliveredAt === undefined) this.cuts.set(channelId, { ...cut, deliveredAt: at });
    if (isCutNotice(env)) return void this.noticePending.delete(channelId);
    const f = env.from;
    const fromName = f.kind === "user" ? (f.username ?? "用户") : f.kind === "api" ? f.name : f.kind === "local" ? (f.agentName ?? "agent") : `bridge${f.label ? `:${f.label}` : ""}`;
    const replyTo = f.kind === "user" || f.kind === "local" ? f.channelId : f.kind === "api" ? `api:${f.tokenId}` : "";
    this.lastInbound.set(channelId, { messageId: env.meta.messageId, fromKind: f.kind, fromName, excerpt: env.content.slice(0, 120), replyTo, at });
  }

  /** agent 调 reply(chat_id) 时调 */
  noteReplied(channelId: string, chatId: string): void {
    const k = `${channelId}\n${chatId}`;
    this.replies.set(k, [...(this.replies.get(k) ?? []), this.now()].slice(-REPLY_KEEP));
  }

  /** 人类消息到达（抢占判断之前）：不是「停」就解除「已叫停」 */
  noteHuman(channelId: string, isStop: boolean): void {
    if (!isStop) this.lastGoAt.set(channelId, this.now());
  }

  /** bridge 要发打断键了（发之前记：Codex 的打断回报 0.5 秒就到） */
  noteKeySent(channelId: string): void {
    this.keySentAt.set(channelId, this.now());
  }

  /** 记一次打断。被打断的回合在处理的是打断之前最后送达的那条（打断它的这条此刻还没送达） */
  record(i: RecordCutInput): Cut {
    const at = this.now();
    this.prune(at);
    const trig = this.lastInbound.get(i.channelId);
    const prev = this.cuts.get(i.channelId);
    // 提醒生成了还没投出去就又被打断：那一段还没收尾，挂进新的链里（旧提醒随之作废，见 noticeWanted）
    const chainable = prev && prev.state === "hinted" && this.noticePending.has(i.channelId) ? { ...prev, state: "open" as const } : prev;
    const cut = makeCut(
      {
        id: `cut_${at.toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        agent: i.agent, channelId: i.channelId, runtime: i.runtime, at, cause: i.cause,
        byMessageId: i.byMessageId, byName: i.byName, tools: i.tools,
        turnTrigger: trig && trig.messageId !== i.byMessageId ? trig : undefined,
      },
      chainable,
    );
    this.cuts.set(i.channelId, cut);
    this.noticePending.delete(i.channelId);
    if (i.runtime === "codex") this.codexPaused.add(i.channelId), this.codexCutSinceStop.add(i.channelId);
    return cut;
  }

  /** 投递前调：Codex 上次 Stop 之后被打断过 → 这一条标 after_interrupt（只标一条：它打出的那一轮结束后队列就恢复了） */
  takeAfterInterrupt(channelId: string): boolean {
    return this.codexPaused.delete(channelId);
  }

  /** channel-server 报打字投递没做成（退回了 queue）：下一条再试着打字，打成了那一轮结束后队列里的也会跟着处理 */
  rearmAfterInterrupt(channelId: string): void {
    this.codexPaused.add(channelId);
  }

  setCodexTypeIn(channelId: string, on: boolean): void {
    if (on) this.codexTypeIn.add(channelId);
    else this.codexTypeIn.delete(channelId);
  }

  /** bridge 能不能主动打断：Codex 要 channel-server 会打字投递；非停字的抢占在上次 Stop 之后只做一次（保顺序） */
  mayBridgeInterrupt(channelId: string, runtime: string | undefined, stop: boolean): boolean {
    if (runtime !== "codex") return true;
    return this.codexTypeIn.has(channelId) && (stop || !this.codexCutSinceStop.has(channelId));
  }

  /** 这次打断回报是不是 bridge 自己发的键引起的（Codex Interrupt hook / CC 会话记录的打断标记） */
  keySentWithin(channelId: string, at: number, ms = OWN_KEY_WINDOW_MS): boolean {
    const k = this.keySentAt.get(channelId);
    return k !== undefined && at >= k - 500 && at - k <= ms;
  }

  /** Autopilot 要不要先别推进：人叫停了（之后没再说别的），或者还有一条打断收尾提醒没投 */
  interruptHold(channelId: string): "stopped" | "notice" | null {
    const cut = this.cuts.get(channelId);
    if (cut && cut.cause !== "preempt" && cut.at >= (this.lastGoAt.get(channelId) ?? -1) && this.now() - cut.at < CUT_TTL_MS * 4) return "stopped";
    return this.noticePending.has(channelId) ? "notice" : null;
  }

  /** 回合结束：该提醒就返回提醒的信封（押后队列投，只提醒一次），否则 null */
  onStop(channelId: string, event: string, agent: string): Envelope | null {
    if (event === "Stop") this.codexPaused.delete(channelId), this.codexCutSinceStop.delete(channelId); // 打断回报是 StopFailure，不算
    const cut = this.cuts.get(channelId);
    if (!cut) return null;
    const d = onStop(cut, event, this.now());
    if (d === "expire") this.cuts.set(channelId, { ...cut, state: "expired" });
    if (d !== "hint") return null;
    this.cuts.set(channelId, { ...cut, state: "hinted" });
    this.noticePending.add(channelId);
    return resumeNoticeEnv(channelId, agent, resumeNotice(cut, (seg) => this.replyState(seg)));
  }

  /** 押着的收尾提醒投出去之前再问一次：生成之后又被打断 / 叫停过、那件事已续上、过了 30 分钟，都不投了 */
  noticeWanted(env: Envelope): boolean {
    if (!isCutNotice(env)) return true;
    const ch = (env.to as LocalEndpoint).channelId;
    const born = Date.parse(env.meta.ts) || 0;
    const cut = this.cuts.get(ch);
    const wanted = this.now() - born <= CUT_TTL_MS && !!cut && cut.at <= born && cut.state === "hinted";
    if (!wanted) this.noticePending.delete(ch);
    return wanted;
  }

  /** 被打断时在处理的人类消息回过没有：送达到被打断之间回过 = 答了；只在打断之后回过 = 可能答的是插话，让 agent 核对 */
  private replyState(seg: Cut): ReplyState {
    const t = seg.turnTrigger;
    if (!t || (t.fromKind !== "user" && t.fromKind !== "api") || !t.replyTo) return "replied";
    const times = (this.replies.get(`${seg.channelId}\n${t.replyTo}`) ?? []).filter((ts) => ts >= t.at);
    return times.some((ts) => ts <= seg.at) ? "replied" : times.length ? "after_cut" : "never";
  }

  /** event-bus 订阅回调：续做检测、迟到的 inflight、会话记录里的打断标记 */
  onEvent(e: CutEvent & { chatId: string; agent: string }): void {
    if (e.type === "turn_interrupted") return this.onTranscriptInterrupt(e);
    if (e.type === "tool_start") {
      const id = typeof e.data.toolId === "string" ? e.data.toolId : "";
      if (id) this.starts.set(id, e);
      if (this.starts.size > START_KEEP) this.starts.delete(this.starts.keys().next().value as string);
    }
    const cut = this.cuts.get(e.chatId);
    if (!cut || !(cut.state === "open" || (cut.state === "hinted" && this.noticePending.has(e.chatId)))) return;
    const resumed = resumeBy(cut, e);
    if (resumed) return void this.cuts.set(e.chatId, resumed);
    if (e.type === "tool_done" && cut.state === "open") {
      const upd = lateInflight(cut, this.starts.get(String(e.data.toolId ?? "")), e);
      if (upd) this.cuts.set(e.chatId, upd);
    }
  }

  /**
   * 会话记录出现 [Request interrupted by user：bridge 近几秒没发过键 = 人在终端里自己打断的——记一条「停」类 cut（不提醒、Autopilot 不推进）。
   * CC 这时不发 Stop，事件态会卡在 thinking：之后没有新消息投进来，就顺手收成 done。
   */
  private onTranscriptInterrupt(e: CutEvent & { chatId: string; agent: string }): void {
    const at = Date.parse(String(e.data.ts ?? "")) || Date.parse(e.ts) || this.now(); // 那一行写进会话记录的时刻（watcher 约 2 秒后才读到）
    if (this.keySentWithin(e.chatId, at)) return;
    console.log(`⏹ ${e.agent} 在终端里被人打断（bridge 没发键）：记为叫停`);
    this.record({ channelId: e.chatId, agent: e.agent, cause: "terminal", tools: inflightTools(e.agent) });
    if ((this.deliveredAt.get(e.chatId) ?? 0) <= at) emitEvent({ agent: e.agent, chatId: e.chatId, type: "agent_status", data: { status: "done", trigger: "terminal_interrupt" } });
  }

  /** 过期很久的记录（agent 早被 kill 的频道）不留在盘上 */
  private prune(now: number): void {
    for (const [ch, c] of this.cuts) if (now - c.at > CUT_TTL_MS * 4) this.cuts.delete(ch);
  }
}

/** 收尾提醒（bridge 身份、label turn-cuts）：处理完的 Stop 不去 @ 用户，和 Autopilot 的提醒一样是 bridge 发起的回合 */
export function isCutNotice(env: Envelope): boolean {
  return env.from.kind === "bridge" && env.from.label === CUT_NOTICE_LABEL;
}

/**
 * 打断收尾提醒的信封：bridge 系统通知，waitForIdle = 目标主回合在跑就押着（回合中裸发会落进丢弃窗口）。
 * ws 留空：进押后队列，投递时按 channelId 取最新连接（held-flush）。
 */
function resumeNoticeEnv(channelId: string, agent: string, text: string): Envelope {
  return {
    from: { kind: "bridge", label: CUT_NOTICE_LABEL },
    to: { kind: "local", channelId, agentName: agent, ws: undefined as never },
    intent: "notification",
    content: text,
    meta: { messageId: newMessageId("cut"), triggerKind: "bridge_synth", ts: new Date().toISOString(), threadId: newThreadId(), waitForIdle: true },
  };
}

export const turnCuts = new TurnCuts();
subscribeEvents({}, (e) => turnCuts.onEvent(e));

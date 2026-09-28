/**
 * 打断记录簿（lib/turn-cuts.ts 的接线）：按频道存最近一条 cut，落盘 turn-cuts.json（bridge 重启后插话那一回合的 Stop 还能提醒）；
 * 记每个频道最后一条入站（被打断的回合在处理谁的什么）和 agent 往各地址 reply 的时刻（收尾提醒列「还没回复」）；
 * 订阅 event-bus：打断后又跑了同名同内容的工具 = 已续做，打断后几秒内出错收尾的工具补进 inflight。
 */
import { statePath } from "../lib/paths.js";
import {
  CUT_TTL_MS, isResumedBy, lateInflight, makeCut, onStop, resumeNotice,
  type Cut, type CutCause, type CutEvent, type CutTool, type TurnTrigger,
} from "../lib/turn-cuts.js";
import { subscribeEvents } from "./event-bus.js";
import { PersistedMap } from "./persisted-map.js";
import { newMessageId, newThreadId, type Envelope } from "./router.js";

const isCut = (v: unknown) => !!v && typeof v === "object" && typeof (v as Cut).id === "string" && Array.isArray((v as Cut).inflight);
/** 收尾提醒自己也是一条入站：不能被记成「被打断的回合在处理它」 */
const CUT_NOTICE_LABEL = "turn-cuts";
const REPLY_KEEP = 20;
const START_KEEP = 50;

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
  /** `${channelId}\n${chatId}` → agent 往这个地址 reply 的时刻（最近几次） */
  private readonly replies = new Map<string, number[]>();
  /** 最近的 tool_start（lateInflight 要拿 tool_done 对回它的 start） */
  private readonly starts = new Map<string, CutEvent>();

  constructor(path: string | null = statePath("turn-cuts.json"), private readonly now: () => number = Date.now) {
    this.cuts = new PersistedMap<Cut>(path, "打断记录", isCut, []);
  }

  get(channelId: string): Cut | undefined {
    return this.cuts.get(channelId);
  }

  /** 消息真正 ws.send 出去之后调：记「这个频道最后在处理什么」；打断它的那条送达了，插话回合从此开始 */
  noteDelivered(env: Envelope, channelId: string): void {
    const at = this.now();
    const cut = this.cuts.get(channelId);
    if (cut && cut.byMessageId === env.meta.messageId && cut.deliveredAt === undefined) this.cuts.set(channelId, { ...cut, deliveredAt: at });
    if (env.from.kind === "bridge" && env.from.label === CUT_NOTICE_LABEL) return;
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

  /** 记一次打断。被打断的回合在处理的是打断之前最后送达的那条（打断它的这条此刻还没送达） */
  record(i: RecordCutInput): Cut {
    const at = this.now();
    this.prune(at);
    const trig = this.lastInbound.get(i.channelId);
    const cut = makeCut(
      {
        id: `cut_${at.toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        agent: i.agent, channelId: i.channelId, runtime: i.runtime, at, cause: i.cause,
        byMessageId: i.byMessageId, byName: i.byName, tools: i.tools,
        turnTrigger: trig && trig.messageId !== i.byMessageId ? trig : undefined,
      },
      this.cuts.get(i.channelId),
    );
    this.cuts.set(i.channelId, cut);
    return cut;
  }

  /** 「停」但这次没发键（本来就空闲 / 刚打断过）：之前没收尾的 cut 也不再提醒 */
  stop(channelId: string): void {
    const cut = this.cuts.get(channelId);
    if (cut?.state === "open") this.cuts.set(channelId, { ...cut, state: "stopped" });
  }

  /** 最近这条 cut 离现在不到 ms（Codex 的 Interrupt 回声：我们自己发的 Esc 已经记过了） */
  recentlyCut(channelId: string, ms: number): boolean {
    const cut = this.cuts.get(channelId);
    return !!cut && this.now() - cut.at <= ms;
  }

  /** 回合结束：该提醒就返回提醒正文（并标 hinted，只提醒一次），否则 null */
  onStop(channelId: string, event: string): string | null {
    const cut = this.cuts.get(channelId);
    if (!cut) return null;
    const d = onStop(cut, event, this.now());
    if (d === "expire") this.cuts.set(channelId, { ...cut, state: "expired" });
    if (d !== "hint") return null;
    this.cuts.set(channelId, { ...cut, state: "hinted" });
    return resumeNotice(cut, (seg) => this.unreplied(seg));
  }

  /** 被打断时在处理的人类消息，从送达到被打断之间 agent 没往它的地址 reply 过 */
  private unreplied(seg: Cut): boolean {
    const t = seg.turnTrigger;
    if (!t || (t.fromKind !== "user" && t.fromKind !== "api") || !t.replyTo) return false;
    return !(this.replies.get(`${seg.channelId}\n${t.replyTo}`) ?? []).some((ts) => ts >= t.at && ts <= seg.at);
  }

  /** event-bus 订阅回调：续做检测与迟到的 inflight */
  onEvent(e: CutEvent & { chatId: string }): void {
    if (e.type === "tool_start") {
      const id = typeof e.data.toolId === "string" ? e.data.toolId : "";
      if (id) this.starts.set(id, e);
      if (this.starts.size > START_KEEP) this.starts.delete(this.starts.keys().next().value as string);
    }
    const cut = this.cuts.get(e.chatId);
    if (!cut || cut.state !== "open") return;
    if (isResumedBy(cut, e)) {
      this.cuts.set(e.chatId, { ...cut, state: "resumed" });
      return;
    }
    if (e.type === "tool_done") {
      const upd = lateInflight(cut, this.starts.get(String(e.data.toolId ?? "")), e);
      if (upd) this.cuts.set(e.chatId, upd);
    }
  }

  /** 过期很久的记录（agent 早被 kill 的频道）不留在盘上 */
  private prune(now: number): void {
    for (const [ch, c] of this.cuts) if (now - c.at > CUT_TTL_MS * 4) this.cuts.delete(ch);
  }
}

export const turnCuts = new TurnCuts();
subscribeEvents({}, (e) => turnCuts.onEvent(e));

/**
 * 打断收尾提醒的信封：bridge 系统通知，waitForIdle = 目标主回合在跑就押着（回合中裸发会落进丢弃窗口）。
 * ws 留空：进押后队列，投递时按 channelId 取最新连接（held-flush）。
 */
export function resumeNoticeEnv(channelId: string, agent: string, text: string): Envelope {
  return {
    from: { kind: "bridge", label: CUT_NOTICE_LABEL },
    to: { kind: "local", channelId, agentName: agent, ws: undefined as never },
    intent: "notification",
    content: text,
    meta: { messageId: newMessageId("cut"), triggerKind: "bridge_synth", ts: new Date().toISOString(), threadId: newThreadId(), waitForIdle: true },
  };
}

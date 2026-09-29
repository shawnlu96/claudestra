/**
 * 打断记录簿（lib/turn-cuts.ts 的接线）：按频道存最近一条 cut，落盘 turn-cuts.json（bridge 重启后插话那一回合的 Stop 还能提醒）；
 * 记每个频道最后一条入站（被打断的回合在处理谁的什么）、agent 往各地址 reply 的时刻（收尾提醒列「还没回复」）、bridge 发键的时刻
 * （认出 Codex 打断回报的回声、认出人在终端里自己按的打断）、owner 叫停了还没再开口的频道（单独一份 turn-cuts-stops.json，Autopilot 据此不推进）。
 * 订阅 event-bus：打断后又跑了同名同内容的工具 = 那一段续上了；打断后几秒内出错收尾的工具补进 inflight；会话记录里的打断标记。
 * Codex 的「打断后 queue 卡住」相关状态也在这里（能不能打字投递、下一条要不要打字），见 lib/codex-tui-submit.ts。
 */
import { statePath } from "../lib/paths.js";
import { isProgramKey, isProgramText, type ProgramInput } from "../lib/program-input.js";
import { MASTER_SESSION, programInputsOf, tmuxSendEscape, windowTarget } from "../lib/tmux-helper.js";
import {
  CUT_TTL_MS, lateInflight, makeCut, onStop, resumeBy, resumeNotice, settleBy,
  type Cut, type CutCause, type CutEvent, type CutTool, type ReplyState, type TurnTrigger,
} from "../lib/turn-cuts.js";
import { emitEvent, inflightTools, subscribeEvents } from "./event-bus.js";
import { HELD_GIVE_UP_MS } from "./held-queue.js";
import { isAcpChannel } from "./acp-state.js";
import { PersistedMap } from "./persisted-map.js";
import { newMessageId, newThreadId, type Envelope, type LocalEndpoint } from "./router.js";

const isStopRec = (v: unknown) => !!v && typeof v === "object" && typeof (v as { at?: unknown }).at === "number";
const isCut = (v: unknown) => !!v && typeof v === "object" && typeof (v as Cut).id === "string" && Array.isArray((v as Cut).inflight);
/** 收尾提醒自己也是一条入站：不能被记成「被打断的回合在处理它」 */
const CUT_NOTICE_LABEL = "turn-cuts";
const REPLY_KEEP = 20;
const START_KEEP = 50;
const INBOUND_KEEP = 8;
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
  /** 这次真的打断了回合（发出了键）；停字 / 停止按钮没发键时 false（只留档、压提醒） */
  interrupted?: boolean;
}

export class TurnCuts {
  private readonly cuts: PersistedMap<Cut>;
  /**
   * 频道 → owner 最近一次叫停（停字 / 停止按钮 / 终端里按的打断）：at = 叫停时刻，goAt = 之后 owner 说了不是停的话。
   * 不跟着「最新一条 cut」走：外源消息的抢占会记一条新 cut 盖掉那条停，却不能替 owner 解除（wf2 stop-semantics-1）。落盘、不设期限
   */
  private readonly stops: PersistedMap<{ at: number; goAt?: number }>;
  /** 频道 → 这一回合（上次 Stop / 打断之后）送到的消息，按先后；被打断时它们就是「在处理的」 */
  private readonly inbound = new Map<string, TurnTrigger[]>();
  private readonly agentOf = new Map<string, string>();
  /** Codex 频道：上次 Stop 之后经 codex queue（不是打进 TUI）投的消息摘录——Esc 之后它们会排在停字后面才跑 */
  private readonly codexQueued = new Map<string, string[]>();
  /** 频道 → 最后一次 ws.send 投递的时刻（终端打断之后有没有新消息进来） */
  private readonly deliveredAt = new Map<string, number>();
  /** `${channelId}\n${chatId}` → agent 往这个地址 reply 的时刻（最近几次） */
  private readonly replies = new Map<string, number[]>();
  /** 最近的 tool_start（lateInflight 要拿 tool_done 对回它的 start） */
  private readonly starts = new Map<string, CutEvent>();
  private readonly keySentAt = new Map<string, { at: number; kind: "preempt" | "manual" }>();
  /** 提醒已生成、还押在队列里没投出去的频道（这期间 agent 续上了 / 又被打断，提醒就作废） */
  private readonly noticePending = new Set<string>();
  // ── Codex（以下只在内存：bridge 重启丢了，最坏是那一条又卡在 queue 里，和改之前一样） ──
  /** channel-server 注册时声明会打字投递的频道（老版本不声明：对它们不主动抢占，否则消息无声卡死） */
  private readonly codexTypeIn = new Set<string>();
  /** 上次 Stop 之后被打断过：下一条入站要打进 TUI */
  private readonly codexPaused = new Set<string>();
  /** 上次 Stop 之后 bridge 抢占过：先到的还在 queue 里排着，再抢占会让后来的插到它前面 */
  private readonly codexCutSinceStop = new Set<string>();

  constructor(
    path: string | null = statePath("turn-cuts.json"), private readonly now: () => number = Date.now,
    /** 程序往这个 agent 窗口发过的键（任何进程的 Esc、cron / manager 敲的字和 C-c，lib/program-input.ts）：它们不是人在终端里操作 */
    private readonly programKeys: (agent: string) => Promise<ProgramInput[]> = async () => [],
  ) {
    this.cuts = new PersistedMap<Cut>(path, "打断记录", isCut, []);
    this.stops = new PersistedMap(path && path.replace(/\.json$/, "-stops.json"), "叫停记录", isStopRec, []);
  }

  get(channelId: string): Cut | undefined {
    return this.cuts.get(channelId);
  }

  /**
   * 消息真正 ws.send 出去之后调：记「这一回合在处理什么」；打断它的那条送达了，插话回合从此开始。
   * typed = Codex 打进 TUI 的那条；busy = 送达时主回合在跑（Codex 空闲时经 queue 投的那条马上就开跑，不算「排在队列里」）
   */
  noteDelivered(env: Envelope, channelId: string, typed = false, busy = true): void {
    const at = this.now();
    this.deliveredAt.set(channelId, at);
    const cut = this.cuts.get(channelId);
    if (cut && cut.byMessageId === env.meta.messageId && cut.deliveredAt === undefined) this.cuts.set(channelId, { ...cut, deliveredAt: at });
    if (isCutNotice(env)) return void this.noticePending.delete(channelId);
    const f = env.from;
    const fromName = f.kind === "user" ? (f.username ?? "用户") : f.kind === "api" ? f.name : f.kind === "local" ? (f.agentName ?? "agent") : `bridge${f.label ? `:${f.label}` : ""}`;
    const replyTo = f.kind === "user" || f.kind === "local" ? f.channelId : f.kind === "api" ? `api:${f.tokenId}` : "";
    const t = { messageId: env.meta.messageId, fromKind: f.kind, fromName, excerpt: env.content.slice(0, 120), replyTo, at };
    if (env.to.kind === "local" && env.to.agentName) this.agentOf.set(channelId, env.to.agentName);
    this.inbound.set(channelId, [...(this.inbound.get(channelId) ?? []), t].slice(-INBOUND_KEEP));
    if (this.codexTypeIn.has(channelId) && !typed && busy && (f.kind === "user" || f.kind === "api")) {
      this.codexQueued.set(channelId, [...(this.codexQueued.get(channelId) ?? []), t.excerpt].slice(-INBOUND_KEEP));
    }
  }

  /** 这一回合送到过的某条消息（Pi 停下后作废回显要找发送方），以及它是发给哪个 agent 的 */
  deliveredMessage(channelId: string, messageId: string): (TurnTrigger & { agent?: string }) | undefined {
    const t = (this.inbound.get(channelId) ?? []).find((x) => x.messageId === messageId);
    return t && { ...t, agent: this.agentOf.get(channelId) };
  }

  /** 这条其实没投进去（Codex 投递失败）：从送达记录里拿掉。回合在不在跑不在这里判（bridge/pi-abort.ts onCodexUndelivered 不替它宣告完成） */
  dropUndelivered(channelId: string, messageId: string): void {
    this.inbound.set(channelId, (this.inbound.get(channelId) ?? []).filter((x) => x.messageId !== messageId));
  }

  /** 这个频道最后一次投递是给哪个 agent 的（送达记录里的那条被挤掉了也查得到） */
  agentOn(channelId: string): string | undefined {
    return this.agentOf.get(channelId);
  }

  /** Codex 停字用：上次 Stop 之后排进 codex queue、还没轮到的人类消息（停之后会先跑它们） */
  codexQueuedBefore(channelId: string): string[] {
    return this.codexQueued.get(channelId) ?? [];
  }

  /** agent 调 reply(chat_id) 时调 */
  noteReplied(channelId: string, chatId: string): void {
    const k = `${channelId}\n${chatId}`;
    this.replies.set(k, [...(this.replies.get(k) ?? []), this.now()].slice(-REPLY_KEEP));
  }

  /** owner 的消息到达（抢占判断之前）：不是「停」就解除「已叫停」。外源（非 owner 的 API 用户）不调：他们不能替 owner 叫停或解除 */
  noteHuman(channelId: string, isStop: boolean): void {
    this.prune(this.now()); // 不只在记新 cut 时清：很少被打断的实例，解除过的叫停记录也要按时清掉
    const s = this.stops.get(channelId);
    if (!isStop && s && s.goAt === undefined) this.stops.set(channelId, { ...s, goAt: this.now() });
  }

  /**
   * agent 被永久 kill（/agent/cleanup）：这个频道的打断 / 叫停记录和内存里的回合状态全删。
   * 不删的话叫停记录一直留在盘上，日后复用这个频道的新 agent 还会被当成「owner 叫停了」，Autopilot 不推进。
   */
  forget(channelId: string): void {
    for (const m of [this.cuts, this.stops, this.inbound, this.agentOf, this.codexQueued, this.deliveredAt, this.keySentAt]) m.delete(channelId);
    for (const s of [this.noticePending, this.codexTypeIn, this.codexPaused, this.codexCutSinceStop]) s.delete(channelId);
    for (const k of [...this.replies.keys()]) if (k.startsWith(`${channelId}\n`)) this.replies.delete(k);
  }

  /** owner 最近一次叫停这个频道的时刻（解除了也还在）：押在它之前、之后才投出去的消息要加抬头（bridge/held-flush.ts） */
  stoppedAt(channelId: string): number | undefined {
    return this.stops.get(channelId)?.at;
  }

  /** bridge 要发打断键了（发之前记：Codex 的打断回报 0.5 秒就到）。preempt = 后面紧跟着要投一条新消息 */
  noteKeySent(channelId: string, kind: "preempt" | "manual"): void {
    this.keySentAt.set(channelId, { at: this.now(), kind });
  }

  /** 记一次打断。被打断的回合在处理的是打断之前最后送达的那条（打断它的这条此刻还没送达） */
  record(i: RecordCutInput): Cut {
    const at = this.now();
    this.prune(at);
    // 被打断的回合在处理的：打断它的这条之前送到的那些；人和 agent 的优先（bridge 自己的通知只在没有别的时才算）
    const all = (this.inbound.get(i.channelId) ?? []).filter((t) => t.messageId !== i.byMessageId);
    const real = all.filter((t) => t.fromKind !== "bridge");
    const [trig, ...alsoPending] = real.length ? real : all.slice(-1);
    this.inbound.set(i.channelId, []); // 插话回合从头记
    const prev = this.cuts.get(i.channelId);
    // 提醒生成了还没投出去就又被打断：那一段还没收尾，挂进新的链里（旧提醒随之作废，见 noticeWanted）
    const chainable = prev && prev.state === "hinted" && this.noticePending.has(i.channelId) ? { ...prev, state: "open" as const } : prev;
    const cut = makeCut(
      {
        id: `cut_${at.toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        agent: i.agent, channelId: i.channelId, runtime: i.runtime, at, cause: i.cause,
        byMessageId: i.byMessageId, byName: i.byName, tools: i.tools,
        turnTrigger: trig, alsoPending,
      },
      chainable,
    );
    this.cuts.set(i.channelId, cut);
    if (cut.state === "stopped") this.stops.set(i.channelId, { at }); // 「停」类只由 owner 记（停字认 owner、非 owner 的停止按钮不记）
    this.noticePending.delete(i.channelId);
    // 真打断了 Codex 才会卡 queue：停字没发出键（空闲 / 被拦）时下一条照常走 queue，不去打字
    if (i.runtime === "codex" && i.interrupted !== false) this.codexPaused.add(i.channelId), this.codexCutSinceStop.add(i.channelId);
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
    if (runtime !== "codex" || isAcpChannel(channelId)) return true; // ACP 宿主打断走 session/cancel，没有 queue 卡住的问题
    return this.codexTypeIn.has(channelId) && (stop || !this.codexCutSinceStop.has(channelId));
  }

  /**
   * 这次打断回报是不是 bridge 自己发的键引起的（Codex Interrupt hook / CC 会话记录的打断标记）。
   * kind 给了就只认那一种：抢占的回声不是回合结束（新消息马上开回合），停止按钮的回声就是回合结束，要照常收尾。
   */
  keySentWithin(channelId: string, at: number, kind?: "preempt" | "manual", ms = OWN_KEY_WINDOW_MS): boolean {
    const k = this.keySentAt.get(channelId);
    return k !== undefined && (!kind || k.kind === kind) && at >= k.at - 500 && at - k.at <= ms;
  }

  /** Autopilot 要不要先别推进：人叫停了、之后没再说别的（不设期限：「等人再开口」），或者还有一条打断收尾提醒没投 */
  interruptHold(channelId: string): "stopped" | "notice" | null {
    const s = this.stops.get(channelId);
    if (s && s.goAt === undefined) return "stopped";
    return this.noticePending.has(channelId) ? "notice" : null;
  }

  /** 回合结束：该提醒就返回提醒的信封（押后队列投，只提醒一次），否则 null */
  onStop(channelId: string, event: string, agent: string): Envelope | null {
    if (event === "Stop") {
      // 回合正常结束：Codex 的队列恢复了、排着的也会依次跑完（打断回报是 StopFailure，不算）；下一回合的消息从头记
      for (const m of [this.codexPaused, this.codexCutSinceStop]) m.delete(channelId);
      this.codexQueued.delete(channelId), this.inbound.delete(channelId);
    }
    const cut = this.cuts.get(channelId);
    if (!cut) return null;
    const d = onStop(cut, event, this.now());
    if (d === "expire") this.cuts.set(channelId, { ...cut, state: "expired" });
    if (d !== "hint") return null;
    this.cuts.set(channelId, { ...cut, state: "hinted" });
    this.noticePending.add(channelId);
    return resumeNoticeEnv(channelId, agent, resumeNotice(cut, (seg, t) => this.replyState(seg, t)));
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
  private replyState(seg: Cut, t: TurnTrigger): ReplyState {
    if ((t.fromKind !== "user" && t.fromKind !== "api") || !t.replyTo) return "replied";
    const times = (this.replies.get(`${seg.channelId}\n${t.replyTo}`) ?? []).filter((ts) => ts >= t.at);
    return times.some((ts) => ts <= seg.at) ? "replied" : times.length ? "after_cut" : "never";
  }

  /** event-bus 订阅回调：续做检测、迟到的 inflight、会话记录里的打断标记 */
  onEvent(e: CutEvent & { chatId: string; agent: string }): void {
    if (e.type === "turn_interrupted") return void this.onTranscriptInterrupt(e);
    if (e.type === "terminal_input") return void this.onTerminalInput(e);
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
      const upd = settleBy(cut, e) ?? lateInflight(cut, this.starts.get(String(e.data.toolId ?? "")), e);
      if (upd) this.cuts.set(e.chatId, upd);
    }
  }

  /**
   * 会话记录出现 [Request interrupted by user：bridge 近几秒没发过键 = 人在终端里自己打断的——记一条「停」类 cut（不提醒、Autopilot 不推进）。
   * CC 这时不发 Stop，事件态会卡在 thinking：之后没有新消息投进来，就顺手收成 done。
   */
  private async onTranscriptInterrupt(e: CutEvent & { chatId: string; agent: string }): Promise<void> {
    const at = Date.parse(String(e.data.ts ?? "")) || Date.parse(e.ts) || this.now(); // 那一行写进会话记录的时刻（watcher 约 2 秒后才读到）
    if (this.keySentWithin(e.chatId, at)) return;
    if (await this.programKeyNear(e.agent, at)) return;
    console.log(`⏹ ${e.agent} 在终端里被人打断（bridge 没发键）：记为叫停`);
    this.record({ channelId: e.chatId, agent: e.agent, cause: "terminal", tools: inflightTools(e.agent) });
    if ((this.deliveredAt.get(e.chatId) ?? 0) <= at) emitEvent({ agent: e.agent, chatId: e.chatId, type: "agent_status", data: { status: "done", trigger: "terminal_interrupt" } });
  }

  /** 程序（任何进程：Esc 护栏、manager 清场的 C-c、tmux-send-keys）刚往这个 agent 窗口发过键：at 时刻的打断不是人在终端里按的 */
  async programKeyNear(agent: string, at: number): Promise<boolean> {
    return isProgramKey(await this.programKeys(agent).catch(() => []), at); // 读不到就当没发过：最坏把程序的键记成一次叫停，和改之前一样
  }

  /** 会话记录里一条终端输入：终端前的就是 owner（不是停就解除「已叫停」）——除非是程序敲进去的（cron、manager tmux-send-keys） */
  private async onTerminalInput(e: CutEvent & { chatId: string; agent: string }): Promise<void> {
    const at = Date.parse(String(e.data.ts ?? "")) || Date.parse(e.ts) || this.now();
    if (isProgramText(await this.programKeys(e.agent).catch(() => []), at, String(e.data.h ?? ""))) return; // 读不到就当人打的
    this.noteHuman(e.chatId, e.data.stop === true);
  }

  /**
   * 过期很久的记录（agent 早被 kill 的频道）不留在盘上。叫停记录只清已解除、且解除超过押后上限（24 小时）的：
   * 押后的消息靠 stoppedAt 判「是不是叫停之前押的」，押得再久也不会超过这个上限；还没解除的一直留着（Autopilot 要等 owner 开口）
   */
  private prune(now: number): void {
    for (const [ch, c] of this.cuts) if (now - c.at > CUT_TTL_MS * 4) this.cuts.delete(ch);
    for (const [ch, s] of this.stops) if (s.goAt !== undefined && now - s.goAt > HELD_GIVE_UP_MS) this.stops.delete(ch);
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

/** agent 名 → tmux 窗口（大总管 "master" / "0" 不在 registry 的普通条目里，是 master:0） */
export const agentWindow = (agent: string) => (agent === "master" || agent === "0" ? `${MASTER_SESSION}:0` : windowTarget(agent));
const programKeys = async (agent: string): Promise<ProgramInput[]> => {
  const win = agentWindow(agent);
  return [{ at: await tmuxSendEscape.lastSentAt(win), h: "" }, ...(await programInputsOf(win))];
};
export const turnCuts = new TurnCuts(undefined, undefined, programKeys);
subscribeEvents({}, (e) => turnCuts.onEvent(e));

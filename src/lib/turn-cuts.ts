/**
 * 打断记录（cut）的纯逻辑：从事件流找被砍断的工具、连环打断挂链、续做检测、Stop 后要不要提醒，以及给 agent 的两段文案。
 * 只提醒、不重放：续做与否由 agent 自己判断，「停」（停字 / 停止按钮）压掉提醒，30 分钟没动静就过期。
 * 接线（落盘、订阅事件、记送达和回复）在 bridge/turn-cuts.ts；单测 tests/turn-cuts.test.ts。
 */
import { bashCommandOf, classifyTool, heavier, sideEffectLabel, type SideEffect, type SideEffectVerdict } from "./side-effects.js";
import { inputHash } from "./program-input.js";
import { matchStopWord } from "./stop-words.js";
import { neutralizeDelegateMarker } from "./delegate-marker.js";

/** terminal：人在 CC 终端里自己按了打断（会话记录出现 [Request interrupted by user，而 bridge 没发过键） */
export type CutCause = "preempt" | "manual" | "stopword" | "codex_interrupt" | "terminal";
type CutState = "open" | "resumed" | "stopped" | "hinted" | "expired";

export interface CutTool {
  toolId: string;
  name: string;
  summary: string;
  /** Bash 的命令原文 / send_to_agent 的 target：分类与续做比对用 */
  command?: string;
  startedAt: number;
}

/** 被打断的回合当时在处理谁的什么（按频道记的最后一条入站） */
export interface TurnTrigger {
  messageId: string;
  fromKind: string;
  fromName: string;
  excerpt: string;
  /** 这条消息的回信地址（meta.chat_id）：判「还没回复」用 */
  replyTo: string;
  at: number;
}

export interface Cut {
  id: string;
  agent: string;
  channelId: string;
  runtime?: string;
  at: number;
  cause: CutCause;
  byMessageId?: string;
  byName?: string;
  turnTrigger?: TurnTrigger;
  /** 同一回合里先后送到、也还等着处理的其它消息（语音连发：抢占冷却期内的补充不会打断，但同样没答） */
  alsoPending?: TurnTrigger[];
  inflight: CutTool[];
  lastDone?: { name: string; summary: string };
  sideEffect: SideEffect;
  checkHint?: string;
  state: CutState;
  /** 打断它的那条消息真正送达的时刻：只有之后的 Stop 才是「插话那一回合结束」 */
  deliveredAt?: number;
  /** 这一段被砍的工具 agent 已经重跑过（连环打断时逐段记，全部续上才算整条 resumed） */
  resumed?: boolean;
  /** 之前还没收尾的 cut（按先后，已摊平） */
  chain: Cut[];
}

/** event-bus 事件里用得到的部分 */
export interface CutEvent {
  type: string;
  ts: string;
  data: Record<string, unknown>;
}

export const CUT_TTL_MS = 30 * 60_000;

/** 会话记录（CC jsonl）里的一条 user 记录 */
export interface TranscriptUserEntry {
  isMeta?: boolean;
  isCompactSummary?: boolean;
  origin?: { kind?: string } | string;
  message?: { content?: unknown };
}

/**
 * 会话记录里的 user 记录对打断记录有没有意义：打断标记（[Request interrupted by user，终端里按的或 bridge 发的键），
 * 或人在终端里敲的新输入（「停」之后又开口了，Autopilot 可以接着推进；敲的是停字就不算）。
 * 真实输入 = 不是 meta / compact 续写、来源不是 channel 注入 / 后台通知 / 自动续跑、没有工具结果、不是斜杠命令或 <标签> 包着的系统文本。
 * 只认 Claude Code：Pi / Codex 的会话记录里 bridge 投进去的消息就是普通 user 文本（带不带来源头都有），分不出是不是终端里敲的——
 * 当成「开口了」会让外源消息解开 owner 的「停」。单测 tests/turn-cuts.test.ts。
 */
export function transcriptUserEvent(
  e: TranscriptUserEntry, runtime?: string,
): { type: "turn_interrupted" | "terminal_input"; data: { stop?: boolean; h?: string }; transient?: true } | null {
  const content = e.message?.content;
  const blocks = Array.isArray(content) ? (content as { type?: string; text?: string }[]) : null;
  const text = typeof content === "string" ? content : blocks ? blocks.map((b) => (b?.type === "text" ? (b.text ?? "") : "")).join("") : "";
  if (text.startsWith("[Request interrupted by user")) return { type: "turn_interrupted", data: {} };
  const origin = typeof e.origin === "object" ? e.origin?.kind : e.origin;
  if (e.isMeta || e.isCompactSummary || (origin && origin !== "human") || blocks?.some((b) => b?.type === "tool_result")) return null;
  const t = text.trim();
  if ((runtime && runtime !== "claude-code") || !t || /^<|^\/[\w:.-]+(\s|$)/.test(t)) return null; // 标签、斜杠命令（「/Users/x/a.log 看下」不算）
  // h = 正文指纹：bridge 拿它对程序敲过的字（lib/program-input.ts）。不进事件环：只给打断记录用
  return { type: "terminal_input", data: { stop: matchStopWord(t).stop, h: inputHash(t) }, transient: true };
}
const CHAIN_MAX = 5;

const str = (x: unknown) => (typeof x === "string" ? x : "");

function toolOf(e: CutEvent): CutTool {
  const name = str(e.data.name);
  const detail = str(e.data.detail);
  const command = name === "Bash" ? bashCommandOf(detail) : name.endsWith("send_to_agent") ? (detail.match(/^→ (\S+)/)?.[1] ?? "") : undefined;
  return { toolId: str(e.data.toolId), name, summary: str(e.data.summary), ...(command !== undefined ? { command } : {}), startedAt: Date.parse(e.ts) || 0 };
}

/** 本回合（最后一次 done 之后）有 tool_start、没有 tool_done 的工具，以及最后一个正常做完的工具 */
export function inflightFrom(events: readonly CutEvent[]): { inflight: CutTool[]; lastDone?: { name: string; summary: string } } {
  let start = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === "agent_status" && events[i].data.status === "done") {
      start = i + 1;
      break;
    }
  }
  const open = new Map<string, CutTool>();
  let lastDone: { name: string; summary: string } | undefined;
  for (const e of events.slice(start)) {
    if (e.type === "tool_start") {
      const t = toolOf(e);
      if (t.toolId) open.set(t.toolId, t);
    } else if (e.type === "tool_done") {
      const t = open.get(str(e.data.toolId));
      if (!t) continue;
      open.delete(t.toolId);
      if (!e.data.error) lastDone = { name: t.name, summary: t.summary };
    }
  }
  return { inflight: [...open.values()], ...(lastDone ? { lastDone } : {}) };
}

/**
 * Codex 的会话记录翻译过来只在命令**跑完**时才有一条 tool_use（没有 tool_done、跑着的看不到）：
 * 不能用 inflightFrom（会把跑完的全当成被砍的）。只取本回合最后一条当「做到了」，被砍的那条如实写看不到。
 */
export function completedOnlyFrom(events: readonly CutEvent[]): { inflight: CutTool[]; lastDone?: { name: string; summary: string } } {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === "agent_status" && e.data.status === "done") break;
    if (e.type === "tool_start") return { inflight: [], lastDone: { name: str(e.data.name), summary: str(e.data.summary) } };
  }
  return { inflight: [] };
}

function verdictOf(tools: readonly CutTool[], extraExternal?: readonly string[]): SideEffectVerdict {
  let out: SideEffectVerdict = { kind: "none" };
  for (const t of tools) out = heavier(out, classifyTool(t.name, { command: t.command, target: t.command, extraExternal }));
  return out;
}

export type NewCutInput = Pick<Cut, "id" | "agent" | "channelId" | "runtime" | "at" | "cause" | "byMessageId" | "byName" | "turnTrigger" | "alsoPending"> & {
  /** inflightFrom 的结果（bridge 从 event-bus 的 inflightTools 取） */
  tools: { inflight: CutTool[]; lastDone?: { name: string; summary: string } };
  extraExternal?: readonly string[];
};

/**
 * 新建一条 cut，把这个 agent 上一条还开着的挂进 chain（连环打断：打断之后插话那一回合又被打断）。
 * 「停」类（手动 / 停字 / 终端里自己按的 Esc）一出生就是 stopped，并且把之前没收尾的一起压掉。
 */
export function makeCut(i: NewCutInput, prev?: Cut): Cut {
  const { inflight, lastDone } = i.tools;
  const verdict = verdictOf(inflight, i.extraExternal);
  const stop = i.cause !== "preempt";
  const older = prev && prev.state === "open" && i.at - prev.at < CUT_TTL_MS ? [...prev.chain, { ...prev, chain: [] }].slice(-CHAIN_MAX) : [];
  return {
    id: i.id, agent: i.agent, channelId: i.channelId, ...(i.runtime ? { runtime: i.runtime } : {}), at: i.at, cause: i.cause,
    ...(i.byMessageId ? { byMessageId: i.byMessageId } : {}), ...(i.byName ? { byName: i.byName } : {}),
    ...(i.turnTrigger ? { turnTrigger: i.turnTrigger } : {}), ...(i.alsoPending?.length ? { alsoPending: i.alsoPending } : {}),
    inflight, ...(lastDone ? { lastDone } : {}), sideEffect: verdict.kind, ...(verdict.hint ? { checkHint: verdict.hint } : {}),
    state: stop ? "stopped" : "open",
    chain: stop ? [] : older,
  };
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * 打断之后又出现同名同内容的工具调用（不是被砍的那一次本身）= agent 把那一段续上了。连环打断逐段记：
 * 只有每一段都续上，整条才是 resumed；否则提醒里只列还没续上的段。没有在跑工具的段（砍在思考 / 出字）认不出续没续，一直算没续。
 * 返回更新后的 cut；没有新续上的段返回 null。
 */
export function resumeBy(cut: Cut, e: CutEvent): Cut | null {
  if (e.type !== "tool_start") return null;
  const t = toolOf(e);
  const hit = (c: Cut) => !c.resumed && c.inflight.some((x) => x.toolId !== t.toolId && x.name === t.name
    && (x.command !== undefined ? norm(x.command) === norm(t.command ?? "") : x.summary === t.summary));
  const chain = cut.chain.map((c) => (hit(c) ? { ...c, resumed: true } : c));
  const self = hit(cut);
  if (!self && chain.every((c, k) => c === cut.chain[k])) return null;
  const next = { ...cut, chain, ...(self ? { resumed: true } : {}) };
  return [next, ...chain].every((c) => c.resumed) ? { ...next, state: "resumed" } : next;
}

/**
 * 打断前一两秒刚跑完的工具：watcher 约 2 秒一轮，快照里它还「在跑」。之后到的**成功** tool_done 说明它没被砍（被砍的 CC 会写出错结果），
 * 从 inflight 里摘掉、记成「做到了」。只认打断后几秒内到的。
 */
export function settleBy(cut: Cut, done: CutEvent, windowMs = 8_000): Cut | null {
  if (done.type !== "tool_done" || done.data.error || (Date.parse(done.ts) || 0) - cut.at > windowMs) return null;
  const hit = cut.inflight.find((t) => t.toolId === str(done.data.toolId));
  if (!hit) return null;
  const inflight = cut.inflight.filter((t) => t !== hit);
  const verdict = verdictOf(inflight);
  const { checkHint: _drop, ...rest } = cut;
  return { ...rest, inflight, lastDone: { name: hit.name, summary: hit.summary }, sideEffect: verdict.kind, ...(verdict.hint ? { checkHint: verdict.hint } : {}) };
}

/** cut 刚记下时 watcher 可能还没读到刚起的工具（约 2 秒轮询）：打断后几秒内出现的出错 tool_done 补进 inflight */
export function lateInflight(cut: Cut, start: CutEvent | undefined, done: CutEvent, windowMs = 8_000): Cut | null {
  if (!start || done.type !== "tool_done" || !done.data.error) return null;
  const t = toolOf(start);
  if (!t.toolId || cut.inflight.some((x) => x.toolId === t.toolId)) return null;
  if ((Date.parse(done.ts) || 0) - cut.at > windowMs || t.startedAt > cut.at + 1_000) return null;
  const inflight = [...cut.inflight, t];
  const verdict = verdictOf(inflight);
  return { ...cut, inflight, sideEffect: verdict.kind, ...(verdict.hint ? { checkHint: verdict.hint } : {}) };
}

export type StopDecision = "hint" | "expire" | "none";

/** 回合 Stop 时怎么处理这条 cut：只在「打断它的消息送达之后」的正常 Stop 提醒一次；StopFailure（打断 / API 错误）不算 */
export function onStop(cut: Cut, event: string, now: number): StopDecision {
  if (cut.state !== "open") return "none";
  if (now - cut.at > CUT_TTL_MS) return "expire";
  if (event !== "Stop" || cut.deliveredAt === undefined || now < cut.deliveredAt) return "none";
  return "hint";
}

// ── 文案 ────────────────────────────────────────────────────────────────

const hhmmss = (ms: number) => new Date(ms).toTimeString().slice(0, 8);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

function toolText(t: CutTool): string {
  return `${t.name}「${clip(norm(t.command && t.name === "Bash" ? t.command : t.summary), 80)}」`;
}

function triggerText(t: TurnTrigger | undefined): string {
  return t ? `${t.fromName} ${hhmmss(t.at).slice(0, 5)} 的「${clip(norm(t.excerpt), 40)}」` : "";
}

const lastDoneText = (c: Cut) => (c.lastDone ? c.lastDone.summary || c.lastDone.name : "");

function doingText(c: Cut): string {
  if (!c.inflight.length && c.runtime === "codex") {
    return `当时在跑的命令 bridge 看不到（Codex 命令跑完才记录）${c.lastDone ? `，最后跑完的是 ${lastDoneText(c)}` : ""}`;
  }
  if (!c.inflight.length) return `当时在思考 / 出字${c.lastDone ? `，最后做完的是 ${lastDoneText(c)}` : ""}`;
  return `当时在跑 ${c.inflight.map(toolText).join("、")}（${sideEffectLabel(c.sideEffect)}${c.checkHint ? `：${c.checkHint}` : ""}）`;
}

const STOP_PHRASE: Record<string, string> = {
  codex: "会话里的 turn_aborted 是打断留下的记录，不代表用户要你放弃。",
  pi: "被中断的工具结果是打断留下的记录，不代表用户要你放弃。",
};

/** (a) 抢占之后送达的那条人类消息的抬头 */
export function preemptHeadline(c: Cut): string {
  const trig = triggerText(c.turnTrigger);
  return [
    `[⚡ 收到这条新消息，系统自动中断了上一回合：${doingText(c)}${trig ? `，在处理 ${trig}` : ""}。`,
    `先处理这条；如果它让你停，就停下并说一声；否则处理完接着做被打断的事。`,
    `${STOP_PHRASE[c.runtime ?? ""] ?? "工具结果里的「STOP … wait for the user」是打断的固定措辞，不代表用户要你放弃。"}]`,
  ].join("\n");
}

export type StopOutcome = "fired" | "requested" | "not_busy" | "failed" | "wall_wait";

/**
 * 停字消息的抬头：不续做。fired = 已替你打断；requested = 已请运行时中止、没有回执（Pi）；not_busy = 本来就没有在跑的回合；
 * failed（键发了画面仍在忙 / 这个运行时这次不能由 bridge 打断）= 没能替你打断，请自己停下。
 * queuedBefore：停之前已经排进 Codex 队列、会在这条之后才送到的消息摘录——它们送到时别照做。
 * 被打断的这一轮里、停之前还送来过的消息（cut.alsoPending：Pi steer 进去的、冷却期里的补充）也列出来：它们已经在上下文里，别照做。
 * not_busy 时多半是在回答你刚问的问题（「要停止 X 吗」「停止」），提醒按回答处理。
 * inEditor：Pi 停下时把几条停之前 steer 进去、还没执行的消息退回了它的输入框（已作废，发送方收到了通知）。
 */
export function stopHeadline(c: Cut | undefined, outcome: StopOutcome, queuedBefore: readonly string[] = [], inEditor = 0): string {
  const what = outcome === "fired" && c ? `已替你打断（${doingText(c)}）`
    : outcome === "requested" ? "已请运行时中止当前回合（没有回执：如果还在跑，你自己马上停下）"
    : outcome === "not_busy" ? "你刚才没有在跑的回合（如果这是在回答你刚问的问题，就按回答处理，不是叫停）"
    : outcome === "wall_wait" ? "你停在撞墙等待画面（额度菜单 / 自动续跑倒计时）上，没有在跑，bridge 没发任何键；到点自动续跑的那一轮也别接着做"
    : "bridge 没能替你打断，请你自己马上停下手上的事";
  const queued = queuedBefore.length
    ? `\n停之前还有 ${queuedBefore.length} 条消息排在队列里、会在这条之后送到（${queuedBefore.map((q) => `「${clip(norm(q), 30)}」`).join("、")}）：它们是停之前发的，送到时先别照做，问用户还要不要。`
    : "";
  const also = c?.alsoPending?.length
    ? `\n这一轮里停之前还送来过 ${c.alsoPending.map((t) => `「${clip(norm(t.excerpt), 30)}」`).join("、")}：也是停之前发的，先别照做，问用户还要不要。`
    : "";
  const editor = inEditor ? `\nPi 输入框里退回了 ${inEditor} 条停之前送到的消息，未执行（已作废，发送方已收到通知）：别照做，也别替用户提交。` : "";
  return `[⏹ 这是一条「停」指令：${what}。停下手上的事，简短确认已停；不要续做被打断的事，除非用户之后再让你做。${queued}${also}${editor}]`;
}

/** Pi 的停字自己的 API 同步等待超时拿到的答复（bridge/pi-abort.ts holdStopWait）：照实写中止回执，它还没回这条「停」 */
export function stopWaitReply(agent: string, outcome: StopOutcome): string {
  const what = outcome === "fired" ? "Pi 回执：已中止当前回合"
    : outcome === "requested" ? "已请 Pi 中止当前回合，没等到回执"
    : outcome === "not_busy" ? "它本来就空闲，没有在跑的回合"
    : outcome === "wall_wait" ? "它停在撞墙等待画面上，没有在跑，没发键"
    : "中止没发出去，它可能还在跑";
  return `[⏹ bridge] 已叫停 ${agent}：${what}。它还没回这条「停」，之后的回复见对话。`;
}

/** 押在撞墙等待画面上的「停」晚投时，owner 在那之后已经又开过口（答卡片 / 说话）：这条作废，按 owner 后来的话做。interrupted = 键在 owner 开口之前已经发出去了 */
export function staleStopNote(stopAt: number, interrupted: boolean, held = true): string {
  const cut = interrupted ? "它送到时打断了当时在跑的回合；" : "";
  const when = held ? `是 ${hhmmss(stopAt).slice(0, 5)} 押在等待画面上的，押到现在才送到` : `（${hhmmss(stopAt).slice(0, 5)}）还没生效`;
  return `[⏹ 这条「停」${when}；${cut}用户之后又开过口，这条已作废，照用户后来的话做，不用停。]`;
}

/** 同上，给停字自己的 API 同步等待（Pi）的答复 */
export function staleStopReply(agent: string, interrupted: boolean): string {
  return `[⏹ bridge] 这条「停」生效之前你又开过口，已作废：${interrupted ? `送到时打断了 ${agent} 当时在跑的回合` : `没有打断 ${agent}`}。`;
}

/**
 * 叫停之前到、叫停之后才送到的消息（忙时作答的 ask 答复、agent 请求、传图慢的「继续」）的抬头：它不是「停之后用户又让你做」。
 * heldAt = 押下的时刻；不是押后队列来的不给（到达时刻没记，只说晚到了）
 */
export function heldAcrossStopNote(heldAt: number | undefined, stopAt: number): string {
  const how = heldAt === undefined ? "发来的，停之后才送到" : `（${hhmmss(heldAt).slice(0, 5)}）发来的，押到现在才送到`;
  return `[⏹ 这条是叫停之前${how}；用户 ${hhmmss(stopAt).slice(0, 5)} 叫停过。它不是停之后又让你做的事：先别照做，问用户还要不要。]`;
}

/**
 * 把抬头放进 renderContentForLocal 渲染好的正文：有来源头（[🌐 …] / [🤝 …]）就插在它后面，没有就放最前。
 * 抬头自成一块、以「]」+ 空行收尾，历史解析（session-history stripChannelHeader）能逐块剥掉，网页不会把它当成用户原话。
 * 抬头里摘录了别人（访客、peer、agent）的话，拼进 owner 的消息前先中和委托标记（lib/delegate-marker.ts），不然摘录能冒充「用户委托」。
 */
export function withInterruptNote(rendered: string, note: string): string {
  const safe = neutralizeDelegateMarker(note);
  const m = /^\[(🌐|🤖|🤝|📢|📣)[\s\S]*?\]\n\n/.exec(rendered);
  return m ? `${m[0]}${safe}\n\n${rendered.slice(m[0].length)}` : `${safe}\n\n${rendered}`;
}

/** 被打断时在处理的人类消息回过没有：never = 送达以来一次都没回过这个地址；after_cut = 只在打断之后回过（可能答的是插话） */
export type ReplyState = "replied" | "never" | "after_cut";

/** (b) 插话那一回合 Stop 之后的收尾提醒：只列还没续上的段；每段在处理的消息（含同回合连发的补充）逐条看回没回 */
export function resumeNotice(c: Cut, replyState: (seg: Cut, t: TurnTrigger) => ReplyState): string {
  const segs = [...c.chain, { ...c, chain: [] }].filter((s) => !s.resumed);
  const block = (s: Cut) => {
    const cutLines = s.inflight.length
      ? s.inflight.map((t) => {
          const v = classifyTool(t.name, { command: t.command, target: t.command });
          return `· 被砍断：${toolText(t)}——${sideEffectLabel(v.kind)}${v.hint ? `：${v.hint}` : ""}`;
        })
      : [s.runtime === "codex" ? "· 被砍断：看不到是哪条命令（Codex 命令跑完才记录），先查进程和最后一步的结果" : "· 被砍断：当时在思考 / 出字，没有在跑的工具"];
    const lines = [...cutLines];
    if (s.lastDone) lines.push(`· 做到了：${lastDoneText(s)}`);
    const trigs = [s.turnTrigger, ...(s.alsoPending ?? [])].filter((t): t is TurnTrigger => !!t);
    const states = trigs.map((t) => ({ t, rs: replyState(s, t) }));
    const never = states.filter((x) => x.rs === "never").map((x) => triggerText(x.t));
    const later = states.filter((x) => x.rs === "after_cut").map((x) => triggerText(x.t));
    lines.push(`· 还没回复：${never.length ? never.join("、") : "无"}`);
    if (later.length) lines.push(`· 回复：打断之后你往同一个地址回过话，核对一下有没有答到 ${later.join("、")}，答过就别重复`);
    const trig = triggerText(s.turnTrigger);
    const head = `${hhmmss(s.at)} 你${trig ? `在处理 ${trig} 时` : ""}被${s.byName ? ` ${s.byName} 的` : ""}新消息打断：`;
    return [head, ...lines].join("\n");
  };
  const body = segs.length === 1 ? `[⏯ 打断收尾] ${block(segs[0])}` : `[⏯ 打断收尾] 连续被打断 ${segs.length} 次（按先后）：\n${segs.map((s, i) => `${i + 1}. ${block(s)}`).join("\n")}`;
  const warn: string[] = [];
  const worst = segs.reduce<SideEffect>((w, s) => (heavier({ kind: w }, { kind: s.sideEffect }).kind), "none");
  if (worst === "external") warn.push("⚠ 对外 / 不可逆：先核对现状，再决定要不要做，不要直接重跑。");
  if (c.runtime === "codex") warn.push("⚠ Codex 提示被中断的命令可能还在后台跑，先查进程或锁。");
  return [body, ...warn, "除非用户让你停，否则接着做。已经做完或决定不做，就忽略这条，不用回复。"].join("\n");
}

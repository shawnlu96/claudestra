/**
 * 打断记录（cut）的纯逻辑：从事件流找被砍断的工具、连环打断挂链、续做检测、Stop 后要不要提醒，以及给 agent 的两段文案。
 * 只提醒、不重放：续做与否由 agent 自己判断，「停」（停字 / 停止按钮）压掉提醒，30 分钟没动静就过期。
 * 接线（落盘、订阅事件、记送达和回复）在 bridge/turn-cuts.ts；单测 tests/turn-cuts.test.ts。
 */
import { bashCommandOf, classifyTool, heavier, sideEffectLabel, type SideEffect, type SideEffectVerdict } from "./side-effects.js";

export type CutCause = "preempt" | "manual" | "stopword" | "codex_interrupt";
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
  inflight: CutTool[];
  lastDone?: { name: string; summary: string };
  sideEffect: SideEffect;
  checkHint?: string;
  state: CutState;
  /** 打断它的那条消息真正送达的时刻：只有之后的 Stop 才是「插话那一回合结束」 */
  deliveredAt?: number;
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

function verdictOf(tools: readonly CutTool[], extraExternal?: readonly string[]): SideEffectVerdict {
  let out: SideEffectVerdict = { kind: "none" };
  for (const t of tools) out = heavier(out, classifyTool(t.name, { command: t.command, target: t.command, extraExternal }));
  return out;
}

export type NewCutInput = Pick<Cut, "id" | "agent" | "channelId" | "runtime" | "at" | "cause" | "byMessageId" | "byName" | "turnTrigger"> & {
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
    ...(i.turnTrigger ? { turnTrigger: i.turnTrigger } : {}),
    inflight, ...(lastDone ? { lastDone } : {}), sideEffect: verdict.kind, ...(verdict.hint ? { checkHint: verdict.hint } : {}),
    state: stop ? "stopped" : "open",
    chain: stop ? [] : older,
  };
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

/** 打断之后又出现同名同内容的工具调用（不是被砍的那一次本身）= agent 自己续上了 */
export function isResumedBy(cut: Cut, e: CutEvent): boolean {
  if (cut.state !== "open" || e.type !== "tool_start") return false;
  const t = toolOf(e);
  const segs = [cut, ...cut.chain];
  return segs.some((c) =>
    c.inflight.some((x) => x.toolId !== t.toolId && x.name === t.name && (x.command !== undefined ? norm(x.command) === norm(t.command ?? "") : x.summary === t.summary)),
  );
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

function doingText(c: Cut): string {
  if (!c.inflight.length) return `当时在思考 / 出字${c.lastDone ? `，最后做完的是 ${c.lastDone.summary || c.lastDone.name}` : ""}`;
  return `当时在跑 ${c.inflight.map(toolText).join("、")}（${sideEffectLabel(c.sideEffect)}）`;
}

const STOP_PHRASE: Record<string, string> = {
  codex: "会话里的 turn_aborted 是打断留下的记录，不代表用户要你放弃。",
  pi: "被中断的工具结果是打断留下的记录，不代表用户要你放弃。",
};

/** (a) 抢占之后送达的那条人类消息的抬头 */
export function preemptHeadline(c: Cut): string {
  const trig = triggerText(c.turnTrigger);
  return [
    `[⚡ 这条消息打断了你：${doingText(c)}${trig ? `，在处理 ${trig}` : ""}。`,
    `先处理这条；如果它让你停，就停下并说一声；否则处理完接着做被打断的事。`,
    `${STOP_PHRASE[c.runtime ?? ""] ?? "工具结果里的「STOP … wait for the user」是打断的固定措辞，不代表用户要你放弃。"}]`,
  ].join("\n");
}

/** 停字消息的抬头：已打断（或本来就空闲）、不续做；停字后面还有话就照常处理 */
export function stopHeadline(c: Cut | undefined, rest: string): string {
  const what = c ? `已替你打断（${doingText(c)}）` : "你刚才没有在跑的回合";
  return rest
    ? `[⏹ 这条以「停」开头：${what}。不要续做被打断的事，除非用户之后再让你做；停字后面的话照常处理。]`
    : `[⏹ 这是一条「停」指令：${what}。停下手上的事，简短确认已停；不要续做被打断的事，除非用户之后再让你做。]`;
}

/**
 * 把抬头放进 renderContentForLocal 渲染好的正文：有来源头（[🌐 …] / [🤝 …]）就插在它后面，没有就放最前。
 * 抬头自成一块、以「]」+ 空行收尾，历史解析（session-history stripChannelHeader）能逐块剥掉，网页不会把它当成用户原话。
 */
export function withInterruptNote(rendered: string, note: string): string {
  const m = /^\[(🌐|🤖|🤝|📢|📣)[\s\S]*?\]\n\n/.exec(rendered);
  return m ? `${m[0]}${note}\n\n${rendered.slice(m[0].length)}` : `${note}\n\n${rendered}`;
}

/** (b) 插话那一回合 Stop 之后的收尾提醒。unreplied：各段被打断时在处理、但还没回过的人类消息 */
export function resumeNotice(c: Cut, unreplied: (seg: Cut) => boolean): string {
  const segs = [...c.chain, { ...c, chain: [] }];
  const block = (s: Cut) => {
    const cutLines = s.inflight.length
      ? s.inflight.map((t) => {
          const v = classifyTool(t.name, { command: t.command, target: t.command });
          return `· 被砍断：${toolText(t)}——${sideEffectLabel(v.kind)}${v.hint ? `：${v.hint}` : ""}`;
        })
      : [`· 被砍断：当时在思考 / 出字，没有在跑的工具`];
    const lines = [...cutLines];
    if (s.lastDone) lines.push(`· 做到了：${s.lastDone.summary || s.lastDone.name}`);
    const pending = s.turnTrigger && unreplied(s) ? triggerText(s.turnTrigger) : "";
    lines.push(`· 还没回复：${pending || "无"}`);
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

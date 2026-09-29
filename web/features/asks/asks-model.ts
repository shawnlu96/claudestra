/**
 * 「待你处理」网页侧的纯逻辑（单测 tests/web-asks-model.test.ts）：列表分组与计数、聊天气泡 ↔ ask 的对应、已答选项回填、时间文案。
 * 形状对应 bridge 的 src/lib/ledger-asks.ts（web 不能 import src，这里只取用到的字段）。
 */
import { uiAgentName } from "@/lib/chat/agents";
import type { WebComponentRow } from "@/lib/chat/events";
import { attachmentUrl, isImageName } from "@/lib/chat/attachments";
import { replyRowKey } from "@/lib/chat/reply-clicks";
import type { ChatMessage } from "@/features/chat/type";

/** superseded = 同一个 agent 同一件事又问了新的一版（授权参数变了），旧卡片失效 */
export type AskState = "open" | "answered" | "expired" | "cancelled" | "superseded";
/** 字段按卡片上的阅读顺序排（谁、问什么、怎么答、什么状态） */
export interface WebAsk {
  id: string;
  /** 人 / 系统发起的（指派事项、chat 审核）没有发起 agent */
  fromAgent: string | null;
  /** 指给谁（local:<principalId>）；指给自己的 guest 也看得到、答得了 */
  assignee?: string | null;
  createdBy?: string | null;
  project: string;
  taskId: string | null;
  title: string;
  context: string;
  body: string;
  kind: "decide" | "authorize" | "owner_action" | "accept" | "assigned";
  kindHint: string | null;
  source: "reply" | "auq" | "permission" | "codex" | "human" | "system";
  options: unknown[];
  allowText: boolean;
  blocking: boolean | null;
  urgency: "normal" | "urgent";
  state: AskState;
  /** 多行 reply 逐行作答时，state 仍是 open、这里是已答的部分 */
  answer: { choices: string[]; labels?: string[]; text: string; via: string; at: number } | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  /** 授权类：批的是哪个动作、哪组参数（卡片原样摆出来，owner 看清自己批准的是什么） */
  bind?: { action: string; params: unknown; version?: string } | null;
  /** 这个凭据能不能答这一条（bridge lib/ask-access.ts canAnswerAsk，列表逐行给）；老 bridge 不给 = 能答 */
  canAnswer?: boolean;
  /** files = 原消息带的附件（bridge 拷进 inbox 后的名字）；loc = 原消息在会话里的位置（定位过才有） */
  extra?: { files?: { name: string; attachment: string }[] };
}

/** 原消息带的附件 → 聊天附件条的形状（卡片上直接点开，走 T37 的预览层） */
export function askAttachments(a: Pick<WebAsk, "extra">): { name: string; kind: "image" | "file"; url: string }[] {
  return (a.extra?.files ?? []).map((f) => ({ name: f.name, kind: isImageName(f.attachment) ? "image" : "file", url: attachmentUrl(f.attachment) }));
}

/** 协作视图的「等你」：开着、非验收、没指给别人的（指给 guest 的指派事项是在等那个 guest，不是等 owner） */
export const waitsOnOwner = (a: Pick<WebAsk, "state" | "kind" | "assignee">): boolean =>
  a.state === "open" && a.kind !== "accept" && (!a.assignee || a.assignee === "local:owner:self");

export interface AskGroups {
  /** 等你拍板 / 授权 / 亲自处理的（按等待时长，久的在前） */
  waiting: WebAsk[];
  /** 待验收（不推送、只攒着） */
  accept: WebAsk[];
  /** 最近处理过 / 过期 / 撤销的（新的在前） */
  recent: WebAsk[];
}

/** 等你处理的排序：急的在前，卡活的其次，同一档里等得久的在前 */
const rank = (a: WebAsk) => (a.urgency === "urgent" ? 0 : a.blocking === true ? 1 : 2);

export function groupAsks(asks: WebAsk[]): AskGroups {
  const open = asks.filter((a) => a.state === "open").sort((x, y) => rank(x) - rank(y) || x.createdAt - y.createdAt);
  return {
    waiting: open.filter((a) => a.kind !== "accept"),
    accept: open.filter((a) => a.kind === "accept"),
    recent: asks.filter((a) => a.state !== "open").sort((x, y) => y.updatedAt - x.updatedAt),
  };
}

/** 侧栏入口上的数字：只数等你处理的（验收单独小字）；0 = 入口不亮 */
export function askCounts(asks: WebAsk[]): { waiting: number; accept: number } {
  const g = groupAsks(asks);
  return { waiting: g.waiting.length, accept: g.accept.length };
}

/** 卡片 / 横幅上给人看的名字：大总管不显示内部名；人 / 系统发起的没有 agent，按类型写「指派」「审核」 */
export function agentLabel(name: string | null, t: (s: string) => string, kind?: WebAsk["kind"]): string {
  if (!name) return kind === "assigned" ? t("指派") : t("审核");
  return name === "master" ? t("大总管") : uiAgentName(name);
}

/**
 * 作答分组（同 bridge 的 lib/ask-options.ts answerGroups）：每一行各一组——按钮行按行号，单选 / 多选按 id。
 * 多行 reply 逐行作答时，答过的行锁住、别的行照样能点；bridge 也按组判「这一项答过了」。
 */
export function rowGroup(row: WebComponentRow, ri: number): string {
  return row.type === "buttons" ? `buttons:${ri}` : `select:${row.id}`;
}

/** 已答的 wire 落在哪些组 */
export function answeredGroups(rows: WebComponentRow[], choices: string[]): Set<string> {
  const out = new Set<string>();
  for (const w of choices) {
    rows.forEach((r, ri) => {
      const hit = r.type === "buttons" ? r.buttons.some((b) => w === `[button:${b.id}]`) : w.startsWith(`[select:${r.id}:`);
      if (hit) out.add(rowGroup(r, ri));
    });
  }
  return out;
}

/** ask 里的是 bridge 名（master / agent-xxx），聊天里的是前端会话名：都换成前端名再比 */
export const sameAgent = (a: string, b: string) => uiAgentName(a) === uiAgentName(b);

/** 与键顺序无关的 JSON：历史接口按 agent 调用时的参数顺序给 components，ask 里存的是 bridge 收到时的顺序，两边不一定一致 */
function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v) ?? "null";
}

const buttonIds = (row: WebComponentRow | undefined) => (row?.type === "buttons" ? row.buttons.map((b) => b.id).join(",") : "");

/**
 * 这个聊天气泡是哪条 ask 建出来的：气泡带 askId（出站事件 / 历史里 reply 的 tool_result）就只按 id 认。
 * 没带的（老消息、历史尾读跨了窗口）才按形状对：同一个 agent、ask 的选项以气泡的 components 开头，行内按钮合成的那一行排在后面（按 id 对），
 * 复用同一组按钮时取建立时间离气泡最近的一条（两分钟内）；授权类不这样猜——认错了会带着新参数那条的 id 去批（bridge 同样一律 409）。
 */
export function askForReply(asks: WebAsk[], agent: string, rows: WebComponentRow[] | undefined, replyTs?: string, inlineIds: string[] = [], askId?: string): WebAsk | null {
  const block = rows ?? [];
  if ((!block.length && !inlineIds.length) || !agent) return null;
  if (askId) return asks.find((a) => a.id === askId) ?? null;
  const at = replyTs ? Date.parse(replyTs) : NaN;
  let best: WebAsk | null = null;
  for (const a of asks) {
    if (a.bind || !sameShape(a, agent, block, inlineIds)) continue;
    if (Number.isFinite(at) && Math.abs(a.createdAt - at) > 120_000) continue;
    if (!best || (Number.isFinite(at) && Math.abs(a.createdAt - at) < Math.abs(best.createdAt - at))) best = a;
    else if (!Number.isFinite(at) && a.createdAt > best.createdAt) best = a;
  }
  return best;
}

/** 这条 ask 是不是这个 agent 用这组按钮建的：选项以气泡的 components 开头，行内按钮合成的那一行排在后面（按 id 对） */
function sameShape(a: WebAsk, agent: string, block: WebComponentRow[], inlineIds: string[]): boolean {
  if (a.source !== "reply" || !a.fromAgent || !sameAgent(a.fromAgent, agent) || canon(a.options.slice(0, block.length)) !== canon(block)) return false;
  return !inlineIds.length || buttonIds(a.options[block.length] as WebComponentRow | undefined) === inlineIds.join(",");
}

/**
 * 气泡没认出 ask（老消息没带 id、带的 id 不在列表里），列表里却有同形状、开着的授权类：按钮锁住、提示去卡片上批（adv3 P2-2）。
 * 放开的话点下去 bridge 回 409，那一行却先被标成已点、消息标「未送达」，看着像点过了
 */
export function unclaimedBindAsk(asks: WebAsk[], agent: string, rows: WebComponentRow[] | undefined, inlineIds: string[] = []): WebAsk | null {
  if ((!rows?.length && !inlineIds.length) || !agent) return null;
  return asks.find((a) => a.bind && a.state === "open" && sameShape(a, agent, rows ?? [], inlineIds)) ?? null;
}

/** bridge 的「待你处理」列表只带开着的和 3 天内结案的（bridge/asks.ts 列表的 closedSince），两边一致 */
export const ASK_LIST_CLOSED_MS = 3 * 24 * 3600_000;

export interface ReplyAskState {
  ask: WebAsk | null;
  closed: WebAsk | null;
  orphan: WebAsk | null;
  gone: boolean;
  /** 点了也不发：closed / orphan / gone 任一 */
  blocked: boolean;
}

/**
 * 一个气泡的按钮对应哪条 ask、锁不锁（use-reply-ask.ts 的纯逻辑）：closed = 认出的 ask 已结案；orphan = 没认出、列表里有同形状开着的授权类；
 * gone = 气泡带 askId、列表已加载却查不到，且 reply 比列表保留期还旧——开着的 ask 一定在列表里，所以它早已结案、移出了列表。
 * gone 不锁的话点下去就是一条普通的 [button:…]，decide 类的 agent 会当成新答复（PR B r1 P2-2）；比保留期新的不算（刚建、列表还没刷到）。
 */
export function replyAskState(
  asks: WebAsk[], loaded: boolean, agent: string, m: Pick<ChatMessage, "replyComponents" | "replyTs" | "ts" | "replyAskId">, inlineIds: string[], now = Date.now(),
): ReplyAskState {
  const rows = m.replyComponents;
  const ask = askForReply(asks, agent, rows, m.replyTs ?? m.ts, inlineIds, m.replyAskId);
  const closed = ask && ask.state !== "open" ? ask : null;
  const orphan = ask ? null : unclaimedBindAsk(asks, agent, rows, inlineIds);
  const at = Date.parse(m.replyTs ?? m.ts ?? "");
  const gone = !!m.replyAskId && !ask && loaded && Number.isFinite(at) && now - at > ASK_LIST_CLOSED_MS;
  return { ask, closed, orphan, gone, blocked: !!closed || !!orphan || gone };
}

/** ask 的答案 → 气泡各行的已答值（与 reply-components 的 replyClicks 同形：按钮存 id，选单存 `<id>:<值>`） */
export function clicksFromAnswer(rows: WebComponentRow[], choices: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  rows.forEach((row, ri) => {
    const k = replyRowKey(row, ri);
    for (const w of choices) {
      if (row.type === "buttons") {
        const id = /^\[button:([\w:-]+)\]$/.exec(w)?.[1];
        if (id && row.buttons.some((b) => b.id === id)) out[k] = id;
      } else if (w.startsWith(`[select:${row.id}:`) && w.endsWith("]")) out[k] = w.slice("[select:".length, -1);
    }
  });
  return out;
}

/** wire → 人话（按钮文字 / 选中项文字，多选用「、」连）：乐观作答时卡片上「已答：…」先显示它，服务端的 labels 回来后以服务端为准 */
export function wireLabels(rows: WebComponentRow[], wires: string[]): string[] {
  return wires.map((w) => {
    const id = /^\[button:([\w:-]+)\]$/.exec(w)?.[1];
    for (const r of rows) {
      if (r.type === "buttons") {
        const b = id ? r.buttons.find((x) => x.id === id) : undefined;
        if (b) return b.label;
      } else if (w.startsWith(`[select:${r.id}:`) && w.endsWith("]")) {
        const vals = w.slice(`[select:${r.id}:`.length, -1).split(",");
        return vals.map((v) => r.options.find((o) => o.value === v)?.label ?? v).join("、");
      }
    }
    return w;
  });
}

/** 「12 分钟」「3 小时」「2 天」：等了多久 / 还剩多久都用它 */
export function spanText(ms: number, t: (s: string, p?: Record<string, string | number>) => string): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 1) return t("不到 1 分钟");
  if (m < 60) return t("{n} 分钟", { n: m });
  const h = Math.round(m / 60);
  return h < 48 ? t("{n} 小时", { n: h }) : t("{n} 天", { n: Math.round(h / 24) });
}

/** 已结案那一行的状态文案 */
export function closedText(a: WebAsk, t: (s: string, p?: Record<string, string | number>) => string): string {
  if (a.state === "answered") return t("已处理");
  if (a.state === "expired") return t("已过期，按未批准处理");
  if (a.state === "superseded") return t("已被新版本取代");
  return t("已撤销");
}

/** 答案的人话：bridge 记下的按钮 / 选项文字（老数据没有就退回 wire），再接上 owner 写的话 */
export function answerSummary(a: WebAsk): string {
  if (!a.answer) return "";
  const picked = a.answer.labels?.length ? a.answer.labels : a.answer.choices;
  return [...picked, a.answer.text ? `「${a.answer.text}」` : ""].filter(Boolean).join("；");
}

/**
 * 另一台设备：收到 SSE ask 事件后等这么久再重拉（一次作答会连着来几条事件，合成一次）。
 * 验收要求「另一台设备 2 秒内消失」：经中继的事件延迟 + 这个等待 + 一次拉取要在 2 秒里（tests/asks-relay-stream.test.ts）
 */
export const ASK_EVENT_REFRESH_MS = 300;

/** 乐观作答（T11b 第 8 条）：提交时本地先记一笔，服务端确认前盖在拉到的数据上 */
export interface PendingAnswer {
  /** 提交返回的时刻（还在飞时是点下去的时刻）：盖多久从这里算 */
  at: number;
  answer: NonNullable<WebAsk["answer"]>;
  /** 请求还没回来：不管多久都不撤（作答接口超时 60 秒，机器忙时拖过 20 秒也正常） */
  inFlight?: boolean;
}
/** 提交返回后盖这么久服务端还说开着：以服务端为准（提交其实没成、或 SSE / 拉取一直没回来），卡片回到「等你处理」 */
export const PENDING_MAX_MS = 20_000;

/**
 * 把乐观作答盖到服务端列表上：盖上的那条显示成已答（移出「等你处理」、计数减 1）。服务端已不是 open（确认了，或别处先答 / 过期）、
 * 列表里没有了、或盖太久了 → 放进 settled，调用方从待确认表里删掉，此后只看服务端
 */
export function applyPending(server: WebAsk[], pending: ReadonlyMap<string, PendingAnswer>, now: number): { asks: WebAsk[]; settled: string[] } {
  const settled = new Set<string>();
  const asks = server.map((a) => {
    const p = pending.get(a.id);
    if (!p) return a;
    if (a.state !== "open" || (!p.inFlight && now - p.at > PENDING_MAX_MS)) {
      settled.add(a.id);
      return a;
    }
    // 多行 reply 已答的那几行留着（聊天气泡的已答高亮从 answer.choices 推导）
    const had = a.answer;
    const answer = had ? { ...p.answer, choices: [...had.choices, ...p.answer.choices], labels: [...(had.labels ?? []), ...(p.answer.labels ?? [])] } : p.answer;
    return { ...a, state: "answered" as const, answer, updatedAt: p.at };
  });
  for (const id of pending.keys()) if (!server.some((a) => a.id === id)) settled.add(id);
  return { asks, settled: [...settled] };
}

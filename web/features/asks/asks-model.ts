/**
 * 「待你处理」网页侧的纯逻辑（单测 tests/web-asks-model.test.ts）：列表分组与计数、聊天气泡 ↔ ask 的对应、已答选项回填、时间文案。
 * 形状对应 bridge 的 src/lib/ledger-asks.ts（web 不能 import src，这里只取用到的字段）。
 */
import { uiAgentName } from "@/lib/chat/agents";
import type { WebComponentRow } from "@/lib/chat/events";
import { replyRowKey } from "@/lib/chat/reply-clicks";

export type AskState = "open" | "answered" | "expired" | "cancelled";
/** 字段按卡片上的阅读顺序排（谁、问什么、怎么答、什么状态） */
export interface WebAsk {
  id: string;
  fromAgent: string;
  project: string;
  taskId: string | null;
  title: string;
  context: string;
  body: string;
  kind: "decide" | "authorize" | "owner_action" | "accept";
  kindHint: string | null;
  source: "reply" | "auq" | "permission" | "codex";
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
}

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

/** 卡片 / 横幅上给人看的名字：大总管不显示内部名 */
export function agentLabel(name: string, t: (s: string) => string): string {
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

/**
 * 这个聊天气泡是哪条 ask 建出来的：同一个 agent、ask 的选项以气泡的 components 开头（行内按钮排在后面）；
 * agent 复用同一组按钮时取建立时间离气泡最近的一条（两分钟内），对不上就当没有。
 */
export function askForReply(asks: WebAsk[], agent: string, rows: WebComponentRow[] | undefined, replyTs?: string): WebAsk | null {
  if (!rows?.length || !agent) return null;
  const want = canon(rows);
  const at = replyTs ? Date.parse(replyTs) : NaN;
  let best: WebAsk | null = null;
  for (const a of asks) {
    if (a.source !== "reply" || !sameAgent(a.fromAgent, agent)) continue;
    if (canon(a.options.slice(0, rows.length)) !== want) continue;
    if (Number.isFinite(at) && Math.abs(a.createdAt - at) > 120_000) continue;
    if (!best || (Number.isFinite(at) && Math.abs(a.createdAt - at) < Math.abs(best.createdAt - at))) best = a;
    else if (!Number.isFinite(at) && a.createdAt > best.createdAt) best = a;
  }
  return best;
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
  return t("已撤销");
}

/** 答案的人话：bridge 记下的按钮 / 选项文字（老数据没有就退回 wire），再接上 owner 写的话 */
export function answerSummary(a: WebAsk): string {
  if (!a.answer) return "";
  const picked = a.answer.labels?.length ? a.answer.labels : a.answer.choices;
  return [...picked, a.answer.text ? `「${a.answer.text}」` : ""].filter(Boolean).join("；");
}

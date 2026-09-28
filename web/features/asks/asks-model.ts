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
  answer: { choices: string[]; text: string; via: string; at: number } | null;
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

export function groupAsks(asks: WebAsk[]): AskGroups {
  const open = asks.filter((a) => a.state === "open").sort((x, y) => x.createdAt - y.createdAt);
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

/** ask 里的是 bridge 名（master / agent-xxx），聊天里的是前端会话名：都换成前端名再比 */
export const sameAgent = (a: string, b: string) => uiAgentName(a) === uiAgentName(b);

/**
 * 这个聊天气泡是哪条 ask 建出来的：同一个 agent、ask 的选项以气泡的 components 开头（行内按钮排在后面）；
 * agent 复用同一组按钮时取建立时间离气泡最近的一条（两分钟内），对不上就当没有。
 */
export function askForReply(asks: WebAsk[], agent: string, rows: WebComponentRow[] | undefined, replyTs?: string): WebAsk | null {
  if (!rows?.length || !agent) return null;
  const want = JSON.stringify(rows);
  const at = replyTs ? Date.parse(replyTs) : NaN;
  let best: WebAsk | null = null;
  for (const a of asks) {
    if (a.source !== "reply" || !sameAgent(a.fromAgent, agent)) continue;
    if (JSON.stringify(a.options.slice(0, rows.length)) !== want) continue;
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

/** 已答的 wire 换回人话（按钮文字 / 选项文字），再接上 owner 写的话；对不上的 wire 原样给 */
export function answerSummary(a: WebAsk): string {
  if (!a.answer) return "";
  const rows = (a.source === "reply" ? a.options : []) as WebComponentRow[];
  const label = (w: string): string => {
    for (const row of rows) {
      if (row.type === "buttons") {
        const b = row.buttons.find((x) => w === `[button:${x.id}]`);
        if (b) return b.label;
      } else if (w.startsWith(`[select:${row.id}:`)) {
        const vals = w.slice(`[select:${row.id}:`.length, -1).split(",");
        return vals.map((v) => row.options.find((o) => o.value === v)?.label ?? v).join("、");
      }
    }
    return w;
  };
  return [...a.answer.choices.map(label), a.answer.text ? `「${a.answer.text}」` : ""].filter(Boolean).join("；");
}

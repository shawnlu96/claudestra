/**
 * 给当班 PM 的推送分两类（agents-PMDIG1，docs/architecture/pm-digest.md）：立即送 / 可合并进摘要。纯函数，bridge 投递口（bridge/pm-digest.ts）
 * 与 manager 只读统计共用。只有三类可合并：调度器「上线后待办」提醒、台账巡检「新发现」、其他 agent 的纯进度同步（oneShot 或开头写「只同步」）；
 * 其余一律立即送，拿不准也立即送。
 */

export type DigestMode = "on" | "observe" | "off";
export type DigestKind = "post-verify" | "audit" | "sync";

/** 可合并的推送在摘要队列里最多等这么久：队列里最早一条等满就单独送一条摘要 */
export const PM_DIGEST_WINDOW_MS = 30 * 60_000;
/** 摘要每行首行原文的截断长度 */
const LINE_MAX = 120;
/** bridge 自己发的单独摘要信封的 from.label */
export const PM_DIGEST_LABEL = "pm-digest";

export interface DigestInput {
  fromKind: "local" | "user" | "bridge" | "api";
  /** local = 发送方 agent 名；bridge = label；其余可空 */
  sender?: string;
  intent: string;
  triggerKind: string;
  oneShot: boolean;
  /** 正文（已去掉 bridge 加的转交抬头 / 摘要块） */
  body: string;
}

export type DigestVerdict =
  | { send: "now"; reason: string }
  | { send: "digest"; reason: string; kind: DigestKind; source: string; card?: string; firstLine: string };

/** 不算「其他 agent」的发送方：调度器、大总管、PM 切换通知；它们的 oneShot 不归进度同步 */
const SYSTEM_SENDERS = new Set(["scheduler", "master", "pm-switch"]);
/** 正文任一行带这些字样的 agent 消息按要紧算（失败 / 冻结 / 事故 / 交付 / 提问 / 要人回答），宁可多叫醒一次 */
const URGENT_RE = /失败|冻结|事故|告警|报警|故障|阻塞|卡住|blocker|交付|已交|提问|请(你)?(回|答|确认|决定|拍板|批|看)|需要你|要你|问你|想问|请教|回复我|[?？]|紧急|急|P0|回滚|挂了|宕|incident|fail/i;
const SYNC_HEAD_RE = /^[[【(（「]?\s*只同步/;
const POST_VERIFY_RE = /^\[上线后待办\]\s*(\S+)/;
const AUDIT_HEAD = "[🔎 台账巡检]";
const CARD_RE = /\b[a-z][a-z0-9]*(?:-[a-z0-9]+)*-[A-Z][A-Z0-9]{2,}\b/;

function firstLineOf(text: string): string {
  return text.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
}

export function classifyPmPush(m: DigestInput): DigestVerdict {
  const firstLine = firstLineOf(m.body), sender = m.sender ?? "";
  if (m.fromKind === "user" || m.fromKind === "api") return { send: "now", reason: "owner / 人类 / peer 的消息" };
  if (m.triggerKind === "ask_answer") return { send: "now", reason: "卡片答复" };
  if (m.fromKind === "bridge") {
    if (sender === PM_DIGEST_LABEL) return { send: "now", reason: "PM 摘要本身（不再进队，防自环）" };
    if (sender === "ledger-audit" && firstLine.startsWith(AUDIT_HEAD)) return { send: "digest", reason: "台账巡检新发现", kind: "audit", source: sender, firstLine };
    return { send: "now", reason: `bridge 通知（${sender || "?"}）` };
  }
  if (sender === "scheduler") {
    const pv = POST_VERIFY_RE.exec(firstLine);
    if (pv) return { send: "digest", reason: "调度器上线后待办提醒", kind: "post-verify", source: sender, card: pv[1], firstLine };
    return { send: "now", reason: "调度器其他通知" };
  }
  if (SYSTEM_SENDERS.has(sender)) return { send: "now", reason: `系统发送方 ${sender}` };
  if (!m.oneShot && !SYNC_HEAD_RE.test(firstLine)) return { send: "now", reason: "agent 消息等回复" };
  // 看整段正文：摘要只留首行，后面几行里的失败 / 交付 / 要你拍板一旦进队就看不见了
  if (URGENT_RE.test(m.body)) return { send: "now", reason: "正文像要紧事 / 要回答" };
  return { send: "digest", reason: m.oneShot ? "agent oneShot 进度同步" : "agent 写明只同步", kind: "sync", source: sender || "agent", card: CARD_RE.exec(firstLine)?.[0], firstLine };
}

export interface DigestEntry {
  /** 原消息 id：去重用 */
  id: string;
  project: string;
  kind: DigestKind;
  source: string;
  card?: string;
  firstLine: string;
  at: number;
}

const clip = (s: string): string => (s.length > LINE_MAX ? `${s.slice(0, LINE_MAX - 1)}…` : s);

/** 摘要正文：同来源同卡（没卡号按同首行）合成一行带次数，按首次出现排序 */
export function digestText(entries: readonly DigestEntry[]): string {
  const rows = new Map<string, { e: DigestEntry; n: number }>();
  for (const e of entries) {
    const key = `${e.source}\u0000${e.card ?? `\u0000${e.firstLine}`}`;
    const row = rows.get(key);
    if (row) row.n++;
    else rows.set(key, { e, n: 1 });
  }
  const lines = [...rows.values()].map(({ e, n }, i) =>
    `${i + 1}. ${[e.source, e.card, clip(e.firstLine)].filter(Boolean).join(" · ")}${n > 1 ? `（×${n}）` : ""}`);
  return [`[📨 PM 摘要] ${entries.length} 条非紧急推送合并送达（不用逐条回复）：`, ...lines].join("\n");
}

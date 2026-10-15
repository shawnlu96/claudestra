/**
 * 给当班 PM 的推送分两类（agents-PMDIG1，docs/architecture/pm-digest.md）：立即送 / 可合并进摘要。纯函数，bridge 投递口（bridge/pm-digest.ts）
 * 与 manager 只读统计共用。发送方标了级别（pm-notice-level.ts）就只认级别：action 立即送、info 进摘要（agents-NOTICETYPE1）；
 * 其他 agent 没标级别的 oneShot 不看正文、一律进摘要并在 `ledger pm-todo` 列出。没标级别的其余消息照旧：只有四类可合并——调度器「上线后待办」
 * 提醒、合并列车二分进度 / 车厢 CI 红、台账巡检「新发现」、其他 agent 开头写「只同步」的等回复消息；其余一律立即送，拿不准也立即送。
 */

import type { PmNoticeLevel } from "./pm-notice-level.js";

export type DigestMode = "on" | "observe" | "off";
export type DigestKind = "post-verify" | "train" | "audit" | "sync";

/** 可合并的推送在摘要队列里最多等这么久：队列里最早一条等满就单独送一条摘要。常规推送本来就不该叫醒 PM，平时随紧急事顺带送到 */
export const PM_DIGEST_WINDOW_MS = 4 * 3600_000;
/** 摘要每行首行原文的截断长度 */
const LINE_MAX = 120;
/** 一条推送首行之后最多带这么多行要点进摘要（agents-PMDIG4），多出的折成一行「还有 N 条」 */
const DETAIL_MAX = 6;
/** 首行之后的要点也要带进摘要的 sync 来源：监工巡检「新异常 N 条」，要点在后面几行 */
const DETAIL_SYNC_SENDERS = new Set(["supervise-watch"]);
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
  /** 发送方在代码里标的级别（pm-notice-level.ts）；分流优先认它 */
  level?: PmNoticeLevel;
}

/** 归类依据（样本记录口）：structured = 按发送方标的级别（或 oneShot 没标级别）分流；regex = 看了正文字样 */
export type LevelSource = "structured" | "regex";
type Basis = { levelSource?: LevelSource; unleveled?: true };
export type DigestVerdict =
  | ({ send: "now"; reason: string } & Basis)
  | ({ send: "digest"; reason: string; kind: DigestKind; source: string; card?: string; firstLine: string; detail?: string[] } & Basis);

/** 旧规则里不算「其他 agent」的发送方：调度器、大总管、PM 切换通知（大总管的 oneShot 已先按级别分流，这里只剩等回复的帧） */
const SYSTEM_SENDERS = new Set(["scheduler", "master", "pm-switch"]);
/** 正文任一行带这些字样的 agent 消息按要紧算（失败 / 冻结 / 事故 / 交付 / 提问 / 要人回答），宁可多叫醒一次 */
const URGENT_RE = /失败|冻结|事故|告警|报警|故障|阻塞|卡住|blocker|交付|已交|提问|请|需要你|要你|问你|想问|回复我|意见|方案|下一步|怎么(办|定|做|处理)|如何|能否|可否|是否|[?？]|紧急|急|P0|回滚|挂了|宕|incident|fail/i;
/** 出借 / 派单停了、结果不明、要 PM 当场核对撤单重派的字样（agents-PMDIG3）：和 URGENT_RE 同用途，晚到会让卡多停一段 */
const HALT_RECHECK_RE = /已停|停了|结果不明|交你|请核对|撤单|重派|超时/;
const SYNC_HEAD_RE = /^[[【(（「]?\s*只同步/;
const POST_VERIFY_RE = /^\[上线后待办\]\s*(\S+)/;
/**
 * 合并列车的二分进度和车厢 CI 红（scheduler-merge-train.ts emit 的 bisect / ci）：调度服务自己接着二分、退修，PM 不用动。
 * 只认单行；列车作废、告警、组车等其他列车通知照旧立即送。改文案时两边一起改，否则这类推送又会逐条叫醒 PM。
 */
const TRAIN_PROGRESS_RE = /^\[合并列车\] 第 \d+ 辆车 \S+：(?:第 \d+ 层二分：|车厢 \S+（[^）]*）CI 红：)/;
const AUDIT_HEAD = "[🔎 台账巡检]";
/** 巡检正文末尾指向全量命令的那行（ledger-audit.ts auditNoticeText），不算要点 */
const AUDIT_TAIL = "全部未解决的";
const CARD_RE = /\b[a-z][a-z0-9]*(?:-[a-z0-9]+)*-[A-Z][A-Z0-9]{2,}\b/;

/** 正文像要紧事 / 要回答（失败、交付、提问、停单、重派……）：只给没标级别、也不是 oneShot 的外来消息用，pm-route 的保护项共用 */
export const pmBodyUrgent = (body: string): boolean => URGENT_RE.test(body) || HALT_RECHECK_RE.test(body);

/**
 * 本机系统进程以固定名义发的帧（调度器、PM 切换、出借服务、台账唤醒）：不算「其他 agent」，没标级别时照旧规则。
 * master 不在内：它的 oneShot 也是 send_to_agent 发的，和其他 agent 一样只认发送方标的级别（没标的进 pm-todo）
 */
const PROCESS_SENDERS = new Set(["scheduler", "pm-switch", "lend", "ledger"]);
/** 其他 agent 发来的 oneShot：级别由发送方在 send_to_agent 上标，PM 侧不看正文 */
export const agentOneShot = (m: Pick<DigestInput, "fromKind" | "sender" | "oneShot" | "intent">): boolean =>
  m.fromKind === "local" && m.oneShot && m.intent !== "response" && !PROCESS_SENDERS.has(m.sender ?? "");

function firstLineOf(text: string): string {
  return text.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
}

const clip = (s: string): string => (s.length > LINE_MAX ? `${s.slice(0, LINE_MAX - 1)}…` : s);

/** 首行之后的非空行：最多 DETAIL_MAX 行、每行截断，多出的折成末尾一行「还有 N 条」；只有首行就不带这个字段 */
function detailOf(body: string, audit = false): { detail?: string[] } {
  const rest = body.split("\n").map((l) => l.trim()).filter(Boolean).slice(1).filter((l) => !audit || !l.startsWith(AUDIT_TAIL));
  if (!rest.length) return {};
  const more = rest.length - DETAIL_MAX;
  return { detail: [...rest.slice(0, DETAIL_MAX).map(clip), ...(more > 0 ? [`还有 ${more} 条`] : [])] };
}

/** 分流判了合并、但摘要归类本身判立即送的（受信列车进度、系统常规推送）：首行 + 要点进摘要 */
export function digestFallback(body: string, source: string, reason: string): DigestVerdict {
  const firstLine = firstLineOf(body);
  return { send: "digest", reason, kind: "sync", source, card: CARD_RE.exec(firstLine)?.[0], firstLine, ...detailOf(body) };
}

export function classifyPmPush(m: DigestInput): DigestVerdict {
  const firstLine = firstLineOf(m.body), sender = m.sender ?? "";
  if (m.fromKind === "user" || m.fromKind === "api") return { send: "now", reason: "owner / 人类 / peer 的消息" };
  if (m.triggerKind === "ask_answer") return { send: "now", reason: "卡片答复" };
  if (m.fromKind === "bridge" && sender === PM_DIGEST_LABEL) return { send: "now", reason: "PM 摘要本身（不再进队，防自环）" };
  // 结构化级别：本项目入口（调度器 / bridge 合成通知）与 agent 的 oneShot。等回复的 agent 消息带了也不认（对方在等答复，不能压进摘要）
  if (m.level && (m.fromKind === "bridge" || m.oneShot)) {
    if (m.level === "action") return { send: "now", reason: "发送方标 action", levelSource: "structured" };
    const base = legacyVerdict(m, firstLine, sender);
    return { ...(base.send === "digest" ? base : digestFallback(m.body, sender || m.fromKind, "")), reason: "发送方标 info", levelSource: "structured" };
  }
  if (agentOneShot(m)) {
    return { send: "digest", reason: "oneShot 没标级别：不送，进 pm-todo 等 PM 拉", kind: "sync", source: sender || "agent", card: CARD_RE.exec(firstLine)?.[0],
      firstLine, ...(DETAIL_SYNC_SENDERS.has(sender) ? detailOf(m.body) : {}), levelSource: "structured", unleveled: true };
  }
  return legacyVerdict(m, firstLine, sender);
}

/** 没有结构化级别时的旧规则（正文字样只在这里用） */
function legacyVerdict(m: DigestInput, firstLine: string, sender: string): DigestVerdict {
  if (m.fromKind === "bridge") {
    if (sender === "ledger-audit" && firstLine.startsWith(AUDIT_HEAD)) return { send: "digest", reason: "台账巡检新发现", kind: "audit", source: sender, firstLine, ...detailOf(m.body, true) };
    return { send: "now", reason: `bridge 通知（${sender || "?"}）` };
  }
  if (sender === "scheduler") {
    const pv = POST_VERIFY_RE.exec(firstLine);
    if (pv) return { send: "digest", reason: "调度器上线后待办提醒", kind: "post-verify", source: sender, card: pv[1], firstLine, ...detailOf(m.body) };
    if (TRAIN_PROGRESS_RE.test(firstLine) && !m.body.trim().includes("\n")) {
      return { send: "digest", reason: "合并列车二分 / 车厢 CI 红", kind: "train", source: sender, firstLine };
    }
    return { send: "now", reason: "调度器其他通知" };
  }
  if (SYSTEM_SENDERS.has(sender)) return { send: "now", reason: `系统发送方 ${sender}` };
  if (!m.oneShot && !SYNC_HEAD_RE.test(firstLine)) return { send: "now", reason: "agent 消息等回复" };
  // 等回复的「只同步」只认单行：首行以下还有内容就可能是要 PM 回答的，摘要只留首行会把它截掉
  if (!m.oneShot && m.body.trim().includes("\n")) return { send: "now", reason: "等回复且首行以下还有内容" };
  // 看整段正文：摘要只留首行，后面几行里的失败 / 交付 / 要你拍板一旦进队就看不见了
  if (pmBodyUrgent(m.body)) return { send: "now", reason: "正文像要紧事 / 要回答", levelSource: "regex" };
  return { send: "digest", reason: m.oneShot ? "agent oneShot 进度同步" : "agent 写明只同步", kind: "sync", source: sender || "agent", card: CARD_RE.exec(firstLine)?.[0], firstLine,
    ...(DETAIL_SYNC_SENDERS.has(sender) ? detailOf(m.body) : {}), levelSource: "regex" };
}

export interface DigestEntry {
  /** 原消息 id：去重用 */
  id: string;
  project: string;
  kind: DigestKind;
  source: string;
  card?: string;
  firstLine: string;
  /** 首行之后的要点（巡检 / 上线后待办 / 监工巡检才有，classifyPmPush 已截好）；旧条目没有 */
  detail?: string[];
  /** 其他 agent 没标级别的 oneShot：`ledger pm-todo` 列出（pm-todo-oneshot.ts） */
  unleveled?: true;
  at: number;
  /** 拼进了这封（message_id）且它押在 PM 队里：等它送到再出队（bridge/pm-digest.ts） */
  carriedBy?: string;
}

/** 摘要正文：同来源同卡（没卡号按同首行）且要点相同的合成一行带次数，按首次出现排序；有要点的在本行下面逐行缩进列出 */
export function digestText(entries: readonly DigestEntry[]): string {
  const rows = new Map<string, { e: DigestEntry; n: number }>();
  for (const e of entries) {
    const key = `${e.source}\u0000${e.card ?? `\u0000${e.firstLine}`}\u0000${(e.detail ?? []).join("\n")}`;
    const row = rows.get(key);
    if (row) row.n++;
    else rows.set(key, { e, n: 1 });
  }
  const lines = [...rows.values()].flatMap(({ e, n }, i) => [
    `${i + 1}. ${[e.source, e.card, clip(e.firstLine)].filter(Boolean).join(" · ")}${n > 1 ? `（×${n}）` : ""}`,
    ...(e.detail ?? []).map((l) => `   ${l}`),
  ]);
  return [`[📨 PM 摘要] ${entries.length} 条非紧急推送合并送达（不用逐条回复）：`, ...lines].join("\n");
}

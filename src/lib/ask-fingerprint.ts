/**
 * 运行时「待你处理」（AUQ / 权限 / Codex 弹框）的指纹（T61）：同一个 agent、同一条规则、命中的同一行原文 = 同一个弹框。
 * 指纹记进 ask 的 extra.fp，落在台账里，bridge 重启后照样认得：
 *   - 同指纹还开着的 → 沿用原卡（不撤旧建新）；
 *   - 同指纹被 owner 删过、或 Codex 额度卡已到重置时间（expired），且弹框从那以后一直没消失过（extra.clearedAt 没记）→ 不再开；
 *   - 其余（答过的、弹框消失后又出现的）→ 开新卡。
 * 单测 tests/ask-dismiss.test.ts。
 */
import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { parseResetAt } from "./autopilot-run.js";
import { t } from "./i18n.js";
import { getAsk, type Ask, type AskSource } from "./ledger-asks.js";

export function runtimeFingerprint(source: AskSource, agent: string, rule: string, line: string): string {
  return createHash("sha256").update(JSON.stringify([source, agent.replace(/^agent-/, ""), rule, line.trim()])).digest("hex").slice(0, 32);
}

/** 两条检测对各字段的截断上限（jsonl-watcher / permission-watcher 的 slice）：到了上限 = 可能没读全 */
const AUQ_CAPS = { question: 300, label: 100, description: 100 };
/** 换行规范化：pane 把折行拼成空格、jsonl 是原文换行，中文还会在任意字间折——去掉全部空白再比 */
const squash = (s: string) => s.replace(/\s+/g, "");
const cut = (s: string, cap: number) => s.length >= cap || /(…|\.\.\.)$/.test(s.trim());

/**
 * AUQ 的身份：各问的问题、单选 / 多选、按顺序的选项文字和描述——网页按下标提交，描述里写的是授权对象、范围和后果，
 * 这几样变了，同一个下标就是另一回事（tests/ask-dismiss.test.ts）。有字段到了截断上限或带省略号 = 读不全，返回 null：
 * 身份未知，不认领旧卡，每次都开新卡
 */
export function auqIdentity(qs: unknown): string | null {
  const list = (Array.isArray(qs) ? qs : []) as { question?: string; multiSelect?: boolean; options?: { label?: string; description?: string }[] }[];
  let whole = true;
  const field = (v: string | undefined, cap: number) => {
    if (cut(v ?? "", cap)) whole = false;
    return squash(v ?? "");
  };
  const id = JSON.stringify(list.map((q) => [
    field(q?.question, AUQ_CAPS.question), !!q?.multiSelect,
    (q?.options ?? []).map((o) => [field(o?.label, AUQ_CAPS.label), field(o?.description, AUQ_CAPS.description)]),
  ]));
  return whole ? id : null;
}

/** 同一个频道、同一种来源、同一个指纹的最近一条（任何状态） */
export function priorByFingerprint(db: Database, source: AskSource, channelId: string, fp: string): Ask | null {
  const r = db.query("SELECT id FROM asks WHERE source = ? AND fromChannelId = ? AND json_extract(extra, '$.fp') = ? ORDER BY createdAt DESC LIMIT 1")
    .get(source, channelId, fp) as { id: string } | null;
  return r ? getAsk(db, r.id) : null;
}

/**
 * 重启后第一次确认屏上没有这种弹框时要对账的：还开着的，和会挡住下一次开卡的（删过的、到期的额度卡）——都还没记 clearedAt。
 * 别的结过的记不记都不影响开卡（reuseOf），不去碰
 */
export function unclearedRuntimeAsks(db: Database, source: AskSource, channelId: string): Ask[] {
  return (db.query(`SELECT id FROM asks WHERE source = ? AND fromChannelId = ? AND json_extract(extra, '$.clearedAt') IS NULL
    AND (state = 'open' OR json_extract(extra, '$.dismissed') IS NOT NULL OR (state = 'expired' AND source = 'codex'))`)
    .all(source, channelId) as { id: string }[]).flatMap((r) => getAsk(db, r.id) ?? []);
}

export type Reuse = "adopt" | "suppress" | "new";

export function reuseOf(prior: Pick<Ask, "state" | "source" | "extra"> | null): Reuse {
  if (!prior) return "new";
  if (prior.state === "open") return "adopt";
  const gone = prior.extra.clearedAt !== undefined;
  const dismissed = prior.extra.dismissed !== undefined;
  const quotaOver = prior.state === "expired" && prior.source === "codex";
  return (dismissed || quotaOver) && !gone ? "suppress" : "new";
}

/**
 * Codex 额度卡按通知处理：「try again at …」解析出的重置时刻就是它的有效期（到点由过期清扫收起，不通知 agent）。
 * now 是第一次看到这行的时刻（新开的卡才调；沿用原卡时有效期早定了）；解析不出 → undefined，用默认有效期
 */
export function codexExpiry(line: string, now: number): number | undefined {
  const at = parseResetAt(line, now);
  return at !== null && at > now ? at : undefined;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** 额度卡正文（T61）：只一句几点恢复（不是今天的带上日期）；解析不出重置时间就只说额度用完 */
export function codexQuotaText(at: number | undefined, now: number): string {
  if (at === undefined) return t("额度用完", "Usage limit reached");
  const d = new Date(at);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.toDateString() === new Date(now).toDateString()) return t(`${hm} 恢复`, `Back at ${hm}`);
  return t(`${d.getMonth() + 1}月${d.getDate()}日 ${hm} 恢复`, `Back ${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })} ${hm}`);
}

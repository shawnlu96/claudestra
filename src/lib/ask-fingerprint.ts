/**
 * 运行时「待你处理」（AUQ / 权限 / Codex 弹框）的指纹（T61）：同一个 agent、同一条规则、命中的同一行原文 = 同一个弹框。下面的跨重启规则只给 Codex / 权限卡，AUQ 见 auqIdentity。
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

/**
 * AUQ 的身份：各问的问题、单选 / 多选、按顺序的选项文字和描述，原样精确比较（不去空白、不做规范化）——网页按下标提交，
 * 描述里写的是授权对象、范围和后果，差一个空格都可能是另一个对象（「/tmp/a /tmp/b」≠「/tmp/a/tmp/b」，tests/ask-dismiss.test.ts）。
 * 只在同一个 bridge 进程里用来判断「还是不是正跟着的那个弹框」；AUQ 不跨重启认领（bridge/ask-runtime.ts）
 */
export function auqIdentity(qs: unknown): string {
  const list = (Array.isArray(qs) ? qs : []) as { question?: string; multiSelect?: boolean; options?: { label?: string; description?: string }[] }[];
  return JSON.stringify(list.map((q) => [q?.question ?? "", !!q?.multiSelect, (q?.options ?? []).map((o) => [o?.label ?? "", o?.description ?? ""])]));
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

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
import { getAsk, type Ask, type AskSource } from "./ledger-asks.js";

export function runtimeFingerprint(source: AskSource, agent: string, rule: string, line: string): string {
  return createHash("sha256").update(JSON.stringify([source, agent.replace(/^agent-/, ""), rule, line.trim()])).digest("hex").slice(0, 32);
}

/** 同一个频道、同一种来源、同一个指纹的最近一条（任何状态） */
export function priorByFingerprint(db: Database, source: AskSource, channelId: string, fp: string): Ask | null {
  const r = db.query("SELECT id FROM asks WHERE source = ? AND fromChannelId = ? AND json_extract(extra, '$.fp') = ? ORDER BY createdAt DESC LIMIT 1")
    .get(source, channelId, fp) as { id: string } | null;
  return r ? getAsk(db, r.id) : null;
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

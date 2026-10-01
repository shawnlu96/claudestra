/**
 * 出借方 B 写单「推送 / 开 PR」可重试失败的记账（i28-PUB1）：lend-drive.ts publishWork 每次可重试失败记一笔（首次失败时刻 + 最近原因），
 * 心跳（lend-beat.ts lineOf）把原因放进 publishing 阶段的摘要让 A 看见；从首次失败起超过 PUBLISH_GIVE_UP_MS 就不再重试，按不可重试停单交 PM。
 * 记在 journal 的 lend_meta（键 publish-fail:<单号>），不放进 work 列：lend submit 拿 work 的 sha 判重交幂等，改了它同一份交付会被当成换了内容。
 * 发布成功或单子结束时清成空串（空 = 没有）；lend_meta 没有删除口，空串行几十字节，只在出过失败的单上留一条。tests/lend-publish-retry.test.ts。
 */
import type { Database } from "bun:sqlite";
import { getMeta, setMeta } from "./lend-journal.js";

/** 连续失败这么久就停单：A 侧 5 分钟起会代为接管交付，30 分钟还没走通说明 A 那边也没接上，交 PM 看 */
export const PUBLISH_GIVE_UP_MS = 30 * 60_000;

export interface PublishFail { since: number; reason: string }

const key = (orderId: string): string => `publish-fail:${orderId}`;

export function publishFail(db: Database, orderId: string): PublishFail | null {
  const raw = getMeta(db, key(orderId));
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<PublishFail>;
    return typeof v.since === "number" && typeof v.reason === "string" ? { since: v.since, reason: v.reason } : null;
  } catch { return null; /* 坏值当没有：最坏是 30 分钟从这一次重新算，不会把好单停掉 */ }
}

/** 记一次可重试失败：首次失败时刻沿用旧的，原因换成最新的 */
export function notePublishFail(db: Database, orderId: string, reason: string, now: number): PublishFail {
  const f = { since: publishFail(db, orderId)?.since ?? now, reason };
  setMeta(db, key(orderId), JSON.stringify(f));
  return f;
}

export function clearPublishFail(db: Database, orderId: string): void {
  if (getMeta(db, key(orderId))) setMeta(db, key(orderId), "");
}

/** 心跳摘要里的那一行（推送失败也用这个开头：都是交付发不出去；调用方再过 excerptOf 脱敏、截断） */
export const publishFailLine = (f: PublishFail, now: number): string =>
  `开 PR 失败：${f.reason}（已持续 ${Math.max(0, Math.floor((now - f.since) / 60_000))} 分钟）`;

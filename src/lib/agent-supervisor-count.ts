/**
 * 监护的续跑计数（dispatch-recovery-SUPCNT1）：计数只在同一件活内累计，bridge（agent-supervisor-bridge.ts 批续跑）和调度服务
 * （agent-supervisor.ts 留痕、报派活方）都按这里的同一套口径数——
 * - 这件活是哪一件：监护名单在 bridge 里有缓存，刚领新单时名单里还是旧单，以台账里派给它的最新一单为准（countKey）；
 * - 哪些撞错算这件活的：只算这件活派出以后的（workStartedAt）。bridge 的撞错记录按频道留一天，换单后旧单的记录还在；
 * - 回合正常结束后从头数：批次数清零并记下清零时刻（clearGrants），台账里早于它的续跑不再算（countedResumes）；
 * - 登录失效（401）不占续跑次数（refundAuthGrant），按 auth 规则报。
 * tests/agent-supervisor-count.test.ts。
 */
import type { Database } from "bun:sqlite";
import { workKeyOf, type WorkRef } from "./agent-supervisor-policy.js";
import type { SuperviseEvent } from "./agent-supervisor-ledger.js";

interface OverloadEvent { at: number; error: string; act: string }
/** key = 活 @ 会话；since = 这件活上一次回合正常结束、次数清零的时刻（没清过就没有） */
export interface OverloadGrant { key: string; used: number; at: number; since?: number }
/** 按频道：近一天的撞错与 bridge 的处理，加这个频道当前这件活批过几次续跑；auth = 最近一次撞的是登录失效、bridge 为它续了一次的时刻 */
export type OverloadFile = Record<string, { agent: string; events: OverloadEvent[]; grant?: OverloadGrant; auth?: number }>;

/** 台账里派给这个 agent 的最新一单（已发出或正在发的；取消的、还没发的不算）；没有调度表 / 没派过 = null */
function latestOrderKey(db: Database, agent: string): string | null {
  try {
    const row = db.query(`SELECT id FROM scheduler_intents WHERE recipient = ? AND action IN ('dispatch','review')
      AND status IN ('submitted','done','unknown') ORDER BY createdAt DESC, rowid DESC LIMIT 1`).get(agent) as { id: string } | null;
    return row ? `order:${row.id}` : null;
  } catch { return null; /* 没有调度表：按名单里看到的活 */ }
}

/** 计数用的活键：名单里是调度单时以台账为准（名单滞后时不拿旧单的次数判新单）；请求类的活、读不到台账时按名单 */
export function countKey(db: Database | null, s: { agent: string; work: WorkRef }): string {
  const seen = workKeyOf(s.work);
  return s.work.kind === "order" && db ? latestOrderKey(db, s.agent) ?? seen : seen;
}

/** 这件活是什么时候到 agent 手上的：调度单 = 意图建立，请求 = 送达；查不到 = 0（不筛） */
export function workStartedAt(db: Database, work: WorkRef): number {
  if (work.kind === "call") return work.since;
  try {
    const row = db.query("SELECT createdAt FROM scheduler_intents WHERE id = ?").get(work.intentId) as { createdAt: number } | null;
    return row?.createdAt ?? 0;
  } catch { return 0; /* 没有调度表：不筛，同改动前 */ }
}

/** 台账里一条续跑记录对应的撞错时刻（故障键 overload:<agent>:<时刻>）；键认不出来就用记账时刻 */
const resumeAt = (e: SuperviseEvent): number => {
  const at = Number(e.faultKey.slice(e.faultKey.lastIndexOf(":") + 1));
  return Number.isFinite(at) ? at : e.ts;
};

/** 台账里这件活记过的续跑（since 之后撞的；不给 = 全算） */
export function countedResumes(events: readonly SuperviseEvent[], workKey: string, since?: number): SuperviseEvent[] {
  return events.filter((e) => e.fault === "overload" && e.step === "resume" && e.phase === "done" && e.workKey === workKey &&
    (since === undefined || resumeAt(e) > since));
}

/** 回合正常结束：这个 agent 批过的续跑次数清零、记下时刻，登录失效的续跑标记一并去掉；有改动才返回 true（没什么可清就不用写盘） */
export function clearGrants(all: OverloadFile, agent: string, now: number): boolean {
  let changed = false;
  for (const e of Object.values(all)) {
    if (e.agent !== agent) continue;
    if (e.grant && e.grant.used > 0) e.grant = { ...e.grant, used: 0, since: now }, changed = true;
    if (e.auth !== undefined) delete e.auth, changed = true;
  }
  return changed;
}

/** 这次撞的是登录失效：把刚为它批的那一次续跑退回去（批的时候还不知道是什么错）；不是这次批的不动 */
export function refundAuthGrant(grant: OverloadGrant | undefined, at: number): OverloadGrant | undefined {
  return grant && grant.at === at && grant.used > 0 ? { ...grant, used: grant.used - 1 } : grant;
}

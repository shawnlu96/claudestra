/**
 * 监护的续跑计数（dispatch-recovery-SUPCNT1）：计数只在同一件活内累计，bridge（agent-supervisor-bridge.ts 批续跑）和调度服务
 * （agent-supervisor.ts 留痕、报派活方）都按这里的同一套口径数——
 * - 这件活是哪一件：监护名单在 bridge 里有缓存，刚领新单时名单里还是旧单，以台账里派给它的最新一单为准（countKey）；
 * - 哪些撞错算这件活的：只算这件活派出以后的（workStartedAt）。bridge 的撞错记录按频道留一天，换单后旧单的记录还在；
 * - 回合正常结束后从头数：批次数清零并记下清零时刻（clearCounts），这一刻及以前的撞错和台账里的续跑都不再算（afterClear / countedResumes）；
 * - 登录失效（401）自己一条线（authMark），不占续跑次数（refundAuthGrant），按 auth 规则报。
 * tests/agent-supervisor-count.test.ts。
 */
import type { Database } from "bun:sqlite";
import { workKeyOf, type WorkRef } from "./agent-supervisor-policy.js";
import type { SuperviseEvent } from "./agent-supervisor-ledger.js";

interface OverloadEvent { at: number; error: string; act: string }
/** key = 活 @ 会话 */
export interface OverloadGrant { key: string; used: number; at: number }
/** 上一次撞的是登录失效、bridge 为它续了一次：哪件活（活 @ 会话）、什么时候撞的。下一次撞的不是登录失效或回合正常结束就去掉 */
interface AuthMark { key: string; at: number }
/**
 * 按频道：近一天的撞错与 bridge 的处理，加这个频道当前这件活批过几次续跑。
 * cleared = 这个会话上一次回合正常结束的时刻（没有过就没有）：这一刻及以前的撞错、续跑都不再算，bridge 和调度服务用同一条线
 */
export type OverloadFile = Record<string, { agent: string; events: OverloadEvent[]; grant?: OverloadGrant; auth?: AuthMark; cleared?: number }>;

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

/** 台账里这件活记过的续跑（清零以后撞的；没清过 = 全算） */
export function countedResumes(events: readonly SuperviseEvent[], workKey: string, cleared?: number): SuperviseEvent[] {
  return events.filter((e) => e.fault === "overload" && e.step === "resume" && e.phase === "done" && e.workKey === workKey &&
    afterClear(resumeAt(e), cleared));
}

/** 清零时刻以后撞的才算（没清过 = 全算）：计数、留痕、报派活方都先过这一条 */
export const afterClear = (at: number, cleared: number | undefined): boolean => cleared === undefined || at > cleared;

/**
 * 回合正常结束：这个 agent 批过的续跑次数清零、登录失效的续跑标记去掉、记下时刻。上次清零以后没撞过错、没批过续跑就不动
 * （返回 false，不用写盘）。次数是 0 也要记时刻：续跑用完、落盘失败升级的那些撞错还在文件里，不记就会在下一轮监护被当成新的
 */
export function clearCounts(all: OverloadFile, agent: string, now: number): boolean {
  let changed = false;
  for (const e of Object.values(all)) {
    if (e.agent !== agent) continue;
    if (!((e.grant?.used ?? 0) > 0 || e.auth !== undefined || e.events.some((x) => afterClear(x.at, e.cleared)))) continue;
    if (e.grant) e.grant = { ...e.grant, used: 0 };
    delete e.auth;
    e.cleared = now;
    changed = true;
  }
  return changed;
}

/** 这次撞的是登录失效：把刚为它批的那一次续跑退回去（入口没拿到错误码、批的时候还不知道是什么错）；不是这次批的不动 */
export function refundAuthGrant(grant: OverloadGrant | undefined, at: number): OverloadGrant | undefined {
  return grant && grant.at === at && grant.used > 0 ? { ...grant, used: grant.used - 1 } : grant;
}

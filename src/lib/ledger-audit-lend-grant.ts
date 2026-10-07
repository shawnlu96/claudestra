/**
 * LGR1：出借方给本项目的授权（lend_peers.grant，最近一次 hello 存下的）快到期 / 已经没了，先告诉 PM——到期后 lend-peers 的 why
 * 只会说「hello 太久没更新」，看着像离线。纯函数：取数在 ledger-audit-snapshot.ts（readLendGrants），落库 / 去重同 ledger-audit-store.ts。
 * 只报最近 24 小时在本项目有过出借单的 peer；只读，不碰放置 / 容量 / 续借，也不给 peer 发任何消息。tests/ledger-audit-lend-grant.test.ts。
 */
import type { AuditFinding, AuditRule, AuditSnapshot } from "./ledger-audit.js";

const MIN = 60_000;
export const LEND_GRANT_RULES = ["lend_grant_expiring", "lend_grant_gone"] as const;
/** 离到期 ≤ 2 小时报「快到期」 */
const LEND_GRANT_WARN_MS = 120 * MIN;
/** 最近这么久在本项目有过出借单（任意状态）才报 */
export const LEND_GRANT_RECENT_MS = 24 * 60 * MIN;

export type GrantState = "live" | "expired" | "none";
/** 一个出借方：until = 存下的授权到期时刻（grant 为 null = null）；recent = 本项目最近 24 小时的出借单数；running = 本项目在它那儿 claimed 的单数 */
export interface LendGrantFact { peer: string; until: number | null; helloAt: number; recent: number; running: number }
export interface LendGrantInputs {
  /** undefined = 台账没有出借表（规则不跑） */
  lendGrants?: readonly LendGrantFact[];
}

/** lend_peers.grant 原文（JSON 或 null）里的 until；坏了当没有授权 */
export function grantUntilOf(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  try {
    const until = (JSON.parse(raw) as { until?: unknown } | null)?.until;
    return typeof until === "number" && Number.isFinite(until) ? until : null;
  } catch {
    return null;
  }
}

export const grantState = (until: number | null, now: number): GrantState => (until === null ? "none" : until > now ? "live" : "expired");

const pad = (n: number) => String(n).padStart(2, "0");
/** 本机时区的 MM-DD HH:mm */
export function localTime(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

type Emit = (f: Omit<AuditFinding, "project" | "notify" | "key"> & { keyParts: (string | number)[] }) => void;
interface Out { emit: Emit; evaluated: AuditRule[] }

export function lendGrantAudit(s: Pick<AuditSnapshot, "project"> & LendGrantInputs, now: number, out: Out): void {
  if (s.lendGrants === undefined) return;
  for (const g of s.lendGrants) {
    if (g.recent <= 0) continue;
    const state = grantState(g.until, now);
    if (state === "live" && g.until !== null && g.until - now <= LEND_GRANT_WARN_MS) {
      out.emit({ rule: "lend_grant_expiring", taskId: null, since: g.until - LEND_GRANT_WARN_MS, keyParts: [g.peer, g.until],
        detail: `peer ${g.peer} 给本项目的出借授权 ${localTime(g.until)} 到期（还剩 ${Math.max(1, Math.floor((g.until - now) / MIN))} 分钟），当前在跑 ${g.running} 单`,
        suggestion: "请对方 owner 续授权" });
    } else if (state !== "live") {
      const at = g.until ?? g.helloAt;
      out.emit({ rule: "lend_grant_gone", taskId: null, since: at, keyParts: [g.peer, at],
        detail: `peer ${g.peer} 的出借授权${state === "expired" ? "已到期" : "已到期 / 已收回"}（${localTime(at)}），调度器不会再往它派单；当前在跑 ${g.running} 单`,
        suggestion: "请对方 owner 续授权；这不是离线" });
    }
  }
  out.evaluated.push(...LEND_GRANT_RULES);
}

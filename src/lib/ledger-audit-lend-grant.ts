/**
 * LGR1：出借方给本项目的授权（lend_peers.grant，最近一次 hello 存下的）快到期 / 已经没了，先告诉 PM——到期后 lend-peers 的 why
 * 只会说「hello 太久没更新」，看着像离线。纯函数：取数在 ledger-audit-snapshot.ts（readLendGrants），落库 / 去重同 ledger-audit-store.ts。
 * 只报最近 24 小时在本项目有过出借单的 peer；只读，不碰放置 / 容量 / 续借，也不给 peer 发任何消息。tests/ledger-audit-lend-grant.test.ts。
 * 上线首轮不吞提醒：reconcileFindings 会把规则第一次 evaluated 那轮的发现直接记成已推（silenceFirstRun），而授权提醒恰恰要在首次满足时推——
 * 所以某条规则在本项目还没有 audit_baseline 时：这轮有发现就照出、但不进 evaluated（不建基线、不静默，发现照常进 pending 推给 PM）；
 * 哪轮它一条发现都没有才进 evaluated 建基线（没东西可静默）。不靠「下一轮再报」——资格（24 小时内有单、离到期还够一轮）可能撑不到下一轮。
 * 同一次授权只报一次：通用对账「解决后再出现就重推」，所以已推过（或已押进推送队列）又被关掉的 (peer, until) key 不再出（told），
 * 免得出了 24 小时窗被关、又来新单时重报；until 变了 = 新 key，照常报。
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
  /** audit_baseline 里本项目已有的授权规则；null = 读不了（规则不跑，免得首轮被静默） */
  lendGrantBaseline?: readonly string[] | null;
  /** 本项目已推过（或已押进推送队列）且已关掉的授权发现 key：不再出，免得重开重推；null = 读不了（规则不跑） */
  lendGrantTold?: readonly string[] | null;
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
  if (s.lendGrants === undefined || s.lendGrantBaseline === null || s.lendGrantTold === null) return;
  const told = new Set(s.lendGrantTold ?? []);
  const hit = new Set<AuditRule>();
  const emit: Emit = (f) => {
    if (told.has([s.project, f.rule, ...f.keyParts].join("|"))) return; // 同 ledger-audit.ts 的 keyOf
    hit.add(f.rule);
    out.emit(f);
  };
  for (const g of s.lendGrants) {
    if (g.recent <= 0) continue;
    const state = grantState(g.until, now);
    if (state === "live" && g.until !== null && g.until - now <= LEND_GRANT_WARN_MS) {
      emit({ rule: "lend_grant_expiring", taskId: null, since: g.until - LEND_GRANT_WARN_MS, keyParts: [g.peer, g.until],
        detail: `peer ${g.peer} 给本项目的出借授权 ${localTime(g.until)} 到期（还剩 ${Math.max(1, Math.floor((g.until - now) / MIN))} 分钟），当前在跑 ${g.running} 单`,
        suggestion: "请对方 owner 续授权" });
    } else if (state !== "live") {
      const at = g.until ?? g.helloAt;
      emit({ rule: "lend_grant_gone", taskId: null, since: at, keyParts: [g.peer, at],
        detail: `peer ${g.peer} 的出借授权${state === "expired" ? "已到期" : "已到期 / 已收回"}（${localTime(at)}），调度器不会再往它派单；当前在跑 ${g.running} 单`,
        suggestion: "请对方 owner 续授权；这不是离线" });
    }
  }
  const ready = new Set(s.lendGrantBaseline ?? []);
  out.evaluated.push(...LEND_GRANT_RULES.filter((r) => ready.has(r) || !hit.has(r)));
}

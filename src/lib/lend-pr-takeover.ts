/**
 * 借入方 A 每轮的出借写单兜底（i28-PUB1）：出借方 B 推上了提交、却一直停在 publishing（PR 开不出来、交付发不回来）的开工单，
 * 由 A 按同一分支接管。条件全满足才动：单仍 claimed、租约没过；心跳 phase = publishing 已持续 TAKEOVER_AFTER_MS（beat 里的 since，
 * ledger-lend-peers.ts beatLend 记）；远端分支 head 是订单起点的严格后代，且连续两轮看到的是同一个 head（B 还在推就等）。
 * 然后用 A 自己的 gh 找分支上开着的 PR，没有就按 B 的格式代开，再调 `ledger lend-takeover` 在一个事务里把交付记到卡上
 * （lend-pr-takeover-ledger.ts）。修复单本来带 PR 号，不在这里。gh / manager / 时钟全部注入（生产接线 lend-pr-takeover-gh.ts）。
 * 某一单出错只记进 failed，不挡别的单。tests/lend-pr-takeover.test.ts。
 */
import type { Database } from "bun:sqlite";
import type { RemoteHead } from "./order-deliver.js";

type Manager = (...args: string[]) => Promise<Record<string, unknown>>;

/** publishing 持续这么久才接管：B 正常一轮推送 + 开 PR 远不到一分钟，5 分钟还没出来就是卡住了 */
export const TAKEOVER_AFTER_MS = 5 * 60_000;

export type GhAnswer<T> = { ok: true; value: T } | { ok: false; error: string };
export interface TakeoverGh {
  /** 远端分支此刻的 head（git ls-remote，同 CLI 核对的那一份） */
  head(repo: string, branch: string): Promise<RemoteHead>;
  /** base...head 的关系（GitHub compare 的 status）：ahead = head 是 base 的严格后代 */
  compare(repo: string, base: string, head: string): Promise<GhAnswer<string>>;
  /** 分支上开着的 PR 号；没有 = null */
  openPr(repo: string, branch: string): Promise<GhAnswer<number | null>>;
  createPr(p: { repo: string; base: string; branch: string; title: string; body: string }): Promise<GhAnswer<number>>;
}

export interface TakeoverStepDeps {
  manager: Manager;
  gh: TakeoverGh;
  now(): number;
  /** 单号 → 上一轮看到的远端 head（连续两轮相同才接管）；缺省用本进程的表，调度服务重启后从头看两轮 */
  seen?: Map<string, string>;
}

interface Row { orderId: string; taskId: string; repo: string; branch: string; base: string; head: string; round: number; leaseUntil: number | null; beat: string | null }
interface Beat { phase?: unknown; since?: unknown }

const SEEN = new Map<string, string>();

/**
 * beat 里「这个 phase 从什么时候开始」：phase 没变就沿用上一次记的 since，变了（或旧的没有）就从这一刻算。
 * beatLend 每次批量心跳调一次，只看 JSON 里的 phase / since 两个字段，读坏了当没有。
 */
export function phaseSince(prevBeat: string | null, phase: string, now: number): number {
  if (!prevBeat) return now;
  try {
    const b = JSON.parse(prevBeat) as Beat;
    return b.phase === phase && typeof b.since === "number" && b.since <= now ? b.since : now;
  } catch { return now; /* 坏的上一条：从这一刻重新算，最多晚 5 分钟接管 */ }
}

const hasBeat = (db: Database): boolean =>
  (db.query("SELECT name FROM pragma_table_info('lend_orders')").all() as { name: string }[]).some((c) => c.name === "beat");

/** 借出去、还在出借方手里、没有 PR 的开工单，且最近一次心跳停在 publishing 够久 */
function stuckWrites(db: Database, now: number): Row[] {
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'lend_orders'").get() || !hasBeat(db)) return [];
  const rows = db.query(`SELECT orderId, taskId, repo, branch, base, head, round, leaseUntil, beat FROM lend_orders
    WHERE status = 'claimed' AND step = 'write' AND pr IS NULL AND branch IS NOT NULL AND base IS NOT NULL AND beat IS NOT NULL ORDER BY createdAt`).all() as Row[];
  return rows.filter((r) => {
    if ((r.leaseUntil ?? 0) < now) return false;
    try {
      const b = JSON.parse(r.beat as string) as Beat;
      return b.phase === "publishing" && typeof b.since === "number" && now - b.since >= TAKEOVER_AFTER_MS;
    } catch { return false; /* 读不懂的心跳不接管：宁可等 B 自己 30 分钟停单交 PM */ }
  });
}

/** 和出借方 B 开 PR 的标题一致（lend-drive.ts publishWork），正文写明是借入方代开 */
function takeoverPrText(r: Pick<Row, "taskId" | "round" | "orderId">): { title: string; body: string } {
  return { title: `${r.taskId}：出借实现（第 ${r.round} 轮）`,
    body: [`出借 worker（出借方的一次性 agent）提交，台账 ${r.taskId} 第 ${r.round} 轮，单号 ${r.orderId}。`, "",
      "出借方开 PR 未成功，借入方代开（i28-PUB1）。摘要 / 自查见提交记录；出借方报的失败原因在借入方台账。", ""].join("\n") };
}

/** 一单走一遍：返回 null = 这一轮不动（条件没满足），字符串 = 出错原因 */
async function driveOne(r: Row, d: TakeoverStepDeps, seen: Map<string, string>): Promise<string | null> {
  const remote = await d.gh.head(r.repo, r.branch);
  if (!remote.ok) return `查远端分支 ${r.branch} 失败：${remote.error}`;
  const prev = seen.get(r.orderId);
  seen.set(r.orderId, remote.head);
  if (prev !== remote.head) return null; // 第一次看到这个 head：等下一轮确认 B 不再推
  if (remote.head === r.head) return null;
  const rel = await d.gh.compare(r.repo, r.head, remote.head);
  if (!rel.ok) return `比对 ${r.branch} 与订单起点失败：${rel.error}`;
  if (rel.value !== "ahead") return null; // 不是起点的严格后代（被改写 / 分叉）：不接管，留给 B 停单交 PM
  const open = await d.gh.openPr(r.repo, r.branch);
  if (!open.ok) return `查 ${r.branch} 的 PR 失败：${open.error}`;
  let pr = open.value;
  if (pr === null) {
    const made = await d.gh.createPr({ repo: r.repo, base: r.base, branch: r.branch, ...takeoverPrText(r) });
    if (!made.ok) return `代开 PR 失败：${made.error}`;
    pr = made.value;
  }
  const res = await d.manager("ledger", "lend-takeover", r.orderId, "--head", remote.head, "--pr", String(pr));
  if (res.ok !== true) return `接管交付没记上：${String(res.error ?? "manager failed")}`;
  seen.delete(r.orderId);
  return null;
}

export async function lendTakeoverStep(db: Database, d: TakeoverStepDeps): Promise<{ failed: { taskId: string; error: string }[] }> {
  const seen = d.seen ?? SEEN;
  const rows = stuckWrites(db, d.now());
  const live = new Set(rows.map((r) => r.orderId));
  for (const id of [...seen.keys()]) if (!live.has(id)) seen.delete(id); // 不再卡着的单：忘掉，下次重新看两轮
  const failed: { taskId: string; error: string }[] = [];
  for (const r of rows) {
    const error = await driveOne(r, d, seen);
    if (error) failed.push({ taskId: r.taskId, error: `出借接管 ${r.orderId}：${error}` });
  }
  return { failed };
}

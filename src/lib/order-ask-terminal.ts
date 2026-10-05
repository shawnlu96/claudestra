/**
 * followup-reliability-ASKT：出借单结清（done / cancelled / released）后，关掉这一单的远端 worker 经 lend/ask 开出的旧提问。
 * 只认精确绑定：source=reply、kind=decide、extra.via=mcp_ask、extra.orderId = 这一单，project / taskId 与单子一致，
 * fromAgent = 单子的 `<worker>@<peer>`（order-ask.ts openOrderAsk 记的口径）。claimed / pooled / unknown 不关——unknown 是结果不明，
 * 等 PM 核对后 lend-cancel / lend-reoffer 再随单关。关闭一律走 closeAsk（cancelled，原正文 / 答案 / 历史不动，extra.settledOrder 记来由），
 * 不当作 answered、不按默认批准；已不是 open 的跳过，同一条只关一次。
 * 结清点在各自事务里改完 lend_orders 状态后调 closeSettledOrderAsks（ledger-lend.ts / ledger-lend-result.ts / lend-arbiter-result.ts /
 * lend-pr-takeover-ledger.ts / lend-reclaim-scheduler.ts）；新问在 asks 写锁内用 assertOrderTakesAsks 复核单子没结清（order-ask.ts）；
 * 历史回收走 `ledger lend-terminal-asks`（manager/ledger-lend-ask-cmd.ts，先 dry-run，--apply 在写锁内按同一套核对重来）。
 * tests/ledger-lend-terminal-asks{,-paths}.test.ts、tests/order-ask.test.ts。
 */
import type { Database } from "bun:sqlite";
import { closeAsk, getAsk, hasAsksTable, type Ask } from "./ledger-asks.js";
import { busyAsLedgerError, LedgerError } from "./ledger-store.js";

/** 结清：这一单不会再有 worker 为它干活 */
const ASK_SETTLED_STATUSES = ["done", "cancelled", "released"] as const;
const settled = (s: string): boolean => (ASK_SETTLED_STATUSES as readonly string[]).includes(s);

/** lend_orders 里核对要用的几列；不经 ledger-lend.ts（它反过来调这里） */
interface AskOrderRef { orderId: string; project: string; taskId: string; peer: string; worker: string | null; status: string }

const hasLendTable = (db: Database): boolean => !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'lend_orders'").get();

function orderRef(db: Database, orderId: string): AskOrderRef | null {
  if (!hasLendTable(db)) return null;
  return db.query("SELECT orderId, project, taskId, peer, worker, status FROM lend_orders WHERE orderId = ?").get(orderId) as AskOrderRef | null;
}

/** 这条 ask 能不能随这一单关；能 = null，不能 = 原因（不含问句原文） */
function askNotClosable(a: Ask, o: AskOrderRef | null): string | null {
  if (a.state !== "open") return `ask 已是 ${a.state}`;
  if (a.source !== "reply" || a.kind !== "decide" || a.extra.via !== "mcp_ask") return "不是执行者经 ask 工具开的提问";
  if (typeof a.extra.orderId !== "string" || !a.extra.orderId) return "没有绑定单号";
  if (!o || o.orderId !== a.extra.orderId) return "单号不在出借台账里（本机单或已删）";
  if (a.project !== o.project || a.taskId !== o.taskId) return "项目或任务与出借单不符";
  if (!o.worker || a.fromAgent !== `${o.worker}@${o.peer}`) return "提问人不是这一单的 worker@peer";
  if (o.status === "unknown") return "出借单结果不明（unknown），等 PM 核对后随单关闭";
  if (!settled(o.status)) return `出借单还在 ${o.status}，未结清`;
  return null;
}

const reasonOf = (o: AskOrderRef): string => `出借单 ${o.orderId} 已结清（${o.status}），执行者的旧提问随单关闭；未作答，不按默认批准`;

/** 关一条；调用方已在事务里核过 askNotClosable。closeAsk 自己再核 open，重复调只关一次 */
function closeOne(db: Database, a: Ask, o: AskOrderRef, now: number, by: string): string | null {
  return closeAsk(db, a.id, "cancelled", reasonOf(o), now, { settledOrder: { orderId: o.orderId, status: o.status, by } })?.id ?? null;
}

/** 绑这个单号、还开着的提问（宽筛，逐条再按 askNotClosable 精确核） */
function openAsksOf(db: Database, where: string, ...args: string[]): Ask[] {
  const rows = db.query(`SELECT id FROM asks WHERE state = 'open' AND json_extract(extra, '$.via') = 'mcp_ask' AND ${where} ORDER BY createdAt`)
    .all(...args) as { id: string }[];
  return rows.map((r) => getAsk(db, r.id)).filter((a): a is Ask => !!a);
}

/**
 * 结清点调：在改完 lend_orders 状态的同一事务里（调用方的 tx；closeAsk 嵌套成 savepoint），关这一单精确绑定的 open 提问。
 * 单子没结清（CAS 没改成、或是 unknown）什么都不做；抛错不吞，整笔回滚。返回关掉的 askId。
 */
export function closeSettledOrderAsks(db: Database, orderId: string, now: number, by = "lend"): string[] {
  if (!hasAsksTable(db)) return [];
  const o = orderRef(db, orderId);
  if (!o || !settled(o.status) || !o.worker) return [];
  return openAsksOf(db, "json_extract(extra, '$.orderId') = ?", orderId)
    .filter((a) => askNotClosable(a, o) === null)
    .map((a) => closeOne(db, a, o, now, by))
    .filter((id): id is string => !!id);
}

/** 开新问的写锁内调（openAskFull 的 beforeWrite）：出借单已结清就拒，不会出现终态后新开的 open 提问。本机单不在 lend_orders 里，放行 */
export function assertOrderTakesAsks(db: Database, orderId: string): void {
  const o = orderRef(db, orderId);
  if (o && settled(o.status)) throw new LedgerError("conflict", `出借单 ${orderId} 已结清（${o.status}），不再收提问`, { askRefused: "not_held", orderId, status: o.status });
}

interface AskSweepRow { askId: string; orderId: string; status: string | null; reason: string }
export interface AskSweepPlan { closable: AskSweepRow[]; kept: AskSweepRow[] }

/**
 * 历史回收的预览：本项目里 extra.via=mcp_ask、单号是出借单（lend: 开头或在 lend_orders 里）的 open 提问，逐条给能不能关与原因。
 * 只列 askId / 单号 / 单子状态 / 原因，不带问句。
 */
export function planSettledAskSweep(db: Database, project: string): AskSweepPlan {
  const plan: AskSweepPlan = { closable: [], kept: [] };
  if (!hasAsksTable(db)) return plan;
  for (const a of openAsksOf(db, "project = ?", project)) {
    const orderId = typeof a.extra.orderId === "string" ? a.extra.orderId : "";
    const o = orderId ? orderRef(db, orderId) : null;
    if (!o && !orderId.startsWith("lend:")) continue; // 本机单的提问不归这里
    const why = o && o.project !== project ? "出借单不属于这个项目" : askNotClosable(a, o);
    const row = { askId: a.id, orderId, status: o?.status ?? null };
    if (why) plan.kept.push({ ...row, reason: why });
    else plan.closable.push({ ...row, reason: reasonOf(o as AskOrderRef) });
  }
  return plan;
}

/**
 * --apply：拿写锁（BEGIN IMMEDIATE，同 ledger-asks 的 tx）后按同一套核对重算再关，预览之后变了的以此刻为准；
 * beforeWrite 在拿到锁之后、写入之前调（调度身份核租约），抛了就一条都不关
 */
export function applySettledAskSweep(db: Database, project: string, now: number, by: string, opts: { beforeWrite?: () => void } = {}):
  AskSweepPlan & { closed: string[] } {
  return busyAsLedgerError("回收旧提问", () => db.transaction(() => {
    opts.beforeWrite?.();
    const plan = planSettledAskSweep(db, project);
    const closed = plan.closable.map((r) => {
      const a = getAsk(db, r.askId), o = orderRef(db, r.orderId);
      return a && o && askNotClosable(a, o) === null ? closeOne(db, a, o, now, by) : null;
    }).filter((id): id is string => !!id);
    return { ...plan, closed };
  }).immediate());
}

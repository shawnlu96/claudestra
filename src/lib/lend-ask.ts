/**
 * 出借单交给出借方 owner 看的那组参数（通知正文用，lend-notice.ts），以及逐单确认退役后的收尾：升级前已经开出去、还挂着的 lend_claim ask
 * 由调度服务经 `ledger lend-ask --retire <askId>` 关掉（原因「改为一次授权」），不再开新的。参数一律按格式收，不收自由文本。
 * 纯函数 + 读写台账，tests/lend-ask.test.ts。
 */
import type { Database } from "bun:sqlite";
import { closeAsk, getAsk, hasAsksTable } from "./ledger-asks.js";
import { isFullSha } from "./order-wire.js";

/** 升级前逐单确认 ask 的 bind.action：只认这一种，别的 ask 拿来 retire 一律拒 */
const LEND_ASK_ACTION = "lend_claim";

export interface LendAskParams {
  orderId: string;
  peer: string;
  fp: string | null;
  family: string;
  repo: string;
  pr: number | null;
  head: string;
  taskId: string;
  step: string;
  /** 额度的人话（今天第几单 / 占第几个位 / 授权到哪天），由 lend 循环按授权算好 */
  quota: string;
}

const ORDER_ID = /^[\w.:-]{1,200}$/;
const NAME = /^[\w.-]{1,64}$/;
const REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/(?!\.\.?$)[A-Za-z0-9_.-]{1,100}$/;
const FP = /^[0-9a-f]{4}(?:-[0-9a-f]{4}){3}$/i;
const LEND_ASK_KEYS = ["orderId", "peer", "fp", "family", "repo", "pr", "head", "taskId", "step", "quota"];

/** 参数形状；null = 合法。extra = 调用方自己核过的附加字段（通知种类等），不算「不认识」 */
export function lendAskProblem(p: unknown, extra: readonly string[] = []): string | null {
  const r = p as Record<string, unknown> | null;
  if (!r || typeof r !== "object" || Array.isArray(r)) return "参数要是对象";
  const unknown = Object.keys(r).filter((k) => !LEND_ASK_KEYS.includes(k) && !extra.includes(k));
  if (unknown.length) return `不认识的字段 ${unknown.join(", ")}`;
  if (typeof r.orderId !== "string" || !ORDER_ID.test(r.orderId)) return "orderId 格式不对";
  for (const k of ["peer", "family", "taskId", "step"] as const) if (typeof r[k] !== "string" || !NAME.test(r[k] as string)) return `${k} 格式不对`;
  if (r.fp !== null && (typeof r.fp !== "string" || !FP.test(r.fp))) return "fp 格式不对";
  if (typeof r.repo !== "string" || !REPO.test(r.repo)) return "repo 要是 GitHub owner/repo";
  if (r.pr !== null && !(Number.isInteger(r.pr) && (r.pr as number) > 0 && (r.pr as number) < 1e9)) return "pr 要是正整数或 null";
  if (typeof r.head !== "string" || !isFullSha(r.head)) return "head 要是完整 SHA";
  if (typeof r.quota !== "string" || r.quota.length > 200 || /[\p{Cc}]/u.test(r.quota)) return "quota 要是 200 字以内的一行字";
  return null;
}

export const RETIRED_REASON = "逐单确认已退役，改为一次授权";

/**
 * 关掉一张升级前的逐单确认 ask：不是 lend_claim 的拒（返回原因），已经不 open 的当作已关（重复调无害）。返回 null = 关了或本来就关着。
 * beforeWrite 在拿到写锁之后、写之前调（同 openAskFull）：调度服务等锁期间失租就抛，什么都不写。
 */
export function retireLendAsk(db: Database, askId: string, now = Date.now(), opts: { beforeWrite?: () => void } = {}): string | null {
  return db.transaction(() => {
    opts.beforeWrite?.();
    const a = hasAsksTable(db) ? getAsk(db, askId) : null;
    if (!a) return null; // 台账里已经没有这张卡：没有可关的，当作已关
    if (a.bind?.action !== LEND_ASK_ACTION) return `ask ${askId} 不是出借逐单确认`;
    closeAsk(db, askId, "cancelled", RETIRED_REASON, now);
    return null;
  }).immediate();
}

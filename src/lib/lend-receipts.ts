/**
 * 出借收据（docs/design/remote-capacity.md §3「B 只留收据」）：statePath("lend","receipts.jsonl")，一单结束（acked / stopped / cancelled / released）
 * 追加一行：谁的单、哪张卡哪一步、哪个 head、哪个会话、起止时间、token 用量、A 回执的签名。不存规格正文、不存结论正文。
 * token 用量按会话从 token 账（T83，usage-store）取，账里没有就写「未知」而不是 0。tests/lend-journal.test.ts「收据」。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { orderOf, type LendRow } from "./lend-journal.js";
import { statePath } from "./paths.js";

export const LEND_RECEIPTS_PATH = statePath("lend", "receipts.jsonl");

export type Tokens = { input: number; cacheCreation: number; cacheRead: number; output: number; totalTokens: number } | "未知";

export interface LendReceipt {
  orderId: string;
  peer: string;
  fp: string | null;
  taskId: string | null;
  step: string | null;
  repo: string | null;
  pr: number | null;
  head: string | null;
  family: string;
  agent: string | null;
  sessionId: string | null;
  outcome: LendRow["state"];
  reason: string | null;
  startedAt: string;
  endedAt: string;
  tokens: Tokens;
  /** A 签过的回执（acked 才有）：{orderId, sha256, eventSeq, taskId} 与签名，原样存 */
  ackSig: unknown;
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

export function receiptOf(row: LendRow, tokens: Tokens, now = Date.now()): LendReceipt {
  const src = { ...row.preview, ...(orderOf(row) ?? {}) } as Record<string, unknown>;
  return {
    orderId: row.orderId, peer: row.peer, fp: row.fp, taskId: str(src.taskId), step: str(src.step), repo: str(src.repo),
    pr: typeof src.pr === "number" ? src.pr : null, head: str(src.head), family: row.family, agent: row.agent, sessionId: row.sessionId,
    outcome: row.state, reason: row.reason, startedAt: new Date(row.createdAt).toISOString(), endedAt: new Date(now).toISOString(), tokens,
    ackSig: row.receipt ?? null,
  };
}

/** 读会话用量：库打不开 / 没这个会话都记「未知」（收据不能因为用量读不到就不写） */
export async function tokensFor(sessionId: string | null): Promise<Tokens> {
  if (!sessionId) return "未知";
  try {
    const { openUsageDb, USAGE_DB_PATH } = await import("./usage-store.js");
    if (!existsSync(USAGE_DB_PATH)) return "未知";
    const db = openUsageDb();
    try {
      const { sessionTokens } = await import("./usage-query.js");
      const t = sessionTokens(db, sessionId);
      return t ? { input: t.input, cacheCreation: t.cacheCreation, cacheRead: t.cacheRead, output: t.output, totalTokens: t.totalTokens } : "未知";
    } finally { db.close(); }
  } catch (e) {
    console.error(`⚠️ [lend] 读 ${sessionId} 的 token 用量失败，收据记未知：${(e as Error).message}`);
    return "未知";
  }
}

/** 同一 orderId 只写一行：重启后重做收尾时不会记两遍 */
export function appendReceipt(r: LendReceipt, path = LEND_RECEIPTS_PATH): boolean {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (existsSync(path) && readFileSync(path, "utf8").split("\n").some((l) => l.startsWith(`{"orderId":${JSON.stringify(r.orderId)},`))) return false;
  appendFileSync(path, `${JSON.stringify(r)}\n`, { mode: 0o600 });
  return true;
}

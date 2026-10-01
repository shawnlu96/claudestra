/**
 * 非 CC 会话（Pi / Codex）的「已投递入站」账（docs/design/t74-inbound-ledger.md）：bridge 每投出一条就按 (agent, message_id)
 * 记下正文 sha256 和当时发出的 meta，不存正文。读历史时 cc-own-records.verifiedForeignBlocks 拿块头的 message_id 当键查账、比哈希，
 * 对上才按账上的 meta 认来源——Pi / Codex 记录里的头只是正文文字，谁都能写，账在正文之外。
 * 表在 web-state.sqlite（bridge 独占、持久）；不放媒体索引库：那是缓存，损坏会整库删。写失败只记日志、不影响投递；读出错按无账（保守）。
 */
import type { Database } from "bun:sqlite";
import { sha256Hex } from "./acp/install.js";
import { canonicalAgent } from "./media-outbound.js";

/** 按 message_id 查账：正文 sha256 + bridge 当时发出的 meta；没有这条 → null */
export type InboundLookup = (mid: string) => { sha: string; meta: Record<string, string> } | null;

const KEEP_MS = 180 * 86_400_000;
const MAX_ROWS = 200_000;
const PRUNE_EVERY_MS = 86_400_000;
/** 0 = 本进程还没清过：bridge 起来后的第一笔顺手清一次 */
let lastPrune = 0;

export const inboundSha = (content: string): string => sha256Hex(Buffer.from(content, "utf8"));

/** openWebState 建表时调用。不进 WEB_STATE_TABLES：那是从旧 BFF settings.db 搬表的清单，旧库没有这张表 */
export function ensureInboundTable(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS inbound_ledger (
    agent TEXT NOT NULL, mid TEXT NOT NULL, sha TEXT NOT NULL, ms INTEGER NOT NULL, meta TEXT NOT NULL, PRIMARY KEY (agent, mid))`);
  db.exec("CREATE INDEX IF NOT EXISTS inbound_ledger_ms ON inbound_ledger(ms)");
}

/** 投递成功后记一笔：同一 mid 重投（押后队列 flush）就覆盖写。从不抛错——写账失败只是这条历史退回保守，投递不能受影响 */
export function noteInbound(db: Database, agent: string, mid: string | undefined, content: string, meta: Record<string, string>, now: number): void {
  if (!mid || agent === "?") return;
  try {
    db.query("INSERT OR REPLACE INTO inbound_ledger (agent, mid, sha, ms, meta) VALUES (?, ?, ?, ?, ?)")
      .run(canonicalAgent(agent), mid, inboundSha(content), now, JSON.stringify(meta));
    if (now - lastPrune >= PRUNE_EVERY_MS) {
      lastPrune = now;
      pruneInbound(db, now);
    }
  } catch (e) {
    console.error(`入站账写入失败（投递照常，这条历史按保守显示）: ${(e as Error).message}`);
  }
}

/**
 * 这个 agent 收到了不经包装、原样进会话记录的入站（tmux 版 Pi）：外源能把 owner 某条真消息的整块包装照抄进自己的正文，
 * 凭真 mid + 原文对上账。所以整份清掉，它的记录一律保守；切回包装投递后重新记。从不抛错，失败记日志
 */
export function forgetInbound(db: Database, agent: string): void {
  try {
    db.query("DELETE FROM inbound_ledger WHERE agent = ?").run(canonicalAgent(agent));
  } catch (e) {
    console.error(`入站账清除失败（${agent}）: ${(e as Error).message}`);
  }
}

/** 删 180 天前的，再按时间只留最新 maxRows 行 */
export function pruneInbound(db: Database, now: number, maxRows = MAX_ROWS): void {
  db.query("DELETE FROM inbound_ledger WHERE ms < ?").run(now - KEEP_MS);
  db.query("DELETE FROM inbound_ledger WHERE rowid IN (SELECT rowid FROM inbound_ledger ORDER BY ms DESC LIMIT -1 OFFSET ?)").run(maxRows);
}

const isStringRecord = (v: unknown): v is Record<string, string> =>
  typeof v === "object" && v !== null && !Array.isArray(v) && Object.values(v).every((x) => typeof x === "string");

/** 一个 agent 的查账函数。表缺失 / 库坏 / 行坏都按「没有这条」（历史退回保守、不 500），每个查账函数只记一次日志 */
export function inboundLookup(db: Database, agent: string): InboundLookup {
  const who = canonicalAgent(agent);
  let logged = false;
  return (mid) => {
    try {
      const row = db.query("SELECT sha, meta FROM inbound_ledger WHERE agent = ? AND mid = ?").get(who, mid) as { sha: string; meta: string } | null;
      const meta: unknown = row ? JSON.parse(row.meta) : null;
      return row && isStringRecord(meta) ? { sha: row.sha, meta } : null;
    } catch (e) {
      if (!logged) console.error(`入站账读取失败（${who}），按无账处理: ${(e as Error).message}`);
      logged = true;
      return null;
    }
  };
}

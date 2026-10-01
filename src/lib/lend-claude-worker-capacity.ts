/** Claude 出借只认 owner 显式提供的 setup-token；不从 ~/.claude 或系统钥匙串搬登录状态。 */
import type { Database } from "bun:sqlite";
import type { LendEntry } from "./lend-config.js";
import { LEASED_STATES, openSlots, ordersToday } from "./lend-journal.js";
import { pausedUntil } from "./lend-health.js";

import { readClaudeLendToken } from "./lend-claude-token.js";

export const CLAUDE_LEND_TOKEN = "CLAUDE_CODE_OAUTH_TOKEN";
let warned = false;

export function claudeLendSlots(entry: LendEntry | undefined, env = process.env, log = console.error): number {
  const slots = entry?.families.claude ?? 0;
  if (!slots) return 0;
  if (readClaudeLendToken(env)) { warned = false; return slots; }
  if (!warned) {
    log("[lend] Claude 位不可用：请运行 claude setup-token，将 CLAUDE_CODE_OAUTH_TOKEN 配给出借调度服务，再重授 --claude N；不读取本机 ~/.claude 登录。");
    warned = true;
  }
  return 0;
}

export const claudeHelloSlots = (db: Database, e: LendEntry | undefined) =>
  ({ total: claudeLendSlots(e), busy: e ? Math.min(openSlots(db, e.peer, "claude"), 100) : 0 });

/** v1 不改字段形状；busy 仍只数已领单，Codex 暂停只冻结 Codex。 */
export function lendPollCapacity(e: LendEntry, db: Database, now: number) {
  const busy = (family: string) => (db.query(`SELECT COUNT(*) AS n FROM lend_orders WHERE peer = ? AND family = ?
    AND state IN (${LEASED_STATES.map(() => "?").join(",")})`).get(e.peer, family, ...LEASED_STATES) as { n: number }).n;
  return { families: { codex: pausedUntil(db, now) === null ? e.families.codex ?? 0 : 0, claude: claudeLendSlots(e) },
    busy: { codex: busy("codex"), claude: busy("claude") }, roles: e.roles, repos: e.repos,
    ordersLeftToday: Math.max(0, e.ordersPerDay - ordersToday(db, e.peer, now)) };
}

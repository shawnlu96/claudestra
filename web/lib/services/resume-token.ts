import { createHash } from "crypto";
import { nanoid } from "nanoid";
import { getDb } from "../db";

/**
 * 原生壳的「记住登录」续期凭证。iOS 壳（WKWebView）冷启动后常丢 cookie，但 localStorage 留着
 * （2026-09-24：每次冷启动都要重登，而上次打开的会话——存在 localStorage——次次都还原了）。
 * 登录后壳把一枚凭证存进 localStorage；冷启动发现 cookie 没了，就拿它换一个新会话。
 *
 * - 库里只存 sha256：库泄露拿不到可用凭证
 * - 一次一换：兑换即作废旧的、发一枚新的；被偷的凭证只要主人先用过一次就废了
 * - 整条链的到期时间 = 最初那次登录的到期时间：凭证不给登录续命，7 天照样要重登一次
 */
const hash = (token: string) => createHash("sha256").update(token).digest("hex");

export function issueResumeToken(username: string, expiresAt: string): string {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare("DELETE FROM resume_tokens WHERE expires_at <= ?").run(now);
  const token = nanoid(43); // ≈256 bit
  db.prepare("INSERT INTO resume_tokens (hash, username, expires_at, created_at) VALUES (?, ?, ?, ?)").run(
    hash(token),
    username,
    expiresAt,
    now,
  );
  return token;
}

/** 兑换（单次有效）：命中且未过期 → 删掉并返回归属；否则 null */
export function redeemResumeToken(token: string): { username: string; expiresAt: string } | null {
  if (!token || token.length > 200) return null;
  const db = getDb();
  const row = db.transaction(() => {
    const r = db.prepare("SELECT username, expires_at FROM resume_tokens WHERE hash = ?").get(hash(token)) as
      | { username: string; expires_at: string }
      | undefined;
    if (r) db.prepare("DELETE FROM resume_tokens WHERE hash = ?").run(hash(token));
    return r;
  })();
  if (!row || Date.parse(row.expires_at) <= Date.now()) return null;
  return { username: row.username, expiresAt: row.expires_at };
}

/** 登出时连同续期凭证一起作废——否则登出后壳冷启动又自己登回来了 */
export function revokeResumeTokens(username: string): void {
  getDb().prepare("DELETE FROM resume_tokens WHERE username = ?").run(username);
}

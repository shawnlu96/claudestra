import { getDb } from "../db";

/**
 * 登录安全加固（owner 2026-08-09「设置里可选启用」第一期）。
 *
 * 现有的内存限速（auth.service checkRateLimit，5/60s）是「同一分钟内挡一下」，
 * 但重启即失忆、且窗口一过就重置——对慢速密码喷洒（每分钟 4 发、跨小时）几乎
 * 无效。这里补的是**持久化累进封禁**：连续失败越多锁越久，锁定状态存 SQLite，
 * 跨进程重启不清零。登录成功即清账。
 *
 * 两者叠加、不互斥：限速挡瞬时爆发，封禁挡长期慢速喷洒。
 */

/** 累进锁定时长（纯函数，便于推理/测试）。失败计数达到每一档阈值时的锁定分钟数。
 *  低于首档不锁（正常人手滑几下不该被关门外）。 */
export function lockoutMinutes(failCount: number): number {
  if (failCount >= 20) return 60;
  if (failCount >= 15) return 15;
  if (failCount >= 10) return 5;
  if (failCount >= 5) return 1;
  return 0;
}

interface LockRow {
  k: string;
  fail_count: number;
  locked_until: number;
  updated_at: number;
}

/** 是否启用累进封禁（auth_config.brute_force_on，默认开）。 */
export function bruteForceEnabled(): boolean {
  try {
    const row = getDb("settings")
      .prepare("SELECT brute_force_on FROM auth_config WHERE id = 1")
      .get() as { brute_force_on: number } | undefined;
    return row ? row.brute_force_on === 1 : true;
  } catch {
    return true; // 读不到配置时保守启用（宁可多挡，不留敞口）
  }
}

/**
 * 登录**前**检查是否处于锁定期。返回 {locked, retryAfterSec}。
 * 未启用封禁、或无锁定记录 → locked:false。锁已过期顺手清 locked_until。
 */
export function checkLockout(key: string, now = Date.now()): { locked: boolean; retryAfterSec: number } {
  if (!bruteForceEnabled()) return { locked: false, retryAfterSec: 0 };
  const db = getDb("settings");
  const row = db.prepare("SELECT * FROM login_lockouts WHERE k = ?").get(key) as LockRow | undefined;
  if (!row || row.locked_until <= now) return { locked: false, retryAfterSec: 0 };
  return { locked: true, retryAfterSec: Math.ceil((row.locked_until - now) / 1000) };
}

/**
 * 记录一次登录失败。失败数 +1，按累进表设定新的 locked_until。
 * 返回本次失败后的 {failCount, lockedForMin}（0=未触发锁定）。
 */
export function recordFailure(key: string, now = Date.now()): { failCount: number; lockedForMin: number } {
  if (!bruteForceEnabled()) return { failCount: 0, lockedForMin: 0 };
  const db = getDb("settings");
  const row = db.prepare("SELECT * FROM login_lockouts WHERE k = ?").get(key) as LockRow | undefined;
  const failCount = (row?.fail_count ?? 0) + 1;
  const min = lockoutMinutes(failCount);
  const lockedUntil = min > 0 ? now + min * 60_000 : (row?.locked_until ?? 0);
  db.prepare(
    `INSERT INTO login_lockouts (k, fail_count, locked_until, updated_at)
     VALUES (@k, @fc, @lu, @ts)
     ON CONFLICT(k) DO UPDATE SET fail_count = @fc, locked_until = @lu, updated_at = @ts`
  ).run({ k: key, fc: failCount, lu: lockedUntil, ts: now });
  return { failCount, lockedForMin: min };
}

/** 登录成功：清掉该 key 的失败账。 */
export function clearFailures(key: string): void {
  try {
    getDb("settings").prepare("DELETE FROM login_lockouts WHERE k = ?").run(key);
  } catch {
    /* 非致命 */
  }
}

// ── auth_config 读写（设置页用）───────────────────────────────────────

export interface AuthConfig {
  bruteForceOn: boolean;
  totpOn: boolean;
  passkeyOn: boolean;
}

/** 读安全配置（不含 totp_secret 等敏感材料——那些永不出后端）。 */
export function readAuthConfig(): AuthConfig {
  try {
    const row = getDb("settings")
      .prepare("SELECT brute_force_on, totp_on, passkey_on FROM auth_config WHERE id = 1")
      .get() as { brute_force_on: number; totp_on: number; passkey_on: number } | undefined;
    return {
      bruteForceOn: row ? row.brute_force_on === 1 : true,
      totpOn: row ? row.totp_on === 1 : false,
      passkeyOn: row ? row.passkey_on === 1 : false,
    };
  } catch {
    return { bruteForceOn: true, totpOn: false, passkeyOn: false };
  }
}

/** 只更新累进封禁开关（第一期设置页唯一可改项；totp/passkey 由各自 enroll 流程管）。 */
export function setBruteForce(on: boolean): void {
  getDb("settings")
    .prepare("UPDATE auth_config SET brute_force_on = ?, updated_at = ? WHERE id = 1")
    .run(on ? 1 : 0, String(Date.now()));
}

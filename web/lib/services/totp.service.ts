import { createHash, randomBytes } from "crypto";
import * as OTPAuth from "otpauth";
import { getDb } from "../db";

/**
 * TOTP 两步验证（登录安全第二期，owner 2026-08-09「做成可选项」）。
 *
 * 设计取舍：
 * - **secret 只在服务端**：enroll 时生成、验证一次才落库激活；未激活的候选
 *   secret 存在内存里（进程重启即失效 —— enroll 是分钟级动作，无需持久化，
 *   反而少一处泄漏面）。
 * - **恢复码是硬需求**：这套系统没有第二个管理员能帮你重置，设备一丢就是永久
 *   失联。10 个一次性码，只存 sha256，明文仅生成时展示一次。
 * - **时间窗 ±1**：容忍设备时钟 30 秒内的漂移，再宽就削弱安全性。
 */

const ISSUER = "Claudestra";

/** 未激活的候选 secret（enroll 中间态，内存即可） */
let pendingSecret: { secret: string; at: number } | null = null;
const PENDING_TTL_MS = 10 * 60_000;

function totpFor(secret: string, label: string): OTPAuth.TOTP {
  return new OTPAuth.TOTP({
    issuer: ISSUER,
    label,
    algorithm: "SHA1", // 认证器 App 的通用默认，改了会导致大部分 App 算不对
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secret),
  });
}

/** 生成候选 secret + otpauth:// URI（enroll 第一步；此时还没激活） */
export function beginEnroll(username: string): { secret: string; uri: string } {
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  pendingSecret = { secret, at: Date.now() };
  return { secret, uri: totpFor(secret, username || "user").toString() };
}

/** 校验一个 6 位码是否匹配给定 secret（window=1 容忍 ±30s 漂移） */
function verifyCode(secret: string, token: string): boolean {
  const clean = (token || "").replace(/\D/g, "");
  if (clean.length !== 6) return false;
  return totpFor(secret, "user").validate({ token: clean, window: 1 }) !== null;
}

/**
 * enroll 第二步：用候选 secret 验一次码，通过才真正落库激活 + 发恢复码。
 * 返回明文恢复码（**仅此一次**）。
 */
export function completeEnroll(token: string): { ok: boolean; error?: string; recoveryCodes?: string[] } {
  if (!pendingSecret || Date.now() - pendingSecret.at > PENDING_TTL_MS) {
    pendingSecret = null;
    return { ok: false, error: "enroll 会话已过期，请重新开始" };
  }
  if (!verifyCode(pendingSecret.secret, token)) {
    return { ok: false, error: "验证码不正确，请检查认证器时间是否同步" };
  }
  const db = getDb("settings");
  db.prepare("UPDATE auth_config SET totp_on = 1, totp_secret = ?, updated_at = ? WHERE id = 1")
    .run(pendingSecret.secret, String(Date.now()));
  pendingSecret = null;
  return { ok: true, recoveryCodes: regenerateRecoveryCodes() };
}

/** 关闭 TOTP：清 secret + 清恢复码（关掉就该不留残留） */
export function disableTotp(): void {
  const db = getDb("settings");
  db.prepare("UPDATE auth_config SET totp_on = 0, totp_secret = '', updated_at = ? WHERE id = 1")
    .run(String(Date.now()));
  db.prepare("DELETE FROM totp_recovery_codes").run();
  pendingSecret = null;
}

export function totpEnabled(): boolean {
  try {
    const row = getDb("settings")
      .prepare("SELECT totp_on, totp_secret FROM auth_config WHERE id = 1")
      .get() as { totp_on: number; totp_secret: string } | undefined;
    return !!row && row.totp_on === 1 && !!row.totp_secret;
  } catch {
    return false; // 读不到配置时不拦登录——把人锁在门外比少一道验证更糟
  }
}

/**
 * 登录第二步校验：先试 TOTP 码，不匹配再试恢复码（一次性，用掉即作废）。
 * 返回 {ok, usedRecovery} —— 用掉恢复码时调用方应提醒用户剩余数量。
 */
export function verifySecondFactor(token: string): { ok: boolean; usedRecovery?: boolean; remaining?: number } {
  const db = getDb("settings");
  const row = db.prepare("SELECT totp_secret FROM auth_config WHERE id = 1").get() as
    | { totp_secret: string }
    | undefined;
  if (row?.totp_secret && verifyCode(row.totp_secret, token)) return { ok: true };

  // 恢复码：规范化（去空格/连字符、转大写）后比对哈希
  const norm = (token || "").replace(/[\s-]/g, "").toUpperCase();
  if (norm.length < 8) return { ok: false };
  const hash = createHash("sha256").update(norm).digest("hex");
  const hit = db
    .prepare("SELECT code_hash FROM totp_recovery_codes WHERE code_hash = ? AND used_at IS NULL")
    .get(hash) as { code_hash: string } | undefined;
  if (!hit) return { ok: false };
  db.prepare("UPDATE totp_recovery_codes SET used_at = ? WHERE code_hash = ?")
    .run(new Date().toISOString(), hash);
  const remaining = (
    db.prepare("SELECT COUNT(*) AS n FROM totp_recovery_codes WHERE used_at IS NULL").get() as { n: number }
  ).n;
  return { ok: true, usedRecovery: true, remaining };
}

/** 重新生成 10 个恢复码（旧的全部作废）。返回明文，仅此一次。 */
export function regenerateRecoveryCodes(): string[] {
  const db = getDb("settings");
  db.prepare("DELETE FROM totp_recovery_codes").run();
  const codes: string[] = [];
  const now = new Date().toISOString();
  const ins = db.prepare("INSERT INTO totp_recovery_codes (code_hash, created_at) VALUES (?, ?)");
  for (let i = 0; i < 10; i++) {
    // Crockford-ish base32，去掉易混字符（0/O、1/I/L）；分两段便于抄写
    const alphabet = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
    let s = "";
    for (const b of randomBytes(10)) s += alphabet[b % alphabet.length];
    const code = `${s.slice(0, 5)}-${s.slice(5)}`;
    codes.push(code);
    ins.run(createHash("sha256").update(code.replace(/-/g, "")).digest("hex"), now);
  }
  return codes;
}

/** 剩余可用恢复码数量（设置页展示，提醒用户及时重生成） */
export function recoveryCodesRemaining(): number {
  try {
    return (
      getDb("settings")
        .prepare("SELECT COUNT(*) AS n FROM totp_recovery_codes WHERE used_at IS NULL")
        .get() as { n: number }
    ).n;
  } catch {
    return 0;
  }
}

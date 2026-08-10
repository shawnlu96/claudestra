import { randomBytes } from "crypto";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import type {
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
} from "@simplewebauthn/server";
import { getDb } from "../db";

/**
 * Passkey / WebAuthn（登录安全第三期，owner 2026-08-09「做成可选项」）。
 *
 * 为什么值得做：它是这三期里唯一**不可钓鱼、不可爆破**的因素——凭据由浏览器
 * 绑定到 rpID，钓鱼站拿不到；私钥在设备安全芯片里，撞库无从谈起。而且体验是
 * 负成本（指纹/面容比打密码快）。
 *
 * ## rpID 的硬约束（本项目的关键设计点）
 * WebAuthn 凭据绑定 rpID，**跨域不可用**。本 web 有多个入口：
 *   - https://claude.sunstriker.cc
 *   - https://mac-mini-jp.tailfdc471.ts.net （Tailscale MagicDNS）
 *   - http://localhost:3333（本机，浏览器视作 secure context，可用）
 *   - http://<tailscale-ip>:3333 —— **WebAuthn 用不了**（非 secure context，
 *     且 IP 不能作 rpID）。这类入口下前端不展示 passkey 入口。
 * 这些是彼此独立的域，一个 passkey 覆盖不了全部。所以 rpID 随凭据存，登录时
 * 按当前 origin 过滤——用户在哪个域用，就在那个域注册一个。
 */

export interface StoredCredential {
  cred_id: string;
  public_key: string;
  counter: number;
  rp_id: string;
  transports: string;
  name: string;
  created_at: string;
  last_used_at: string | null;
}

/**
 * 从请求推导 rpID 与 origin。反代（Caddy）后端是 http，必须认
 * x-forwarded-host / x-forwarded-proto，否则 rpID 会算成 127.0.0.1。
 * 返回 null = 该入口不支持 WebAuthn（IP 字面量 / 非 secure context）。
 */
export function deriveRp(request: Request): { rpID: string; origin: string } | null {
  const h = request.headers;
  const fwdHost = h.get("x-forwarded-host")?.split(",")[0]?.trim();
  const host = (fwdHost || h.get("host") || "").trim();
  if (!host) return null;
  const proto = (h.get("x-forwarded-proto")?.split(",")[0]?.trim() || "http").toLowerCase();
  const hostname = host.replace(/:\d+$/, "");

  // IP 字面量不能作 rpID（规范要求可注册域名后缀）
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(":")) return null;
  // secure context：https 或 localhost。其余（明文 http 到域名）浏览器会拒
  const isLocalhost = hostname === "localhost" || hostname === "127.0.0.1";
  if (proto !== "https" && !isLocalhost) return null;

  return { rpID: hostname, origin: `${proto}://${host}` };
}

// ── 挑战暂存（内存，短 TTL）────────────────────────────────────────────
// 注册挑战要求已登录，认证挑战是**登录前**的（还没有 session），所以统一用
// 「服务端发 id、客户端带回」的模式，而不是塞 session。分钟级动作，不持久化。
const challenges = new Map<string, { challenge: string; rpID: string; at: number }>();
const CHALLENGE_TTL_MS = 5 * 60_000;

function putChallenge(challenge: string, rpID: string): string {
  const now = Date.now();
  for (const [k, v] of challenges) if (now - v.at > CHALLENGE_TTL_MS) challenges.delete(k);
  const id = randomBytes(16).toString("hex");
  challenges.set(id, { challenge, rpID, at: now });
  return id;
}

function takeChallenge(id: string, rpID: string): string | null {
  const hit = challenges.get(id);
  challenges.delete(id); // 一次性
  if (!hit || Date.now() - hit.at > CHALLENGE_TTL_MS) return null;
  if (hit.rpID !== rpID) return null; // 挑战不能跨域复用
  return hit.challenge;
}

// ── 凭据存取 ──────────────────────────────────────────────────────────

export function listCredentials(rpID?: string): StoredCredential[] {
  const db = getDb("settings");
  return (
    rpID
      ? db.prepare("SELECT * FROM webauthn_credentials WHERE rp_id = ? ORDER BY created_at").all(rpID)
      : db.prepare("SELECT * FROM webauthn_credentials ORDER BY created_at").all()
  ) as StoredCredential[];
}

export function passkeyCount(): number {
  return (
    getDb("settings").prepare("SELECT COUNT(*) AS n FROM webauthn_credentials").get() as { n: number }
  ).n;
}

export function deleteCredential(credId: string): void {
  getDb("settings").prepare("DELETE FROM webauthn_credentials WHERE cred_id = ?").run(credId);
}

export function renameCredential(credId: string, name: string): void {
  getDb("settings")
    .prepare("UPDATE webauthn_credentials SET name = ? WHERE cred_id = ?")
    .run(name.slice(0, 60), credId);
}

// ── 注册（需已登录）───────────────────────────────────────────────────

export async function beginRegistration(request: Request, username: string) {
  const rp = deriveRp(request);
  if (!rp) return { error: "当前访问地址不支持 Passkey（需要 HTTPS 域名或 localhost）" };
  const existing = listCredentials(rp.rpID);
  const options = await generateRegistrationOptions({
    rpName: "Claudestra",
    rpID: rp.rpID,
    userName: username || "claudestra",
    attestationType: "none", // 自托管单用户，不需要证明设备型号，少收集一份信息
    // 已注册的排除掉，避免同一设备重复注册出两条凭据
    excludeCredentials: existing.map((c) => ({
      id: c.cred_id,
      transports: c.transports ? (JSON.parse(c.transports) as never) : undefined,
    })),
    authenticatorSelection: {
      residentKey: "preferred",     // 可发现凭据 → 登录时无需先输用户名
      userVerification: "preferred", // 指纹/面容/PIN，设备不支持时不强求
    },
  });
  return { challengeId: putChallenge(options.challenge, rp.rpID), options };
}

export async function finishRegistration(
  request: Request,
  challengeId: string,
  response: RegistrationResponseJSON,
  name: string,
) {
  const rp = deriveRp(request);
  if (!rp) return { error: "当前访问地址不支持 Passkey" };
  const expected = takeChallenge(challengeId, rp.rpID);
  if (!expected) return { error: "注册会话已过期，请重试" };

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: expected,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpID,
      requireUserVerification: false,
    });
  } catch (e) {
    return { error: `验证失败：${(e as Error).message}` };
  }
  if (!verification.verified || !verification.registrationInfo) {
    return { error: "凭据验证未通过" };
  }

  const { credential } = verification.registrationInfo;
  getDb("settings")
    .prepare(
      `INSERT INTO webauthn_credentials (cred_id, public_key, counter, rp_id, transports, name, created_at)
       VALUES (@id, @pk, @counter, @rp, @tr, @name, @ts)
       ON CONFLICT(cred_id) DO UPDATE SET public_key=@pk, counter=@counter, rp_id=@rp, transports=@tr`
    )
    .run({
      id: credential.id,
      pk: Buffer.from(credential.publicKey).toString("base64"),
      counter: credential.counter,
      rp: rp.rpID,
      tr: JSON.stringify(credential.transports ?? []),
      name: (name || "").slice(0, 60) || "Passkey",
      ts: new Date().toISOString(),
    });
  return { ok: true, credId: credential.id };
}

// ── 认证（登录前，无 session）─────────────────────────────────────────

export async function beginAuthentication(request: Request) {
  const rp = deriveRp(request);
  if (!rp) return { error: "当前访问地址不支持 Passkey" };
  const creds = listCredentials(rp.rpID);
  if (creds.length === 0) return { error: "该地址下还没有注册过 Passkey" };
  const options = await generateAuthenticationOptions({
    rpID: rp.rpID,
    userVerification: "preferred",
    allowCredentials: creds.map((c) => ({
      id: c.cred_id,
      transports: c.transports ? (JSON.parse(c.transports) as never) : undefined,
    })),
  });
  return { challengeId: putChallenge(options.challenge, rp.rpID), options };
}

export async function finishAuthentication(
  request: Request,
  challengeId: string,
  response: AuthenticationResponseJSON,
): Promise<{ ok: true; credName: string } | { error: string }> {
  const rp = deriveRp(request);
  if (!rp) return { error: "当前访问地址不支持 Passkey" };
  const expected = takeChallenge(challengeId, rp.rpID);
  if (!expected) return { error: "登录会话已过期，请重试" };

  const db = getDb("settings");
  const cred = db
    .prepare("SELECT * FROM webauthn_credentials WHERE cred_id = ? AND rp_id = ?")
    .get(response.id, rp.rpID) as StoredCredential | undefined;
  if (!cred) return { error: "未知凭据" };

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: expected,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpID,
      requireUserVerification: false,
      credential: {
        id: cred.cred_id,
        publicKey: new Uint8Array(Buffer.from(cred.public_key, "base64")),
        counter: cred.counter,
        transports: cred.transports ? (JSON.parse(cred.transports) as never) : undefined,
      },
    });
  } catch (e) {
    return { error: `验证失败：${(e as Error).message}` };
  }
  if (!verification.verified) return { error: "凭据验证未通过" };

  // 计数器回退 = 凭据可能被克隆（规范建议拒绝）。counter 恒为 0 的认证器
  // （不少平台 passkey 就是）不参与该检查。
  const newCounter = verification.authenticationInfo.newCounter;
  if (cred.counter > 0 && newCounter > 0 && newCounter <= cred.counter) {
    return { error: "凭据计数器异常（疑似克隆），已拒绝" };
  }
  db.prepare("UPDATE webauthn_credentials SET counter = ?, last_used_at = ? WHERE cred_id = ?")
    .run(newCounter, new Date().toISOString(), cred.cred_id);
  return { ok: true, credName: cred.name };
}

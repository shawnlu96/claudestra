import { getDb } from "../db";
import { nanoid } from "nanoid";
import { Client } from "ssh2";
import { cookies } from "next/headers";
import type { Session } from "../types";

export const SESSION_COOKIE = "cstra_session";
const SESSION_DAYS = 7;

/**
 * 会话 cookie 的唯一写法（密码登录 / passkey / 落盘跳转三处共用——属性不一致浏览器会当成两个 cookie）。
 * Secure 默认关：这套 web 常经 Tailscale / 本机明文 HTTP 访问，Secure cookie 在 HTTP 下会被直接丢弃
 * → 登录成功却存不下、一直跳回登录页；只有前面是 HTTPS 反代的部署才设 COOKIE_SECURE=on。
 * （httpOnly + sameSite=strict 已防 XSS/CSRF，Secure 只防明文窃听。）
 */
export function sessionCookie(id: string, maxAgeSec = SESSION_DAYS * 24 * 60 * 60) {
  const secure = process.env.COOKIE_SECURE === "on";
  return { name: SESSION_COOKIE, value: id, httpOnly: true, sameSite: "strict" as const, secure, path: "/", maxAge: maxAgeSec };
}

// ---- SSH/PAM authentication ----
// 通过连接本机 SSH 服务校验账号密码（等价 PAM）。成功即视为鉴权通过。
//
// 目标 host/port **硬编码为本机**，绝不取自请求：否则未认证请求可把 host 指向
// 攻击者自控的 sshd（接受任意密码）来伪造"登录成功"、拿到合法会话，本机 PAM
// 门禁形同虚设，且 host/port 可任意 → 内网端口扫描 SSRF。若真有非本机 PAM 需求，
// 用服务端 env 白名单，绝不接受客户端传入。
const SSH_HOST = "127.0.0.1";
const SSH_PORT = 22;

export function verifySSH(username: string, password: string): Promise<boolean> {
  return new Promise((resolve) => {
    const conn = new Client();
    conn
      .on("ready", () => {
        conn.end();
        resolve(true);
      })
      .on("error", () => {
        resolve(false);
      })
      .connect({
        host: SSH_HOST,
        port: SSH_PORT,
        username,
        password,
        readyTimeout: 5000,
      });
  });
}

// ---- Rate limiting (in-memory) ----
//
// key 由调用方按客户端 IP 派生（见 login route），不是纯 username——否则换 username
// 即换桶，密码喷洒 / SSRF 探测不受限。Map 有界并惰性清扫过期项，防未认证请求用海量
// 一次性 key 撑爆内存。

const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 60 * 1000;
const MAX_KEYS = 10_000;

function sweepExpired(now: number): void {
  for (const [k, v] of loginAttempts) {
    if (now > v.resetAt) loginAttempts.delete(k);
  }
}

export function checkRateLimit(key: string): boolean {
  const now = Date.now();
  // 有界兜底：逼近上限先清过期项；清完仍满则拒绝（未认证内存膨胀防护）
  if (loginAttempts.size >= MAX_KEYS) {
    sweepExpired(now);
    if (loginAttempts.size >= MAX_KEYS) return false;
  }
  const entry = loginAttempts.get(key);
  if (!entry || now > entry.resetAt) {
    loginAttempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }
  entry.count++;
  return entry.count <= MAX_ATTEMPTS;
}

// ---- Session ----

export function createSession(username: string): Session {
  const db = getDb();
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  const session: Session = {
    id: nanoid(32),
    username,
    expires_at: expires.toISOString(),
    created_at: now.toISOString(),
  };
  db.prepare(
    `INSERT INTO sessions (id, username, expires_at, created_at)
     VALUES (@id, @username, @expires_at, @created_at)`
  ).run(session);
  return session;
}

export function getSession(sessionId: string): Session | undefined {
  const db = getDb();
  return db
    .prepare("SELECT * FROM sessions WHERE id = ? AND expires_at > ?")
    .get(sessionId, new Date().toISOString()) as Session | undefined;
}

export function deleteSession(sessionId: string) {
  const db = getDb();
  db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
}

// ---- Cookie helpers ----

export async function getSessionFromCookie(): Promise<Session | undefined> {
  const jar = await cookies();
  const sessionId = jar.get(SESSION_COOKIE)?.value;
  if (!sessionId) return undefined;
  return getSession(sessionId);
}

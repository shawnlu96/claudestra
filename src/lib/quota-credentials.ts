/**
 * 订阅额度查询的凭据适配器：读 Claude Code / Codex 的 OAuth token，并把它和账户键绑成一份「凭据句柄」。
 *
 * 契约（设计稿 T2b §2.1 / §5，其它模块不自己拼账户键、不碰秘密）：
 *   - 秘密只活在 authHeaders() 的闭包里：toJSON / inspect / 字符串化都只给脱敏形态；不进日志、文件、argv。
 *   - 账户键 = HMAC(本机密钥, provider:原始账户 id)，原始 id 不出本模块。Claude 的 token 在 Keychain、
 *     accountUuid 在 ~/.claude.json，分开存放，只能算「推定同一账号」→ identity "assumed"；Codex 同在 auth.json → "bound"。
 *   - 读取前后各读一次账户标识，变了就作废（identity_changed）；请求回来后 confirmCredential 再核一次。
 *   - Keychain 读不到不退到 ~/.claude/.credentials.json（本机那份是旧凭据，可能属于别的账号）。
 * 只读：不刷新 token、不登录登出。单测 tests/quota-credentials.test.ts（全部假 Keychain / 假文件）。
 */

import { createHash, createHmac, hkdfSync } from "node:crypto";
import { inspect } from "node:util";
import { homedir } from "node:os";
import { join } from "node:path";
import { instanceKeySync, type InstanceKey } from "./instance-key.js";

export type QuotaProvider = "claude" | "codex";

export type CredErrorCode =
  | "no_secret"
  | "keychain_denied"
  | "keychain_timeout"
  | "keychain_missing"
  | "keychain_error"
  | "auth_missing"
  | "auth_bad_shape"
  | "account_missing"
  | "token_expired"
  | "identity_changed";

export interface QuotaCredential {
  readonly provider: QuotaProvider;
  /** HMAC(本机密钥, provider:原始账户 id) 的前 32 位 hex */
  readonly accountKey: string;
  readonly identity: "assumed" | "bound";
  /** HMAC(本机密钥, 凭据内容)：只用来判「401 之后凭据换没换」 */
  readonly fingerprint: string;
  authHeaders(): Record<string, string>;
}

export type CredResult = { ok: true; cred: QuotaCredential } | { ok: false; code: CredErrorCode };

export type KeychainOutcome = { status: "ok"; stdout: string } | { status: "denied" | "missing" | "timeout" | "error" };

export interface CredDeps {
  readKeychain(service: string): Promise<KeychainOutcome>;
  /** 文件不存在（或读不了）返回 null */
  readText(path: string): Promise<string | null>;
  env: Record<string, string | undefined>;
  home: string;
  /** 本机 HMAC 密钥；拿不到返回 null */
  secret(): Buffer | null;
  now(): number;
}

type AnyRecord = Record<string, any>;

const HMAC_INFO = "claudestra-quota-hmac-v1";

/** 从本机实例私钥（instance-key.pem）派生额度模块专用的 HMAC 密钥；带用途标签，和签名等其它用途隔开 */
export function deriveQuotaSecret(key: InstanceKey | null = instanceKeySync()): Buffer | null {
  if (!key) return null;
  const d = key.privateKey.export({ format: "jwk" }).d;
  if (typeof d !== "string" || !d) return null;
  return Buffer.from(hkdfSync("sha256", Buffer.from(d, "base64url"), Buffer.alloc(0), HMAC_INFO, 32));
}

export function hmacHex(secret: Buffer, ...parts: string[]): string {
  return createHmac("sha256", secret).update(parts.join("\u0000")).digest("hex").slice(0, 32);
}

/**
 * Claude 的两个位置。CLAUDE_CONFIG_DIR 下 Keychain 服务名带「-<sha256(配置目录) 前 8 位>」后缀——
 * 这是按记忆写的 CC 行为，**未对真实 Keychain 验证**；读不到时调用方当 keychain_missing 降级到本机缓存，不报错。
 */
export function claudePaths(env: CredDeps["env"], home: string): { accountFile: string; keychainService: string } {
  const dir = env.CLAUDE_CONFIG_DIR;
  if (!dir) return { accountFile: join(home, ".claude.json"), keychainService: "Claude Code-credentials" };
  const suffix = createHash("sha256").update(dir).digest("hex").slice(0, 8);
  return { accountFile: join(dir, ".claude.json"), keychainService: `Claude Code-credentials-${suffix}` };
}

export function codexAuthPath(env: CredDeps["env"], home: string): string {
  return join(env.CODEX_HOME || join(home, ".codex"), "auth.json");
}

function parseJson(text: string | null): AnyRecord | null {
  if (text === null) return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" ? v : null;
  } catch {
    return null; // 形状不对由调用方按 auth_bad_shape / account_missing 报固定错误码，原文不外传
  }
}

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 8192;

async function claudeAccountId(deps: CredDeps): Promise<string | null> {
  const j = parseJson(await deps.readText(claudePaths(deps.env, deps.home).accountFile));
  const id = j?.oauthAccount?.accountUuid;
  return nonEmpty(id) ? id : null;
}

async function codexAuth(deps: CredDeps): Promise<{ token: string; accountId: string } | CredErrorCode> {
  const raw = await deps.readText(codexAuthPath(deps.env, deps.home));
  if (raw === null) return "auth_missing";
  const j = parseJson(raw);
  if (!j) return "auth_bad_shape";
  const token = j.tokens?.access_token;
  const accountId = j.tokens?.account_id;
  if (!nonEmpty(token)) return "auth_bad_shape";
  if (!nonEmpty(accountId)) return "account_missing";
  return { token, accountId };
}

/** 句柄：秘密只在闭包里；所有能把对象变成文字的路径都只给脱敏形态 */
function makeCredential(
  base: { provider: QuotaProvider; accountKey: string; identity: "assumed" | "bound"; fingerprint: string },
  headers: () => Record<string, string>,
): QuotaCredential {
  const safe = { ...base };
  const cred = { ...base, authHeaders: headers };
  Object.defineProperties(cred, {
    toJSON: { value: () => safe, enumerable: false },
    toString: { value: () => `[QuotaCredential ${base.provider}]`, enumerable: false },
    [inspect.custom]: { value: () => safe, enumerable: false },
    [Symbol.for("nodejs.util.inspect.custom")]: { value: () => safe, enumerable: false },
  });
  return Object.freeze(cred);
}

const KEYCHAIN_CODES: Record<Exclude<KeychainOutcome["status"], "ok">, CredErrorCode> = {
  denied: "keychain_denied",
  missing: "keychain_missing",
  timeout: "keychain_timeout",
  error: "keychain_error",
};

export async function readClaudeCredential(deps: CredDeps): Promise<CredResult> {
  const secret = deps.secret();
  if (!secret) return { ok: false, code: "no_secret" };
  const before = await claudeAccountId(deps);
  if (!before) return { ok: false, code: "account_missing" };
  const kc = await deps.readKeychain(claudePaths(deps.env, deps.home).keychainService);
  if (kc.status !== "ok") return { ok: false, code: KEYCHAIN_CODES[kc.status] };
  const oauth = parseJson(kc.stdout.trim())?.claudeAiOauth;
  const token = oauth?.accessToken;
  if (!nonEmpty(token)) return { ok: false, code: "auth_bad_shape" };
  // expiresAt 是毫秒；已过期的 token 发出去只会拿 401，等 CC 自己续期
  if (typeof oauth.expiresAt === "number" && oauth.expiresAt <= deps.now()) return { ok: false, code: "token_expired" };
  const after = await claudeAccountId(deps);
  if (after !== before) return { ok: false, code: "identity_changed" };
  const base = {
    provider: "claude" as const,
    accountKey: hmacHex(secret, "claude", before),
    identity: "assumed" as const,
    fingerprint: hmacHex(secret, "fp", token),
  };
  return { ok: true, cred: makeCredential(base, () => ({ Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" })) };
}

export async function readCodexCredential(deps: CredDeps): Promise<CredResult> {
  const secret = deps.secret();
  if (!secret) return { ok: false, code: "no_secret" };
  const a = await codexAuth(deps);
  if (typeof a === "string") return { ok: false, code: a };
  const base = {
    provider: "codex" as const,
    accountKey: hmacHex(secret, "codex", a.accountId),
    identity: "bound" as const,
    fingerprint: hmacHex(secret, "fp", a.token),
  };
  const { token, accountId } = a;
  return { ok: true, cred: makeCredential(base, () => ({ Authorization: `Bearer ${token}`, "ChatGPT-Account-Id": accountId })) };
}

/**
 * 只看账户标识、不碰秘密（不读 Keychain）：调度器在读凭据之前先用它判「这个账户是否在冷却 / 限频中」，
 * 既不为了被限频而白读一次 Keychain，也不会因为上一个账户在冷却而卡住刚换上的新账户。
 */
export async function peekAccountKey(p: QuotaProvider, deps: CredDeps): Promise<string | null> {
  const secret = deps.secret();
  if (!secret) return null;
  if (p === "claude") {
    const id = await claudeAccountId(deps);
    return id ? hmacHex(secret, "claude", id) : null;
  }
  const a = await codexAuth(deps);
  return typeof a === "string" ? null : hmacHex(secret, "codex", a.accountId);
}

/**
 * 请求回来后的复核：账户标识变了（换号）→ false，调用方丢弃结果。
 * Claude 只重读 ~/.claude.json，不再第二次读 Keychain（每次查询读两遍，弹框风险翻倍）；
 * Codex 重读 auth.json，账户与凭据指纹都比（续期落盘恰好发生在请求期间也作废这一次）。
 */
export async function confirmCredential(cred: QuotaCredential, deps: CredDeps): Promise<boolean> {
  const secret = deps.secret();
  if (!secret) return false;
  if (cred.provider === "claude") {
    const id = await claudeAccountId(deps);
    return id !== null && hmacHex(secret, "claude", id) === cred.accountKey;
  }
  const a = await codexAuth(deps);
  if (typeof a === "string") return false;
  return hmacHex(secret, "codex", a.accountId) === cred.accountKey && hmacHex(secret, "fp", a.token) === cred.fingerprint;
}

// ── Keychain：spawn /usr/bin/security 读 stdout，超时杀掉并回收 ─────────────────

interface SpawnedProc {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(signal?: number | NodeJS.Signals): void;
}
export type SpawnFn = (argv: string[]) => SpawnedProc;

const bunSpawn: SpawnFn = (argv) => Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" }) as unknown as SpawnedProc;

/** 输出上限：Keychain 里的凭据 blob 只有几 KB，超过就当异常，不无限读 */
const OUTPUT_CAP = 64 * 1024;

/**
 * 跑一个子进程读 stdout；超时 SIGKILL 并 await exited——不能只让 Promise 超时、留下进程和授权框。
 * argv 里不放秘密；stdout / stderr 只交给调用方判定，不打日志。
 */
export async function runWithTimeout(
  argv: string[],
  timeoutMs: number,
  spawn: SpawnFn = bunSpawn,
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  const proc = spawn(argv);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, timeoutMs);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (timedOut) return { code: null, stdout: "", stderr: "", timedOut };
    return { code, stdout: stdout.length > OUTPUT_CAP ? "" : stdout, stderr: stderr.slice(0, 512), timedOut };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 退出码与 stderr 的判定按 `security` 的常见表现写（44 = 找不到条目；锁屏 / 用户点拒绝走 stderr 文案），
 * **launchd 与锁屏环境下未实测**（T2b-1 红线不读真实 Keychain）；认不出的一律 error，调用方长冷却。
 */
export function classifyKeychain(r: { code: number | null; stdout: string; stderr: string; timedOut: boolean }): KeychainOutcome {
  if (r.timedOut) return { status: "timeout" };
  if (r.code === 0 && r.stdout) return { status: "ok", stdout: r.stdout };
  if (r.code === 44 || /could not be found/i.test(r.stderr)) return { status: "missing" };
  if (/interaction is not allowed|user canceled|denied|authoriz/i.test(r.stderr)) return { status: "denied" };
  return { status: "error" };
}

export function spawnKeychainReader(opts: { timeoutMs?: number; spawn?: SpawnFn } = {}): CredDeps["readKeychain"] {
  return async (service) =>
    classifyKeychain(await runWithTimeout(["/usr/bin/security", "find-generic-password", "-s", service, "-w"], opts.timeoutMs ?? 5000, opts.spawn));
}

/** 生产用的依赖（T2b-2 接线用）；密钥只派生一次 */
export function defaultCredDeps(): CredDeps {
  let secret: Buffer | null | undefined;
  return {
    readKeychain: spawnKeychainReader(),
    readText: async (path) => {
      try {
        const f = Bun.file(path);
        return (await f.exists()) ? await f.text() : null;
      } catch {
        return null; // 权限 / 竞态删掉：按「没有这份凭据」降级，错误原文可能带路径以外的东西，不外传
      }
    },
    env: process.env,
    home: homedir(),
    secret: () => (secret === undefined ? (secret = deriveQuotaSecret()) : secret),
    now: Date.now,
  };
}

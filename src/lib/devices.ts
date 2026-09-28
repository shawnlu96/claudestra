/**
 * 设备凭据（docs/design-hosted-frontend.md §3、§5）：person = principal，device = 挂在它下面的一条 credential。
 * owner 本人的所有设备共享 `owner:self` 这一个 principal（所以聊天身份 api:owner:self 只有一个，手机和电脑不会
 * 变成两个「用户」）；别人的设备是独立的 guest principal。凭据是高熵随机 token，服务端只存 sha256；浏览器以
 * HttpOnly cookie 持有（JS 拿不到、偷不走），每条有自己的 grant（能碰哪些 agent、能不能开终端、能不能管理）。
 * 全部纯函数 / 内存状态机（tests/devices.test.ts）；落盘由 bridge/devices.ts 经 principals.json。
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Principal, PrincipalsFile } from "./principals.js";
import { isMasterAgent } from "./registry.js";

export const OWNER_PRINCIPAL_ID = "owner:self";
export const DEVICE_COOKIE = "cstra_dev";
/** 非 GET/HEAD 必须带的头：cookie 会被浏览器自动附上，这个头浏览器不会——跨站表单打不进来 */
export const DEVICE_HEADER = "x-cstra-device";
/** 90 天不用就失效；每次使用往后滑 */
const CREDENTIAL_TTL_MS = 90 * 24 * 60 * 60_000;
/** lastSeenAt 至少隔这么久才落盘一次：每个请求都写 principals.json 是自找麻烦 */
const TOUCH_PERSIST_MS = 10 * 60_000;
const APPROVAL_TTL_MS = 10 * 60_000;
const CHALLENGE_TTL_MS = 2 * 60_000;

export interface Grant {
  /** 与 Principal.agents 同一写法："*" = 全部普通 agent，master 要显式列 */
  agents: string[];
  terminal: boolean;
  /** 管理端点：cron / projects / config / update / restart-all / devices / peers / stats / relay */
  manage: boolean;
}

export interface DeviceCredential {
  /** dev_ 开头的短 id，撤销 / 列表用 */
  id: string;
  /** 凭据格式版本；以后加公钥类凭据时换 type */
  v: 1;
  type: "bearer";
  /** sha256(token) hex */
  hash: string;
  deviceName: string;
  grant: Grant;
  createdAt: string;
  expiresAt: string;
  lastSeenAt?: string;
  lastIp?: string;
  disabled?: boolean;
  /** 审计：谁签的配对码 / 谁批准的手输短码（凭据 id，本机终端是 "cli"；本机一键配对、旧登录迁移没有） */
  issuedBy?: string;
  approvedBy?: string;
}

export type Random = (n: number) => Uint8Array;
const defaultRandom: Random = (n) => new Uint8Array(randomBytes(n));

export const fullGrant = (): Grant => ({ agents: ["*", "master"], terminal: true, manage: true });

/** 用户输入（CLI flags / 网页对话框）→ 合法 grant；缺什么补默认，agents 去空去重 */
export function normalizeGrant(input: Partial<{ agents: unknown; terminal: unknown; manage: unknown }> | undefined, base: Grant = fullGrant()): Grant {
  const agents = Array.isArray(input?.agents) ? [...new Set(input!.agents.map((a) => String(a).trim()).filter(Boolean))] : base.agents;
  return {
    agents: agents.length ? agents : base.agents,
    terminal: typeof input?.terminal === "boolean" ? input.terminal : base.terminal,
    manage: typeof input?.manage === "boolean" ? input.manage : base.manage,
  };
}

/** guest 的默认：不碰 master、不开终端、不管理 */
export const guestGrant = (agents: string[]): Grant => ({ agents: agents.filter((a) => !isMasterAgent(a)), terminal: false, manage: false });

function newDeviceToken(random: Random = defaultRandom): string {
  return `dev_${Buffer.from(random(32)).toString("base64url")}`;
}

export function hashDeviceToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function newCredentialId(random: Random = defaultRandom): string {
  return `dev_${Buffer.from(random(4)).toString("hex")}`;
}

function ownerPrincipal(file: PrincipalsFile): Principal | null {
  return file.principals.find((p) => p.id === OWNER_PRINCIPAL_ID) ?? null;
}

/** owner principal 不存在就建（第一次配对时）；role owner、全 agent + master、终端、镜像到 Discord 与 web-ui token 一致 */
export function ensureOwnerPrincipal(file: PrincipalsFile, now: Date = new Date()): Principal {
  const hit = ownerPrincipal(file);
  if (hit) return hit;
  const p: Principal = { id: OWNER_PRINCIPAL_ID, role: "owner", name: "owner", agents: ["*", "master"], terminal: true, mirror: true, createdAt: now.toISOString(), credentials: [] };
  file.principals.push(p);
  return p;
}

export function newGuestPrincipal(name: string, grant: Grant, now: Date = new Date(), random: Random = defaultRandom): Principal {
  return {
    id: `guest:${Buffer.from(random(4)).toString("hex")}`,
    role: "external",
    name,
    agents: grant.agents.filter((a) => !isMasterAgent(a)), // "agent-master" 也是大总管：agentInScope 对它逐字匹配
    ...(grant.terminal ? { terminal: true } : {}),
    mirror: true,
    createdAt: now.toISOString(),
    credentials: [],
  };
}

/** 生成一条凭据并挂到 principal 上；返回明文 token（只此一次） */
export function attachCredential(
  p: Principal,
  deviceName: string,
  grant: Grant,
  opts: { now?: Date; ip?: string | null; random?: Random; issuedBy?: string; approvedBy?: string } = {},
): { token: string; credential: DeviceCredential } {
  const now = opts.now ?? new Date();
  const random = opts.random ?? defaultRandom;
  const token = newDeviceToken(random);
  const credential: DeviceCredential = {
    id: newCredentialId(random), v: 1, type: "bearer", hash: hashDeviceToken(token),
    deviceName: deviceName.trim().slice(0, 64) || "device", grant,
    createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + CREDENTIAL_TTL_MS).toISOString(),
    ...(opts.ip ? { lastIp: opts.ip } : {}),
    ...(opts.issuedBy ? { issuedBy: opts.issuedBy } : {}),
    ...(opts.approvedBy ? { approvedBy: opts.approvedBy } : {}),
  };
  (p.credentials ??= []).push(credential);
  return { token, credential };
}

function hashEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a, "hex"), bb = Buffer.from(b, "hex");
  return ba.length === bb.length && ba.length > 0 && timingSafeEqual(ba, bb);
}

export interface CredentialHit {
  principal: Principal;
  credential: DeviceCredential;
}

/** cookie 里的 token → 哪条凭据；禁用、过期、principal 禁用都算没有 */
export function findCredential(file: PrincipalsFile, token: string, now: Date = new Date()): CredentialHit | null {
  if (!token.startsWith("dev_")) return null;
  const hash = hashDeviceToken(token);
  for (const principal of file.principals) {
    if (principal.disabled) continue;
    for (const credential of principal.credentials ?? []) {
      if (!credential.disabled && hashEquals(credential.hash, hash)) {
        return Date.parse(credential.expiresAt) > now.getTime() ? { principal, credential } : null;
      }
    }
  }
  return null;
}

/** 凭据在 principal 权限之内再收窄：agents 取交集，终端 / 管理两者都要 */
export function intersectAgents(principalAgents: string[], grantAgents: string[]): string[] {
  const out = new Set<string>();
  const pAll = principalAgents.includes("*"), gAll = grantAgents.includes("*");
  if (pAll && gAll) out.add("*");
  for (const a of grantAgents) {
    if (a === "*") continue;
    // master 的两种写法都只能来自 principal 显式列的 master——"*" 不含它，别让 "agent-master" 借 pAll 混进去
    if (isMasterAgent(a)) {
      if (principalAgents.some(isMasterAgent)) out.add("master");
    } else if (pAll || principalAgents.includes(a)) out.add(a);
  }
  if (gAll) for (const a of principalAgents) if (a !== "*" && !isMasterAgent(a)) out.add(a);
  return [...out];
}

/**
 * 请求里生效的 principal 视图：id / name / mirror 不变（聊天身份不变），agents 收窄，终端与管理按 grant。
 * role 保持——terminalAllowed 对 owner 一律放行，所以终端由这里的 terminal 字段单独关；manage=false 时
 * canManage 直接拒。
 */
export function effectivePrincipal(hit: CredentialHit): Principal {
  const { principal: p, credential: c } = hit;
  const terminal = c.grant.terminal && (p.role === "owner" || p.terminal === true);
  return { ...p, agents: intersectAgents(p.agents, c.grant.agents), terminal, role: terminal ? p.role : "external", manage: c.grant.manage && p.role === "owner", credential: c.id };
}

/** 管理端点的门：设备凭据看 grant.manage；老的全 scope 非 peer token 过渡期仍放行（T6 退场时收紧为只认 owner） */
export function canManage(p: Principal): boolean {
  if (p.manage === false) return false;
  return p.role === "owner" || (p.agents.includes("*") && !p.peer);
}

/**
 * 内置台账（docs 10-ledger §4）的唯一读门，API / SSE ledger 事件 / GET /agents 的 ledgerTask 三处共用。
 * 台账横跨整个项目的任务、执行者与 owner 原话，所以比 canManage 多要「全 scope、非 peer」：
 * 部分 scope 的 owner 设备、guest、peer（含历史上签过 "*" 的）一律不给；老的全 scope Bearer 随 canManage 过渡期放行。
 */
export function canReadLedger(p: Principal): boolean {
  return canManage(p) && p.agents.includes("*") && !p.peer;
}

/**
 * 在网页里发配对码 / 批准配对的门：要 manage，而且得是设备凭据——老的全 scope Bearer token 过渡期还能过 canManage，
 * 但不该拿它签出带终端和管理的新设备（codex 复核 #67）。本机终端走回环控制路由，不经这里。
 */
export function canAdministerPairing(p: Principal): boolean {
  return canManage(p) && !!p.credential;
}

/** 给出去的权限不能比自己手里的大：会话取交集，终端 / 管理要自己有才给得出。一个会话都不剩 → null */
export function capGrant(g: Grant, issuer: Principal): Grant | null {
  const agents = intersectAgents(issuer.agents, g.agents);
  if (!agents.length) return null;
  return { agents, terminal: g.terminal && (issuer.role === "owner" || issuer.terminal === true), manage: g.manage && canManage(issuer) };
}

/** 记一次使用：lastSeenAt / lastIp / 到期往后滑。返回 true = 变化大到该落盘了 */
export function touchCredential(c: DeviceCredential, now: Date, ip: string | null): boolean {
  const last = c.lastSeenAt ? Date.parse(c.lastSeenAt) : 0;
  if (now.getTime() - last < TOUCH_PERSIST_MS && (!ip || ip === c.lastIp)) return false;
  c.lastSeenAt = now.toISOString();
  c.expiresAt = new Date(now.getTime() + CREDENTIAL_TTL_MS).toISOString();
  if (ip) c.lastIp = ip;
  return true;
}

export function cookieValueFrom(header: string | null, name: string = DEVICE_COOKIE): string | null {
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/** 签发 / 删除 cookie 的 Set-Cookie 值。经中继时中继会把 Path 钉成 /m/<fp>/ 并补 Secure（lib/relay-machine-path.ts） */
export function deviceCookieHeader(token: string | null, opts: { path?: string; secure: boolean; maxAgeSec?: number }): string {
  const maxAge = token ? (opts.maxAgeSec ?? Math.floor(CREDENTIAL_TTL_MS / 1000)) : 0;
  return [`${DEVICE_COOKIE}=${token ?? ""}`, `Path=${opts.path ?? "/"}`, `Max-Age=${maxAge}`, "HttpOnly", "SameSite=Strict", ...(opts.secure ? ["Secure"] : [])].join("; ");
}

/** CSRF：cookie 鉴权的非 GET/HEAD 必须带自定义头 */
export function csrfOk(method: string, headerValue: string | null): boolean {
  const m = method.toUpperCase();
  return m === "GET" || m === "HEAD" || headerValue !== null;
}

// ── 配对用的两个内存状态机 ───────────────────────────────────────────────

/** 二维码配对的挑战：一次性、2 分钟；最多 100 个在途，多了顶掉最旧的 */
export class ChallengeStore {
  private readonly issued = new Map<string, number>();
  constructor(private readonly now: () => number = Date.now, private readonly random: Random = defaultRandom, private readonly max = 100, private readonly ttlMs = CHALLENGE_TTL_MS) {}

  issue(): { challenge: string; expiresAt: number } {
    this.prune();
    while (this.issued.size >= this.max) this.issued.delete(this.issued.keys().next().value!);
    const challenge = Buffer.from(this.random(32)).toString("base64url");
    const expiresAt = this.now() + this.ttlMs;
    this.issued.set(challenge, expiresAt);
    return { challenge, expiresAt };
  }

  /** true = 是我签的、没过期、没用过；用掉 */
  consume(challenge: string): boolean {
    this.prune();
    const exp = this.issued.get(challenge);
    this.issued.delete(challenge);
    return exp !== undefined && exp > this.now();
  }

  private prune(): void {
    const now = this.now();
    for (const [c, exp] of this.issued) if (exp <= now) this.issued.delete(c);
  }
}

export interface Approval {
  id: string;
  code: string;
  deviceName: string;
  clientIp: string | null;
  grant: Grant;
  guest?: string;
  /** 这个短码是谁签的（审计，见 pairing-codes IssuedCode.issuer） */
  issuer?: string;
  createdAt: number;
  expiresAt: number;
  /** approving = 有人点了批准、正在签凭据：不再出现在待批列表，别人的批准 / 拒绝都进不来 */
  state: "pending" | "approving" | "approved" | "denied";
  /** 批准后由 bridge 填：浏览器下一次轮询取走即删 */
  result?: { token: string; credentialId: string; principalId: string; expiresAt: string };
}

/** 手输短码的待确认队列：浏览器兑换成功 → pending → Mac 侧 approve/deny → 浏览器轮询取结果 */
export class Approvals {
  private readonly items = new Map<string, Approval>();
  constructor(private readonly now: () => number = Date.now, private readonly random: Random = defaultRandom, private readonly ttlMs = APPROVAL_TTL_MS) {}

  add(a: { code: string; deviceName: string; clientIp: string | null; grant: Grant; guest?: string; issuer?: string }): Approval {
    this.prune();
    const item: Approval = { id: Buffer.from(this.random(16)).toString("base64url"), ...a, createdAt: this.now(), expiresAt: this.now() + this.ttlMs, state: "pending" };
    this.items.set(item.id, item);
    return item;
  }

  pending(): Approval[] {
    this.prune();
    return [...this.items.values()].filter((a) => a.state === "pending");
  }

  get(id: string): Approval | null {
    this.prune();
    return this.items.get(id) ?? null;
  }

  /** 抢占一条待批：只有一个人能赢（多台设备同时点批准 / 一边批准一边拒绝）；已被抢 / 不存在返回 null */
  claim(id: string): Approval | null {
    const a = this.get(id);
    if (!a || a.state !== "pending") return null;
    a.state = "approving";
    return a;
  }

  /** 抢到之后的结论；签凭据失败时 release 放回待批，别人还能再批 */
  settle(id: string, approve: boolean, result?: Approval["result"]): void {
    const a = this.items.get(id);
    if (!a || a.state !== "approving") return;
    a.state = approve ? "approved" : "denied";
    if (approve && result) a.result = result;
  }

  release(id: string): void {
    const a = this.items.get(id);
    if (a?.state === "approving") a.state = "pending";
  }

  /** 一步到位的决定（claim + settle）；已决定 / 不存在返回 null */
  decide(id: string, approve: boolean, result?: Approval["result"]): Approval | null {
    const a = this.claim(id);
    if (!a) return null;
    this.settle(id, approve, result);
    return a;
  }

  /** 浏览器轮询：approved 的结果只给一次（拿走即删）；denied / 过期也删 */
  take(id: string): { state: "pending" } | { state: "approved"; result: NonNullable<Approval["result"]>; approval: Approval } | { state: "denied" | "expired" } {
    const a = this.get(id);
    if (!a) return { state: "expired" };
    if (a.state === "pending" || a.state === "approving") return { state: "pending" };
    this.items.delete(id);
    return a.state === "approved" && a.result ? { state: "approved", result: a.result, approval: a } : { state: "denied" };
  }

  private prune(): void {
    const now = this.now();
    for (const [id, a] of this.items) if (a.expiresAt <= now) this.items.delete(id);
  }
}

/**
 * 配对码的本机状态机（docs/design-hosted-frontend.md §4；tests/relay-pairing.test.ts）。每次 `claudestra pair` 签一组：
 *   - 8 位短码：登记到中继做「码 → 指纹」查找，手输用；兑换后进入待确认，Mac 侧点头才发凭据；
 *   - 128 位秘密：只进二维码 / 链接的 # 片段（不经中继），浏览器用它对挑战做 HMAC，对上即直接发凭据；
 *   - grant：这组码签出去的凭据能做什么，生成时就定死。
 * 一次性、10 分钟过期、每分钟最多 5 次错误尝试、同时最多 5 组（多了顶掉最旧的）。中继只知道码，兑换成败它不知道。
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { LIMITS, normalizeCode, randomCode } from "./relay-protocol.js";
import { fullGrant, type Grant } from "./devices.js";

export interface PairingCodesOptions {
  now?: () => number;
  random?: (n: number) => Uint8Array;
  ttlMs?: number;
  maxActive?: number;
  maxAttemptsPerMin?: number;
}

export interface IssuedCode {
  code: string;
  secret: string;
  grant: Grant;
  /** 给别人的设备：凭据挂到一个新的 guest principal 上，而不是 owner */
  guest?: string;
  expiresAt: number;
}

export type RedeemResult = { ok: true; code: string; secret: string; grant: Grant; guest?: string } | { ok: false; reason: "invalid" | "expired" | "rate_limited" };

/** 二维码里的秘密对挑战做 HMAC-SHA256，base64url；浏览器与 bridge 同一算法 */
export function proofFor(secret: string, challenge: string): string {
  return createHmac("sha256", Buffer.from(secret, "base64url")).update(challenge).digest("base64url");
}

function proofEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a), bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export class PairingCodes {
  private readonly active = new Map<string, IssuedCode>();
  private failures: number[] = [];
  private readonly now: () => number;
  private readonly random: (n: number) => Uint8Array;
  private readonly ttlMs: number;
  private readonly maxActive: number;
  private readonly maxAttemptsPerMin: number;

  constructor(o: PairingCodesOptions = {}) {
    this.now = o.now ?? Date.now;
    this.random = o.random ?? ((n) => new Uint8Array(randomBytes(n)));
    this.ttlMs = o.ttlMs ?? LIMITS.codeTtlMs;
    this.maxActive = o.maxActive ?? LIMITS.maxCodesPerInstance;
    this.maxAttemptsPerMin = o.maxAttemptsPerMin ?? 5;
  }

  /** 签一组新码；超过上限先顶掉最旧的（返回给调用方去中继注销） */
  issue(grant: Grant = fullGrant(), guest?: string): IssuedCode & { evicted: string[] } {
    this.prune();
    const evicted: string[] = [];
    while (this.active.size >= this.maxActive) {
      const oldest = [...this.active.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt)[0][0];
      this.active.delete(oldest);
      evicted.push(oldest);
    }
    let code = randomCode(this.random);
    while (this.active.has(code)) code = randomCode(this.random);
    const issued: IssuedCode = { code, secret: Buffer.from(this.random(16)).toString("base64url"), grant, ...(guest ? { guest } : {}), expiresAt: this.now() + this.ttlMs };
    this.active.set(code, issued);
    return { ...issued, evicted };
  }

  private tooMany(): boolean {
    const now = this.now();
    this.failures = this.failures.filter((t) => now - t < 60_000);
    return this.failures.length >= this.maxAttemptsPerMin;
  }

  /** 手输短码：命中即作废。错码（含形状不对）计入限流；过期的码不再接受 */
  redeem(input: string): RedeemResult {
    if (this.tooMany()) return { ok: false, reason: "rate_limited" };
    const code = normalizeCode(input);
    const hit = code ? this.active.get(code) : undefined;
    if (!code || !hit) {
      this.failures.push(this.now());
      return { ok: false, reason: "invalid" };
    }
    return this.consume(hit);
  }

  /** 二维码：拿挑战与 HMAC 找对得上的那组；每组都比一遍（常数时间比较），对不上计入限流 */
  redeemByProof(challenge: string, proof: string): RedeemResult {
    if (this.tooMany()) return { ok: false, reason: "rate_limited" };
    let hit: IssuedCode | undefined;
    for (const c of this.active.values()) if (proofEquals(proofFor(c.secret, challenge), proof)) hit = c;
    if (!hit) {
      this.failures.push(this.now());
      return { ok: false, reason: "invalid" };
    }
    return this.consume(hit);
  }

  private consume(hit: IssuedCode): RedeemResult {
    this.active.delete(hit.code);
    if (hit.expiresAt <= this.now()) {
      this.failures.push(this.now());
      return { ok: false, reason: "expired" };
    }
    return { ok: true, code: hit.code, secret: hit.secret, grant: hit.grant, ...(hit.guest ? { guest: hit.guest } : {}) };
  }

  activeCodes(): IssuedCode[] {
    this.prune();
    return [...this.active.values()];
  }

  /** 过期的码从表里清掉；返回清掉的（调用方顺手在中继注销） */
  prune(): string[] {
    const now = this.now();
    const gone: string[] = [];
    for (const [code, c] of this.active) {
      if (c.expiresAt <= now) {
        this.active.delete(code);
        gone.push(code);
      }
    }
    return gone;
  }
}

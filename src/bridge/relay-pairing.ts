/**
 * 配对短码（docs/relay/protocol.md §5.2）的本机状态：`claudestra pair` 签一个 8 位码登记到中继，
 * 手机在网页上输入 / 扫码后由 Web 拿码来兑换（POST /relay/pair/redeem），成功即换成 Web 会话。
 * 校验全在本机：一次性、10 分钟过期、每分钟最多 5 次错误尝试、同时最多 5 个有效码（多了顶掉最旧的）。
 * 中继只存 code → 指纹的映射，兑换成败它不知道。纯逻辑在 PairingCodes（tests/relay-pairing.test.ts）。
 */
import { randomBytes } from "node:crypto";
import { LIMITS, normalizeCode, randomCode } from "../lib/relay-protocol.js";
import type { RelayClient } from "../lib/relay-client.js";

export interface PairingCodesOptions {
  now?: () => number;
  random?: (n: number) => Uint8Array;
  ttlMs?: number;
  maxActive?: number;
  maxAttemptsPerMin?: number;
}

export type RedeemResult = { ok: true; code: string } | { ok: false; reason: "invalid" | "expired" | "rate_limited" };

export class PairingCodes {
  private readonly active = new Map<string, number>();
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

  /** 签一个新码；超过上限先顶掉最旧的（返回给调用方去中继注销） */
  issue(): { code: string; expiresAt: number; evicted: string[] } {
    this.prune();
    const evicted: string[] = [];
    while (this.active.size >= this.maxActive) {
      const oldest = [...this.active.entries()].sort((a, b) => a[1] - b[1])[0][0];
      this.active.delete(oldest);
      evicted.push(oldest);
    }
    let code = randomCode(this.random);
    while (this.active.has(code)) code = randomCode(this.random);
    const expiresAt = this.now() + this.ttlMs;
    this.active.set(code, expiresAt);
    return { code, expiresAt, evicted };
  }

  /** 兑换：命中即作废。错码（含形状不对）计入限流；过期的码不再接受 */
  redeem(input: string): RedeemResult {
    const now = this.now();
    this.failures = this.failures.filter((t) => now - t < 60_000);
    if (this.failures.length >= this.maxAttemptsPerMin) return { ok: false, reason: "rate_limited" };
    const code = normalizeCode(input);
    const exp = code ? this.active.get(code) : undefined;
    if (!code || exp === undefined) {
      this.failures.push(now);
      return { ok: false, reason: "invalid" };
    }
    this.active.delete(code);
    if (exp <= now) {
      this.failures.push(now);
      return { ok: false, reason: "expired" };
    }
    return { ok: true, code };
  }

  activeCodes(): Array<{ code: string; expiresAt: number }> {
    this.prune();
    return [...this.active.entries()].map(([code, expiresAt]) => ({ code, expiresAt }));
  }

  /** 过期的码从表里清掉；返回清掉的（调用方顺手在中继注销） */
  prune(): string[] {
    const now = this.now();
    const gone: string[] = [];
    for (const [code, exp] of this.active) {
      if (exp <= now) {
        this.active.delete(code);
        gone.push(code);
      }
    }
    return gone;
  }
}

const codes = new PairingCodes();

/** 签码并登记到中继；顶掉 / 过期的顺手注销 */
export function issuePairingCode(client: RelayClient): { code: string; expiresAt: number } {
  for (const c of codes.prune()) client.delCode(c);
  const r = codes.issue();
  for (const c of r.evicted) client.delCode(c);
  client.putCode(r.code, Math.floor(r.expiresAt / 1000));
  return { code: r.code, expiresAt: r.expiresAt };
}

/** Web 拿用户输入的码来换会话；成功或过期都从中继注销（一次性） */
export function redeemPairingCode(client: RelayClient | null, input: string): RedeemResult {
  const r = codes.redeem(input);
  const code = r.ok ? r.code : normalizeCode(input);
  if (code && (r.ok || (!r.ok && r.reason === "expired"))) client?.delCode(code);
  return r;
}

export function activePairingCodes(): number {
  return codes.activeCodes().length;
}

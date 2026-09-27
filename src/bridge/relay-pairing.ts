/**
 * 配对码与中继的对接（状态机在 lib/pairing-codes.ts，tests/relay-pairing.test.ts）：签一组码就把短码登记到中继
 * （码 → 指纹，手输查找用），兑换 / 过期就注销。中继只知道短码；秘密、grant、兑换成败它都不知道。
 * 没连中继（client 为 null）也能签：直托管入口的配对不经中继。
 */
import { PairingCodes, type IssuedCode, type RedeemResult } from "../lib/pairing-codes.js";
import type { Grant } from "../lib/devices.js";
import { normalizeCode } from "../lib/relay-protocol.js";
import type { RelayClient } from "../lib/relay-client.js";

const codes = new PairingCodes();

/** 签一组码并登记到中继；顶掉 / 过期的顺手注销 */
export function issuePairingCode(client: RelayClient | null, grant?: Grant, guest?: string): IssuedCode {
  for (const c of codes.prune()) client?.delCode(c);
  const r = codes.issue(grant, guest);
  for (const c of r.evicted) client?.delCode(c);
  client?.putCode(r.code, Math.floor(r.expiresAt / 1000));
  return r;
}

/** 手输短码；成功或过期都从中继注销（一次性） */
export function redeemPairingCode(client: RelayClient | null, input: string): RedeemResult {
  const r = codes.redeem(input);
  const code = r.ok ? r.code : normalizeCode(input);
  if (code && (r.ok || r.reason === "expired")) client?.delCode(code);
  return r;
}

/** 二维码 / 链接：秘密对挑战的 HMAC */
export function redeemPairingByProof(client: RelayClient | null, challenge: string, proof: string): RedeemResult {
  const r = codes.redeemByProof(challenge, proof);
  if (r.ok) client?.delCode(r.code);
  return r;
}

export function activePairingCodes(): number {
  return codes.activeCodes().length;
}

/** 还没被消费的码（`claudestra pair` 用它判断自己那组是不是已经被扫码配走了） */
export function activePairingCodeList(): string[] {
  return codes.activeCodes().map((c) => c.code);
}

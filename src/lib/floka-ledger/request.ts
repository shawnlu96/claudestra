/**
 * 共享台账请求签名与入会证明的双族接线。两者同用 shared-ledger 用途，靠首字段（JOIN / 大写方法 / 新族标签）与字段数互相挪不动。
 * 新族请求多带一个 purpose（HTTP 头 LEDGER_PURPOSE_HEADER）；不带的就是旧请求，验法与改动前一字不差。
 * 防重放键不分族：同一把钥匙的同一 nonce 用过一次，换族也再用不了。
 */
import { receiveLedgerUse, type LedgerReceive, type LedgerSigned } from "./uses.js";

export const LEDGER_PURPOSE_HEADER = "x-shared-ledger-purpose";

export type { LedgerReceive };

export function verifyLedgerSignature(signed: LedgerSigned, fields: string[], rx: LedgerReceive = {}): boolean {
  return receiveLedgerUse("shared-ledger", signed, fields, rx).ok;
}

/** 发送方：新族请求多带用途头；旧族（没有 purpose）不加任何头，与改动前逐字一致 */
export function ledgerPurposeHeaders(signed: { purpose?: string }): Record<string, string> {
  return signed.purpose ? { [LEDGER_PURPOSE_HEADER]: signed.purpose } : {};
}

/**
 * 共享台账请求签名与入会证明的双族接线。两者同用 shared-ledger 用途，靠首字段（JOIN / 大写方法 / 新族标签）与字段数互相挪不动。
 * 新族请求多带一个 purpose（HTTP 头 LEDGER_PURPOSE_HEADER）；不带的就是旧请求，验法与改动前一字不差。
 * 防重放键不分族：同一把钥匙的同一 nonce 用过一次，换族也再用不了。
 */
import type { LedgerGear } from "./gear.js";
import { verifyLedgerUse, type LedgerObservation, type LedgerSigned } from "./uses.js";

export const LEDGER_PURPOSE_HEADER = "x-shared-ledger-purpose";

/** 接收方的档位与 observe 报告出口；都不给 = off */
export interface LedgerReceive { receive?: LedgerGear; report?: (o: LedgerObservation) => void }

export function verifyLedgerSignature(signed: LedgerSigned, fields: string[], rx: LedgerReceive = {}): boolean {
  const c = verifyLedgerUse("shared-ledger", signed, fields, rx.receive ?? "off");
  if (!c.ok && c.observed) rx.report?.(c.observed);
  return c.ok;
}

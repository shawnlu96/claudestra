/**
 * 中心收入会证明的双族验法（中心本体在私仓，接线在那边；这里给纯函数和合成契约测试用）。
 * 证明里的 instanceId、公钥都在签名字段内，中心只需另给自己的 centerId；不带 purpose 的旧证明照旧按旧族验。
 */
import { sharedLedgerJoinFields, type SharedLedgerJoinRequest } from "../shared-ledger-join-protocol.js";
import { verifyLedgerSignature, type LedgerReceive } from "./request.js";

export function verifySharedLedgerJoin(req: SharedLedgerJoinRequest, centerId: string, rx: LedgerReceive = {}): boolean {
  if (![req.code, req.publicKey, req.instanceId, req.signature].every((v) => typeof v === "string")) return false;
  const fields = sharedLedgerJoinFields(centerId, req.code, req.publicKey, req.instanceId);
  return verifyLedgerSignature({ key: req.publicKey, sig: req.signature, purpose: req.purpose }, fields, rx);
}

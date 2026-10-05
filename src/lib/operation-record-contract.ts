/** RDO1：操作摘要与结果证据的纯合同（RD3 的代码基础）。只对传入的只读快照与回执做决策：不写 SQLite/文件、不发消息、
 * 不取消 lease，返回值也不是事务提交证明——真正的 CAS/唯一去重归 RD3、RD4/4M 现有的权威事务。
 * 请求摘要由调用方用现有 helper 算好传入；回执真伪只经注入的 ReceiptAuthority 判定，本文件不签名、不另起哈希算法，
 * payload 完整性复用 v2ObjectDigest。tests/operation-record-contract*.test.ts。
 */
import { canonicalJson } from "./canonical-json.js";
import {
  choice, digest, fail, id, nullable, object, refine, scope, text, timestamp, v2ObjectDigest, V2ContractError, type Infer,
} from "./shared-ledger-contract-v2.js";

const method = choice(["GET", "POST", "PUT", "PATCH", "DELETE"]);
/** 原样的 pathname(+query)，与 shared-ledger-auth 的签名原文一致，不做规范化。 */
const path = refine(text(500, 1), p => p.startsWith("/") && !/\s/.test(p));
const request = { operationId: id, identity: object({ ...scope, principal: id }), method, path, requestDigest: digest };
const parseOperationRequest = object(request);
export type OperationRequest = Infer<typeof parseOperationRequest>;

const settled = ["succeeded", "failed", "cancelled"] as const;
type Settled = typeof settled[number];
/** proof 是权威方的不透明凭据，只交给 ReceiptAuthority 核验；unknown 回执不带 payload。 */
const parseOperationReceipt = refine(object({
  ...request, receiptId: id, outcome: choice([...settled, "unknown"]), payloadDigest: nullable(digest),
  observedAt: timestamp, proof: text(4096, 1),
}), r => r.outcome !== "unknown" || r.payloadDigest === null);
export type OperationReceipt = Infer<typeof parseOperationReceipt>;

/** 确认态必有与之同结果、同请求绑定的回执；pending/unknown 不存回执（unknown 回执不构成结算）。 */
const parseOperationRecord = refine(object({
  ...request, state: choice(["pending", "unknown", ...settled]), receipt: nullable(parseOperationReceipt),
}), r => r.receipt === null ? r.state === "pending" || r.state === "unknown"
  : r.receipt.outcome === r.state && sameRequest(r, r.receipt));
export type OperationRecord = Infer<typeof parseOperationRecord>;

/** 注入 port：由现有签名/权威校验实现。抛错或非 true 一律按「无法证明」拒绝。 */
export interface ReceiptAuthority { isAuthentic(receipt: OperationReceipt): boolean }
export interface ReceiptEvidence { receipt: unknown; body?: unknown }

type OperationReject = "invalid" | "dedup_mismatch" | "conflict" | "unverified" | "incomplete";
export type OperationDecision =
  | { ok: true; record: OperationRecord; changed: boolean }
  | { ok: false; reason: OperationReject };

function requestOf(r: OperationRequest): OperationRequest {
  return { operationId: r.operationId, identity: r.identity, method: r.method, path: r.path, requestDigest: r.requestDigest };
}
function sameRequest(a: OperationRequest, b: OperationRequest): boolean {
  return canonicalJson(requestOf(a)) === canonicalJson(requestOf(b));
}
function isSettled(state: OperationRecord["state"]): state is Settled { return (settled as readonly string[]).includes(state); }
function reject(reason: OperationReject): OperationDecision { return { ok: false, reason }; }
function keep(record: OperationRecord): OperationDecision { return { ok: true, record, changed: false }; }
function move(record: OperationRecord): OperationDecision { return { ok: true, record: parseOperationRecord(record), changed: true }; }

/** 只把合同层的字段校验失败折成 invalid；其他异常是程序错误，原样抛出。 */
function parsed<T>(parse: () => T): T | null {
  try { return parse(); }
  catch (e) { if (e instanceof V2ContractError) return null; throw e; }
}
function authentic(authority: ReceiptAuthority, receipt: OperationReceipt): boolean {
  try { return authority.isAuthentic(receipt) === true; }
  catch { return false; /* 权威核验自身出错 = 拿不出可信 proof，按未验证拒绝，绝不放行 */ }
}

/** 同 ID 再次到来：请求绑定完全一致才返回既有记录（changed=false），且既有 pending/unknown 不等于可再发一次。 */
export function admitOperation(existing: unknown, incoming: unknown): OperationDecision {
  const req = parsed(() => parseOperationRequest(incoming));
  if (!req) return reject("invalid");
  if (existing === null) return move({ ...requestOf(req), state: "pending", receipt: null });
  const old = parsed(() => parseOperationRecord(existing));
  if (!old || old.operationId !== req.operationId) return reject("invalid");
  return sameRequest(old, req) ? keep(old) : reject("dedup_mismatch");
}

/** 超时、已重发、重启后没有回执：至多 pending→unknown；永远推不出完成或撤单成功。 */
export function observeWithoutProof(snapshot: unknown): OperationDecision {
  const record = parsed(() => parseOperationRecord(snapshot));
  if (!record) return reject("invalid");
  return record.state === "pending" ? move({ ...record, state: "unknown" }) : keep(record);
}

/** 用一份回执推进状态：绑定一致 → 权威核验 → payload 完整 → 状态转移；已确认结果不降级，结论不同则冲突。 */
export function applyReceipt(snapshot: unknown, evidence: ReceiptEvidence, authority: ReceiptAuthority): OperationDecision {
  const record = parsed(() => parseOperationRecord(snapshot));
  const receipt = parsed(() => parseOperationReceipt(evidence.receipt));
  if (!record || !receipt) return reject("invalid");
  if (!sameRequest(record, receipt)) return reject("conflict");
  if (!authentic(authority, receipt)) return reject("unverified");
  if (receipt.outcome === "succeeded" && receipt.payloadDigest === null) return reject("incomplete");
  if (receipt.payloadDigest !== null
    && (!Object.hasOwn(evidence, "body") || v2ObjectDigest(evidence.body) !== receipt.payloadDigest)) return reject("incomplete");
  if (receipt.outcome === "unknown") return record.state === "pending" ? move({ ...record, state: "unknown" }) : keep(record);
  if (!isSettled(record.state)) return move({ ...record, state: receipt.outcome, receipt });
  return sameSettlement(record.receipt!, receipt) ? keep(record) : reject("conflict");
}

function sameSettlement(a: OperationReceipt, b: OperationReceipt): boolean {
  return a.outcome === b.outcome && a.payloadDigest === b.payloadDigest;
}

/** 合并同一操作的两份（可能乱序/并发读到的）快照：确认 > unknown > pending；确认回执重新核验，两份确认不一致则冲突。
 * 结果与参数顺序无关（两份等价确认取规范 JSON 较小的回执）。 */
export function mergeOperationSnapshots(first: unknown, second: unknown, authority: ReceiptAuthority): OperationDecision {
  const a = parsed(() => parseOperationRecord(first)), b = parsed(() => parseOperationRecord(second));
  if (!a || !b) return reject("invalid");
  if (!sameRequest(a, b)) return reject("dedup_mismatch");
  for (const r of [a, b]) if (r.receipt && !authentic(authority, r.receipt)) return reject("unverified");
  let merged: OperationRecord;
  if (a.receipt && b.receipt) {
    if (!sameSettlement(a.receipt, b.receipt)) return reject("conflict");
    merged = canonicalJson(a.receipt) <= canonicalJson(b.receipt) ? a : b;
  } else if (a.receipt || b.receipt) merged = a.receipt ? a : b;
  else merged = a.state === "unknown" || b.state === "unknown" ? { ...a, state: "unknown" } : a;
  return canonicalJson(merged) === canonicalJson(a) ? keep(a) : move(merged);
}

/** 落盘/读回用同一份规范 JSON：重启后读回再序列化逐字节相同；读回同样过 schema，坏数据拒绝而不是当成新操作。 */
export function serializeOperationRecord(record: OperationRecord): string {
  return canonicalJson(parseOperationRecord(record));
}
export function readOperationRecord(json: string): OperationRecord {
  let value: unknown;
  try { value = JSON.parse(json); } catch { return fail(); /* 半截/损坏的 JSON 是非法输入，交给调用方按 unknown 处理 */ }
  return parseOperationRecord(value);
}

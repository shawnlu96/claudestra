/**
 * 请求签名头的双族识别与验签。规矩（rename-floka-SIGN1 PM 定 4）：
 * 只有半套头、两族各拿几个拼起来、两族整套但值不同都拒；两族整套且值完全相同按旧族归一，只验一次；
 * 验签失败就是失败，不回落成无签名、不换族重试。off / observe 不认新族（observe 只报告新族验签结果，结论同 off）。
 */
import { signedHeaders, verifySigned, type InstanceKey, type SigCheck } from "../../instance-signature.js";
import { REQUEST_HEADERS, requestMethodTag, type RenameSignatureMode, type SignatureFamily } from "./families.js";

type RequestReject = "partial" | "conflict" | "family_off" | "bad" | "stale";

export type RequestCheck =
  | { status: "unsigned" }
  | { status: "ok"; family: SignatureFamily; publicKey: string; observed?: SigCheck }
  | { status: "reject"; reason: RequestReject; family?: SignatureFamily; observed?: SigCheck };

interface SignedReq { method: string; path: string; body: string | Uint8Array }
type Headers = Readonly<Record<string, string | undefined>>;
type HeaderSet = { key: string; ts: string; sig: string };

/** 头名大小写不敏感；只差大小写的同名头值不同返回 null（按冲突拒），不让后写的悄悄盖掉前面的 */
function lower(headers: Headers): Map<string, string> | null {
  const m = new Map<string, string>();
  for (const [k, v] of Object.entries(headers)) {
    if (typeof v !== "string") continue;
    const name = k.toLowerCase();
    if (m.has(name) && m.get(name) !== v) return null;
    m.set(name, v);
  }
  return m;
}

/** null = 一个都没有；"partial" = 有缺；否则整套 */
function pick(h: Map<string, string>, family: SignatureFamily): HeaderSet | "partial" | null {
  const names = REQUEST_HEADERS[family];
  const got = { key: h.get(names.key), ts: h.get(names.ts), sig: h.get(names.sig) };
  const n = [got.key, got.ts, got.sig].filter((v) => v !== undefined).length;
  if (n === 0) return null;
  return n === 3 ? (got as HeaderSet) : "partial";
}

function check(family: SignatureFamily, set: HeaderSet, req: SignedReq, now: number): SigCheck {
  const method = family === "floka" ? requestMethodTag(req.method) : req.method;
  return verifySigned(set.key, { method, path: req.path, ts: set.ts, sig: set.sig, body: req.body }, now);
}

const verdict = (family: SignatureFamily, set: HeaderSet, c: SigCheck, observed?: SigCheck): RequestCheck =>
  c === "ok" ? { status: "ok", family, publicKey: set.key, ...(observed ? { observed } : {}) }
    : { status: "reject", reason: c, family, ...(observed ? { observed } : {}) };

export function verifyRequestFamilies(headers: Headers, req: SignedReq, mode: RenameSignatureMode, now = Date.now()): RequestCheck {
  const h = lower(headers);
  if (!h) return { status: "reject", reason: "conflict" };
  const old = pick(h, "claudestra");
  const neu = pick(h, "floka");
  if (old === "partial" || neu === "partial") return { status: "reject", reason: "partial" };
  if (!old && !neu) return { status: "unsigned" };
  if (old && neu) {
    if (old.key !== neu.key || old.ts !== neu.ts || old.sig !== neu.sig) return { status: "reject", reason: "conflict" };
    return verdict("claudestra", old, check("claudestra", old, req, now));
  }
  if (old) return verdict("claudestra", old, check("claudestra", old, req, now));
  const set = neu as HeaderSet;
  if (mode === "on") return verdict("floka", set, check("floka", set, req, now));
  const observed = mode === "observe" ? check("floka", set, req, now) : undefined;
  return { status: "reject", reason: "family_off", family: "floka", ...(observed ? { observed } : {}) };
}

/** 发送：给哪一族就只出那一族的整套头；没有钥匙返回空对象（与 signedHeaders 同口径） */
export function signRequestFamily(
  family: SignatureFamily, req: SignedReq, key: InstanceKey | null, now = Date.now(),
): Record<string, string> {
  if (family === "claudestra") return signedHeaders(req.method, req.path, req.body, key, now);
  const raw = signedHeaders(requestMethodTag(req.method), req.path, req.body, key, now);
  const old = REQUEST_HEADERS.claudestra;
  const neu = REQUEST_HEADERS.floka;
  return raw[old.sig] ? { [neu.key]: raw[old.key]!, [neu.ts]: raw[old.ts]!, [neu.sig]: raw[old.sig]! } : {};
}

/**
 * B → A 的出借接口的请求体与响应解析：T93 定的 lend wire v1（POST /api/v1/lend/{poll,claim,lease,result}，逐字节冻结），
 * 加 i28-W2 的 v2（hello / beat / ask，格式在 lend-wire-v2.ts）。v2 接口回 404 = 对方是没有 v2 的旧版本，code 记 old_peer，
 * 调用方据此退回 v1 轮询（A 的 v2 拒绝码里没有 404）。
 * 传输由调用方注入（生产是 `manager lend call`：peerCliFetch 的 E2E 那一半，走不了 E2E 就拒，不退明文）。
 * 响应一律严格解析：多字段、少字段、类型不对都当「对方回了看不懂的东西」（transport 类失败，结果不明），不猜。
 * 前提检查（peer 记录钉钥 + E2E、没有代理变量）也在这里：不满足就不发任何请求。tests/lend-remote.test.ts。
 */
import type { HttpPeer } from "./peers.js";
import { isBaseBranch, LEND_BRANCH_RE } from "./lend-git.js";
import { parseOrderWire, type OrderWire } from "./order-wire.js";
import { createHash } from "node:crypto";
import { parseV2Response, type LendV2Endpoint } from "./lend-wire-v2.js";
import { claimBranch } from "./lend-arbiter-wire.js";

const LEND_WIRE_V = 1;
const V2_OPS: readonly string[] = ["hello", "beat", "ask"] satisfies LendV2Endpoint[];
export type LendOp = "poll" | "claim" | "lease" | "result";
/** v1 的四个加 v2 的三个（B → A） */
export type LendAnyOp = LendOp | "hello" | "beat" | "ask";
/** 对方没有这个 v2 接口（旧版本）：按 proto 1 处理，只轮询 */
export const LEND_OLD_PEER = "old_peer";

/** 注入的传输：status = HTTP 状态，body = 解析后的 JSON（不是 JSON 就是 null）；抛错 = 没发出去或不知道发没发出去 */
export type LendCall<O extends string = LendOp> = (peer: string, op: O, body: Record<string, unknown>) => Promise<{ status: number; body: unknown }>;

type LendErr = { ok: false; status: number; code: string; error: string };
export type LendRes<T> = { ok: true; value: T } | LendErr;

export interface Lease { gen: number; expiresAt: number; ms: number }
export interface PolledOrder {
  orderId: string; taskId: string; step: string; family: string; repo: string; pr: number | null; head: string; round: number; specRev: number; offeredAt: number;
}
/** 写单（i28-R6）另带订单分支与基线；审查单没有这一项 */
interface Claimed { order: OrderWire; text: string; sha256: string; lease: Lease; write: { branch: string; base: string } | null }
export interface Receipt { orderId: string; sha256: string; eventSeq: number; taskId: string; key: string; sig: string }

class Bad extends Error {}
const bad = (why: string): never => { throw new Bad(why); };

function obj(v: unknown, keys: readonly string[], what: string): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return bad(`${what} 不是对象`);
  const r = v as Record<string, unknown>;
  const extra = Object.keys(r).filter((k) => !keys.includes(k));
  if (extra.length) bad(`${what} 有不认识的字段 ${extra.slice(0, 3).join(", ")}`);
  const missing = keys.filter((k) => !(k in r));
  if (missing.length) bad(`${what} 缺字段 ${missing.join(", ")}`);
  return r;
}
const str = (v: unknown, re: RegExp, what: string): string => (typeof v === "string" && re.test(v) ? v : bad(`${what} 格式不对`));
const int = (v: unknown, what: string, min = 0): number => (Number.isSafeInteger(v) && (v as number) >= min ? (v as number) : bad(`${what} 要是整数`));

const ID = /^[\w.:-]{1,200}$/;
const NAME = /^[\w.-]{1,64}$/;
const REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/(?!\.\.?$)[A-Za-z0-9_.-]{1,100}$/;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const HEX64 = /^[0-9a-f]{64}$/i;
const B64URL = /^[A-Za-z0-9_-]{1,200}$/;
const BASE = /^[\w./-]{1,100}$/;

function lease(v: unknown): Lease {
  const r = obj(v, ["gen", "expiresAt", "ms"], "lease");
  return { gen: int(r.gen, "lease.gen"), expiresAt: int(r.expiresAt, "lease.expiresAt"), ms: int(r.ms, "lease.ms", 1) };
}

function polled(v: unknown, i: number): PolledOrder {
  const w = `orders[${i}]`;
  const r = obj(v, ["orderId", "taskId", "step", "family", "repo", "pr", "head", "round", "specRev", "offeredAt"], w);
  return {
    orderId: str(r.orderId, ID, `${w}.orderId`), taskId: str(r.taskId, NAME, `${w}.taskId`), step: str(r.step, NAME, `${w}.step`),
    family: str(r.family, NAME, `${w}.family`), repo: str(r.repo, REPO, `${w}.repo`), pr: r.pr === null ? null : int(r.pr, `${w}.pr`, 1),
    head: str(r.head, SHA, `${w}.head`).toLowerCase(), round: int(r.round, `${w}.round`), specRev: int(r.specRev, `${w}.specRev`),
    offeredAt: int(r.offeredAt, `${w}.offeredAt`),
  };
}

const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");
const v2 = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => (r.ok ? r.value : bad(r.error));

/** 成功体的解析器：拿到的是 ok/v 之外的字段 */
const PARSE = {
  poll: (r: unknown) => {
    const o = obj(r, ["ok", "v", "orders", "pollAfterMs"], "poll 响应");
    if (!Array.isArray(o.orders) || o.orders.length > 20) bad("orders 要是不超过 20 条的数组");
    return { orders: (o.orders as unknown[]).map(polled), pollAfterMs: int(o.pollAfterMs, "pollAfterMs", 1) };
  },
  claim: (r: unknown): Claimed => {
    const has = !!r && typeof r === "object" && "write" in r;
    const o = obj(r, ["ok", "v", "order", "text", "sha256", "lease", ...(has ? ["write"] : [])], "claim 响应");
    const order = parseOrderWire(o.order);
    if (!order.ok) bad(`order 不合格：${order.error}`);
    const text = typeof o.text === "string" && o.text ? o.text : bad("text 要是非空字符串");
    const sum = str(o.sha256, HEX64, "sha256").toLowerCase();
    if (sha256(text) !== sum) bad("派单全文的 sha256 对不上");
    const w = has ? obj(o.write, ["branch", "base"], "write") : null;
    const write = w ? { branch: claimBranch(order, w.branch, (v) => str(v, LEND_BRANCH_RE, "write.branch")), base: str(w.base, BASE, "write.base") } : null;
    if (write && !isBaseBranch(write.base)) bad("write.base 不是能用的分支名");
    return { order: (order as { ok: true; value: OrderWire }).value, text, sha256: sum, lease: lease(o.lease), write };
  },
  lease: (r: unknown): Lease | null => {
    const o = obj(r, ["ok", "v", "lease"], "lease 响应");
    return o.lease === null ? null : lease(o.lease);
  },
  result: (r: unknown): Receipt => {
    const o = obj(r, ["ok", "v", "receipt"], "result 响应");
    const c = obj(o.receipt, ["orderId", "sha256", "eventSeq", "taskId", "key", "sig"], "receipt");
    return { orderId: str(c.orderId, ID, "receipt.orderId"), sha256: str(c.sha256, HEX64, "receipt.sha256").toLowerCase(),
      eventSeq: int(c.eventSeq, "receipt.eventSeq"), taskId: str(c.taskId, NAME, "receipt.taskId"), key: str(c.key, B64URL, "receipt.key"),
      sig: str(c.sig, B64URL, "receipt.sig") };
  },
  hello: (r: unknown) => v2(parseV2Response("hello", r)),
  beat: (r: unknown) => v2(parseV2Response("beat", r)),
  ask: (r: unknown) => v2(parseV2Response("ask", r)),
} as const;

type Parsed = { [K in LendAnyOp]: ReturnType<(typeof PARSE)[K]> };

/**
 * 发一次、解析一次。transport 抛错 → code "transport"（不知道对方收没收到，调用方按「结果不明」处理，不当成拒绝）；
 * 对方明确拒绝（ok:false + code）→ 原样带出；成功体解析不了 → code "bad_response"（同样是结果不明）。
 */
export async function lendRequest<K extends LendAnyOp>(call: LendCall<K>, peer: string, op: K, body: Record<string, unknown>): Promise<LendRes<Parsed[K]>> {
  let res: { status: number; body: unknown };
  try {
    res = await call(peer, op, { v: LEND_WIRE_V, ...body });
  } catch (e) {
    return { ok: false, status: 0, code: "transport", error: (e as Error).message.slice(0, 300) };
  }
  const b = res.body as Record<string, unknown> | null;
  if (V2_OPS.includes(op) && res.status === 404) return { ok: false, status: 404, code: LEND_OLD_PEER, error: `对方没有 lend/${op} 接口（旧版本），退回轮询` };
  if (!b || typeof b !== "object") return { ok: false, status: res.status, code: "bad_response", error: `对方回了 ${res.status}（不是 JSON）` };
  if (b.ok !== true) {
    const code = typeof b.code === "string" && /^[\w.-]{1,40}$/.test(b.code) ? b.code : `http_${res.status}`;
    return { ok: false, status: res.status, code, error: typeof b.error === "string" ? b.error.slice(0, 300) : code };
  }
  try {
    if (b.v !== LEND_WIRE_V) bad(`只认 v${LEND_WIRE_V}`);
    return { ok: true, value: PARSE[op](b) as Parsed[K] };
  } catch (e) {
    if (e instanceof Bad) return { ok: false, status: res.status, code: "bad_response", error: e.message };
    throw e;
  }
}

/** 会触发代理的环境变量：带着它们出站，请求可能不经本机直连 / 中继而被第三方看到或改道，lend 循环一律不 poll */
const PROXY_VARS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"];
export const proxyVarsIn = (env: Record<string, string | undefined>): string[] => PROXY_VARS.filter((k) => !!env[k]?.trim());

/**
 * 能不能对这个 peer 借单：记录在、没禁用、握手完整（地址 + 对方签给我的 token）、钉了完整公钥（回执验签要用）、有 E2E 记录。
 * 返回 null = 可以；否则是 doctor / 日志里给人看的原因。
 */
export function peerLendProblem(rec: HttpPeer | undefined, name: string): string | null {
  if (!rec) return `peer ${name} 不在 peers.json 里`;
  if (rec.disabled) return `peer ${name} 已禁用`;
  if (!rec.baseUrl || !rec.outToken) return `peer ${name} 握手没完成（缺地址或对方签给我的 token）`;
  if (!rec.publicKey) return `peer ${name} 没钉完整公钥（老记录），收不了签名回执，不借单`;
  if (!rec.e2e) return `peer ${name} 没有端到端加密记录（老记录或 --allow-legacy 建的），不借单`;
  return null;
}

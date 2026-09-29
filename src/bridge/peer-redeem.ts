/**
 * POST /api/v1/peers/redeem 进 manager 之前的一段（api-routes.ts handlePeerRedeem 调）：来源、正文、兑换口令、限流、对方身份。
 * 限流先核口令再计数：口令不对的按来源分桶（经中继的按发件人指纹，其余按 socket 地址——XFF 一律不信），
 * 一个来源乱试只耗它自己的额度，也不会连累同一来源上口令对的兑换（本机反代进来的共用一个地址）；口令对的进一个较宽的全局桶
 * （一张邀请只能成功一次，实例 id 冲突另有每张邀请的次数上限，manager/peer-join.ts）。口令 192 位，限速挡的是噪音不是猜测。
 * 单测在 tests/peer-redeem-gate.test.ts。
 */
import { findPendingInviteByJoinSecret } from "../lib/peers.js";
import { SlidingWindowLimiter } from "../lib/principals.js";
import { isPublicKey, keyFingerprint, SIG_HEADERS, verifySigned } from "../lib/instance-key.js";
import { FP_RE } from "../lib/relay-protocol.js";
import { apiJson, INVALID_JSON, invalidJsonBody, readJsonBody } from "./api-respond.js";
import { requestContextOf } from "./request-context.js";

/** 每个来源每分钟可以试错几次口令；来源表超过上限先丢最早的（丢了只是那个来源的计数清零） */
const BAD_JOIN_PER_SOURCE = 10;
const MAX_SOURCES = 2_000;
/** 口令对的兑换全局每分钟上限：正常一张邀请兑换一次，这个数只挡异常的连发 */
const VALID_PER_MIN = 30;

const badJoin = new Map<string, SlidingWindowLimiter>();
let valid = new SlidingWindowLimiter(VALID_PER_MIN, 60_000);

/** 单测用：清空限流状态 */
export function resetRedeemLimitsForTest(): void {
  badJoin.clear();
  valid = new SlidingWindowLimiter(VALID_PER_MIN, 60_000);
}

export interface RedeemInput {
  join: string;
  name: string;
  url: string;
  token: string;
  /** 对方自报的实例 id（形状不对当没带） */
  iid: string;
  /** 加入方给的一次性随机数：兑换成功时本机签一份持钥证明回去（manager/peer-join.ts） */
  nonce: string;
  /** 对方指纹与完整公钥：经中继的取 peer 入口核过的发件人，直连的取签名对得上的钥匙；都没有为 "" */
  fp: string;
  pk: string;
}

/** 经中继来的兑换（隧道或路径模式）一律 403：合法的兑换只走 peer 帧（进 peer 入口）或直连 */
export function redeemRefusal(req: Request): Response | null {
  if (requestContextOf(req).source !== "relay") return null;
  return apiJson(403, { ok: false, error: "invites are not redeemed on the relay path", code: "redeem_via_relay_path" });
}

/** 经中继来的请求的发件人指纹：只认 peer 入口核过进程内标记后放进请求上下文的（peer-ingress.ts），原始头一律不信；没有返回 "" */
export function relaySenderFp(req: Request): string {
  const fp = requestContextOf(req).relayFrom ?? "";
  return FP_RE.test(fp) ? fp : "";
}

/**
 * 兑换方的指纹与公钥。经中继的：中继入站已核过签名钥匙的指纹就是发件人（bridge/relay-inbound.ts），签名头原样转来；
 * 直连的：请求自带签名对得上才算。要在读正文之前调（读的是克隆）。
 */
export async function redeemSender(req: Request): Promise<{ fp: string; pk: string }> {
  const key = req.headers.get(SIG_HEADERS.key) ?? "", relayed = relaySenderFp(req);
  if (relayed) return { fp: relayed, pk: isPublicKey(key) && keyFingerprint(key) === relayed ? key : "" };
  const ts = req.headers.get(SIG_HEADERS.ts), sig = req.headers.get(SIG_HEADERS.sig);
  if (!ts || !sig || !isPublicKey(key)) return { fp: "", pk: "" };
  const u = new URL(req.url);
  const body = new Uint8Array(await req.clone().arrayBuffer());
  const ok = verifySigned(key, { method: req.method, path: u.pathname + u.search, ts, sig, body }) === "ok";
  return ok ? { fp: keyFingerprint(key), pk: key } : { fp: "", pk: "" };
}

function sourceKey(req: Request): string {
  const relayed = relaySenderFp(req);
  if (relayed) return `fp:${relayed}`;
  return `ip:${requestContextOf(req).clientIp ?? "unknown"}`;
}

function sourceLimiter(key: string): SlidingWindowLimiter {
  let l = badJoin.get(key);
  if (!l) {
    if (badJoin.size >= MAX_SOURCES) badJoin.delete(badJoin.keys().next().value!);
    badJoin.set(key, (l = new SlidingWindowLimiter(BAD_JOIN_PER_SOURCE, 60_000)));
  }
  return l;
}

const limited = (): Response => apiJson(429, { ok: false, error: "rate limited", code: "rate_limited", reason: "rate_limited" });
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** 通过返回兑换参数；不通过返回要回给对方的响应。失败一律 400 不细分原因：这是无鉴权端点，不给探测者更多信息面 */
export async function redeemPrecheck(req: Request, now = Date.now()): Promise<RedeemInput | Response> {
  const refused = redeemRefusal(req);
  if (refused) return refused;
  const sender = await redeemSender(req);
  const body: any = await readJsonBody(req);
  if (body === INVALID_JSON) return invalidJsonBody();
  const join = str(body?.join), name = str(body?.name);
  if (!join || !name) return apiJson(400, { ok: false, error: '"join" and "name" required' });
  if (!(await findPendingInviteByJoinSecret(join))) {
    return sourceLimiter(sourceKey(req)).tryAcquire(now) ? apiJson(400, { ok: false, error: "邀请无效或已被使用" }) : limited();
  }
  if (!valid.tryAcquire(now)) return limited();
  const iid = typeof body?.iid === "string" && /^[\w-]{1,64}$/.test(body.iid) ? body.iid : "";
  const nonce = typeof body?.nonce === "string" && /^[A-Za-z0-9_-]{22,128}$/.test(body.nonce) ? body.nonce : ""; // ≥ 22 个 base64url 字符 = ≥ 128 位
  return { join, name, url: str(body?.url), token: str(body?.token), iid, nonce, ...sender };
}

/** manager peer-invite-redeem 的参数（manager/peer-join.ts parseRedeemArgs 按同样的名字读） */
export function redeemArgs(i: RedeemInput): string[] {
  const opt = (flag: string, v: string): string[] => (v ? [flag, v] : []);
  return ["--join", i.join, "--name", i.name, ...opt("--url", i.url), ...opt("--token", i.token), ...opt("--iid", i.iid),
    ...opt("--fp", i.fp), ...opt("--pk", i.pk), ...opt("--nonce", i.nonce)];
}

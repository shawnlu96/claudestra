/**
 * POST /api/v1/peers/redeem 进 manager 之前的一段（api-routes.ts handlePeerRedeem 调）：来源、正文、兑换口令、限流、对方身份。
 * 限流先核口令再计数：口令不对的按来源分桶（经中继的按发件人指纹，其余按 socket 地址——XFF 一律不信），
 * 一个来源乱试只耗它自己的额度，也不会连累同一来源上口令对的兑换（本机反代进来的共用一个地址）；口令对的按邀请分桶——
 * 拿着一张邀请连发只耗这张邀请的额度，别的邀请照常兑换（一张邀请只能成功一次，实例 id 冲突另有每张邀请的次数上限，
 * manager/peer-join.ts）。口令 192 位，限速挡的是噪音不是猜测。
 * 带密钥的邀请（docs/relay/e2e-design.md §5.1）：正文是 HPKE 信封，先认出发件人（不花 ECDH）再解，解开后兑换方的身份公钥必须就是
 * 外层认出的那台机器，之后的口令、限速照旧；成功响应加密回去，明文兑换带密钥的邀请由 manager 拒掉并作废（口令已明文过了网络）。
 * 单测在 tests/peer-redeem-gate.test.ts、tests/peer-e2e-relay.test.ts。
 */
import { findPendingInviteByJoinSecret, isPeerBaseUrl } from "../lib/peers.js";
import { SlidingWindowLimiter } from "../lib/principals.js";
import { isPublicKey, keyFingerprint, SIG_HEADERS, verifySigned } from "../lib/instance-key.js";
import { FP_RE } from "../lib/relay-protocol.js";
import { apiJson, INVALID_JSON, invalidJsonBody, readJsonBody } from "./api-respond.js";
import { requestContextOf, sourceAllows } from "./request-context.js";
import { verifyE2eKey } from "../lib/e2e-machine-key.js";
import { recordMetric } from "../lib/metrics.js";
import { localE2e, type LocalE2e } from "../lib/peer-e2e-local.js";
import { isSealedRedeem, openRedeemRequest, sealRedeemResponse, type RedeemSession } from "../lib/peer-e2e-redeem.js";

/** 每个来源每分钟可以试错几次口令；来源表超过上限先丢最早的（丢了只是那个来源的计数清零） */
const BAD_JOIN_PER_SOURCE = 10;
const MAX_SOURCES = 2_000;
/** 口令对的兑换每张邀请每分钟上限：正常一张邀请兑换一次（被拒了重试几次），这个数只挡异常的连发 */
const VALID_PER_INVITE = 6;

const badJoin = new Map<string, SlidingWindowLimiter>();
const validJoin = new Map<string, SlidingWindowLimiter>();

/** 单测用：清空限流状态 */
export function resetRedeemLimitsForTest(): void {
  badJoin.clear();
  validJoin.clear();
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
  /** 加入方手里邀请串的原始地址（manager 和这张邀请生成时的地址比对，签进证明）；不是 peer 地址的样子当没带 */
  inviteUrl: string;
  /** 对方指纹与完整公钥：经中继的取 peer 入口核过的发件人，直连的取签名对得上的钥匙；都没有为 "" */
  fp: string;
  pk: string;
  /** 加密兑换：解开的对方 {idk, ek}（JSON，manager --e2e）与响应要用的 HPKE 上下文；明文兑换为 "" / 没有 */
  e2e: string;
  session?: RedeemSession;
}

/** 兑换只认本机、主端口与 peer 入口来源（request-context.ts sourceAllows）：经中继路径模式或隧道来的一律 403，合法的兑换只走 peer 帧或直连 */
export function redeemRefusal(req: Request): Response | null {
  if (sourceAllows(req, "redeem")) return null;
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

function limiterOf(table: Map<string, SlidingWindowLimiter>, key: string, perMin: number): SlidingWindowLimiter {
  let l = table.get(key);
  if (!l) {
    if (table.size >= MAX_SOURCES) table.delete(table.keys().next().value!);
    table.set(key, (l = new SlidingWindowLimiter(perMin, 60_000)));
  }
  return l;
}

const limited = (): Response => apiJson(429, { ok: false, error: "rate limited", code: "rate_limited", reason: "rate_limited" });
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

type Opened = { payload: any; session: RedeemSession; e2e: string };

/**
 * 解加密兑换：发件人认不出就不解（解一次要做 ECDH）；解不开的和口令错一样按来源计数。解开后核对兑换方的身份公钥
 * = 外层认出的发件人（带了完整公钥的比公钥），并验他的签名块。
 */
async function openSealed(req: Request, raw: unknown, sender: { fp: string; pk: string }, local: () => Promise<LocalE2e | null>, now: number): Promise<Opened | Response> {
  if (!sender.fp) return apiJson(403, { ok: false, error: "redeemer identity unknown" });
  const l = await local();
  if (!l) return apiJson(503, { ok: false, error: "end-to-end key unavailable on this instance" });
  const o = isSealedRedeem(raw) ? await openRedeemRequest(l.machine.pair, l.fp, raw) : null;
  if (!o) return limiterOf(badJoin, sourceKey(req), BAD_JOIN_PER_SOURCE).tryAcquire(now) ? apiJson(400, { ok: false, error: "invalid invite redemption" }) : limited();
  const p = (o.payload ?? {}) as { idk?: unknown; key?: unknown };
  const ek = typeof p.idk === "string" ? await verifyE2eKey(p.idk, p.key) : null;
  if (!ek) return apiJson(400, { ok: false, error: "redeemer key block invalid" });
  if (keyFingerprint(p.idk as string) !== sender.fp || (sender.pk && sender.pk !== p.idk)) return apiJson(403, { ok: false, error: "redeemer identity does not match the sender" });
  return { payload: o.payload, session: o.session, e2e: JSON.stringify({ idk: p.idk, ek: { v: ek.v, ts: ek.ts, pub: ek.pub, sig: ek.sig } }) };
}

/** 通过返回兑换参数；不通过返回要回给对方的响应。失败一律 400 不细分原因：这是无鉴权端点，不给探测者更多信息面 */
export async function redeemPrecheck(req: Request, now = Date.now(), local: () => Promise<LocalE2e | null> = () => localE2e()): Promise<RedeemInput | Response> {
  const refused = redeemRefusal(req);
  if (refused) return refused;
  const sender = await redeemSender(req);
  const raw: any = await readJsonBody(req);
  if (raw === INVALID_JSON) return invalidJsonBody();
  const sealed = isSealedRedeem(raw) ? await openSealed(req, raw, sender, local, now) : null;
  if (sealed instanceof Response) return sealed;
  const body = sealed ? sealed.payload : raw;
  const join = str(body?.join), name = str(body?.name);
  if (!join || !name) return apiJson(400, { ok: false, error: '"join" and "name" required' });
  const inv = await findPendingInviteByJoinSecret(join);
  if (!inv) return limiterOf(badJoin, sourceKey(req), BAD_JOIN_PER_SOURCE).tryAcquire(now) ? apiJson(400, { ok: false, error: "邀请无效或已被使用" }) : limited();
  if (!limiterOf(validJoin, inv.id, VALID_PER_INVITE).tryAcquire(now)) return limited();
  const iid = typeof body?.iid === "string" && /^[\w-]{1,64}$/.test(body.iid) ? body.iid : "";
  const nonce = typeof body?.nonce === "string" && /^[A-Za-z0-9_-]{22,128}$/.test(body.nonce) ? body.nonce : ""; // ≥ 22 个 base64url 字符 = ≥ 128 位
  const inviteUrl = isPeerBaseUrl(str(body?.inviteUrl)) && str(body?.inviteUrl).length <= 2048 ? str(body?.inviteUrl) : "";
  return { join, name, url: str(body?.url), token: str(body?.token), iid, nonce, inviteUrl, ...sender, e2e: sealed?.e2e ?? "", ...(sealed ? { session: sealed.session } : {}) };
}

/** manager peer-invite-redeem 的参数（manager/peer-join.ts parseRedeemArgs 按同样的名字读） */
export function redeemArgs(i: RedeemInput): string[] {
  const opt = (flag: string, v: string): string[] => (v ? [flag, v] : []);
  return ["--join", i.join, "--name", i.name, ...opt("--url", i.url), ...opt("--token", i.token), ...opt("--iid", i.iid),
    ...opt("--fp", i.fp), ...opt("--pk", i.pk), ...opt("--nonce", i.nonce), ...opt("--invite-url", i.inviteUrl), ...opt("--e2e", i.e2e)];
}

export interface RedeemDeps {
  /** bridge/management.ts 的 runManager（hub，不能从这里 import，由 api-routes 注入） */
  runManager: (...args: string[]) => Promise<any>;
  notifyOwner?: (content: string) => Promise<void>;
  local?: () => Promise<LocalE2e | null>;
}

/** POST /api/v1/peers/redeem（无 Bearer 的公开端点，api-routes.ts handleApiRequest 顶部调；从 api-routes 搬出） */
export async function handlePeerRedeem(req: Request, d: RedeemDeps): Promise<Response> {
  const input = await redeemPrecheck(req, Date.now(), d.local); // 来源、口令、按来源限流、对方指纹与公钥、加密兑换
  if (input instanceof Response) return input;
  const r: any = await d.runManager("peer-invite-redeem", ...redeemArgs(input));
  if (r?.ok) {
    recordMetric("peer_managed", { meta: { action: "redeem", peer: r.peer } });
    console.log(`🤝 [api] peer 邀请已兑换: ${r.peer}（scope: ${(r.agents || []).join(",")}）${input.session ? "（端到端加密）" : ""}`);
    void d.notifyOwner?.(
      `🤝 新 peer「${r.peer}」通过一键邀请接入，可访问: ${(r.agents || []).join(", ") || "（无）"}` +
        (r.oneWay ? "（单向：对方访问我，我未获对方权限）" : "") +
        `。撤销：侧栏顶部 Peer 按钮 → 移除，或 \`peer-http-remove ${r.peer}\``,
    ).catch(() => {}); // 提醒 owner 失败不影响兑换本身，对方已经接入
  }
  if (r?.ok && input.session) return apiJson(200, await sealRedeemResponse(input.session, r));
  if (r?.code === "e2e_required") return apiJson(403, { ok: false, code: "e2e_required", error: r.error });
  // 失败一律 400 且不细分原因等级——这是个无鉴权端点，不给探测者更多信息面
  return apiJson(r?.ok ? 200 : 400, r ?? { ok: false, error: "manager failed" });
}

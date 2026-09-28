/**
 * POST /api/v1/peers/redeem：一键邀请的兑换回调（从 api-routes.ts 搬出，腾出行数给 E2E）。对方 bridge 打进来，拿不到我方 Bearer，
 * 鉴权依据是 body 里的一次性 joinSecret（manager 侧常数时间比对），限流是纵深防御 + 挡日志噪音。
 * 带密钥的邀请（docs/relay/e2e-design.md §5.1）：正文是 HPKE 信封，解开后兑换方的身份公钥必须就是外层认出的那台机器，
 * 成功响应加密回去；明文兑换带密钥的邀请由 manager 拒掉并作废邀请（口令已明文过了网络）。失败一律明文、不带秘密。
 */
import { verifyE2eKey } from "../lib/e2e-machine-key.js";
import { keyFingerprint } from "../lib/instance-key.js";
import { recordMetric } from "../lib/metrics.js";
import { localE2e, type LocalE2e } from "../lib/peer-e2e-local.js";
import { isSealedRedeem, openRedeemRequest, sealRedeemResponse, type RedeemSession } from "../lib/peer-e2e-redeem.js";
import { SlidingWindowLimiter } from "../lib/principals.js";
import { redeemRefusal, redeemSenderFp } from "./api-auth.js";
import { apiJson, INVALID_JSON, invalidJsonBody, readJsonBody } from "./api-respond.js";

export interface RedeemDeps {
  /** bridge/management.ts 的 runManager（hub，不能从这里 import，由 api-routes 注入） */
  runManager: (...args: string[]) => Promise<any>;
  notifyOwner?: (content: string) => Promise<void>;
  local?: () => Promise<LocalE2e | null>;
}

const redeemLimiter = new SlidingWindowLimiter(10, 60_000);

type Opened = { payload: any; session: RedeemSession; e2e: string };

/** 解开加密兑换，核对兑换方的身份公钥 = 外层认出的发送方，并验他的签名块；不过 → 明文错误响应 */
async function openSealed(raw: unknown, fromFp: string | null, local: () => Promise<LocalE2e | null>): Promise<Opened | Response> {
  const l = await local();
  if (!l) return apiJson(503, { ok: false, error: "end-to-end key unavailable on this instance" });
  const o = isSealedRedeem(raw) ? await openRedeemRequest(l.machine.pair, l.fp, raw) : null;
  if (!o) return apiJson(400, { ok: false, error: "invalid invite redemption" });
  const p = (o.payload ?? {}) as { idk?: unknown; key?: unknown };
  const ek = typeof p.idk === "string" ? await verifyE2eKey(p.idk, p.key) : null;
  if (!ek) return apiJson(400, { ok: false, error: "redeemer key block invalid" });
  if (!fromFp || keyFingerprint(p.idk as string) !== fromFp) return apiJson(403, { ok: false, error: "redeemer identity does not match the sender" });
  return { payload: o.payload, session: o.session, e2e: JSON.stringify({ idk: p.idk, ek: { v: ek.v, ts: ek.ts, pub: ek.pub, sig: ek.sig } }) };
}

export async function handlePeerRedeem(req: Request, d: RedeemDeps): Promise<Response> {
  const refused = redeemRefusal(req); // 经中继隧道 / 路径模式来的兑换一律 403（bridge/api-auth.ts）
  if (refused || !redeemLimiter.tryAcquire()) return refused ?? apiJson(429, { ok: false, error: "rate limited" });
  const fromFp = await redeemSenderFp(req); // 对方指纹：经中继的取 peer 入口核过的发件人，直连的取兑换请求的签名钥匙（bridge/api-auth.ts）
  const raw: any = await readJsonBody(req);
  if (raw === INVALID_JSON) return invalidJsonBody();
  const sealed = isSealedRedeem(raw) ? await openSealed(raw, fromFp, d.local ?? (() => localE2e())) : null;
  if (sealed instanceof Response) return sealed;
  const body = sealed ? sealed.payload : raw;
  const join = typeof body?.join === "string" ? body.join.trim() : "";
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const peerUrl = typeof body?.url === "string" ? body.url.trim() : "", token = typeof body?.token === "string" ? body.token.trim() : "";
  const iid = typeof body?.iid === "string" && /^[\w-]{1,64}$/.test(body.iid) ? body.iid : ""; // 对方实例 id：同一对方合进同一条记录
  if (!join || !name) return apiJson(400, { ok: false, error: '"join" and "name" required' });
  const r: any = await d.runManager(
    "peer-invite-redeem", "--join", join, "--name", name,
    ...(peerUrl ? ["--url", peerUrl] : []), ...(token ? ["--token", token] : []), ...(iid ? ["--iid", iid] : []), ...(fromFp ? ["--fp", fromFp] : []),
    ...(sealed ? ["--e2e", sealed.e2e] : []),
  );
  if (r?.ok) {
    recordMetric("peer_managed", { meta: { action: "redeem", peer: r.peer } });
    console.log(`🤝 [api] peer 邀请已兑换: ${r.peer}（scope: ${(r.agents || []).join(",")}）${sealed ? "（端到端加密）" : ""}`);
    void d.notifyOwner?.(
      `🤝 新 peer「${r.peer}」通过一键邀请接入，可访问: ${(r.agents || []).join(", ") || "（无）"}` +
        (r.oneWay ? "（单向：对方访问我，我未获对方权限）" : "") +
        `。撤销：侧栏顶部 Peer 按钮 → 移除，或 \`peer-http-remove ${r.peer}\``,
    ).catch(() => {}); // 提醒 owner 失败不影响兑换本身，对方已经接入
  }
  if (r?.ok && sealed) return apiJson(200, await sealRedeemResponse(sealed.session, r));
  if (r?.code === "e2e_required") return apiJson(403, { ok: false, code: "e2e_required", error: r.error });
  // 失败一律 400 且不细分原因等级——这是个无鉴权端点，不给探测者更多信息面
  return apiJson(r?.ok ? 200 : 400, r ?? { ok: false, error: "manager failed" });
}

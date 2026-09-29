/**
 * peer 请求被对方拒绝时给调用方的话（直连的 401/403/429 响应体、经中继的 RelayError）与本机拒绝时写进 error 的说明。
 * 原则：按原因说清楚该谁做什么；签名类的问题重新握手（换 token）解决不了，不能说成「token 失效」。
 * 单测在 tests/peer-trust.test.ts。
 */
import { E2eError, E2eLocalError, E2eOuterError } from "./peer-e2e-client.js";
import type { RelayError } from "./relay-client-types.js";
import { remoteCode } from "./remote-text.js";

const SIG_HINTS: Record<string, string> = {
  replay: "这条请求被对方当成了重放（同一个签名用了两次）——不要原样重发，稍后重新发一条即可",
  full: "对方的防重放缓存满了，暂时不收新的请求——稍后再发",
  before_start: "对方 bridge 刚重启，这条请求的签名时间早于它启动（本机时钟比对方慢）——先校准本机时间，再重新发",
  stale: "两台机器时钟差超过 5 分钟，签名被判过期——先校准两边的系统时间",
  bad: "签名和请求对不上（请求在路上被改过）——重发一次；一直这样就检查中间的反代：它改了路径或正文（比如剥掉了路径前缀），签名就对不上",
  unanchored: "对方已过了老 peer 的截止日，又从没记下本机的钥匙——请对方删掉这个 peer 后重新给你发一张邀请",
  invite_expired: "这张邀请已过期或被撤销，里面带的 token 跟着失效——请对方重新生成一张邀请",
  invite_read_only: "邀请还没兑换完成，里面带的 token 只能读——先完成加入再发消息",
  // 本机 E2E 出站合成的（lib/peer-e2e-outbound.ts）：重握手后原样重发撞上 before_start = 对方真重启过、原请求没被处理
  e2e_peer_restarted: "对方重启过，这条没被处理，请重发",
};

const KEY_HINT = "对方认不出本机的签名钥匙（本机重装过，或对方记下的指纹不是本机）——请对方删掉这个 peer 后重新给你发一张邀请";

/** 对方回 401/403/429 时的提示。body 是对方回的 JSON（可能为空）；code=peer_signature 按 reason 分开说，其余是 token / scope 问题 */
export function peerAuthHint(raw: unknown): string {
  const body = (raw && typeof raw === "object" ? raw : {}) as { code?: unknown; reason?: unknown; cause?: unknown };
  if (body.code === "rate_limited") return "对方限流：一分钟里请求太多——稍后再发";
  if (body.code !== "peer_signature") return "token 无效或已被对方 revoke——联系对方确认，或重新握手";
  if (body.reason === "sig_rate_limited") return `一分钟里验签失败太多次，对方暂时限流（最近一次失败原因：${typeof body.cause === "string" && Object.hasOwn(SIG_HINTS, body.cause) ? body.cause : "未知"}）——先按原因修好再发`;
  const reason = String(body.reason);
  return Object.hasOwn(SIG_HINTS, reason) ? SIG_HINTS[reason]! : KEY_HINT; // 只认本机的表，原型上的键不算
}

/**
 * 对方中继入站（bridge/relay-inbound.ts）拒绝验签时的说明原文。它经中继传回，中继能改，所以发起方只拿收到的说明跟这几条逐字比，
 * 挑出本机的提示，说明本身从不展示（tests/peer-trust.test.ts）
 */
export const RELAY_SIG_DETAIL = {
  missing: "signature headers missing",
  foreignKey: "signing key does not match sender",
  stale: "timestamp outside ±300 s",
  mismatch: "signature mismatch",
  beforeStart: "signed before the receiver started: your clock is behind, sync it and resend",
} as const;

/** 超时类的中继错误：按 TimeoutError 抛，http-peer 据此说「可能已送达，别重发」 */
const RELAY_TIMEOUT_CODES = new Set(["timeout", "local_timeout", "peer_disconnected", "connection_lost", "stream_idle"]);

/**
 * 经中继的 peer 请求被拒（对方中继入站或中继本身）时的准确一句；不是这类（真连不上、超时）返回 null，调用方照旧按网络问题说。
 * 只看 code 与逐字比对的说明（RELAY_SIG_DETAIL），不把远端文字放进返回值
 */
export function relayRefusalHint(code: string, detail?: string): string | null {
  if (code === "bad_signature") {
    if (detail === RELAY_SIG_DETAIL.beforeStart) return SIG_HINTS.before_start!;
    if (detail === RELAY_SIG_DETAIL.stale) return SIG_HINTS.stale!;
    return detail === RELAY_SIG_DETAIL.missing || detail === RELAY_SIG_DETAIL.foreignKey ? KEY_HINT : SIG_HINTS.bad!;
  }
  if (code === "replay") return SIG_HINTS.replay!;
  if (code === "replay_full") return SIG_HINTS.full!;
  if (code === "sender_forbidden") return "对方只收联系人发来的、带对方签给本机的 token 的请求，这条不符合——请对方删掉这个 peer 后重新给你发一张邀请";
  return null;
}

/** 经中继调用失败：只带清洗过的 code 与本机的提示（bridge/relay-link.ts、relay-routes.ts 造）；中继 / 对方给的说明文字只进日志 */
export class RelayCallError extends Error {
  readonly hint: string | null;
  constructor(readonly code: string, remoteDetail?: string) {
    super(`relay ${code}`);
    this.name = RELAY_TIMEOUT_CODES.has(code) ? "TimeoutError" : "RelayCallError";
    this.hint = relayRefusalHint(code, remoteDetail);
  }
}

export const relayCallError = (e: RelayError): RelayCallError => new RelayCallError(remoteCode(e.code, "relay_error"), e.message);

/** 这次失败按「超时 = 可能已送达」报吗：E2E 的错误另有自己的结局（看类型），不从它的文字里猜 */
export function peerCallIsTimeout(e: unknown): boolean {
  if (e instanceof E2eError) return false;
  return (e as Error)?.name === "TimeoutError" || /timed?\s*out/i.test((e as Error)?.message || "");
}

/**
 * 发 peer 请求抛了异常（不是超时）时给调用方 agent 的话：只用本机的固定模板，按失败来源（lib/peer-e2e-client.ts 三类、中继、本机网络）分。
 * 投递结局只按本机知道的事实说：本机没发出 → 没送到；加密请求已发出却没拿到认证过的回执 → 状态未知，不许说「没送到」或「请重发」
 */
export function peerCallFailureText(label: string, e: unknown, peerName: string): string {
  const online = `请确认对方实例在线（peer-http-test ${peerName}）`;
  if (e instanceof E2eLocalError) {
    if (e.code === "e2e_too_large") return `[⚠️ peer 调用失败] ${label} 没有发出：加密后超过对方的单条上限（2 MiB），消息没送到——缩短或拆成几条再发。`;
    return `[⚠️ peer 调用失败] ${label} 没有发出：本机的端到端加密不可用（${e.code}），消息没送到。`;
  }
  if (e instanceof E2eOuterError) {
    if (!e.sent) return `[⚠️ peer 调用失败] ${label} 没有发出：和对方建立加密会话失败，消息没送到。${online}。`;
    return `[⚠️ peer 调用结果未知] ${label}：请求已加密发出，但没收到对方认证过的回执，可能已被处理——不要原样重发，稍后向对方确认。`;
  }
  if (e instanceof RelayCallError) {
    if (e.hint) return `[⚠️ peer 调用失败] ${label} 经中继被对方拒绝（${e.code}）：${e.hint}。`;
    return `[⚠️ peer 调用失败] ${label} 经中继没能送达（中继或对方给的原因未经认证，已记入日志）。${online}。`;
  }
  return `[⚠️ peer 调用失败] ${label} 网络不可达：${(e as Error)?.message ?? String(e)}。${online}。`;
}

/**
 * 对方响应体里的 error 文字能不能给 agent 看：认证过的（E2E 内层响应，lib/peer-e2e-client.ts isE2eResponse；解开的加密兑换）
 * 出自对方本人，照原样用；legacy 明文响应中继 / 路上都能伪造，只用本机的 fallback 模板，原文只进日志并标明未经认证
 */
export function peerErrorText(authenticated: boolean, body: unknown, fallback: string, peerName: string): string {
  const err = (body as { error?: unknown } | null)?.error;
  if (typeof err !== "string" || !err) return fallback;
  if (authenticated) return err;
  console.warn(`⚠️ [peer] ${peerName} 明文响应里的 error（未经认证，只供排查）: ${JSON.stringify(err.slice(0, 200))}`);
  return fallback;
}

/** 本机拒绝 peer 签名时写进 error 的说明：老版本的调用方只会原样显示 error（它不认 reason），所以要在这里说清楚不是 token 失效 */
export function peerSigErrorText(reason: string): string {
  const extra = reason === "replay" ? "（老版本同一秒发两条相同的消息也会这样：换个说法或隔一秒再发）" : "";
  return `peer request signature rejected: ${reason} — 签名问题，不是 token 失效。${SIG_HINTS[reason] ?? KEY_HINT}${extra}`;
}

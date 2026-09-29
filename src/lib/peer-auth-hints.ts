/**
 * peer 请求被对方拒绝时给调用方的话（直连的 401/403/429 响应体、经中继的 RelayError）与本机拒绝时写进 error 的说明。
 * 原则：按原因说清楚该谁做什么；签名类的问题重新握手（换 token）解决不了，不能说成「token 失效」。
 * 单测在 tests/peer-trust.test.ts。
 */

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
  if (body.reason === "sig_rate_limited") return `一分钟里验签失败太多次，对方暂时限流（最近一次失败原因：${String(body.cause ?? "未知")}）——先按原因修好再发`;
  return SIG_HINTS[String(body.reason)] ?? KEY_HINT;
}

/**
 * 经中继的 peer 请求被对方的中继入站拒绝（bridge/relay-inbound.ts，经 bridge/relay-link.ts 变成 "relay <code>: <说明>" 的异常）：
 * 返回准确的一句；不是这类（真连不上、超时）返回 null，调用方照旧按网络问题说。
 */
export function relayRefusalHint(message: string): string | null {
  const m = /^relay (\w+): (.*)$/s.exec(message);
  if (!m) return null;
  const [, code, detail] = m;
  if (code === "bad_signature") {
    if (/started/.test(detail!)) return SIG_HINTS.before_start!;
    if (/300 s/.test(detail!)) return SIG_HINTS.stale!;
    return /does not match sender|missing/.test(detail!) ? KEY_HINT : SIG_HINTS.bad!;
  }
  if (code === "replay") return SIG_HINTS.replay!;
  if (code === "replay_full") return SIG_HINTS.full!;
  if (code === "sender_forbidden") return "对方只收联系人发来的、带对方签给本机的 token 的请求，这条不符合——请对方删掉这个 peer 后重新给你发一张邀请";
  return null;
}

/** 发 peer 请求抛了异常（不是超时）时给调用方的话：中继入站的拒绝按原因说，其余才是连不上 */
export function peerCallFailureText(label: string, message: string, peerName: string): string {
  const refused = relayRefusalHint(message);
  if (refused) return `[⚠️ peer 调用失败] ${label} 被对方拒绝（${message}）：${refused}。`;
  return `[⚠️ peer 调用失败] ${label} 网络不可达：${message}。请确认对方实例在线（peer-http-test ${peerName}）。`;
}

/** 本机拒绝 peer 签名时写进 error 的说明：老版本的调用方只会原样显示 error（它不认 reason），所以要在这里说清楚不是 token 失效 */
export function peerSigErrorText(reason: string): string {
  const extra = reason === "replay" ? "（老版本同一秒发两条相同的消息也会这样：换个说法或隔一秒再发）" : "";
  return `peer request signature rejected: ${reason} — 签名问题，不是 token 失效。${SIG_HINTS[reason] ?? KEY_HINT}${extra}`;
}

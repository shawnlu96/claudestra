/**
 * 网络 / 服务端瞬时错误的判定（NRT-1，docs/architecture/api-error-resume.md）：断网、代理抖、服务端 5xx / 满载这类等一会儿自己会好的，
 * 续跑按 TRANSIENT_BACKOFF_MS 退避、期间不开卡不报频道，预算用完才报一次。额度、登录失效、内容策略拦截、上下文耗尽、模型不可用
 * 不算——它们各有各的路（额度闸 / 登录卡 / 监护 cyber / 人工），在这里先排除，就算原文里同时带了网络字样也不改道。
 * 输入是 Claude Code 的错误码 + 原文（拼在一起给），或 ACP 失败的 message。纯函数，tests/transient-error.test.ts 用真实原文钉住。
 */
import type { AcpFailure } from "./acp/failures.js";

/**
 * 先排除：登录 / 额度（含套餐过期）/ 策略 / 上下文 / 模型不可用 / 请求本身错（4xx、invalid_request、not_found）/ 本机钥匙串。
 * 「not your usage limit」是服务端临时限流的原话，不当额度
 */
const NOT_TRANSIENT_RE = new RegExp([
  String.raw`\/login|log ?in\b|authenticat|unauthori[sz]ed|forbidden|invalid[ _-]?api[ _-]?key|oauth|keychain`,
  String.raw`(hit|reached) your .{0,40}limit|(?<!not your )usage limit|UsageLimit|usage-credits|\bquota\b|insufficient[_ ]quota|exceeded your`,
  String.raw`billing|spend limit|payment required|credit balance|insufficient balance|(package|plan|subscription) has expired`,
  String.raw`cyber|safeguards flagged|content (filtering )?policy|usage policy|legal\/aup`,
  String.raw`prompt is too long|context (length|window|limit)|maximum context|too many tokens`,
  String.raw`model_not_found|not_found|issue with the selected model|could not be parsed|\binvalid_request|extra inputs are not permitted`,
  String.raw`\b40[0-7]\b|\b41\d\b`,
].join("|"), "i");

/** 网络层（连接 / DNS / TLS / 超时 / 中途断流）与服务端瞬时（5xx、529 满载、临时限流） */
const TRANSIENT_RE = new RegExp([
  String.raw`connection (error|dropped|lost|closed|refused|reset)|unable to connect|can't reach|socket hang up|fetch failed|network error`,
  String.raw`stream (disconnected|ended|closed)|premature close|other side closed|socket disconnected|no response body|dns error|failed to lookup address|\bsocks5? proxy`,
  String.raw`（connection）|ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|\bUND_ERR`,
  String.raw`certificate|\bTLS\b|\bSSL\b|handshake`,
  String.raw`\btimed? ?out\b|\bterminated\b|operation was aborted|mid-response|mid-stream|stopped arriving|stalled`,
  String.raw`server_error|server-side issue|\b50[0234]\b|bad gateway|service unavailable|\b529\b|overloaded|high demand`,
  String.raw`\b429\b|rate[ _-]?limited|too many requests|temporarily limiting`,
].join("|"), "i");

/** 这段错误（CC：错误码 + 原文；ACP：失败 message）是不是瞬时网络类 */
export function isTransientError(text: string): boolean {
  return TRANSIENT_RE.test(text) && !NOT_TRANSIENT_RE.test(text);
}

/**
 * ACP 回合失败是不是瞬时网络类、且会走续跑：适配器明说不能重试（retry:false，宿主不标 API 错误、不会续跑）、投递不明、
 * 上下文耗尽（newSession）的都不算，照旧开卡。
 */
export function isTransientAcpFailure(f: AcpFailure): boolean {
  return f.kind === "error" && f.retry !== false && !f.deliveryUnknown && !f.newSession && isTransientError(f.message);
}

/** 第 n 次续跑前等多久（n 从 0 数）：1、2、4、8 分钟，共 4 次、约 15 分钟；第 5 次再撞才报 */
export const TRANSIENT_BACKOFF_MS: readonly number[] = [1, 2, 4, 8].map((m) => m * 60_000);

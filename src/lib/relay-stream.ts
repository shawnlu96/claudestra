/**
 * 帧与 HTTP 之间的搬运（docs/relay/protocol.md §3）：正文分块、头过滤、流的收尾。纯函数 + 一个把 data 帧
 * 拼回 ReadableStream 的小闸门，服务端 front 与 bridge 侧的隧道 / peer 转发共用，两边分块大小与头规则才一致。
 * 不依赖 WebSocket、不知道帧要发给谁；发送由调用方注入的 emit 完成。
 */
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import { LIMITS, type Headers } from "./relay-protocol.js";

/** hop-by-hop 与由传输层重算的头，任何方向都不透传 */
const HOP = new Set(["connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade", "proxy-authorization", "proxy-authenticate", "content-length"]);

/** 出站请求头：去 hop-by-hop；drop 里的也去（peer 路径去 host / x-forwarded-* / 对方自带的 x-claudestra-relay-*） */
export function forwardHeaders(h: Headers, drop: (k: string) => boolean = () => false): Headers {
  const out: Headers = {};
  for (const [k, v] of Object.entries(h)) {
    const key = k.toLowerCase();
    if (HOP.has(key) || drop(key)) continue;
    out[key] = v;
  }
  return out;
}

/**
 * peer 路径要额外去掉的头（§4.1）。cookie 与设备头（lib/devices.ts DEVICE_HEADER）也去：peer 只凭 Bearer + 签名进门，
 * 帧里带着浏览器凭据也不能在本机换成设备身份
 */
export const dropForPeer = (k: string): boolean =>
  k === "host" || k === "cookie" || k === "x-cstra-device" || k.startsWith("x-forwarded-") || k.startsWith("x-claudestra-relay-");

/** set-cookie 是唯一不能用逗号合并的多值头（Expires 里就有逗号）：帧里多条以 \n 连接，recordToHeaders 再拆回去 */
export const SET_COOKIE_SEP = "\n";

/** fetch 的 Headers 对象 → 小写键的普通对象；同名多值 fetch 已用 ", " 合并，set-cookie 单独按 \n 连接 */
export function headersToObject(h: globalThis.Headers): Headers {
  const out: Headers = {};
  h.forEach((v, k) => {
    out[k.toLowerCase()] = v;
  });
  const cookies = typeof h.getSetCookie === "function" ? h.getSetCookie() : [];
  if (cookies.length) out["set-cookie"] = cookies.join(SET_COOKIE_SEP);
  return out;
}

/** 帧里的头 → fetch 的 Headers：set-cookie 按 \n 拆成多条 append（一条合并的 set-cookie 浏览器只认第一段） */
export function recordToHeaders(h: Headers): globalThis.Headers {
  const out = new globalThis.Headers();
  for (const [k, v] of Object.entries(h)) {
    if (k.toLowerCase() !== "set-cookie") {
      out.set(k, v);
      continue;
    }
    for (const c of v.split(SET_COOKIE_SEP)) if (c) out.append("set-cookie", c);
  }
  return out;
}

/** 明文端口上的 Web 把 Location 算成 http://<host>/…：改回 https，浏览器才不会先绕 80 一圈（§4.2） */
export function rewriteLocation(headers: Headers, host: string): Headers {
  const loc = headers.location;
  if (!loc || !host) return headers;
  const prefix = `http://${host.toLowerCase()}`;
  if (loc.toLowerCase().startsWith(prefix + "/") || loc.toLowerCase() === prefix) {
    return { ...headers, location: `https://${host}${loc.slice(prefix.length)}` };
  }
  return headers;
}

const B64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export const b64 = {
  enc: (u: Uint8Array): string => Buffer.from(u).toString("base64"),
  dec: (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "base64")),
  /** 严格解码：不是规范的 base64（长度、字符、填充）返回 null——Buffer.from 会把乱码默默解成更短甚至空的字节 */
  decStrict: (s: string): Uint8Array | null => (B64_RE.test(s) ? new Uint8Array(Buffer.from(s, "base64")) : null),
};

/** 把一段字节切成 ≤ maxChunk 的块（空输入 → 空数组） */
export function chunkBytes(u: Uint8Array, maxChunk: number = LIMITS.maxChunkBytes): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < u.length; i += maxChunk) out.push(u.subarray(i, Math.min(u.length, i + maxChunk)));
  return out;
}

/**
 * 把一个正文（字节或流）按块交给 emit（data 帧），最后 emit(null) 表示 end。
 * 流里的每个 chunk 再按 maxChunk 切，保证单帧不超上限。abort 或 emit 抛错：cancel 源流后抛出，不发 end。
 */
export async function pumpBody(
  body: Uint8Array | ReadableStream<Uint8Array> | null,
  emit: (chunk: Uint8Array | null) => void,
  signal?: AbortSignal,
  maxChunk: number = LIMITS.maxChunkBytes,
): Promise<void> {
  if (!body) return emit(null);
  if (body instanceof Uint8Array) {
    for (const c of chunkBytes(body, maxChunk)) emit(c);
    return emit(null);
  }
  const reader = body.getReader();
  // 中止 / emit 失败都要 cancel 源流：只 releaseLock 的话源流的 cancel() 永不触发，SSE 这类推流源（终端、events）
  // 会一直活着往没人读的队列里堆（tests/relay-stream.test.ts）。abort 时立刻 cancel，挂着的 read 随之返回 done
  const stop = (why: unknown) => void reader.cancel(why).catch(() => { /* 源流已出错或已关：没有要收尾的了 */ });
  const onAbort = () => stop(signal?.reason);
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      if (signal?.aborted) throw new Error("aborted");
      const { done, value } = await reader.read();
      if (done) break;
      if (value) for (const c of chunkBytes(value, maxChunk)) emit(c);
    }
    if (signal?.aborted) throw new Error("aborted"); // abort 唤醒的 done 不是正文读完：不补发 end
    emit(null);
  } catch (e) {
    stop(e);
    throw e;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

/**
 * 收 data 帧、出 ReadableStream：push(bytes) 入队，end() 关流，fail(err) 让读端报错。
 * 读端取消（浏览器断开、fetch abort）时调 onCancel，调用方据此发 cancel 帧。
 */
export interface StreamSink {
  stream: ReadableStream<Uint8Array>;
  push(bytes: Uint8Array): void;
  end(): void;
  fail(err: Error): void;
  /** 已经 end / fail / 被读端取消 */
  readonly closed: boolean;
}

export function streamSink(onCancel?: () => void): StreamSink {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    start: (c) => {
      controller = c;
    },
    cancel: () => {
      closed = true;
      onCancel?.();
    },
  });
  const guard = (fn: () => void) => {
    if (closed || !controller) return;
    try {
      fn();
    } catch {
      closed = true; // 读端已经走了（controller 关闭 / 出错）：再往里塞没有接收者，丢掉正确
    }
  };
  return {
    stream,
    push: (bytes) => guard(() => controller!.enqueue(bytes)),
    end: () =>
      guard(() => {
        closed = true;
        controller!.close();
      }),
    fail: (err) =>
      guard(() => {
        closed = true;
        controller!.error(err);
      }),
    get closed() {
      return closed;
    },
  };
}

/** 把整个流读成一段字节（peer 路径验签要完整正文；上限防止对方灌满内存） */
export async function collectBody(body: ReadableStream<Uint8Array> | Uint8Array | null, maxBytes: number): Promise<Uint8Array> {
  if (!body) return new Uint8Array();
  if (body instanceof Uint8Array) {
    if (body.length > maxBytes) throw new Error(`body exceeds ${maxBytes} bytes`);
    return body;
  }
  const parts: Uint8Array[] = [];
  let total = 0;
  const reader = body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.length;
      if (total > maxBytes) throw new Error(`body exceeds ${maxBytes} bytes`);
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** 这些状态码的 Response 不许带 body，硬塞会抛 */
export const NULL_BODY_STATUS: ReadonlySet<number> = new Set([101, 204, 205, 304]);

/** 小于这个就不压：省下的字节抵不过 gzip 头尾 */
const GZIP_MIN_BYTES = 1024;
/** 一次性正文的文本类型才压：SSE（text/event-stream）、text/plain 这类可能是长流的不碰，图片 / 字体 / 压缩包本来就压过 */
const COMPRESSIBLE = /^(?:application\/(?:json|javascript|xml|manifest\+json|[\w.-]+\+json)|text\/(?:html|css|javascript|xml)|image\/svg\+xml)\s*(?:;|$)/i;
const gzipAsync = promisify(gzip);

/**
 * Accept-Encoding 是否接受 gzip（RFC 9110 §12.5.3）：按编码名 + q 值判断，`gzip;q=0` 是明确拒收。
 * 显式写了 gzip 就以它为准，没写才看 `*`；只认 gzip 这个词会把拒收当成接受。
 */
function acceptsGzip(acceptEncoding: string): boolean {
  let star: boolean | null = null;
  for (const part of acceptEncoding.split(",")) {
    const [name, ...params] = part.split(";").map((x) => x.trim().toLowerCase());
    const q = params.find((p) => p.startsWith("q="));
    const ok = !q || Number(q.slice(2)) > 0; // q 写坏（NaN）当拒收：NaN > 0 为 false
    if (name === "gzip" || name === "x-gzip") return ok;
    if (name === "*") star = ok;
  }
  return star === true;
}

/**
 * 浏览器经中继拿的响应（隧道与路径模式）在本机 gzip 后再上中继：上行慢时 JSON / JS 原文再经 base64 是大头，
 * 历史 / agent 列表压完约剩两成；front 原样转 content-encoding，浏览器按头自己解。本机 Web 已压过的（带 content-encoding）、
 * 没声明 gzip 的、分段（206 / content-range）的原样过。整读可以——只压一次性正文；gzip 走线程池，不卡事件循环。
 */
export async function gzipBody(
  status: number, headers: Headers, body: Uint8Array | ReadableStream<Uint8Array> | null, acceptEncoding = "",
): Promise<{ headers: Headers; body: Uint8Array | ReadableStream<Uint8Array> | null }> {
  if (!body || status === 206 || headers["content-range"] || headers["content-encoding"]) return { headers, body };
  if (!acceptsGzip(acceptEncoding) || !COMPRESSIBLE.test(headers["content-type"] ?? "")) return { headers, body };
  const raw = body instanceof Uint8Array ? body : new Uint8Array(await new Response(body).arrayBuffer());
  if (raw.length < GZIP_MIN_BYTES) return { headers, body: raw };
  const { "content-length": _len, ...rest } = headers;
  const vary = rest.vary ? `${rest.vary}, Accept-Encoding` : "Accept-Encoding";
  return { headers: { ...rest, "content-encoding": "gzip", vary }, body: new Uint8Array(await gzipAsync(raw)) };
}

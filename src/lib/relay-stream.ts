/**
 * 帧与 HTTP 之间的搬运（docs/relay/protocol.md §3）：正文分块、头过滤、流的收尾。纯函数 + 一个把 data 帧
 * 拼回 ReadableStream 的小闸门，服务端 front 与 bridge 侧的隧道 / peer 转发共用，两边分块大小与头规则才一致。
 * 不依赖 WebSocket、不知道帧要发给谁；发送由调用方注入的 emit 完成。
 */
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

/** peer 路径要额外去掉的头（§4.1） */
export const dropForPeer = (k: string): boolean => k === "host" || k.startsWith("x-forwarded-") || k.startsWith("x-claudestra-relay-");

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

export const b64 = {
  enc: (u: Uint8Array): string => Buffer.from(u).toString("base64"),
  dec: (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "base64")),
};

/** 把一段字节切成 ≤ maxChunk 的块（空输入 → 空数组） */
export function chunkBytes(u: Uint8Array, maxChunk: number = LIMITS.maxChunkBytes): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < u.length; i += maxChunk) out.push(u.subarray(i, Math.min(u.length, i + maxChunk)));
  return out;
}

/**
 * 把一个正文（字节或流）按块交给 emit（data 帧），最后 emit(null) 表示 end。
 * 流里的每个 chunk 再按 maxChunk 切，保证单帧不超上限。abort 触发后停止读取并抛出。
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
  try {
    while (true) {
      if (signal?.aborted) throw new Error("aborted");
      const { done, value } = await reader.read();
      if (done) break;
      if (value) for (const c of chunkBytes(value, maxChunk)) emit(c);
    }
    emit(null);
  } finally {
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

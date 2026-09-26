/**
 * 中继客户端的出站在途表（docs/relay/protocol.md §3）：request() 发 req 帧、等 res 头、把 data / end 拼成流。
 * 只认识帧与 Promise，不知道 WebSocket——send 由 relay-client.ts 注入，断线时它调 rejectAll。
 * 同一个 id 可能同时是我发出去的请求与别人发进来的请求（各自生成 id），所以判归属要看来源指纹：
 * 我的出站 pending 记着 to，帧的 from 与之相等（或中继没盖 from）才算响应。
 */
import { LIMITS, apiPathOk, newRequestId, type DataFrame, type EndFrame, type ErrorFrame, type ResFrame } from "./relay-protocol.js";
import { b64, pumpBody, streamSink, type StreamSink } from "./relay-stream.js";
import { RelayError, type RelayRequest, type RelayResponse } from "./relay-client-types.js";

interface Pending {
  id: string;
  to: string;
  resolve: (r: RelayResponse) => void;
  reject: (e: Error) => void;
  sink: StreamSink | null;
  headTimer: ReturnType<typeof setTimeout>;
  cleanup: () => void;
}

export interface RequestOptions {
  /** 等响应头的时长；中继按它超时，本地再多等 headGraceMs 兜底 */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type SendFrame = (frame: object) => boolean;

export class OutboundTable {
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly send: SendFrame,
    private readonly random: (n: number) => Uint8Array,
    private readonly maxChunk: number = LIMITS.maxChunkBytes,
    private readonly headGraceMs = 5_000,
  ) {}

  get size(): number {
    return this.pending.size;
  }

  /** 这个 id 是不是我发出去、且来源对得上的在途请求 */
  owns(id: string, from: string | undefined): boolean {
    const p = this.pending.get(id);
    return !!p && (from === undefined || p.to === from);
  }

  request(to: string, req: RelayRequest, opts: RequestOptions = {}): Promise<RelayResponse> {
    if (!apiPathOk(req.path)) return Promise.reject(new RelayError("path_forbidden", "client", `${req.path} is not under /api/v1`));
    if (opts.signal?.aborted) return Promise.reject(new RelayError("cancelled", "client", "aborted before send"));
    let id = newRequestId(this.random);
    while (this.pending.has(id)) id = newRequestId(this.random);
    const timeoutMs = opts.timeoutMs ?? LIMITS.defaultReqTimeoutMs;
    return new Promise<RelayResponse>((resolve, reject) => {
      const onAbort = () => {
        this.send({ t: "cancel", id, to });
        this.fail(id, new RelayError("cancelled", "client", "request aborted"));
      };
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      const p: Pending = {
        id, to, resolve, reject, sink: null,
        headTimer: setTimeout(() => this.fail(id, new RelayError("timeout", "client", `no response head within ${timeoutMs + this.headGraceMs} ms`)), timeoutMs + this.headGraceMs),
        cleanup: () => opts.signal?.removeEventListener("abort", onAbort),
      };
      this.pending.set(id, p);
      const body = req.body ?? null;
      const inline = body instanceof Uint8Array && body.length <= this.maxChunk;
      const head = {
        t: "req", id, to, timeoutMs, method: req.method.toUpperCase(), path: req.path, headers: req.headers,
        ...(inline ? { body: b64.enc(body) } : {}), more: !inline && body !== null,
      };
      if (!this.send(head)) return this.fail(id, new RelayError("connection_lost", "client", "relay not connected"));
      if (!inline && body !== null) void this.pump(id, to, body, opts.signal);
    });
  }

  private async pump(id: string, to: string, body: Uint8Array | ReadableStream<Uint8Array>, signal?: AbortSignal): Promise<void> {
    try {
      await pumpBody(body, (chunk) => {
        if (!this.pending.has(id)) throw new Error("request already settled");
        this.send(chunk ? { t: "data", id, to, b64: b64.enc(chunk) } : { t: "end", id, to });
      }, signal, this.maxChunk);
    } catch (e) {
      // 正文没发完对方也收不到 end：告诉它别等，本地按失败结掉（已结掉的 fail 是空操作）
      this.send({ t: "cancel", id, to });
      this.fail(id, e instanceof RelayError ? e : new RelayError("cancelled", "client", `request body failed: ${(e as Error).message}`));
    }
  }

  /** res 头：resolve 出流；inline body 先入队，more=false 直接关流 */
  onRes(f: ResFrame): boolean {
    const p = this.pending.get(f.id);
    if (!p || p.sink) return false;
    clearTimeout(p.headTimer);
    p.sink = streamSink(() => {
      // 读端不要了（调用方 cancel 了流）：告诉对方别再发，本地清掉
      this.send({ t: "cancel", id: f.id, to: p.to });
      this.drop(f.id);
    });
    if (f.body) p.sink.push(b64.dec(f.body));
    if (!f.more) {
      p.sink.end();
      this.drop(f.id);
    }
    p.resolve({ status: f.status, headers: f.headers, body: p.sink.stream });
    return true;
  }

  onData(f: DataFrame): boolean {
    const p = this.pending.get(f.id);
    if (!p?.sink) return false;
    p.sink.push(b64.dec(f.b64));
    return true;
  }

  onEnd(f: EndFrame): boolean {
    const p = this.pending.get(f.id);
    if (!p?.sink) return false;
    p.sink.end();
    this.drop(f.id);
    return true;
  }

  /** 带 id 的 error：头没到就 reject，头到了就让流报错 */
  onError(f: ErrorFrame & { id: string }): boolean {
    if (!this.pending.has(f.id)) return false;
    this.fail(f.id, new RelayError(f.code, f.origin, f.message));
    return true;
  }

  /** 中继替对方取消了我的请求（对方断线等）：等同错误 */
  onCancel(id: string): boolean {
    if (!this.pending.has(id)) return false;
    this.fail(id, new RelayError("peer_disconnected", "relay", "cancelled by relay"));
    return true;
  }

  rejectAll(err: RelayError): void {
    for (const id of [...this.pending.keys()]) this.fail(id, err);
  }

  private fail(id: string, err: Error): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.drop(id);
    if (p.sink) p.sink.fail(err);
    else p.reject(err);
  }

  private drop(id: string): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    clearTimeout(p.headTimer);
    p.cleanup();
  }
}

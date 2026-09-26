/**
 * 中继客户端的入站路由（docs/relay/protocol.md §3、§4）：中继送来的 req 交给 bridge 注入的 handler，
 * 请求正文的 data / end 拼成流喂给它，处理结果用 res + data + end 发回；发起方 cancel 就 abort。
 * 入站 id 由发起方生成，不同发起方可能撞同一个 id，所以表按 `${from}|${id}` 记。
 * 隧道请求（from = "relay"）的回帖不带 to；peer 请求的 to = 发起方指纹。
 */
import { LIMITS, RELAY_FROM, type DataFrame, type EndFrame, type ReqFrame } from "./relay-protocol.js";
import { b64, pumpBody, streamSink, type StreamSink } from "./relay-stream.js";
import { RelayError, type InboundHandler, type InboundResponse } from "./relay-client-types.js";
import type { SendFrame } from "./relay-client-outbound.js";

interface Inbound {
  from: string;
  to: string | undefined;
  ctrl: AbortController;
  body: StreamSink;
}

export type Logger = (level: "info" | "warn" | "error", msg: string) => void;

export class InboundRouter {
  private readonly table = new Map<string, Inbound>();

  constructor(
    private readonly send: SendFrame,
    private readonly handler: InboundHandler | undefined,
    private readonly log: Logger,
    private readonly maxChunk: number = LIMITS.maxChunkBytes,
  ) {}

  get size(): number {
    return this.table.size;
  }

  private key(from: string, id: string): string {
    return `${from}|${id}`;
  }

  has(from: string, id: string): boolean {
    return this.table.has(this.key(from, id));
  }

  onReq(f: ReqFrame): void {
    const from = f.from ?? RELAY_FROM;
    const to = from === RELAY_FROM ? undefined : from;
    const k = this.key(from, f.id);
    if (this.table.has(k)) return this.log("warn", `入站请求 id 重复，忽略：${k}`);
    const ctrl = new AbortController();
    const body = streamSink();
    if (f.body) body.push(b64.dec(f.body));
    if (!f.more) body.end();
    const entry: Inbound = { from, to, ctrl, body };
    this.table.set(k, entry);
    void this.run(f, entry).finally(() => {
      if (this.table.get(k) === entry) this.table.delete(k);
    });
  }

  private async run(f: ReqFrame, entry: Inbound): Promise<void> {
    const { id } = f;
    const { from, to, ctrl } = entry;
    let res: InboundResponse;
    try {
      if (!this.handler) throw new RelayError("local_unreachable", "peer", "no inbound handler");
      res = await this.handler({ method: f.method, path: f.path, headers: f.headers, body: entry.body.stream }, { from, signal: ctrl.signal });
    } catch (e) {
      if (ctrl.signal.aborted) return; // 发起方已经不要了：回什么都没人收
      const err = e instanceof RelayError ? e : new RelayError("local_unreachable", "peer", (e as Error).message);
      this.log("warn", `入站 ${from} ${f.method} ${f.path} 失败: ${err.code} ${err.message}`);
      if (to) return void this.send({ t: "error", id, to, code: err.code, message: err.message, origin: "peer" });
      // 隧道请求没有 error 帧可回（发起方是中继 front）：给浏览器一个 502，正文说明是本机哪一步没通
      const body = b64.enc(new TextEncoder().encode(JSON.stringify({ ok: false, error: err.code, message: err.message })));
      this.send({ t: "res", id, status: 502, headers: { "content-type": "application/json" }, body, more: false });
      return;
    }
    if (ctrl.signal.aborted) return;
    const body = res.body ?? null;
    const inline = body instanceof Uint8Array && body.length <= this.maxChunk;
    const head = { t: "res", id, ...(to ? { to } : {}), status: res.status, headers: res.headers, ...(inline ? { body: b64.enc(body) } : {}), more: !inline && body !== null };
    if (!this.send(head) || inline || body === null) return;
    try {
      await pumpBody(body, (chunk) => {
        if (ctrl.signal.aborted) throw new Error("cancelled");
        this.send(chunk ? { t: "data", id, ...(to ? { to } : {}), b64: b64.enc(chunk) } : { t: "end", id, ...(to ? { to } : {}) });
      }, ctrl.signal, this.maxChunk);
    } catch (e) {
      // 响应流半途断了（本机 Web 掐了 SSE、或发起方已取消）：让对方别等剩下的
      if (!ctrl.signal.aborted) this.send({ t: "cancel", id, ...(to ? { to } : {}) });
      this.log("info", `入站 ${from} ${f.path} 响应流中断: ${(e as Error).message}`);
    }
  }

  /** 请求正文的后续块 */
  onData(from: string, f: DataFrame): boolean {
    const e = this.table.get(this.key(from, f.id));
    if (!e) return false;
    e.body.push(b64.dec(f.b64));
    return true;
  }

  onEnd(from: string, f: EndFrame): boolean {
    const e = this.table.get(this.key(from, f.id));
    if (!e) return false;
    e.body.end();
    return true;
  }

  /** 发起方 / 中继取消：abort 给 handler，请求流报错 */
  onCancel(from: string, id: string): boolean {
    const k = this.key(from, id);
    const e = this.table.get(k);
    if (!e) return false;
    this.table.delete(k);
    e.ctrl.abort();
    e.body.fail(new RelayError("cancelled", "relay", "request cancelled by originator"));
    return true;
  }

  /** 断线：所有在处理的入站一起 abort（回帖已经没有连接可发） */
  abortAll(): void {
    for (const [k, e] of this.table) {
      this.table.delete(k);
      e.ctrl.abort();
      e.body.fail(new RelayError("connection_lost", "client", "relay connection lost"));
    }
  }
}

/**
 * 中继客户端的推送在途表（docs/relay/protocol.md §3.5）：push() 发 push 帧、按 id 等 push-ack。与 relay-client-outbound.ts
 * 的 request() 同一套路（id 关联 + 本地超时 + 断线全拒），但简单得多：没有流、没有取消，一帧换一帧。
 * 只认识帧与 Promise，不知道 WebSocket——send 由 relay-client.ts 注入。
 */
import { newRequestId, type PushAckFrame } from "./relay-protocol.js";
import { RelayError, type PushAck, type PushRequest } from "./relay-client-types.js";
import type { SendFrame } from "./relay-client-outbound.js";

interface Waiter {
  resolve: (a: PushAck) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class PushTable {
  private readonly pending = new Map<string, Waiter>();

  constructor(
    private readonly send: SendFrame,
    private readonly random: (n: number) => Uint8Array,
    private readonly timeoutMs: number,
  ) {}

  get size(): number {
    return this.pending.size;
  }

  push(req: PushRequest): Promise<PushAck> {
    let id = newRequestId(this.random);
    while (this.pending.has(id)) id = newRequestId(this.random);
    return new Promise<PushAck>((resolve, reject) => {
      const timer = setTimeout(() => this.fail(id, new RelayError("timeout", "client", `no push-ack within ${this.timeoutMs} ms`)), this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      if (!this.send({ t: "push", id, ...req })) this.fail(id, new RelayError("connection_lost", "client", "relay not connected"));
    });
  }

  /** push-ack 帧：对上在途的就 resolve；对不上返回 false（超时后迟到的回执） */
  onAck(f: PushAckFrame): boolean {
    const w = this.pending.get(f.id);
    if (!w) return false;
    this.pending.delete(f.id);
    clearTimeout(w.timer);
    const { t: _t, id: _id, ...ack } = f;
    w.resolve(ack);
    return true;
  }

  rejectAll(err: RelayError): void {
    for (const id of [...this.pending.keys()]) this.fail(id, err);
  }

  private fail(id: string, err: Error): void {
    const w = this.pending.get(id);
    if (!w) return;
    this.pending.delete(id);
    clearTimeout(w.timer);
    w.reject(err);
  }
}

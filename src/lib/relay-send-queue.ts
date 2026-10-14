/**
 * 中继上行发送队列（docs/relay/protocol.md §3.6）：Bun 客户端 WebSocket 看不到发送缓冲（bufferedAmount 恒 0、send 不报背压），
 * 帧一交给 ws.send 就只能排队尾——pong 排在几百 KB 正文后面会被中继判死，小响应也要等大响应发完。所以帧先进这里：
 * - send()：控制帧（ping / pong / auth / cancel / error / push / contacts …）与本机发出的请求帧直接写，和改前一样；
 * - reply()：回给发起方的 res / data / end 按「对端 + id」分道，每次放「近来发得最少」那道的一帧（已发字节按 1 s 半衰期衰减）：
 *   新来的响应与偶尔推一条的 SSE 先走，正在灌大列表的那道持续让路；
 * - 已写出、中继还没确认的字节不超过窗口：每写窗口的 1/4 插一个 ping 探针，中继按序处理并原样回带 ts，
 *   某个探针的 pong 到了就说明它之前写的字节都已到中继。中继不回 pong 时正文停在这里，由心跳判死重连收尾。
 * 窗口按实测送达速率 × targetMs 自调：慢上行上在途只压几百毫秒的数据，快链路上窗口随确认变快而长大。
 */
export interface SendQueueOptions {
  /** 窗口下限：起步与慢链路上的在途量，放得下一两块回帖（16 KB 一块，上线约 22 KB） */
  minWindowBytes: number;
  /** 窗口上限：防内存与突发 */
  maxWindowBytes: number;
  /** 想让在途数据大约排多久（毫秒）：决定插队的 pong / 新响应最多等多久 */
  targetMs: number;
}

export const DEFAULT_SEND_QUEUE: SendQueueOptions = { minWindowBytes: 32 * 1024, maxWindowBytes: 4 * 1024 * 1024, targetMs: 400 };

const MIN_PROBE_BYTES = 4 * 1024;
/** 每道「近来已发字节」的半衰期：太长则长寿 SSE 攒下的历史会让它输给新来的大响应，太短则大响应和小响应分不开 */
const SERVICE_HALF_LIFE_MS = 1000;

type Frame = { t?: unknown; id?: unknown; to?: unknown; ts?: unknown } & Record<string, unknown>;
/** busy = 发探针时还有正文在排队：这段时间是窗口在卡，确认间隔才反映链路速率（空闲时测出来的只是应用自己慢） */
type Probe = { ts: number; upTo: number; busy: boolean };

const laneKey = (to: string | undefined, id: string): string => `${to ?? ""}|${id}`;

export class RelaySendQueue {
  /** 每道的待发帧（已序列化；fin = 这道最后一帧，发出后这道的记账清掉） */
  private readonly lanes = new Map<string, { raw: string; fin: boolean }[]>();
  /** 每道近来已发的字节（衰减前的值 + 记账时刻）；道排空不清，响应发完 / 取消 / 断线才清 */
  private readonly served = new Map<string, { bytes: number; at: number }>();
  private readonly probes: Probe[] = [];
  private written = 0;
  private acked = 0;
  private sinceProbe = 0;
  private lastTs = 0;
  private lastAck: { at: number; upTo: number } | null = null;
  private win: number;

  constructor(
    private readonly write: (raw: string) => boolean,
    private readonly o: SendQueueOptions = DEFAULT_SEND_QUEUE,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.win = o.minWindowBytes;
  }

  /** 排队中的帧数（测试与日志用） */
  get queued(): number {
    let n = 0;
    for (const q of this.lanes.values()) n += q.length;
    return n;
  }

  /** 当前窗口（字节） */
  get window(): number {
    return this.win;
  }

  /** 直写（不排队）；ping 记成探针 */
  send(frame: Frame): boolean {
    return frame.t === "ping" ? this.ping(frame) : this.put(JSON.stringify(frame));
  }

  /** 入站请求的回帖：res / data / end 进本道排队，cancel 丢掉本道排着的帧后直写，其余（error）直写 */
  reply(frame: Frame): boolean {
    const id = typeof frame.id === "string" ? frame.id : null;
    const to = typeof frame.to === "string" ? frame.to : undefined;
    if (!id || (frame.t !== "res" && frame.t !== "data" && frame.t !== "end")) {
      if (frame.t === "cancel" && id) this.drop(to, id); // 响应流半途断了：排着的正文不必再发
      return this.send(frame);
    }
    const k = laneKey(to, id);
    // 这道的最后一帧：end，或正文内联、不跟 data 的 res（漏了它，每个小响应都会在 served 里留一条）
    const item = { raw: JSON.stringify(frame), fin: frame.t === "end" || (frame.t === "res" && frame.more !== true) };
    const q = this.lanes.get(k);
    if (q) q.push(item);
    else this.lanes.set(k, [item]);
    this.pump();
    return true;
  }

  /** 中继回了 pong：ts 不晚于它的探针都算确认；两次确认之间都在排队的话，用这段送达速率调窗口 */
  onPong(ts: unknown): void {
    if (typeof ts !== "number") return;
    let last: Probe | null = null;
    while (this.probes.length && this.probes[0].ts <= ts) last = this.probes.shift()!;
    if (!last) return;
    this.acked = last.upTo;
    const at = this.now();
    if (last.busy && this.lastAck && at > this.lastAck.at) {
      const sample = ((last.upTo - this.lastAck.upTo) / (at - this.lastAck.at)) * this.o.targetMs;
      // 平滑一下：单次间隔受中继调度抖动影响大；被窗口卡住时 sample > 窗口（RTT < targetMs）就会长，直到排队拉长 RTT
      this.win = Math.round(Math.min(this.o.maxWindowBytes, Math.max(this.o.minWindowBytes, this.win * 0.75 + sample * 0.25)));
    }
    this.lastAck = { at, upTo: last.upTo };
    this.pump();
  }

  /** 发起方 / 中继取消了某个入站请求：丢掉它还没发出的帧 */
  drop(to: string | undefined, id: string): void {
    this.lanes.delete(laneKey(to, id));
    this.served.delete(laneKey(to, id));
  }

  /** 断线：排着的帧与探针都作废（新连接从零记账，窗口重新起步） */
  reset(): void {
    this.lanes.clear();
    this.served.clear();
    this.probes.length = 0;
    this.written = this.acked = this.sinceProbe = 0;
    this.lastAck = null;
    this.win = this.o.minWindowBytes;
  }

  private put(raw: string): boolean {
    if (!this.write(raw)) return false;
    this.written += raw.length;
    this.sinceProbe += raw.length;
    return true;
  }

  /** ping 的 ts 保证单调递增，pong 才能对上是哪个探针（心跳 ping 也算探针） */
  private ping(frame: Frame): boolean {
    const now = typeof frame.ts === "number" ? frame.ts : Date.now();
    const ts = now > this.lastTs ? now : this.lastTs + 1;
    this.lastTs = ts;
    if (!this.put(JSON.stringify({ ...frame, ts }))) return false;
    this.probes.push({ ts, upTo: this.written, busy: this.lanes.size > 0 });
    this.sinceProbe = 0;
    return true;
  }

  private service(k: string, now: number): number {
    const s = this.served.get(k);
    return s ? s.bytes * 2 ** ((s.at - now) / SERVICE_HALF_LIFE_MS) : 0;
  }

  // ponytail: 线性找最小，道数就是在途响应数（中继限 256 以内）；真多到要紧时换小顶堆
  private nextLane(now: number): [string, { raw: string; fin: boolean }[]] {
    let best: [string, { raw: string; fin: boolean }[]] | null = null;
    let min = Infinity;
    for (const e of this.lanes) {
      const v = this.service(e[0], now);
      if (v < min) [best, min] = [e, v];
    }
    return best!;
  }

  // ponytail: 道内不设上限、不回压生产方（与改前 Bun 内部缓冲一样吃内存）；要防超大响应占内存时让 pumpBody 的 emit 等 drain
  private pump(): void {
    const probeEvery = Math.max(MIN_PROBE_BYTES, this.win / 4);
    while (this.lanes.size && this.written - this.acked < this.win) {
      const now = this.now();
      const [k, q] = this.nextLane(now);
      if (!this.put(q[0].raw)) return; // 连接正在关：close 回调会 reset
      const { raw, fin } = q.shift()!;
      if (fin) this.served.delete(k);
      else this.served.set(k, { bytes: this.service(k, now) + raw.length, at: now });
      if (!q.length) this.lanes.delete(k);
      if (this.sinceProbe >= probeEvery) this.ping({ t: "ping" });
    }
    // 窗口卡住而最后一段字节后面没有探针（被控制帧占满、或窗口刚缩小）：补一个，不然等不到能放行的确认
    if (this.lanes.size && this.sinceProbe > 0 && this.written - this.acked >= this.win) this.ping({ t: "ping" });
  }
}

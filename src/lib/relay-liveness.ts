/**
 * 中继心跳判死：pong 超时时区分「连接死了」和「ping 排在自己大段上行数据后面还没发出去」。
 * Bun 客户端 WebSocket 的 bufferedAmount 恒为 0、send 也不报背压，看不到发送队列，所以用两条旁证：
 * 本次 ping 之后收到过入站帧（下行活着），或 ping 发出时前面压着 ≥ queuedAheadBytes 的本端数据。
 * 有旁证就顺延一轮，但最多 maxGraces 轮始终没等到 pong 仍判死——防半开连接永不重连；任何 pong 到达都清零。
 */
export interface LivenessOptions {
  queuedAheadBytes: number;
  maxGraces: number;
}

export const DEFAULT_LIVENESS: LivenessOptions = { queuedAheadBytes: 256 * 1024, maxGraces: 3 };

export interface PongTimeoutVerdict {
  dead: boolean;
  reason: string;
}

export class RelayLiveness {
  private sentSincePong = 0;
  private queuedAhead = 0;
  private inboundSincePing = false;
  private graces = 0;

  constructor(private readonly o: LivenessOptions = DEFAULT_LIVENESS) {}

  onSend(bytes: number): void {
    this.sentSincePong += bytes;
  }

  /** 在 ping 帧发出之前调用：记下排在它前面的本端字节数 */
  onPing(): void {
    this.queuedAhead = this.sentSincePong;
    this.inboundSincePing = false;
  }

  onInbound(): void {
    this.inboundSincePing = true;
  }

  onPong(): void {
    this.sentSincePong = 0;
    this.graces = 0;
  }

  reset(): void {
    this.sentSincePong = 0;
    this.queuedAhead = 0;
    this.inboundSincePing = false;
    this.graces = 0;
  }

  onPongTimeout(): PongTimeoutVerdict {
    const why = `queued=${this.queuedAhead}B inbound=${this.inboundSincePing ? "yes" : "no"} graces=${this.graces}/${this.o.maxGraces}`;
    const busy = this.inboundSincePing || this.queuedAhead >= this.o.queuedAheadBytes;
    if (busy && this.graces < this.o.maxGraces) {
      this.graces++;
      return { dead: false, reason: why };
    }
    return { dead: true, reason: why };
  }
}

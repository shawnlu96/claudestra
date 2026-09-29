/**
 * 防重放滑动窗口（docs/relay/e2e-design.md §4.1.4 第 3 步；做法同 RFC 4303 §3.4.3、RFC 6347 §4.1.2.6）。
 * accept() 是同步的，「查」和「记」在一次调用里完成：调用方在它前后都不许插 await，否则同一个 rid 的两份并发副本
 * 可能都通过，bridge 就会为同一个 rid 建两个响应编码器、同一 nonce 加密两次。窗口下沿只升不降。
 */
const WINDOW_SIZE = 1024;

export class ReplayWindow {
  private max = 0n;
  private readonly bits: Uint32Array;
  private readonly size: bigint;

  constructor(size = WINDOW_SIZE) {
    if (size <= 0 || size % 32 !== 0) throw new RangeError("window size must be a positive multiple of 32");
    this.size = BigInt(size);
    this.bits = new Uint32Array(size / 32);
  }

  private slot(rid: bigint): [number, number] {
    const at = Number(rid % this.size);
    return [at >>> 5, 1 << (at & 31)];
  }

  /** true = 首次见到且在窗口内，已记下；false = 重放，或已跌出窗口（rid ≤ 已见最大值 − 窗口大小） */
  accept(rid: bigint): boolean {
    if (rid <= 0n) return false;
    if (rid > this.max) {
      const gap = rid - this.max;
      if (gap >= this.size) this.bits.fill(0);
      else for (let r = this.max + 1n; r <= rid; r++) this.clear(r);
      this.max = rid;
      this.set(rid);
      return true;
    }
    if (rid <= this.max - this.size) return false;
    const [w, m] = this.slot(rid);
    if (this.bits[w] & m) return false;
    this.bits[w] |= m;
    return true;
  }

  private set(rid: bigint): void {
    const [w, m] = this.slot(rid);
    this.bits[w] |= m;
  }

  private clear(rid: bigint): void {
    const [w, m] = this.slot(rid);
    this.bits[w] &= ~m;
  }
}

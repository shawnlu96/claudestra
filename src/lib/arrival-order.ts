/**
 * 到达序号：bridge 收到一条消息 / 一次卡片作答 / 一次停止按钮时，在第一个 await 之前当场领一个号（全局单调递增，
 * 同一频道内自然也严格递增）。owner 的「停」和「开口」谁先谁后只比这个号（bridge/turn-cuts.ts、bridge/preempt.ts）。
 * 不比墙钟毫秒：两条处理回调各自有 await，同一毫秒现实可达，`>` 和 `>=` 总有一个方向判反（tests/arrival-order.test.ts）。
 * 起点取「盘上记的上限」和「启动时刻 ×1000」的大者：号文件丢了也不会比盘上已有的叫停记录小（否则那条停永远解不开）。
 */
import { readJsonStateSync, writeJsonAtomicSync } from "./state-file.js";

/**
 * 一个事件在到达顺序里的位置。seq = 到达序号；t 只有终端里的事件有：会话记录晚约 2 秒才读到，
 * 按那一行的时刻回推，排在 seq 那一号之后、下一号之前，同一位置的几条终端事件再按 t 排
 */
export interface Order {
  seq: number;
  t?: number;
}

/** a 是不是在 b 之后到的。同一个号（同一件事）不算之后 */
export function isAfter(a: Order, b: Order): boolean {
  if (a.seq !== b.seq) return a.seq > b.seq;
  if (a.t === undefined) return false;
  return b.t === undefined || a.t > b.t;
}

export const laterOf = (a: Order | undefined, b: Order): Order => (a && !isAfter(b, a) ? a : b);

/** 每用完这么多个号才写一次盘（盘上存的是已经预留到的上限，重启从它接着涨，中间跳号无妨，只比大小） */
const BLOCK = 1_000;
/** 回推终端事件要用的「号 → 到达时刻」只留这么久：终端事件晚两三秒就读到，留 10 分钟够宽 */
const MARK_KEEP_MS = 10 * 60_000;
const MARK_MAX = 2_000;

export class ArrivalOrder {
  private next: number;
  private ceiling: number;
  private readonly marks: { at: number; seq: number }[] = [];

  constructor(private readonly path: string | null, private readonly now: () => number = Date.now) {
    const r = path ? readJsonStateSync(path, (d) => typeof (d as { ceiling?: unknown })?.ceiling === "number") : null;
    const saved = r?.status === "ok" ? (r.data as { ceiling: number }).ceiling : 0;
    if (r && r.status !== "ok" && r.status !== "missing") console.error(`🚨 到达序号文件读不了（${r.status}），按启动时刻起号`);
    this.next = this.ceiling = Math.max(saved, Math.floor(now()) * 1_000, 1);
  }

  /** 领一个号：调用点必须在处理这件事的第一个 await 之前 */
  take(): number {
    if (this.next >= this.ceiling) {
      this.ceiling = this.next + BLOCK;
      // 写不下去照样发号：同一进程里照样单调；只有「写失败 + 重启 + 时钟往回拨」才会重号
      if (this.path) try { writeJsonAtomicSync(this.path, { ceiling: this.ceiling }); } catch (e) { console.error("🚨 到达序号落盘失败:", (e as Error).message); }
    }
    const seq = this.next++;
    const at = this.now();
    this.marks.push({ at, seq });
    while (this.marks.length > MARK_MAX || (this.marks.length && at - this.marks[0].at > MARK_KEEP_MS)) this.marks.shift();
    return seq;
  }

  /** 新领一个号的位置 */
  order(): Order {
    return { seq: this.take() };
  }

  /**
   * 终端里的事件（会话记录那一行的时刻 at，bridge 读到时已晚约 2 秒）回推到当时的位置。
   * 拿不准的同一毫秒一律判「停」在后：stop = 同一毫秒到的排在它前面；不是停 = 同一毫秒到的排在它后面
   */
  backdate(at: number, stop: boolean): Order {
    let base = (this.marks[0]?.seq ?? this.next) - 1; // 比留着的最早一号还早：排在它们前面
    for (const m of this.marks) if (stop ? m.at <= at : m.at < at) base = m.seq;
    return { seq: base, t: at };
  }
}

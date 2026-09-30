/**
 * 到达序号：bridge 收到一条消息 / 一次卡片作答 / 一次停止按钮时，在第一个 await 之前当场领一个号（全局单调递增，
 * 同一频道内自然也严格递增）。owner 的「停」和「开口」谁先谁后只比这个号（bridge/turn-cuts.ts、bridge/preempt.ts）。
 * 不比墙钟毫秒：两条处理回调各自有 await，同一毫秒现实可达，`>` 和 `>=` 总有一个方向判反（tests/arrival-order.test.ts）。
 * 起点取「盘上记的上限」和「启动时刻 ×1000」的大者，再由调用方用盘上已有的号垫底（atLeast）：号文件丢了、时钟又往回拨，
 * 新号也不会比已记的叫停小（否则那条停永远解不开）。只支持一个 bridge 写这份文件：两个同时跑会重号（doctor 报两个 bridge）。
 */
import { readJsonStateSync, writeJsonAtomicSync } from "./state-file.js";

/**
 * 一个事件在到达顺序里的位置。seq = 到达序号；t、n 只有终端里的事件有：会话记录晚约 2 秒才读到，按那一行的时刻 t 回推，
 * 排在 seq 那一号之后、下一号之前；n = 读到的先后（watcher 按行序读），同一毫秒的两行终端事件靠它分先后
 */
export interface Order {
  seq: number;
  t?: number;
  n?: number;
}

/**
 * a 是不是在 b 之后到的。同一个号（同一件事）不算之后。两条都是终端事件：只按会话记录里的先后比（时刻，再行序）——
 * 回推时「停」和「不是停」对同一毫秒的 bridge 事件落点不同，拿 seq 比会把同一毫秒里先停后开口的两行判反（tests/arrival-order.test.ts）
 */
export function isAfter(a: Order, b: Order): boolean {
  if (a.t !== undefined && b.t !== undefined) return a.t !== b.t ? a.t > b.t : (a.n ?? 0) > (b.n ?? 0);
  if (a.seq !== b.seq) return a.seq > b.seq;
  return a.t !== undefined && b.t === undefined;
}

export const laterOf = (a: Order | undefined, b: Order): Order => (a && !isAfter(b, a) ? a : b);

/** 每用完这么多个号才写一次盘（盘上存的是已经预留到的上限，重启从它接着涨，中间跳号无妨，只比大小） */
const BLOCK = 1_000;
/** 回推终端事件要用的「号 → 到达时刻」只留这么久：终端事件晚两三秒就读到，留 10 分钟够宽 */
const MARK_KEEP_MS = 10 * 60_000;
const MARK_MAX = 2_000;

/** 号文件：ceiling = 已预留到的上限；pid = 最后写它的进程；foreign = 最近一次发现别的进程也在写（两个 bridge 共用状态目录，doctor 报） */
export type SeqFile = { ceiling: number; pid?: number; foreign?: { pid?: number; at: number } };
const isSeqFile = (d: unknown) => typeof (d as { ceiling?: unknown })?.ceiling === "number";

export class ArrivalOrder {
  private next: number;
  private ceiling: number;
  /** 盘上的上限最后是我们读到 / 写下的哪个数：再读到更大的 = 别的进程写过 */
  private written: number;
  private foreign: SeqFile["foreign"];
  private readonly marks: { at: number; seq: number }[] = [];
  private lines = 0;

  constructor(private readonly path: string | null, private readonly now: () => number = Date.now) {
    const r = path ? readJsonStateSync(path, isSeqFile) : null;
    const saved = r?.status === "ok" ? (r.data as SeqFile) : undefined;
    if (r && r.status !== "ok" && r.status !== "missing") console.error(`🚨 到达序号文件读不了（${r.status}），按启动时刻起号`);
    this.written = saved?.ceiling ?? 0;
    this.foreign = saved?.foreign;
    this.next = this.ceiling = Math.max(this.written, Math.floor(now()) * 1_000, 1);
  }

  /** 盘上已有的号（叫停记录）垫底：之后发的号都比它大 */
  atLeast(seq: number): void {
    if (seq < this.next) return;
    this.next = this.ceiling = seq + 1; // 下一次 take 先把新上限落盘
  }

  /** 领一个号：调用点必须在处理这件事的第一个 await 之前 */
  take(): number {
    if (this.next >= this.ceiling) this.reserve();
    const seq = this.next++;
    const at = this.now();
    this.marks.push({ at, seq });
    while (this.marks.length > MARK_MAX || (this.marks.length && at - this.marks[0].at > MARK_KEEP_MS)) this.marks.shift();
    return seq;
  }

  /** 预留下一块号并落盘。写不下去照样发号：同一进程里照样单调；只有「写失败 + 重启 + 时钟往回拨」才会重号 */
  private reserve(): void {
    const r = this.path ? readJsonStateSync(this.path, isSeqFile) : null;
    const disk = r?.status === "ok" ? (r.data as SeqFile) : undefined;
    if (disk && disk.ceiling > this.written) {
      // 别的进程在我们之后写过：两个 bridge 共用一个状态目录（不支持）。跳过它预留的号，记下来给 doctor 报
      this.foreign = { ...(disk.pid !== undefined ? { pid: disk.pid } : {}), at: this.now() };
      console.error(`🚨 到达序号文件被另一个进程（pid ${disk.pid ?? "?"}）写过：两个 bridge 共用状态目录，「停」和开口的先后会判错`);
      this.next = Math.max(this.next, disk.ceiling);
    }
    this.ceiling = this.next + BLOCK;
    const file: SeqFile = { ceiling: this.ceiling, pid: process.pid, ...(this.foreign ? { foreign: this.foreign } : {}) };
    if (this.path) try { writeJsonAtomicSync(this.path, file); this.written = this.ceiling; } catch (e) { console.error("🚨 到达序号落盘失败:", (e as Error).message); }
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
    return { seq: base, t: at, n: ++this.lines };
  }
}

/**
 * owner 的叫停记录（bridge/turn-cuts.ts 用；单独一份 turn-cuts-stops.json，落盘、不设期限）：频道 → 最近一次叫停（停字 / 停止按钮 /
 * 终端里按的打断），go = owner 最近一次说「不是停」的话，go 在它之后到 = 已解除。先后只比到达位置（lib/arrival-order.ts），不比墙钟：
 * 两条回调各有 await，同一毫秒现实可达（tests/arrival-order.test.ts、tests/preempt-stop.test.ts）。Autopilot 据此不推进。
 */
import { isAfter, laterOf, type Order } from "../lib/arrival-order.js";
import { PersistedMap } from "./persisted-map.js";

/** at = 记下的墙钟（抬头显示、清理）；seq/t = 这次「停」的到达位置（老版本落的盘没有，按 0：比之后的一切都早）；goAt = 解除的墙钟（清理用） */
type StopRec = { at: number; seq?: number; t?: number; goAt?: number; go?: Order };
const isStopRec = (v: unknown) => !!v && typeof v === "object" && typeof (v as { at?: unknown }).at === "number";
const orderOf = (s: StopRec): Order => ({ seq: s.seq ?? 0, ...(s.t !== undefined ? { t: s.t } : {}) });
const released = (s: StopRec) => !!s.go && isAfter(s.go, orderOf(s));

export class StopBook {
  private readonly stops: PersistedMap<StopRec>;
  /** 频道 → owner 最近一次开口的到达位置（落盘的那份在叫停记录的 go 上） */
  private readonly spoke = new Map<string, Order>();

  constructor(path: string | null, private readonly now: () => number) {
    this.stops = new PersistedMap(path, "叫停记录", isStopRec, []);
  }

  /** owner 说了不是停的话（到达位置 order）：只解除在它之前到的停——作答的回调 await 了一阵才走到这里，之后才到的停不解 */
  go(channelId: string, order: Order): void {
    this.spoke.set(channelId, laterOf(this.spoke.get(channelId), order));
    const s = this.stops.get(channelId);
    if (!s || (s.go && !isAfter(order, s.go))) return;
    const next = { ...s, go: order };
    this.stops.set(channelId, released(next) && s.goAt === undefined ? { ...next, goAt: this.now() } : next);
  }

  /** 位置 order 的那次「停」到达之后，owner 又开过口 = 这条停作废。bridge 重启后从叫停记录的 go 上认得 */
  spokeAfter(channelId: string, order: Order): boolean {
    const l = this.lastSpoke(channelId);
    return !!l && isAfter(l, order);
  }

  /** 记叫停：比现有那条早到的旧停（押着晚投的）不盖掉新的；owner 在它之后已经开过口（作答的回调先走完了）就带着解除记 */
  stop(channelId: string, at: number, order: Order): void {
    const prev = this.stops.get(channelId);
    if (prev && !isAfter(order, orderOf(prev))) return;
    const go = this.lastSpoke(channelId);
    const rec: StopRec = { at, seq: order.seq, ...(order.t !== undefined ? { t: order.t } : {}), ...(go ? { go } : {}) };
    this.stops.set(channelId, released(rec) ? { ...rec, goAt: at } : rec);
  }

  /** 最近一次叫停（解除了也还在）：在它之前到、之后才投出去的消息要加抬头（bridge/held-flush.ts）。at 只给抬头显示 */
  mark(channelId: string): { at: number; order: Order } | undefined {
    const s = this.stops.get(channelId);
    return s && { at: s.at, order: orderOf(s) };
  }

  stopped(channelId: string): boolean {
    const s = this.stops.get(channelId);
    return !!s && !released(s);
  }

  /** agent 被永久 kill（TurnCuts.forget）：盘上的和内存里的都删 */
  delete(channelId: string): void {
    this.stops.delete(channelId);
    this.spoke.delete(channelId);
  }

  /** 只清已解除、且解除超过 keepMs 的：还没解除的一直留着（Autopilot 要等 owner 开口） */
  prune(now: number, keepMs: number): void {
    for (const [ch, s] of this.stops) if (s.goAt !== undefined && now - s.goAt > keepMs) this.stops.delete(ch);
  }

  private lastSpoke(channelId: string): Order | undefined {
    const s = this.stops.get(channelId)?.go;
    const m = this.spoke.get(channelId);
    return s && m ? laterOf(s, m) : (s ?? m);
  }
}

/**
 * 「同一个频道被两个活着的 channel-server 反复对抢」的识别（纯逻辑，单测在
 * tests/channel-contention.test.ts）。
 *
 * 背景：bridge 的 register 语义是**后来者接管**——旧连接收到 replaced + close(4001)。
 * 对 channel-server 来说，被顶替后的正确应对是「stdio 还连着就退避重连把频道抢回来」
 * （见 lib/link-policy.ts：退出等于该 agent 永久失联，比抢占更糟）。这个组合在只有
 * 一个正主时完全正确，但**两个都握过手的实例同时活着**时就变成无限交替：
 * A 抢到 → B 抢回 → A 再抢回 …… 退避从 3s 涨到 60s，谁也不死，谁也不赢。
 *
 * 那个交替是**故意**的降级行为，不该改。真正的缺陷是它**完全静默**：
 *   - 日志长得跟「Claude Code 重启了 MCP server」一模一样（同样是 replaced + 重新注册），
 *     翻日志的人分不出哪个是正常哪个是内战；
 *   - register 帧此前不带 pid，想知道是哪两个进程在抢只能 `ps eww` 考古。
 *
 * 2026-09-15 实测：owner 机器上两个 master 实例（一个在 tmux window 0，一个在游离的
 * window 19）抢 CONTROL_CHANNEL_ID 抢了几小时，日志刷了 2359 行，没有任何告警——
 * 是人工翻日志 + 按 DISCORD_CHANNEL_ID 反查进程环境变量才找出来的。
 *
 * ## 判据：为什么不是「顶替次数多就报警」
 *
 * 合法的 MCP 重启也会连着顶替好几次（Claude Code 重试），照次数报警必然误报。两者的
 * 区别在**同一个 pid 会不会回来**：
 *   - 合法重启：每个新 pid 只出现一次，旧 pid 死了就不再出现；
 *   - 两实例内战：pid 在 toPid 序列里**反复出现**（被顶掉又抢回来）。
 * 所以判据是「窗口内有某个 pid 至少两次拿到频道」，这是内战独有的签名。
 *
 * 另外只统计**旧连接近期还在通信**的那些顶替（idleMs 小）：旧连接早就不说话了说明
 * 它是僵尸，新连接接管是正常交接，不是对抢。
 */

/** 旧连接多久之内还在通信，才算「它是活的」——超过这个值视为僵尸交接，不计入对抢 */
export const CONTENTION_LIVE_IDLE_MS = 60_000;
/** 统计窗口 */
export const CONTENTION_WINDOW_MS = 10 * 60_000;
/** 窗口内至少这么多次「活连接被顶替」才考虑报警 */
export const CONTENTION_MIN_FLIPS = 3;
/** 同一频道两次报警的最小间隔（内战会持续很久，不能每次顶替都刷一条） */
export const CONTENTION_COOLDOWN_MS = 30 * 60_000;
/** 每个频道最多留多少条历史（内存兜底，窗口本身已经在裁剪） */
const MAX_HISTORY = 32;

export interface ChannelFlip {
  /** 发生时刻（ms） */
  at: number;
  /** 被顶掉的那个 channel-server 的 pid（老版本 channel-server 不上报 → undefined） */
  fromPid?: number;
  /** 抢到频道的那个 channel-server 的 pid */
  toPid?: number;
  /** 旧连接距离上次通信过了多久 */
  idleMs: number;
}

export interface ContentionAlert {
  channelId: string;
  /** 窗口内「活连接被顶替」的次数 */
  flips: number;
  /** 参与对抢的 pid（按最近一次出现排序，最多两三个） */
  pids: number[];
  /** 反复出现的那个（们）——内战的证据 */
  repeatPids: number[];
  windowMs: number;
}

/**
 * 逐个频道记账。**不碰时钟**：`now` 一律取 `flip.at`，方便单测。
 */
export class ContentionTracker {
  private readonly history = new Map<string, ChannelFlip[]>();
  private readonly lastAlertAt = new Map<string, number>();

  /**
   * 记一次「频道被重新注册、旧连接被顶掉」。
   * 判定为对抢且不在冷却期时返回告警，否则返回 null。
   */
  note(channelId: string, flip: ChannelFlip): ContentionAlert | null {
    const now = flip.at;
    const list = this.history.get(channelId) ?? [];
    list.push(flip);
    // 裁掉窗口外的；再按上限兜一刀
    let kept = list.filter((f) => now - f.at <= CONTENTION_WINDOW_MS);
    if (kept.length > MAX_HISTORY) kept = kept.slice(-MAX_HISTORY);
    this.history.set(channelId, kept);

    // 只有「旧连接还活着」的顶替才算对抢
    const live = kept.filter((f) => f.idleMs <= CONTENTION_LIVE_IDLE_MS);
    if (live.length < CONTENTION_MIN_FLIPS) return null;

    // 内战签名：某个 pid 在窗口内**不止一次**拿到频道（被顶掉又抢回来）。
    // 合法的 MCP 重启里每个新 pid 只会出现一次。
    const counts = new Map<number, number>();
    for (const f of live) {
      if (typeof f.toPid !== "number") continue;
      counts.set(f.toPid, (counts.get(f.toPid) ?? 0) + 1);
    }
    const repeatPids = [...counts.entries()].filter(([, n]) => n >= 2).map(([pid]) => pid);
    if (repeatPids.length === 0) return null;

    const last = this.lastAlertAt.get(channelId);
    if (last !== undefined && now - last < CONTENTION_COOLDOWN_MS) return null;
    this.lastAlertAt.set(channelId, now);

    // pid 列表：按最近一次出现倒序，去重
    const seen = new Set<number>();
    const pids: number[] = [];
    for (let i = live.length - 1; i >= 0; i--) {
      for (const p of [live[i].toPid, live[i].fromPid]) {
        if (typeof p === "number" && !seen.has(p)) {
          seen.add(p);
          pids.push(p);
        }
      }
    }

    return { channelId, flips: live.length, pids, repeatPids, windowMs: CONTENTION_WINDOW_MS };
  }

  /** 频道恢复正常（连接干净关闭 / agent 被 kill）时清账，避免旧记录跨越很久后凑成误报 */
  forget(channelId: string): void {
    this.history.delete(channelId);
    this.lastAlertAt.delete(channelId);
  }

  /** 诊断用 */
  size(): number {
    return this.history.size;
  }
}

/**
 * 人类消息抢占的每频道冷却：打断过一次，短窗内谁都不再打断。
 * Discord 入站（window-ops.preemptIfBusy）和 deliverToLocal 各有一道抢占，共用这一份；
 * 分开记的话同一条消息会发两次 C-c，而空闲的 CC 在短窗内收到两次 C-c 就退出。单测 tests/preempt-cooldown.test.ts。
 */
export class PreemptCooldown {
  private last = new Map<string, number>();
  constructor(private readonly ms: number) {}

  ready(channelId: string, now = Date.now()): boolean {
    return now - (this.last.get(channelId) ?? 0) > this.ms;
  }

  mark(channelId: string, now = Date.now()): void {
    this.last.set(channelId, now);
  }

  /** 绑定一个频道，给 preemptIfBusy 的 cooldown 参数用 */
  for(channelId: string): { ready: () => boolean; mark: () => void } {
    return { ready: () => this.ready(channelId), mark: () => this.mark(channelId) };
  }
}

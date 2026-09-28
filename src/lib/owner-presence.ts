/**
 * 「owner 在不在」（docs 13 §4.1）：只用来在「应用内提示」和「推送」之间选，不做别的判断。
 * 信号：网页可见时每分钟一次心跳、切到后台时报 hidden（按设备记）；owner 的人类动作（发消息、作答）。
 * 规则：任一设备可见且心跳未过期 → active；否则最近 5 分钟有动作、且动作晚于最后一次 hidden → active；其余 away。
 * 只在内存：bridge 重启后是 away（宁可多推一次，不漏推）。单测 tests/owner-presence.test.ts。
 */

export type Presence = "active" | "away";

/** 有动作后多久内算在 */
export const ACTIVE_WINDOW_MS = 5 * 60_000;
/** 网页可见时心跳间隔 60s；两个间隔没来就当那台设备不在了（手机锁屏时 JS 冻住，hidden 可能发不出来） */
export const HEARTBEAT_STALE_MS = 150_000;

export class OwnerPresence {
  private devices = new Map<string, { visible: boolean; at: number }>();
  private lastActionAt = 0;
  private lastHiddenAt = 0;
  constructor(private readonly now: () => number = Date.now) {}

  /** owner 做了一件事（发消息、点按钮、作答） */
  touch(): void {
    this.lastActionAt = this.now();
  }

  /** 网页报可见性（visibilitychange + 可见时心跳） */
  setVisible(device: string, visible: boolean): void {
    const at = this.now();
    this.devices.set(device, { visible, at });
    if (!visible) this.lastHiddenAt = at;
  }

  state(): Presence {
    const now = this.now();
    for (const d of this.devices.values()) if (d.visible && now - d.at < HEARTBEAT_STALE_MS) return "active";
    return now - this.lastActionAt < ACTIVE_WINDOW_MS && this.lastActionAt > this.lastHiddenAt ? "active" : "away";
  }
}

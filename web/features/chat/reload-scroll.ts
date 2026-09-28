/**
 * 全量重拉 ↔ 消息列表的滚动交接。store 不碰 DOM：整体替换 messages 前向列表要一份锚点快照，
 * 列表在这次替换提交后取走恢复（components/use-scroll-follow.ts）。
 * align（回到页面：后台恢复 / 断线重连 / bridge 重启 / 差量回退全量 / 差量替换直播气泡）锚定原位，
 * 往上翻着时保留已翻出的更早前缀；latest（点推送 / 深链 / 重点当前会话）一律落到最底。
 */
import { keepOlderPrefix, type ViewAnchor } from "./scroll-anchor";
import type { ChatMessage } from "./type";

export type ReloadKind = "align" | "latest";

/**
 * reconnect(full) 的落点：force（点推送 / 深链 / 重点当前会话）= 要看最新 → latest；其余与
 * keepPlace（同步失败 pill 的重试：强制重拉，但它是恢复动作）→ align 停在原位。
 */
export function reloadKindFor(opts?: { force?: boolean; keepPlace?: boolean }): ReloadKind {
  return opts?.force && !opts.keepPlace ? "latest" : "align";
}

export interface ReloadScrollView {
  capture(): ViewAnchor | null;
}

export interface ArmedReload {
  agent: string;
  /** anchor = 放回锚点；其余都落到最底：latest 要看最新 / rotated 换了 session（seq 不可比）/ bottom 原本就贴底 */
  why: "anchor" | "latest" | "rotated" | "bottom";
  anchor: ViewAnchor | null;
  /** 保留下来的更早前缀条数（日志用） */
  prefix: number;
  /** 差量对齐（syncDelta 替换直播气泡）：7s 对账心跳也走这里，只在真的按锚点放回时记日志 */
  delta: boolean;
}

export class ReloadScroll {
  private view: ReloadScrollView | null = null;
  private armed: ArmedReload | null = null;

  /** 列表挂载时登记；返回注销函数（只注销自己，防新旧实例交替卸载时误清） */
  attach(v: ReloadScrollView): () => void {
    this.view = v;
    return () => {
      if (this.view === v) this.view = null;
    };
  }

  /**
   * store 在整体替换前调。reload 为空（首次打开 / 切会话 / 历史现场进出）不交接——那些路径的
   * 落点由列表自己的 active / browsing 逻辑管。返回要写进视图的 messages（可能拼了前缀）。
   */
  merge(
    agent: string,
    p: { reload?: ReloadKind; delta?: boolean; sameSession: boolean; current: readonly ChatMessage[]; next: ChatMessage[] },
  ): ChatMessage[] {
    this.armed = null;
    if (!p.reload) return p.next;
    const anchor = p.reload === "align" ? (this.view?.capture() ?? null) : null;
    if (p.reload === "align" && !anchor) return p.next; // 列表没挂载：没有位置可恢复
    const why: ArmedReload["why"] =
      p.reload === "latest" ? "latest" : !p.sameSession ? "rotated" : anchor?.atBottom ? "bottom" : "anchor";
    const messages = why === "anchor" ? keepOlderPrefix(p.current, p.next) : p.next;
    this.armed = { agent, why, anchor, prefix: messages.length - p.next.length, delta: !!p.delta };
    return messages;
  }

  /** 列表在替换提交后取走（只取一次；换了会话的快照作废） */
  take(agent: string): ArmedReload | null {
    const x = this.armed;
    this.armed = null;
    return x && x.agent === agent ? x : null;
  }
}

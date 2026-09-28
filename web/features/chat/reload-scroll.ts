/**
 * 全量重拉 ↔ 消息列表的滚动交接。store 不碰 DOM：整体替换 messages 前向列表要一份锚点快照
 * （列表没挂载 = 没有快照，照旧），列表在这次替换提交后取走快照恢复位置（components/use-scroll-follow.ts）。
 * 用户往上翻着时顺带保留已翻出的更早前缀，锚点才不会随「只剩最近一页」一起消失。
 */
import { keepOlderPrefix, type ViewAnchor } from "./scroll-anchor";
import type { ChatMessage } from "./type";

export interface ReloadScrollView {
  capture(): ViewAnchor | null;
}

export interface ArmedReload {
  agent: string;
  anchor: ViewAnchor;
  /** 保留下来的更早前缀条数（日志用） */
  prefix: number;
}

export class ReloadScroll {
  private view: ReloadScrollView | null = null;
  private armed: ArmedReload | null = null;
  private expected: string | null = null;

  /**
   * 重连选路走全量时调：只有「同一会话的对齐重拉」才锚定。首次打开 / 切会话 / 退出历史现场
   * 也走 loadMessages，但那些本来就该落到最新尾部，锚定反而会把人留在缓存快照的半截。
   */
  expect(agent: string): void {
    this.expected = agent;
  }

  /** 列表挂载时登记；返回注销函数（只注销自己，防新旧实例交替卸载时误清） */
  attach(v: ReloadScrollView): () => void {
    this.view = v;
    return () => {
      if (this.view === v) this.view = null;
    };
  }

  /**
   * store 在整体替换前调：expect 过的才取快照并挂起给列表；按快照决定要不要拼回更早前缀。
   * 会话换了（sid 变）不拼——两个 session 的 seq 不可比。
   */
  merge(agent: string, p: { sameSession: boolean; current: readonly ChatMessage[]; next: ChatMessage[] }): ChatMessage[] {
    const want = this.expected === agent;
    this.expected = null;
    const anchor = want ? (this.view?.capture() ?? null) : null;
    const messages = anchor && !anchor.atBottom && p.sameSession ? keepOlderPrefix(p.current, p.next) : p.next;
    const prefix = messages.length - p.next.length;
    this.armed = anchor ? { agent, anchor, prefix } : null;
    return messages;
  }

  /** 列表在替换提交后取走（只取一次；换了会话的快照作废） */
  take(agent: string): ArmedReload | null {
    const x = this.armed;
    this.armed = null;
    return x && x.agent === agent ? x : null;
  }
}

/**
 * 借入面板的刷新与写后收尾（PM 定 23:30，tests/web-borrow-refresh.test.ts）：不依赖 React，useBorrowView 只是把它接到 state 上。
 * 每次拉取发起时编号（issued），成功的快照带上发起它的编号（seq）；失败、被下一次拉取中止的不产出快照。
 * 卡片写成功后记下当时的 issued，直到拿到 seq 更大的快照（写之后发起、真的拿回来的服务端值）才解锁——
 * 刷新 503 或被 15 秒轮询中止都不解锁，免得用旧 props 再写一次盖掉刚存的值。
 */
import type { MachineRef } from "@/lib/machines";
import { fetchBorrow, machineNow, removeBorrowPeer, saveBorrowPeer, stillOn, type BorrowView, type PeerView } from "./borrow-api";

export interface FeedState {
  view: BorrowView | null;
  receivedAt: number;
  hidden: boolean;
  /** 这份快照是第几次拉取拿回来的；0 = 还没有 */
  seq: number;
  /** 删除成功、还没被之后的快照确认的 peer → 删除时的 issued */
  gone: ReadonlyMap<string, number>;
}
export const EMPTY_FEED: FeedState = { view: null, receivedAt: 0, hidden: false, seq: 0, gone: new Map() };

export interface Feed {
  load: () => Promise<void>;
  stop: () => void;
  /** 已发起的拉取次数（写成功那一刻记下它） */
  issued: () => number;
  /** DELETE 成功：这张卡立刻不再渲染，不等后面的 GET */
  markGone: (peer: string) => void;
}

export function borrowFeed(emit: (s: FeedState) => void, fetcher: typeof fetchBorrow = fetchBorrow, now: () => number = Date.now): Feed {
  let state = EMPTY_FEED;
  let issued = 0;
  let ctrl: AbortController | null = null;
  const set = (s: FeedState) => emit((state = s));
  return {
    async load() {
      ctrl?.abort();
      const ac = new AbortController();
      ctrl = ac;
      const my = ++issued;
      try {
        const view = await fetcher(ac.signal);
        if (ac.signal.aborted) return;
        // 删除之后才发起的快照说了算：没有它就是删掉了，有它就是又加回来了，两种都不用再藏
        const gone = new Map([...state.gone].filter(([, at]) => at >= my));
        set(view ? { view, receivedAt: now(), hidden: false, seq: my, gone } : { ...EMPTY_FEED, hidden: true, seq: my, gone });
      } catch (e) {
        // 断网 / 超时 / 503：保留上一次的数据，下一轮再拉；面板不因为一次失败消失，等写后快照的卡继续锁着
        if (!ac.signal.aborted) console.warn("[borrow] 拉取失败", e);
      }
    },
    stop: () => ctrl?.abort(),
    issued: () => issued,
    markGone: (peer) => set({ ...state, gone: new Map(state.gone).set(peer, issued) }),
  };
}

/** 要显示的借入 peer：去掉刚删掉、还没被之后的快照确认的 */
export const visiblePeers = (s: Pick<FeedState, "view" | "gone">): PeerView[] => (s.view?.peers ?? []).filter((p) => !s.gone.has(p.peer));

/** 卡片锁着：写在途，或写成功后还没拿到 seq 大于 waitAfter 的快照 */
export const cardLocked = (busy: boolean, waitAfter: number | null, seq: number): boolean => busy || (waitAfter !== null && seq <= waitAfter);

/**
 * 卡片的一次保存：PUT → 成功就 hold(当时的 issued)，再刷新。failed = 写本身失败（立即解锁、回到原值）；
 * away = 回来时已切到别的机器（不动这张卡）；saved = 已存，卡片锁到写后快照到达
 */
export async function saveThenRefresh(o: {
  peer: string;
  body: { projects: string[]; maxOpen: number };
  at: MachineRef | undefined;
  feed: Pick<Feed, "issued" | "load">;
  hold: (waitAfter: number) => void;
}): Promise<"failed" | "away" | "saved"> {
  try {
    await saveBorrowPeer(o.peer, o.body, o.at);
  } catch {
    return "failed";
  }
  if (!stillOn(o.at)) return "away";
  o.hold(o.feed.issued());
  await o.feed.load();
  return "saved";
}

/**
 * 删一条借入（卡片与失效行共用）：DELETE 成功 → fade（整行淡出）→ markGone 立刻不再渲染 → 刷新；后面的 GET 失败也不会让它回来。
 * 请求绑定点击那一刻的机器；失败 fail（抖被点的按钮）。动效由调用方传入，这里不碰 DOM
 */
export async function dropPeer(peer: string, feed: Pick<Feed, "markGone" | "load">, fx: { fade: () => Promise<void>; fail: () => void }): Promise<void> {
  const at = machineNow();
  try {
    await removeBorrowPeer(peer, at);
  } catch {
    if (stillOn(at)) fx.fail();
    return;
  }
  if (!stillOn(at)) return;
  await fx.fade();
  feed.markGone(peer);
  await feed.load();
}

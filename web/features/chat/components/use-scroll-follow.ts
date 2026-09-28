"use client";
/**
 * 消息列表的吸底跟随 + 全量重拉后的位置恢复（从 message-list.tsx 拆出；判据是纯函数，见
 * ../scroll-anchor.ts 与 tests/web-scroll-anchor.test.ts）。
 *
 * 吸底：scroll 事件判「用户是否离底」，ResizeObserver 在吸底时把内容长高推到底。
 * 恢复：store 的对齐重拉整体替换 messages 前，经 reloadScroll 向这里要锚点快照；替换提交后
 * 这里取回快照——原本贴底就继续贴底，原本在看某条就把那条放回原偏移，并在 SETTLE_MS 内随富文本
 * 异步长高持续校正（用户一碰屏幕即停）。
 */
import { useEffect, useLayoutEffect, useRef, type MutableRefObject, type RefObject } from "react";
import type { ChatStore } from "../chat-store";
import type { ChatMessage } from "../type";
import { isNearBottom } from "../scroll-follow";
import { anchorScrollDelta, captureAnchor, followAfterScroll, resolveAnchor, windowToKeep, type RowBox } from "../scroll-anchor";
import { isSelectMode } from "../select-mode";
import { installTapRescue } from "@/lib/tap-rescue";

/** 重拉后按锚点校正的时长：Domd 富文本重挂后异步长高（实测 1-2s 落定），锚点上方长高会把它顶走 */
const SETTLE_MS = 1500;

interface Place {
  id: string;
  offset: number;
}

export interface ScrollFollowOpts {
  store: ChatStore;
  active: string;
  messages: ChatMessage[];
  /** 当前渲染窗口条数（尾部 N 条）；锚点在窗口外时用 ensureWindow 扩到能渲染它 */
  windowSize: number;
  ensureWindow: (n: number) => void;
  scrollerRef: RefObject<HTMLDivElement | null>;
  followRef: MutableRefObject<boolean>;
  touchHoldRef: MutableRefObject<number>;
  snapRef: MutableRefObject<(() => void) | null>;
  onNearBottom: (near: boolean) => void;
}

function nodeTop(el: HTMLElement, id: string): number | null {
  const node = el.querySelector(`[data-mid="${CSS.escape(id)}"]`);
  return node ? node.getBoundingClientRect().top - el.getBoundingClientRect().top : null;
}

function placeAnchor(el: HTMLElement, p: Place): boolean {
  const top = nodeTop(el, p.id);
  if (top === null) return false;
  el.scrollTop += anchorScrollDelta(top, p.offset);
  return true;
}

function captureView(el: HTMLElement) {
  const base = el.getBoundingClientRect().top;
  const rows: RowBox[] = [];
  el.querySelectorAll<HTMLElement>("[data-mid]").forEach((n) => {
    const r = n.getBoundingClientRect();
    rows.push({ id: n.dataset.mid ?? "", top: r.top - base, bottom: r.bottom - base });
  });
  return captureAnchor(rows, el);
}

type SettleRef = MutableRefObject<(Place & { until: number }) | null>;

export function useScrollFollow(o: ScrollFollowOpts) {
  /** 重拉后持续校正的锚点（到期或用户触碰即清） */
  const settleRef: SettleRef = useRef(null);
  useFollowObserver(o, settleRef);
  useReloadAnchor(o, settleRef);
}

/** scroll 判离底 + ResizeObserver 吸底；重拉校正期内 RO 改为按锚点放回 */
function useFollowObserver(o: ScrollFollowOpts, settleRef: SettleRef) {
  const { store, active, scrollerRef, followRef, touchHoldRef, snapRef } = o;
  useEffect(() => {
    const el = scrollerRef.current;
    const inner = el?.firstElementChild;
    if (!el || !inner) return;
    // 触摸丢 click 兜底(lib/tap-rescue.ts):回弹 / 减速尾巴 / 吸底期间点工具行也能展开
    const offRescue = installTapRescue(el, { name: "msgs", log: (m) => store.clientLog(m) });
    let lastTop = el.scrollTop;
    const onScroll = () => {
      // 向上滑立即退出吸底（不等离底 >90px）——流式内容持续长高时，90px 缓冲区内的每次 resize 吸底
      // 都会把刚起步的上滑手势拽回去。但被夹回最底不算上滑（见 followAfterScroll）。
      followRef.current = followAfterScroll(lastTop, el.scrollTop, el.scrollHeight, el.clientHeight);
      lastTop = el.scrollTop;
      // 按钮可见性按「离底」判，与 follow 解耦：真的离开底部 90px 才弹，贴着底微调不闪
      o.onNearBottom(isNearBottom(el.scrollHeight, el.scrollTop, el.clientHeight));
    };
    const stopSettle = () => {
      settleRef.current = null;
    };
    el.addEventListener("scroll", onScroll);
    for (const ev of ["touchstart", "wheel", "pointerdown"] as const) el.addEventListener(ev, stopSettle, { passive: true });
    const snap = () => {
      el.scrollTop = el.scrollHeight;
      lastTop = el.scrollTop; // 吸底自身的位移不算「用户上滑」
    };
    snapRef.current = snap;
    const ro = new ResizeObserver(() => {
      if (isSelectMode()) return; // 选字期间新内容长高也不吸底：滚一下选区就没了
      if (Date.now() < touchHoldRef.current) return; // 手指在屏幕上:见 message-list 的 touchHoldRef 注释
      const s = settleRef.current;
      if (s && Date.now() < s.until) {
        placeAnchor(el, s);
        lastTop = el.scrollTop;
        return;
      }
      settleRef.current = null;
      if (followRef.current) snap();
    });
    ro.observe(inner);
    return () => {
      el.removeEventListener("scroll", onScroll);
      for (const ev of ["touchstart", "wheel", "pointerdown"] as const) el.removeEventListener(ev, stopSettle);
      ro.disconnect();
      snapRef.current = null;
      offRescue();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
}

/** 对齐重拉的锚点快照登记 / 提交后恢复，以及往上翻着时窗口只扩不滑 */
function useReloadAnchor(o: ScrollFollowOpts, settleRef: SettleRef) {
  const { store, active, scrollerRef, followRef } = o;
  /** 锚点不在渲染窗口里：等窗口扩开的那次提交再放 */
  const placeRef = useRef<Place | null>(null);
  /** 渲染窗口顶部那条（按会话）：往上翻着时保住它（windowToKeep） */
  const topRef = useRef<{ agent: string; id: string } | null>(null);

  useEffect(
    () => store.reloadScroll.attach({ capture: () => (scrollerRef.current ? captureView(scrollerRef.current) : null) }),
    [store, scrollerRef],
  );

  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const ids = o.messages.map((m) => m.id);
    const armed = store.reloadScroll.take(active);
    if (armed) {
      const { anchor } = armed;
      const hit = anchor.atBottom ? null : resolveAnchor(anchor, ids);
      const result = anchor.atBottom ? "bottom" : hit?.id ? `anchor:${hit.how}` : "missing→bottom";
      store.clientLog(
        `reload-scroll: agent=${active} atBottom=${anchor.atBottom} anchorSeq=${anchor.seq ?? "-"} prefix=${armed.prefix} result=${result}`,
      );
      placeRef.current = null;
      settleRef.current = null;
      if (!hit?.id) {
        followRef.current = true;
        el.scrollTop = el.scrollHeight;
        return;
      }
      followRef.current = false;
      placeRef.current = { id: hit.id, offset: anchor.offset };
      settleRef.current = { ...placeRef.current, until: Date.now() + SETTLE_MS };
    }
    const top = topRef.current?.agent === active ? topRef.current.id : null;
    const keep = followRef.current ? null : windowToKeep(top, ids, o.windowSize);
    if (keep) return o.ensureWindow(keep); // 扩开的那次提交再继续（placeRef 保留）
    if (ids.length) topRef.current = { agent: active, id: ids[Math.max(0, ids.length - o.windowSize)] };
    const want = placeRef.current;
    if (!want || placeAnchor(el, want)) {
      placeRef.current = null;
      return;
    }
    // 锚点在渲染窗口之外（窗口按尾部条数截，重拉后条数变了）：扩窗口，下一次提交再放
    const idx = ids.indexOf(want.id);
    const need = ids.length - idx + 5;
    if (idx >= 0 && need > o.windowSize) o.ensureWindow(need);
    else placeRef.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [o.messages, o.windowSize]);
}

"use client";
/**
 * 消息列表的吸底跟随、渲染窗口定位与对齐重拉后的位置恢复（判据是纯函数：../scroll-anchor.ts）。
 * store 整体替换 messages 前经 reloadScroll 要锚点快照，提交后这里取回：该落底就落底，否则把锚点气泡
 * 放回原偏移，并在 SETTLE_MS 内随富文本异步长高持续校正（用户一滚 / 一碰即停），结束时记实际偏差。
 */
import { useEffect, useLayoutEffect, useRef, useState, type MutableRefObject, type RefObject } from "react";
import type { ChatStore } from "../chat-store";
import type { ChatMessage } from "../type";
import { isNearBottom } from "../scroll-follow";
import { anchorScrollDelta, captureAnchor, planWindow, resolveAnchor, scrollDecision, type RowBox } from "../scroll-anchor";
import { isSelectMode } from "../select-mode";
import { installTapRescue } from "@/lib/tap-rescue";

/** 重拉后按锚点校正的时长：Domd 富文本重挂后异步长高（实测 1-2s 落定），锚点上方长高会把它顶走 */
const SETTLE_MS = 1500;

interface Place {
  id: string;
  offset: number;
}
/** 校正期：anchor = 按锚点放回；bottom = 只在结束时记离底像素（吸底由 RO 照常负责）。quiet = 差量对齐不记日志 */
type Settle = ((Place & { kind: "anchor" }) | { kind: "bottom" }) & { quiet?: boolean };
interface SettleState {
  s: Settle;
  timer: ReturnType<typeof setTimeout>;
}
type SettleRef = MutableRefObject<SettleState | null>;
/** 上一次 scroll 事件 / 自己写 scrollTop 后的位置：scrollDecision 据此分「自己写的 / 被夹 / 用户在滚」 */
type LastRef = MutableRefObject<{ top: number; max: number }>;

export interface ScrollFollowOpts {
  store: ChatStore;
  active: string;
  messages: ChatMessage[];
  /** 不含自动扩窗的渲染窗口条数（基础 + 用户点「显示更早」展开的） */
  baseWindow: number;
  scrollerRef: RefObject<HTMLDivElement | null>;
  followRef: MutableRefObject<boolean>;
  touchHoldRef: MutableRefObject<number>;
  snapRef: MutableRefObject<(() => void) | null>;
  onNearBottom: (near: boolean) => void;
}

interface Shared {
  settleRef: SettleRef;
  /** 上一个 scroll 事件的位置（判吸底） */
  lastRef: LastRef;
  /** 上次自己写 scrollTop 后的位置（判「用户在滚」按自此累计的位移） */
  selfRef: LastRef;
  /** 锚点不在渲染窗口里：等窗口扩开的那次提交再放 */
  placeRef: MutableRefObject<Place | null>;
  resetWindow: () => void;
}

function nodeTop(el: HTMLElement, id: string): number | null {
  const node = el.querySelector(`[data-mid="${CSS.escape(id)}"]`);
  return node ? node.getBoundingClientRect().top - el.getBoundingClientRect().top : null;
}

function placeAnchor(el: HTMLElement, p: Place): boolean {
  const top = nodeTop(el, p.id);
  if (top === null) return false;
  const d = anchorScrollDelta(top, p.offset);
  if (Math.abs(d) >= 1) el.scrollTop += d; // 亚像素不写：写了会掐断 iOS 惯性
  return true;
}

/**
 * 记下自己写完的位置（下一个 scroll 事件据此认出不是用户在滚）。吸底时关掉浏览器原生滚动锚定：
 * Chrome 会因上方内容变化自调 scrollTop（变小），被当成上滑、吸底误关；不吸底时保留——桌面屏外气泡
 * content-visibility 占位（globals.css）靠它不顿。iOS 本就没有。
 */
function mark(el: HTMLElement, o: ScrollFollowOpts, sh: Pick<Shared, "lastRef" | "selfRef">) {
  sh.selfRef.current = note(el, o, sh.lastRef);
}

/** 记下 scroll 事件后的位置（不算自己写的） */
function note(el: HTMLElement, o: ScrollFollowOpts, lastRef: LastRef) {
  lastRef.current = { top: el.scrollTop, max: el.scrollHeight - el.clientHeight };
  el.style.overflowAnchor = o.followRef.current ? "none" : "";
  return lastRef.current;
}

/** 手指在屏幕上 / 正在选字：不写 scrollTop（抬手后 releaseTouchHold / RO 补吸底；选区不被滚掉） */
function held(o: ScrollFollowOpts): boolean {
  return Date.now() < o.touchHoldRef.current || isSelectMode();
}

/** 落底：吸底打开、自动窗口归零；手指按着 / 选字时只开吸底不写 scrollTop */
function toBottom(el: HTMLElement, o: ScrollFollowOpts, sh: Shared) {
  o.followRef.current = true;
  sh.resetWindow();
  o.onNearBottom(true);
  if (!held(o)) el.scrollTop = el.scrollHeight;
  mark(el, o, sh);
}

function captureView(el: HTMLElement, following: boolean) {
  const base = el.getBoundingClientRect().top;
  const rows: RowBox[] = [];
  el.querySelectorAll<HTMLElement>("[data-mid]").forEach((n) => {
    const r = n.getBoundingClientRect();
    rows.push({ id: n.dataset.mid ?? "", top: r.top - base, bottom: r.bottom - base });
  });
  return captureAnchor(rows, { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, following });
}

/** 离开锚点恢复（落底 / 回到底部按钮 / 自己发消息）：结束校正期、清掉待放的锚点、自动窗口归零 */
function leaveAnchor(o: ScrollFollowOpts, sh: Shared) {
  endSettle(o, sh.settleRef, "superseded");
  sh.placeRef.current = null;
  sh.resetWindow();
}

/** 校正期结束（到期 / 用户滚动 / 触碰 / 被新一轮重拉接管）：记实际结果，真机验收靠这一行对 client.log */
function endSettle(o: ScrollFollowOpts, ref: SettleRef, end: "timeout" | "scroll" | "touch" | "superseded") {
  const cur = ref.current;
  const el = o.scrollerRef.current;
  if (!cur) return;
  clearTimeout(cur.timer);
  ref.current = null;
  if (!el) return;
  const fb = Math.round(el.scrollHeight - el.scrollTop - el.clientHeight);
  const top = cur.s.kind === "anchor" ? nodeTop(el, cur.s.id) : null;
  const drift = cur.s.kind === "anchor" ? (top === null ? "gone" : `${Math.round(top - cur.s.offset)}px`) : "-";
  // agent 取 store 当前值：attach 的 bottom 回调闭包里的 o 是首次渲染那份
  if (!cur.s.quiet) o.store.clientLog(`reload-scroll: settled agent=${o.store.state.activeAgent} kind=${cur.s.kind} drift=${drift} fb=${fb}px end=${end}`);
}

export function useScrollFollow(o: ScrollFollowOpts) {
  const settleRef: SettleRef = useRef(null);
  const lastRef: LastRef = useRef({ top: 0, max: 0 });
  const selfRef: LastRef = useRef({ top: 0, max: 0 });
  const placeRef = useRef<Place | null>(null);
  /** 自动扩 / 缩出来的窗口条数（相对 baseWindow，可为负）；回到吸底即归零，DOM 不无限长 */
  const [auto, setAuto] = useState(0);
  const autoRef = useRef(0);
  const resetWindow = () => {
    if (autoRef.current === 0) return;
    autoRef.current = 0;
    setAuto(0);
  };
  const setWindow = (n: number) => {
    autoRef.current = n - o.baseWindow;
    setAuto(autoRef.current);
  };
  const windowSize = Math.max(1, o.baseWindow + auto);
  const sh: Shared = { settleRef, lastRef, selfRef, placeRef, resetWindow };
  useFollowObserver(o, sh);
  useReloadAnchor(o, sh, { windowSize, setWindow });
  return { windowSize, leaveAnchor: () => leaveAnchor(o, sh) };
}

/** scroll 判离底 + ResizeObserver 吸底；校正期内 RO 改为按锚点放回，用户一滚即结束校正 */
function useFollowObserver(o: ScrollFollowOpts, sh: Shared) {
  const { store, active, scrollerRef, followRef, snapRef } = o;
  const { settleRef, lastRef, selfRef } = sh;
  useEffect(() => {
    sh.resetWindow(); // 换会话：自动窗口归零（基础窗口由 message-list 的 [active] effect 归零）
    const el = scrollerRef.current;
    const inner = el?.firstElementChild;
    if (!el || !inner) return;
    // 触摸丢 click 兜底(lib/tap-rescue.ts):回弹 / 减速尾巴 / 吸底期间点工具行也能展开
    const offRescue = installTapRescue(el, { name: "msgs", log: (m) => store.clientLog(m) });
    mark(el, o, sh);
    const onScroll = () => {
      // 向上滑立即退出吸底（不等离底 >90px）——流式内容持续长高时，90px 缓冲区内的每次 resize 吸底
      // 都会把刚起步的上滑手势拽回去。被夹回 / 回弹落位 / 自己写的不算（见 scrollDecision）。
      const was = followRef.current;
      const d = scrollDecision({
        settle: settleRef.current?.s.kind ?? null,
        prev: lastRef.current,
        self: selfRef.current,
        top: el.scrollTop,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
      });
      if (d.endSettle) endSettle(o, settleRef, "scroll");
      followRef.current = d.follow;
      note(el, o, lastRef);
      if (!was && followRef.current) sh.resetWindow();
      // 按钮可见性按「离底」判，与 follow 解耦：真的离开底部 90px 才弹，贴着底微调不闪
      o.onNearBottom(isNearBottom(el.scrollHeight, el.scrollTop, el.clientHeight));
    };
    const onTouch = () => endSettle(o, settleRef, "touch");
    el.addEventListener("scroll", onScroll);
    for (const ev of ["touchstart", "wheel", "pointerdown"] as const) el.addEventListener(ev, onTouch, { passive: true });
    const snap = () => {
      el.scrollTop = el.scrollHeight;
      mark(el, o, sh); // 吸底自身的位移不算「用户上滑」
    };
    snapRef.current = snap;
    const ro = new ResizeObserver(() => {
      if (held(o)) return; // 选字期间不滚（选区会丢）；手指在屏幕上:见 message-list 的 touchHoldRef 注释
      const s = settleRef.current?.s;
      if (s?.kind === "anchor") {
        placeAnchor(el, s);
        mark(el, o, sh);
        return;
      }
      if (followRef.current) snap();
    });
    ro.observe(inner);
    return () => {
      el.removeEventListener("scroll", onScroll);
      for (const ev of ["touchstart", "wheel", "pointerdown"] as const) el.removeEventListener(ev, onTouch);
      ro.disconnect();
      snapRef.current = null;
      offRescue();
      if (settleRef.current) clearTimeout(settleRef.current.timer);
      settleRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
}

interface WindowCtl {
  windowSize: number;
  setWindow: (n: number) => void;
}

/** 对齐重拉的锚点快照登记 / 提交后恢复，以及往上翻着时窗口按顶部那条定位（planWindow） */
function useReloadAnchor(o: ScrollFollowOpts, sh: Shared, w: WindowCtl) {
  const { store, active, scrollerRef, followRef } = o;
  const { settleRef, placeRef } = sh;
  /** 渲染窗口顶部那条（按会话 + 基础窗口）：用户自己展开窗口时重新记，不跟他抢 */
  const topRef = useRef<{ agent: string; base: number; id: string } | null>(null);

  useEffect(
    () =>
      store.reloadScroll.attach({
        capture: () => (scrollerRef.current ? captureView(scrollerRef.current, followRef.current) : null),
        bottom: () => {
          leaveAnchor(o, sh);
          if (scrollerRef.current) toBottom(scrollerRef.current, o, sh);
        },
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store, scrollerRef, followRef],
  );

  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const ids = o.messages.map((m) => m.id);
    const armed = store.reloadScroll.take(active);
    if (armed) {
      const hit = armed.why === "anchor" && armed.anchor ? resolveAnchor(armed.anchor, ids) : null;
      const result = hit?.id ? `anchor:${hit.how}` : armed.why === "anchor" ? "missing→bottom" : `${armed.why}→bottom`;
      const quiet = armed.delta && !hit?.id; // 差量对齐（含 7s 对账心跳）只在真的按锚点放回时记
      if (!quiet) {
        store.clientLog(
          `reload-scroll: agent=${active}${armed.delta ? " delta" : ""} atBottom=${armed.anchor?.atBottom ?? "-"} anchorSeq=${armed.anchor?.seq ?? "-"} prefix=${armed.prefix} result=${result}`,
        );
      }
      endSettle(o, settleRef, "superseded");
      placeRef.current = null;
      const s: Settle = hit?.id && armed.anchor ? { kind: "anchor", id: hit.id, offset: armed.anchor.offset } : { kind: "bottom", quiet };
      settleRef.current = { s, timer: setTimeout(() => endSettle(o, settleRef, "timeout"), SETTLE_MS) };
      if (s.kind === "bottom") return toBottom(el, o, sh);
      followRef.current = false;
      placeRef.current = { id: s.id, offset: s.offset };
    }
    const cur = topRef.current;
    const plan = planWindow({
      following: followRef.current,
      top: cur?.agent === active && cur.base === o.baseWindow ? cur.id : null,
      ids,
      windowSize: w.windowSize,
      placeId: placeRef.current?.id ?? null,
    });
    if (plan.reset) sh.resetWindow();
    if (plan.recordTop) topRef.current = { agent: active, base: o.baseWindow, id: plan.recordTop };
    // 手指按着（iOS 惯性中途）不放：写 scrollTop 会掐断惯性；校正期里 RO 松手后会放
    if (plan.place === "now" && placeRef.current && !held(o)) {
      placeAnchor(el, placeRef.current);
      mark(el, o, sh);
    }
    if (plan.place !== "wait") placeRef.current = null;
    if (plan.resize !== null) w.setWindow(plan.resize); // 定位好的那次提交再继续（placeRef 保留）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [o.messages, w.windowSize, o.baseWindow]);
}

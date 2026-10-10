"use client";
/**
 * 协作视图打开时桌面端（sm 及以上）把会话栏收起来，让视图占满宽度（team-project-N8C1）。
 * 收起只是隐藏、不卸载：CollabSidebarGate 包住会话栏，收起时外层 sm:hidden，其余时候外层 contents（不影响布局）；
 * 移动端永远是 contents，照旧走横滑。视图左边的窄栏（CollabSidebarRail）上有个按钮能临时把会话栏展开回来。
 * 「这次打开有没有手动展开」是独立的小 store（写法同 collab-nav.ts），不进 chat-store。
 */
import { useEffect, useLayoutEffect, useRef, useSyncExternalStore, type ReactNode, type UIEvent } from "react";
import { Icon } from "./collab-icons";
import { useCollabT } from "./collab-i18n";
import { useCollabNav } from "./collab-nav";

/** expanded = 这次打开手动展开了；gates = 挂着几个 CollabSidebarGate（没有会话栏可管的地方不出窄栏） */
let state = { expanded: false, gates: 0 };
const subs = new Set<() => void>();

function set(next: typeof state) {
  if (next.expanded === state.expanded && next.gates === state.gates) return;
  state = next;
  for (const cb of subs) cb();
}
const setExpanded = (expanded: boolean) => set({ ...state, expanded });

const subscribe = (cb: () => void) => (subs.add(cb), () => void subs.delete(cb));
const current = () => state;
const useSidebarState = () => useSyncExternalStore(subscribe, current, current);

/** sm 及以上才真的收起（外层 sm:hidden 生效）；手机上外层一直是 contents，会话栏照常可见可滚 */
const SM = "(min-width: 640px)";
const subscribeSm = (cb: () => void) => {
  const mq = window.matchMedia(SM);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
};
const useSm = () => useSyncExternalStore(subscribeSm, () => window.matchMedia(SM).matches, () => false);

export function CollabSidebarGate({ children }: { children: ReactNode }) {
  const open = !!useCollabNav().project;
  const { expanded } = useSidebarState();
  const collapsed = open && !expanded;
  /** 真的 display:none 了（只有桌面端）：这期间不记滚动位置，结束时放回去；手机上永远是 false，位置照常跟着用户走 */
  const concealed = useSm() && collapsed;
  useEffect(() => {
    set({ ...state, gates: state.gates + 1 });
    return () => set({ ...state, gates: state.gates - 1 });
  }, []);
  // 只管本次打开：视图关掉就忘掉手动展开，下次打开默认又是收起
  useEffect(() => {
    if (!open) setExpanded(false);
  }, [open]);
  // display:none 期间有的浏览器会把里面的滚动位置清零：平时记着，展开回来时放回去
  const tops = useRef(new Map<Element, number>());
  const hidden = useRef(concealed);
  const onScroll = (e: UIEvent) => {
    if (!hidden.current && e.target instanceof Element) tops.current.set(e.target, e.target.scrollTop);
  };
  useLayoutEffect(() => {
    hidden.current = concealed;
    if (concealed) return;
    for (const [el, top] of tops.current) {
      if (!el.isConnected) tops.current.delete(el);
      else if (el.scrollTop !== top) el.scrollTop = top;
    }
  }, [concealed]);
  return (
    <div data-collab-sidebar={collapsed ? "collapsed" : "shown"} className={collapsed ? "contents sm:hidden" : "contents"} onScrollCapture={onScroll}>
      {children}
    </div>
  );
}

/** 协作视图左缘的窄栏（只在 sm 及以上出现）：一个图标按钮，展开 / 收起会话栏 */
export function CollabSidebarRail() {
  const { expanded: shown, gates } = useSidebarState();
  const tr = useCollabT();
  const label = tr(shown ? "收起会话栏" : "展开会话栏");
  if (!gates) return null;
  return (
    <div className="hidden w-8 shrink-0 flex-col items-center border-r border-base-300 bg-base-200 pt-2 sm:flex">
      <button type="button" className="btn btn-ghost btn-xs btn-square focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary"
        aria-label={label} title={label} aria-expanded={shown} onClick={() => setExpanded(!shown)}>
        <Icon name={shown ? "panelLeftClose" : "panelLeftOpen"} size={15} />
      </button>
    </div>
  );
}

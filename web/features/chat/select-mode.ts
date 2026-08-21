/**
 * 移动端「选择模式」+ 剪贴板兜底（2026-08-21 owner 真机反馈）。
 *
 * 症状：iPhone 上想复制一段文字，长按选中后手一拖，页面/气泡跟着动，选区永远
 * 框不准。两个原因缺一不可地都得关掉：
 *  ① 消息滚动容器还在接管拖动（选择手柄靠近边缘时 iOS 还会自动滚屏），并且
 *     吸底逻辑随时可能把视口拉到底 —— 选区当场作废；
 *  ② QuoteSwipe 的左滑引用手势：横向一动就 translateX 整块，字跟着跑。
 *
 * 所以把「正在选字」做成一个显式模式，真相挂在 body 的 data 属性上：CSS 靠它
 * 冻结滚动，手势 / 吸底逻辑靠它让路。
 *
 * 为什么用 DOM 属性而不是 React state/context：QuoteSwipe 包在几百张 memo 过的
 * 工具卡/气泡里，context 一变就是全量重渲染（2026-07-13「列表滑动卡死」的老根
 * 因）；而触摸处理器读 DOM 是零成本、且永远拿到最新值。需要跟随渲染的只有那个
 * 浮动工具条，单点订阅足够。
 */

/** 订阅者只有浮动条一个，Set 足矣。 */
type Listener = (on: boolean) => void;
const listeners = new Set<Listener>();

/** 被选中的块加这个类（描边高亮），退出时统一清。 */
export const SELECTING_CLASS = "cstra-selecting";

export function isSelectMode(): boolean {
  return typeof document !== "undefined" && document.body.dataset.cstraSelect === "1";
}

export function onSelectModeChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * 进入选择模式，并把整块先整体选上 —— 手柄立刻出现，用户只需拖两端收窄，
 * 不用先长按碰运气（长按本身就是最难对准的那一步）。
 */
export function enterSelectMode(el: HTMLElement | null): void {
  if (typeof document === "undefined") return;
  document.body.dataset.cstraSelect = "1";
  if (el) {
    el.classList.add(SELECTING_CLASS);
    try {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      sel?.removeAllRanges();
      sel?.addRange(range);
    } catch {
      /* 选不上不影响进模式：用户仍可自己长按选，反正滚动已经冻住了 */
    }
  }
  listeners.forEach((f) => f(true));
}

export function exitSelectMode(): void {
  if (typeof document === "undefined") return;
  delete document.body.dataset.cstraSelect;
  document.querySelectorAll(`.${SELECTING_CLASS}`).forEach((n) => n.classList.remove(SELECTING_CLASS));
  window.getSelection()?.removeAllRanges();
  listeners.forEach((f) => f(false));
}

/** 当前选区文本（浮动条的「复制所选」用）。 */
export function selectedText(): string {
  if (typeof window === "undefined") return "";
  return window.getSelection()?.toString() ?? "";
}

/**
 * 复制。优先 clipboard API；局域网明文 http 下它整个不存在（非安全上下文），
 * 回退到老掉牙的 textarea + execCommand —— 按钮宁可土也不能是死的。
 */
export async function copyText(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 落到下面的兜底 */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    // 不能 display:none / visibility:hidden——那样 iOS 选不中也就复制不了
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;";
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/** 页面上是否已有有效选区（有就别让左滑引用手势插一脚）。 */
export function hasLiveSelection(): boolean {
  if (typeof window === "undefined") return false;
  const s = window.getSelection();
  return !!s && !s.isCollapsed && !!s.toString().trim();
}

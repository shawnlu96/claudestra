/**
 * 触摸点击兜底(2026-09-11,owner:「现在没回弹总以为是卡住了」)。
 *
 * 背景:iOS 的合成 click 分两步——按下时记响应节点,抬手后同点重新命中测试,节点
 * 变了就 commitPotentialTapFailed,click 不派发(WebPageCocoa.mm)。橡皮筋回弹、
 * 惯性滚动的减速尾巴、流式吸底都会让它失败。09-07 曾用 overscroll-none 关掉
 * 回弹绕开,代价是列表到头没反馈、像卡住;这里改为不动手感,直接补 click。
 *
 * 规则(装在滚动容器上,对容器内一切可点击元素生效):
 * - 只管触摸(pointerType=touch)、短按(≤350ms)、位移 ≤10px、按下时目标有可点击祖先;
 * - 抬手后等 450ms(WebKit 提交合成 click 最长 ~350ms 双击消歧 + 余量),真 click
 *   没来 → 向按下时的目标派发一个 bubbles 的合成 click(React 的根监听照常收到);
 * - 容器 700ms 内有过 >200px/s 的滚动 → 不补:用户是在按停滚动,不是点;
 *   回弹回位 ~100px/s、减速尾巴 ~1px/帧 都在阈值之下,照补;
 * - 补过之后 1s 内同一目标上迟到的真 click 吞掉(capture 阶段 stopPropagation),
 *   不双触发;记 [tap-synth] / [tap-synth-late] 供统计。
 *
 * 2026-09-13 两处补漏(client.log [tap-lost] 实锤,均在 streaming 时):
 * - **pointercancel 路径**:iOS 把触摸判成滑动会派 pointercancel 而**不派 pointerup**,
 *   此前兜底只挂 pointerup,这类点从未 arm。实测有零位移(d=0,0)的 cancel——布局
 *   抖动期 WebKit 的投机性取消,手指根本没动。现把 cancel 也送进同一条 arm 链:
 *   真实滑动靠两道既有守卫剔掉——① cancel 坐标较按下位移 >10px(浏览器过了 slop
 *   才判滑,坐标已挪) ② 450ms 后容器速度 >200px/s(滑起来了)。零位移的投机 cancel
 *   两道都过 → 照补。cancel 坐标为 (0,0) 时退回按下坐标(视为没动)。
 * - **嵌套让路**:body 层再装一个实例兜浮层/顶栏(bubble-menu portal、claude-switcher
 *   的 btn-xs 不在 msgs/list 内,此前无人管)。安装时给容器打 data-tap-rescued,外层
 *   实例按下时发现目标落在别的已兜底容器里就让路,避免同一次点被内外各补一个 click。
 */
export function installTapRescue(
  el: HTMLElement,
  opts: { name: string; log?: (msg: string) => void },
): () => void {
  const CLICKABLE = "button,a,[role=button],input,select,label,summary,code,.cursor-pointer,[data-clickable]";
  const MARK = "data-tap-rescued";
  let down: { t: number; x: number; y: number; target: Element; edge: number } | null = null;
  // 手指自按下起的最大位移(touchmove 实测)。iOS 一旦把触摸判成滑动就停派 pointermove、
  // pointercancel 带的往往仍是按下坐标——只看 up/cancel 坐标会把慢速滚动当成零位移
  // (2026-09-14 owner:「上下滑动的时候还会误触点进 Agent」,884e300 回归)。touchmove
  // 在滚动期间照常派发,是唯一可靠的「手指动没动」信号;回弹/惯性爬行是容器在动、
  // 手指没动,不受此守卫影响。
  let moved = 0;
  let lastClickAt = 0;
  let suppressUntil = 0;
  let suppressTarget: Element | null = null;
  const sc = { t: 0, top: 0, v: 0 };

  const tg = (n: Element | null) => {
    if (!n) return "?";
    const cls = (n.getAttribute("class") || "").split(/\s+/).filter(Boolean).slice(0, 2).join(".");
    return `${n.tagName}${n.id ? `#${n.id}` : ""}${cls ? `.${cls}` : ""}`;
  };
  const edgeNow = () => {
    const mx = el.scrollHeight - el.clientHeight;
    return el.scrollTop < 0 ? Math.round(el.scrollTop) : Math.round(Math.max(0, el.scrollTop - mx));
  };
  const onScroll = () => {
    if (el.scrollTop === sc.top) return; // 零位移的 scroll 事件不带信息(程序化赋值后浏览器还会补发一次)
    const now = performance.now();
    const dt = now - sc.t;
    sc.v = dt > 0 && dt < 500 ? (Math.abs(el.scrollTop - sc.top) / dt) * 1000 : 0;
    sc.t = now;
    sc.top = el.scrollTop;
  };
  const onDown = (e: PointerEvent) => {
    // 新的触摸开始 = 之后到的 click 都归它,上一次兜底的「吞迟到 click」窗口作废
    // (Playwright 实测:不清的话,兜底后 1s 内再点同一按钮,第二次的真 click 被吞、
    // 而 lastClickAt 已更新让兜底也不补 → 第二次点击整个丢失)
    suppressUntil = 0;
    suppressTarget = null;
    if (e.pointerType !== "touch" || !e.isPrimary || !(e.target instanceof Element)) {
      down = null;
      return;
    }
    // 嵌套让路:目标落在别的已兜底容器里 → 那个实例管,本实例不 arm(防双补)
    const owner = e.target.closest(`[${MARK}]`);
    if (owner && owner !== el) {
      down = null;
      return;
    }
    down = { t: performance.now(), x: e.clientX, y: e.clientY, target: e.target, edge: edgeNow() };
    moved = 0;
  };
  const onTouchMove = (e: TouchEvent) => {
    if (!down || e.touches.length !== 1) return;
    const t = e.touches[0];
    const dist = Math.hypot(t.clientX - down.x, t.clientY - down.y);
    if (dist > moved) moved = dist;
  };
  /** pointerup / pointercancel 共用的 arm 链:过守卫 → 450ms 后真 click 没来就补。 */
  const arm = (e: PointerEvent, via: "up" | "cancel") => {
    const d = down;
    down = null;
    if (!d || e.pointerType !== "touch") return;
    // cancel 事件偶见 (0,0) 坐标(手指没动,浏览器没填)→ 退回按下坐标视为零位移
    const cx = via === "cancel" && e.clientX === 0 && e.clientY === 0 ? d.x : e.clientX;
    const cy = via === "cancel" && e.clientX === 0 && e.clientY === 0 ? d.y : e.clientY;
    if (performance.now() - d.t > 350 || Math.hypot(cx - d.x, cy - d.y) > 10) return;
    if (moved > 10) return; // 手指实际滑过了(touchmove 实测):是滚动,不是点——cancel 坐标不可信
    const target = d.target;
    if (!target.closest(CLICKABLE)) return; // 死区:本来就没 click
    // data-hold:按住说话类手势键,按设计无 click。data-tap-self:自己在 pointerup 上执行
    // 动作的键(发送/暂停,3601ee6),pointerup 一跑输入框清空/按钮 disabled,WebKit 的 click
    // 作废是我们自己造成的——再补一个 click 什么都救不了,只污染 [tap-synth] 计数
    // (2026-09-15 实测 13 条 body 层合成全打在这两键上,全被 touchClick 的 1s 窗口吞掉)。
    if (target.closest("[data-hold],[data-tap-self]")) return;
    const upAt = performance.now();
    window.setTimeout(() => {
      if (lastClickAt >= upAt) return; // 真 click 到了
      if (!target.isConnected) return;
      if (sc.v > 200 && performance.now() - sc.t < 700) return; // 列表明显在滚:按停,不是点
      suppressUntil = performance.now() + 1000;
      suppressTarget = target;
      opts.log?.(`[tap-synth] ${opts.name} ${tg(target)} edge=${d.edge} v=${Math.round(sc.v)} via=${via}`);
      const ev = new MouseEvent("click", { bubbles: true, cancelable: true, clientX: cx, clientY: cy, view: window });
      (ev as MouseEvent & { __cstraSynth?: boolean }).__cstraSynth = true;
      target.dispatchEvent(ev);
    }, 450);
  };
  const onUp = (e: PointerEvent) => arm(e, "up");
  const onCancel = (e: PointerEvent) => arm(e, "cancel");
  const onClick = (e: MouseEvent) => {
    if ((e as MouseEvent & { __cstraSynth?: boolean }).__cstraSynth) return;
    lastClickAt = performance.now();
    const t = e.target;
    if (
      performance.now() < suppressUntil &&
      suppressTarget &&
      t instanceof Node &&
      (t === suppressTarget || suppressTarget.contains(t) || (t instanceof Element && t.contains(suppressTarget)))
    ) {
      e.stopPropagation();
      e.preventDefault();
      opts.log?.(`[tap-synth-late] ${opts.name} 真 click 晚到 ${Math.round(performance.now() - (suppressUntil - 1000))}ms,已吞`);
    }
  };
  el.setAttribute(MARK, opts.name);
  el.addEventListener("pointerdown", onDown);
  el.addEventListener("pointerup", onUp);
  el.addEventListener("pointercancel", onCancel);
  el.addEventListener("touchmove", onTouchMove, { passive: true });
  el.addEventListener("click", onClick, true);
  el.addEventListener("scroll", onScroll, { passive: true });
  return () => {
    el.removeAttribute(MARK);
    el.removeEventListener("pointerdown", onDown);
    el.removeEventListener("pointerup", onUp);
    el.removeEventListener("pointercancel", onCancel);
    el.removeEventListener("touchmove", onTouchMove);
    el.removeEventListener("click", onClick, true);
    el.removeEventListener("scroll", onScroll);
  };
}

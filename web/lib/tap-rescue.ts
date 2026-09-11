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
 */
export function installTapRescue(
  el: HTMLElement,
  opts: { name: string; log?: (msg: string) => void },
): () => void {
  const CLICKABLE = "button,a,[role=button],input,select,label,summary,code,.cursor-pointer,[data-clickable]";
  let down: { t: number; x: number; y: number; target: Element; edge: number } | null = null;
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
    down = { t: performance.now(), x: e.clientX, y: e.clientY, target: e.target, edge: edgeNow() };
  };
  const onUp = (e: PointerEvent) => {
    const d = down;
    down = null;
    if (!d || e.pointerType !== "touch") return;
    if (performance.now() - d.t > 350 || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 10) return;
    const target = d.target;
    if (!target.closest(CLICKABLE)) return; // 死区:本来就没 click
    if (target.closest("[data-hold]")) return; // 按住说话类手势键:按设计无 click
    const upAt = performance.now();
    const { clientX, clientY } = e;
    window.setTimeout(() => {
      if (lastClickAt >= upAt) return; // 真 click 到了
      if (!target.isConnected) return;
      if (sc.v > 200 && performance.now() - sc.t < 700) return; // 列表明显在滚:按停,不是点
      suppressUntil = performance.now() + 1000;
      suppressTarget = target;
      opts.log?.(`[tap-synth] ${opts.name} ${tg(target)} edge=${d.edge} v=${Math.round(sc.v)}`);
      const ev = new MouseEvent("click", { bubbles: true, cancelable: true, clientX, clientY, view: window });
      (ev as MouseEvent & { __cstraSynth?: boolean }).__cstraSynth = true;
      target.dispatchEvent(ev);
    }, 450);
  };
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
  el.addEventListener("pointerdown", onDown);
  el.addEventListener("pointerup", onUp);
  el.addEventListener("click", onClick, true);
  el.addEventListener("scroll", onScroll, { passive: true });
  return () => {
    el.removeEventListener("pointerdown", onDown);
    el.removeEventListener("pointerup", onUp);
    el.removeEventListener("click", onClick, true);
    el.removeEventListener("scroll", onScroll);
  };
}

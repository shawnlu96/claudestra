"use client";
import { useRef } from "react";
import { useChatStoreApi } from "../chat-store";
import { hasLiveSelection, isSelectMode } from "../select-mode";

/**
 * 消息块左滑引用(owner 2026-07-16):文字段/工具卡/回复/user 气泡左滑露出
 * 引用图标,过阈值松手 → composer 出现引用预览,发送时以 Markdown 引用块
 * 前置(web/Discord 都原生渲染)。方向裁决同终端页手势:竖向先动让给滚动。
 * 跟手位移直接写 DOM style(不 setState——流式期间高频 re-render 是性能命门)。
 */
/**
 * v2.21.4 块级引用(owner 2026-09-04「Markdown 渲染出来是一块一块的,能做成块级别吗」):
 * blockLevel 时手指落点所在的 markdown 块(段落 / 列表项 / 代码块 / 表格 / 标题 /
 * 引用)单独跟手位移,松手引用**这一块**的渲染文本(innerText,隐藏的 md 符号不带);
 * 落点不在任何块上(段间空白)退回整段。DOMD 渲染在 light DOM,closest 能直接命中。
 */
const QUOTE_BLOCK_SEL = [
  // DOMD 的块元素未必是原生标签,类名与原生标签都列上;LiP(列表项里的段)比 li 更近,
  // closest 先命中它——引用的是那一条列表项的正文
  ".DOMD-LiP", ".DOMD-li", ".DOMD-CheckBoxLi", "li",
  ".DOMD-P", "p",
  ".DOMD-Pre", "pre",
  ".DOMD-TableScrollable", "table",
  ".DOMD-Blockquote", "blockquote",
  ".DOMD-H1", ".DOMD-H2", ".DOMD-H3", ".DOMD-H4", ".DOMD-H5", ".DOMD-H6", "h1", "h2", "h3", "h4", "h5", "h6",
].join(", ");
function quoteTextOfBlock(el: HTMLElement): string {
  // 代码块只取代码正文(顶栏的语言名 / 复制按钮文字不算)
  const code = el.querySelector<HTMLElement>(".DOMD-PreCodeContent, pre code, code");
  const src = el.matches("pre, .DOMD-Pre") && code ? code : el;
  return (src.innerText ?? src.textContent ?? "").trim();
}

export function QuoteSwipe({ quote, className, children, blockLevel }: { quote: string; className?: string; children: React.ReactNode; blockLevel?: boolean }) {
  const store = useChatStoreApi();
  const wrapRef = useRef<HTMLDivElement>(null);
  const ref = useRef<HTMLDivElement>(null);
  const iconRef = useRef<HTMLSpanElement>(null);
  const st = useRef<{ x: number; y: number; drag: boolean; dead: boolean; startDx: number; block: HTMLElement | null } | null>(null);
  // 跟手位移的目标:块级命中的那块,否则整段
  const moving = () => st.current?.block ?? ref.current;
  return (
    <div ref={wrapRef} className={`relative ${className ?? ""}`}>
      <span
        ref={iconRef}
        className="pointer-events-none absolute right-0 top-1/2 -translate-y-1/2 text-base-content/50"
        style={{ opacity: 0 }}
        aria-hidden
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
          <path d="M9.5 8C7 8 5 10 5 12.7c0 2 1.5 3.6 3.4 3.6 1.7 0 3-1.3 3-3 0-1.6-1.2-2.8-2.8-2.8-.3 0-.6 0-.8.1C8.2 9.6 9 8.9 10 8.5L9.5 8zm7 0C14 8 12 10 12 12.7c0 2 1.5 3.6 3.4 3.6 1.7 0 3-1.3 3-3 0-1.6-1.2-2.8-2.8-2.8-.3 0-.6 0-.8.1.4-1 1.2-1.7 2.2-2.1L16.5 8z" />
        </svg>
      </span>
      <div
        ref={ref}
        onTouchStart={(e) => {
          // 正在选字(选择模式,或页面上已有选区)时整个手势让开:横向一动就 translateX
          // 整块,字跟着跑,选区永远框不准(2026-08-21 owner iPhone 实测)
          if (isSelectMode() || hasLiveSelection()) {
            st.current = null;
            return;
          }
          const t = e.touches[0];
          let block: HTMLElement | null = null;
          if (blockLevel && ref.current) {
            const hit = (e.target as HTMLElement | null)?.closest?.(QUOTE_BLOCK_SEL) as HTMLElement | null;
            if (hit && ref.current.contains(hit) && hit !== ref.current) block = hit;
          }
          st.current = t ? { x: t.clientX, y: t.clientY, drag: false, dead: false, startDx: 0, block } : null;
        }}
        onTouchMove={(e) => {
          const s = st.current;
          const el = ref.current;
          if (!s || s.dead || !el) return;
          const t = e.touches[0];
          if (!t) return;
          const dx = t.clientX - s.x;
          const dy = Math.abs(t.clientY - s.y);
          if (!s.drag) {
            // 手势中途冒出选区(长按选字)→ 让开,别在人家拖手柄时把块横着拽走
            if (isSelectMode() || hasLiveSelection()) {
              s.dead = true;
              return;
            }
            // 竖向先动 → 手势让给列表滚动;轻微左滑即接管(阈值太高「不跟手」,
            // owner 2026-07-16 打回过一版 14px)
            if (dy > 10 && dy > -dx) {
              s.dead = true;
              return;
            }
            if (!(dx < -6 && -dx > dy)) return;
            s.drag = true;
            s.startDx = dx; // 从接管点起算,起步不跳变
            // 块级:引用图标对准命中块的竖直中心(默认在整段中线)
            if (s.block && iconRef.current && wrapRef.current) {
              const br = s.block.getBoundingClientRect();
              const wr = wrapRef.current.getBoundingClientRect();
              iconRef.current.style.top = `${br.top - wr.top + br.height / 2}px`;
            }
          }
          e.stopPropagation();
          const raw = Math.min(0, dx - s.startDx);
          // 72px 内 1:1 跟手,超出 sqrt 阻尼(能继续拖但渐重,不再生硬钉死)
          const pull = raw > -72 ? raw : -72 - Math.sqrt(-raw - 72) * 3;
          const mv = moving() ?? el;
          mv.style.transition = "none";
          mv.style.transform = `translateX(${pull}px)`;
          if (iconRef.current) iconRef.current.style.opacity = String(Math.min(1, -pull / 44));
        }}
        onTouchEnd={(e) => {
          const s = st.current;
          const el = ref.current;
          st.current = null;
          if (!s?.drag || !el) return;
          const t = e.changedTouches[0];
          const dx = t ? t.clientX - s.x - s.startDx : 0;
          const mv = s.block ?? el;
          mv.style.transition = "transform 0.18s ease-out";
          mv.style.transform = "translateX(0)";
          if (iconRef.current) {
            iconRef.current.style.transition = "opacity 0.18s ease-out";
            iconRef.current.style.opacity = "0";
            iconRef.current.style.top = ""; // 回到整段中线(下次可能不是块级命中)
          }
          if (dx < -44) {
            const blockText = s.block ? quoteTextOfBlock(s.block) : "";
            store.setQuote(blockText || quote);
          }
        }}
      >
        {children}
      </div>
    </div>
  );
}

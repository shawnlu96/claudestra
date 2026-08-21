"use client";
/**
 * 气泡长按菜单（2026-08-22 owner 打回第一版：「点一下就出现太敏感了，点完下面
 * 又多一个按钮，把排版顶下去了」）。
 *
 * 第一版是点击展开一条内联按钮条，两个毛病：
 *  ① 点击在聊天界面里太廉价 —— 滑一下手指、点个空白都会误触；
 *  ② 内联条进文档流，一开一合整页跳动。
 *
 * 改成聊天软件的通行做法（iMessage / Telegram / WhatsApp 同款）：
 *  - 触摸端 **长按 450ms** 唤出浮层菜单：portal 到 body + fixed 定位在手指旁边，
 *    不进文档流 → 排版一个像素都不动；
 *  - 桌面端 **右键**唤出同一个菜单，鼠标划选完全不受影响；
 *  - 单击回到原来的语义：只切秒级时间戳。
 *
 * 代价（写清楚免得以后当成 bug 改回去）：触摸端把气泡的原生长按关掉了
 * （globals.css 里的 -webkit-touch-callout/user-select），否则我们的菜单会和
 * iOS 自己的「拷贝 / 查询」气泡打架。要选局部文字走菜单里的「选择文字」，
 * 那条路会把 user-select 放开、并冻结滚动（见 ../select-mode）。
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useChatStoreApi } from "../chat-store";
import { fmtTs } from "../fmt-time";
import { useT } from "@/lib/i18n";
import { copyText, enterSelectMode, exitSelectMode, isSelectMode, onSelectModeChange, selectedText } from "../select-mode";

/** 长按判定。450ms：比 iOS 原生 callout(≈500ms)稍早，抢在它前面出。 */
const LONG_PRESS_MS = 450;
/** 手指挪超过这个距离就认为是在滚动/左滑，不是长按。 */
const MOVE_TOLERANCE = 12;

export interface BubbleMenuTarget {
  /** 这一块的纯文本（复制 / 引用用它）。 */
  text: string;
  /** 整条消息的纯文本（assistant 多段时给「复制整条」用；与 text 相同则不显示）。 */
  fullText?: string;
  ts?: string;
  /** 「选择文字」要框住的 DOM。 */
  getEl: () => HTMLElement | null;
}

type MenuState = (BubbleMenuTarget & { x: number; y: number }) | null;

const subs = new Set<(s: MenuState) => void>();
function emit(s: MenuState) {
  subs.forEach((f) => f(s));
}
export function openBubbleMenu(s: NonNullable<MenuState>): void {
  emit(s);
}
export function closeBubbleMenu(): void {
  emit(null);
}

/**
 * 挂在气泡上的触发器。返回的 handlers 直接摊到元素上；consumedClick() 给调用方
 * 判断「这次 click 只是长按的尾巴」——否则松手会顺带把时间戳切了。
 */
export function useBubbleMenuTrigger(get: () => BubbleMenuTarget) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const firedAt = useRef(0);
  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => clear, []);
  return {
    consumedClick: () => Date.now() - firedAt.current < 700,
    handlers: {
      onTouchStart: (e: React.TouchEvent) => {
        if (isSelectMode()) return; // 选字期间一切手势让位给选区
        const t = e.touches[0];
        if (!t) return;
        start.current = { x: t.clientX, y: t.clientY };
        clear();
        timer.current = setTimeout(() => {
          firedAt.current = Date.now();
          navigator.vibrate?.(8); // 安卓有触感，iOS 无声降级
          openBubbleMenu({ ...get(), x: start.current!.x, y: start.current!.y });
        }, LONG_PRESS_MS);
      },
      onTouchMove: (e: React.TouchEvent) => {
        const s = start.current;
        const t = e.touches[0];
        if (!s || !t) return;
        if (Math.abs(t.clientX - s.x) > MOVE_TOLERANCE || Math.abs(t.clientY - s.y) > MOVE_TOLERANCE) clear();
      },
      onTouchEnd: clear,
      onTouchCancel: clear,
      // 桌面右键；安卓 Chrome 的长按也会走这里（和上面的计时器重复触发无害，
      // 后一次只是用同样的内容重开一次）
      onContextMenu: (e: React.MouseEvent) => {
        if (isSelectMode()) return;
        e.preventDefault();
        firedAt.current = Date.now();
        openBubbleMenu({ ...get(), x: e.clientX, y: e.clientY });
      },
    },
  };
}

const MENU_W = 190;

function Item({
  icon,
  label,
  onClick,
  danger,
}: {
  icon: string;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className={`flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left text-[13.5px] active:bg-base-300 ${
        danger ? "text-error" : "text-base-content/85"
      }`}
      onClick={onClick}
    >
      <span className="w-4 shrink-0 text-center opacity-70">{icon}</span>
      {label}
    </button>
  );
}

/**
 * 单实例菜单 + 复制成功的小提示。挂一份在 MessageList 里即可。
 */
export function BubbleMenu() {
  const t = useT();
  const store = useChatStoreApi();
  const [s, setS] = useState<MenuState>(null);
  const [toast, setToast] = useState("");
  useEffect(() => {
    subs.add(setS);
    return () => {
      subs.delete(setS);
    };
  }, []);
  // 路由变化（返回列表页）时收起——会话页在移动端并不卸载
  useEffect(() => {
    const close = () => emit(null);
    window.addEventListener("hashchange", close);
    window.addEventListener("popstate", close);
    return () => {
      window.removeEventListener("hashchange", close);
      window.removeEventListener("popstate", close);
    };
  }, []);

  const flash = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast((v) => (v === msg ? "" : v)), 1400);
  };
  const doCopy = (text: string) => {
    closeBubbleMenu();
    void copyText(text).then((ok) => flash(ok ? `✓ ${t("已复制")}` : t("复制失败")));
  };

  const menu = (() => {
    if (!s) return null;
    const hasFull = !!s.fullText && s.fullText !== s.text;
    const rows = 2 + (hasFull ? 1 : 0) + 1; // 复制 / (整条) / 选择 / 引用
    const h = rows * 42 + (s.ts ? 26 : 0) + 12;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const left = Math.min(Math.max(8, s.x - MENU_W / 2), vw - MENU_W - 8);
    // 手指下方放得下就放下面，放不下翻到上面（长按点始终看得见）
    const below = s.y + 14;
    const top = below + h < vh - 8 ? below : Math.max(8, s.y - h - 14);
    return (
      <>
        {/* 背板：点任意处收起；touch-action:none 顺带挡住背后的滚动 */}
        <div
          className="fixed inset-0 z-[997]"
          style={{ touchAction: "none" }}
          onPointerDown={() => closeBubbleMenu()}
        />
        <div
          role="menu"
          className="cstra-menu-in fixed z-[998] overflow-hidden rounded-2xl border border-base-300 bg-base-100/97 py-1.5 shadow-xl backdrop-blur"
          style={{ left, top, width: MENU_W }}
        >
          <Item icon="⧉" label={hasFull ? t("复制这段") : t("复制")} onClick={() => doCopy(s.text)} />
          {hasFull && <Item icon="📄" label={t("复制整条")} onClick={() => doCopy(s.fullText!)} />}
          <Item
            icon="✂️"
            label={t("选择文字")}
            onClick={() => {
              const el = s.getEl();
              closeBubbleMenu();
              enterSelectMode(el);
            }}
          />
          <Item
            icon="❝"
            label={t("引用")}
            onClick={() => {
              store.setQuote(s.text);
              closeBubbleMenu();
            }}
          />
          {s.ts && (
            <div className="px-3.5 pb-0.5 pt-1 font-mono text-[10px] tabular-nums text-base-content/35">
              {fmtTs(s.ts)}
            </div>
          )}
        </div>
      </>
    );
  })();

  if (typeof document === "undefined") return null;
  return createPortal(
    <>
      {menu}
      {toast && (
        <div
          className="pointer-events-none fixed left-1/2 z-[999] -translate-x-1/2 rounded-full bg-neutral px-3 py-1.5 text-xs text-neutral-content shadow-lg"
          style={{ bottom: "calc(env(safe-area-inset-bottom, 0px) + 96px)" }}
        >
          {toast}
        </div>
      )}
    </>,
    document.body
  );
}

/**
 * 选择模式的浮动条（同样 portal 到 body —— 移动端会话页在 transform 横滑容器
 * 里，容器内的 fixed 会定位到屏幕外，页面规矩 5b）。
 */
export function SelectModeBar() {
  const t = useT();
  const [on, setOn] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(
    () =>
      onSelectModeChange((v) => {
        setOn(v);
        if (!v) setCopied(false);
      }),
    []
  );
  // 卸载(切页/热更新)时别把冻住的滚动留在那儿。移动端返回列表页时会话页并不
  // 卸载(两页同时在 DOM),所以再挂一道路由变化的退出。
  useEffect(() => {
    window.addEventListener("hashchange", exitSelectMode);
    window.addEventListener("popstate", exitSelectMode);
    return () => {
      window.removeEventListener("hashchange", exitSelectMode);
      window.removeEventListener("popstate", exitSelectMode);
      exitSelectMode();
    };
  }, []);
  if (!on || typeof document === "undefined") return null;
  return createPortal(
    <div
      className="fixed inset-x-0 z-[998] flex justify-center px-4"
      style={{ bottom: "calc(env(safe-area-inset-bottom, 0px) + 16px)" }}
    >
      <div className="flex items-center gap-2 rounded-full border border-base-300 bg-base-100/95 px-2 py-1.5 shadow-lg backdrop-blur">
        <span className="pl-1.5 text-[11px] leading-tight text-base-content/50">
          {t("滚动已锁定 · 拖动手柄调整选区")}
        </span>
        <button
          type="button"
          className="btn btn-primary btn-xs h-7 min-h-0 gap-1 rounded-full px-2.5 text-[11px] font-normal"
          onClick={() => {
            const sel = selectedText().trim();
            if (!sel) return;
            void copyText(sel).then((ok) => {
              if (!ok) return;
              setCopied(true);
              setTimeout(exitSelectMode, 700);
            });
          }}
        >
          {copied ? `✓ ${t("已复制")}` : `⧉ ${t("复制所选")}`}
        </button>
        <button
          type="button"
          className="btn btn-xs h-7 min-h-0 gap-1 rounded-full border-base-content/10 bg-base-200/70 px-2.5 text-[11px] font-normal text-base-content/70"
          onClick={exitSelectMode}
        >
          ✕ {t("完成")}
        </button>
      </div>
    </div>,
    document.body
  );
}

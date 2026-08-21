"use client";
/**
 * 气泡 / 文本块的操作条（2026-08-21 owner：「iPhone 上想复制一段文字，一选中
 * 页面就跟着动」）。
 *
 * 交互沿用用户已有的习惯：点一下气泡本来就会冒出秒级时间戳，现在冒出来的是
 * 一条「复制 / 选择 / 引用 + 时间」的小条 —— 不新增手势，不占常驻空间。
 *
 *  - 复制：整块直接进剪贴板（九成场景一步到位，根本不用碰选区）；
 *  - 选择：进入选择模式（见 ../select-mode）——冻结滚动 + 关掉左滑引用手势，
 *    并把整块先选上，用户只需拖手柄收窄；
 *  - 引用：桌面端补上左滑引用的等价入口（鼠标没法左滑）。
 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useChatStoreApi } from "../chat-store";
import { fmtTs } from "../fmt-time";
import { useT } from "@/lib/i18n";
import { copyText, enterSelectMode, exitSelectMode, onSelectModeChange, selectedText } from "../select-mode";

function ActBtn({
  onClick,
  children,
  tone,
}: {
  onClick: () => void;
  children: React.ReactNode;
  tone?: "primary";
}) {
  return (
    <button
      type="button"
      className={`btn btn-xs h-7 min-h-0 gap-1 rounded-full px-2.5 text-[11px] font-normal ${
        tone === "primary"
          ? "btn-primary"
          : "border-base-content/10 bg-base-200/70 text-base-content/70 hover:bg-base-200"
      }`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/**
 * @param text  这一块的纯文本（复制 / 引用用的就是它）
 * @param getEl 取本块 DOM（进选择模式时把它整体选上）——用取值函数而不是 ref
 *              对象，调用方挂 ref 的层级可以随意
 */
export function BlockActions({
  text,
  ts,
  getEl,
  align = "start",
}: {
  text: string;
  ts?: string;
  getEl: () => HTMLElement | null;
  align?: "start" | "end";
}) {
  const store = useChatStoreApi();
  const t = useT();
  const [copied, setCopied] = useState(false);
  return (
    <div
      className={`mt-1.5 flex flex-wrap items-center gap-1.5 ${align === "end" ? "justify-end" : ""}`}
      // 条本身在气泡内部,气泡的 onClick 会把条收起来——按钮点击不能冒上去
      onClick={(e) => e.stopPropagation()}
    >
      <ActBtn
        onClick={() => {
          void copyText(text).then((ok) => {
            if (!ok) return;
            setCopied(true);
            setTimeout(() => setCopied(false), 1400);
          });
        }}
      >
        {copied ? `✓ ${t("已复制")}` : `⧉ ${t("复制")}`}
      </ActBtn>
      <ActBtn onClick={() => enterSelectMode(getEl())}>✂️ {t("选择文字")}</ActBtn>
      <ActBtn onClick={() => store.setQuote(text)}>❝ {t("引用")}</ActBtn>
      {ts && (
        <span className="font-mono text-[10px] tabular-nums opacity-40">{fmtTs(ts)}</span>
      )}
    </div>
  );
}

/**
 * 选择模式的浮动条（portal 到 body —— 移动端会话页在 transform 横滑容器里，
 * 容器内的 fixed 会定位到屏幕外，页面规矩 5b）。
 * 挂一份在 MessageList 里即可。
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
  // 卸载(两页同时在 DOM),所以再挂一道路由变化的退出——否则浮动条会飘在列表上。
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
        <ActBtn
          tone="primary"
          onClick={() => {
            const s = selectedText().trim();
            if (!s) return;
            void copyText(s).then((ok) => {
              if (!ok) return;
              setCopied(true);
              setTimeout(exitSelectMode, 700);
            });
          }}
        >
          {copied ? `✓ ${t("已复制")}` : `⧉ ${t("复制所选")}`}
        </ActBtn>
        <ActBtn onClick={exitSelectMode}>✕ {t("完成")}</ActBtn>
      </div>
    </div>,
    document.body
  );
}

"use client";
/**
 * 错误兜底的外壳（核心在 lib/error-boundary.ts）：根 = 整页，Pane = 聊天主区 / 协作视图 / 侧栏，Bubble = 单条消息。
 * 兜底画面用纯函数 t() 不用 useT()：出错的可能正是某个 hook，兜底里不能再依赖订阅；语言在崩之前就定好了。
 */
import type { ReactNode } from "react";
import { ErrorBoundary, onlyOnce } from "@/lib/error-boundary";
import { reportBoundaryError } from "@/lib/runtime-error";
import { clearLocalCaches } from "@/lib/crash-reset";
import { t } from "@/lib/i18n";

const onError = (scope: string) => (err: Error, stack: string) => reportBoundaryError(scope, err, stack);
const ROOT_ERR = onError("root");
const CHAT_ERR = onError("chat");
const COLLAB_ERR = onError("collab");
const SIDEBAR_ERR = onError("sidebar");

/** 气泡层每条消息只报第一次：resetKey 是消息对象，流式气泡每来一段就重试一次，不去重会几秒用光 5 分钟 8 条的额度 */
const firstBubbleReport = onlyOnce();
function reportBubble(id: string, err: Error, stack: string) {
  if (firstBubbleReport(id)) reportBoundaryError("bubble", err, stack, id);
}

function AlertIcon({ className }: { className: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </svg>
  );
}

function reloadClean() {
  if (!window.confirm(t("会清掉本机的草稿、界面偏好和缓存（配对的机器不受影响），然后重新加载。继续吗？"))) return;
  const stores = [];
  try {
    stores.push(localStorage, sessionStorage);
  } catch {
    // 隐私模式访问存储就抛：没有可清的，直接重载
  }
  clearLocalCaches(stores);
  window.location.reload();
}

function RootFallback({ error }: { error: Error }) {
  return (
    <div role="alert" className="fixed inset-0 z-[100] flex flex-col items-center justify-center gap-3 bg-base-100 px-6 pb-safe-bottom pt-safe-top text-center">
      <AlertIcon className="size-8 text-warning" />
      <div className="text-lg font-semibold text-base-content">{t("出错了")}</div>
      <p className="max-w-sm text-sm text-base-content/70">{t("页面遇到了一个错误，已经记下来了。重新加载通常就能恢复。")}</p>
      <p className="line-clamp-3 max-w-sm break-all font-mono text-xs text-base-content/50">{error.message}</p>
      <div className="mt-2 flex flex-col items-center gap-2">
        <button type="button" className="btn btn-primary btn-sm min-w-40" onClick={() => window.location.reload()}>
          {t("重新加载")}
        </button>
        <button type="button" className="btn btn-ghost btn-sm text-base-content/70" onClick={reloadClean}>
          {t("清除本地缓存并重载")}
        </button>
      </div>
    </div>
  );
}

export function RootBoundary({ children }: { children: ReactNode }) {
  return (
    <ErrorBoundary onError={ROOT_ERR} fallback={(e) => <RootFallback error={e} />}>
      {children}
    </ErrorBoundary>
  );
}

function PaneFallback({ error, reset, onClose }: { error: Error; reset: () => void; onClose?: () => void }) {
  return (
    <div role="alert" className="flex min-h-0 w-full flex-1 flex-col items-center justify-center gap-2 bg-base-100 px-6 text-center">
      <AlertIcon className="size-6 text-warning" />
      <div className="text-sm font-medium text-base-content">{t("这部分出错了")}</div>
      <p className="line-clamp-3 max-w-sm break-all font-mono text-xs text-base-content/50">{error.message}</p>
      <div className="mt-1 flex gap-2">
        <button type="button" className="btn btn-sm" onClick={reset}>
          {t("重试")}
        </button>
        {onClose && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
            {t("关闭协作视图")}
          </button>
        )}
      </div>
    </div>
  );
}

/** 聊天主区（顶栏 + 消息 + 输入框）：resetKey 传当前会话，切走再切回自动重试 */
export function ChatPaneBoundary({ resetKey, children }: { resetKey: unknown; children: ReactNode }) {
  return (
    <ErrorBoundary onError={CHAT_ERR} resetKey={resetKey} fallback={(e, reset) => <PaneFallback error={e} reset={reset} />}>
      {children}
    </ErrorBoundary>
  );
}

/** 协作视图：盖在聊天上面的整层，兜底要给出「关闭」，不然用户被困在覆盖层下 */
export function CollabPaneBoundary({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  return (
    <ErrorBoundary onError={COLLAB_ERR} fallback={(e, reset) => <PaneFallback error={e} reset={reset} onClose={onClose} />}>
      {children}
    </ErrorBoundary>
  );
}

/** 侧栏：会话列表崩了不拖垮聊天区（桌面双栏时右边照常能用） */
export function SidebarBoundary({ children }: { children: ReactNode }) {
  return (
    <ErrorBoundary onError={SIDEBAR_ERR} fallback={(e, reset) => <PaneFallback error={e} reset={reset} />}>
      {children}
    </ErrorBoundary>
  );
}

/** 单条消息：一条坏消息只把自己换成一行灰字，列表照常。resetKey 传消息对象本身，内容一更新就再试 */
export function BubbleBoundary({ id, resetKey, children }: { id: string; resetKey: unknown; children: ReactNode }) {
  return (
    <ErrorBoundary
      onError={(err, stack) => reportBubble(id, err, stack)}
      resetKey={resetKey}
      fallback={(e) => (
        <div role="alert" title={e.message} className="my-1 flex items-center gap-1.5 px-1 text-xs text-base-content/50">
          <AlertIcon className="size-3.5 shrink-0 text-warning" />
          {t("这条消息显示不了")}
        </div>
      )}
    >
      {children}
    </ErrorBoundary>
  );
}

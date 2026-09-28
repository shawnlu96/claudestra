/**
 * 点侧栏行打开会话时的意图（chat-store.openAgent 第二参，只在点的就是当前会话时起作用）。
 * 窄屏（< 640px，与 chat.tsx 的 isNarrow 同一断点）列表页只在内容页收起时可点：点回同一行 =
 * 返回后回到页面（reenter，常规对齐）。桌面双栏重点当前行 = 明确要看最新（latest，强制全量）。
 */
export function rowOpenIntent(): "latest" | "reenter" {
  return typeof window !== "undefined" && window.matchMedia("(max-width: 639.98px)").matches ? "reenter" : "latest";
}

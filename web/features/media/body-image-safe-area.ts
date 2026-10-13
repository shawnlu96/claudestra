/**
 * 大图查看器顶栏让出安全区（PM 补 10-12 03:23）：App 壳是 contentInset never + 状态栏覆盖 WebView，页面 viewport-fit=cover，
 * PhotoSwipe 顶栏贴 top 0，保存 / 关闭按钮落在状态栏和灵动岛底下点不到。上沿让 safe-area-inset-top，左右让各自的 inset；
 * 普通浏览器里 inset 都是 0，位置和原来一样。PhotoSwipe 其余布局不动。
 */
export const TOP_BAR_INSET: Record<string, string> = {
  top: "env(safe-area-inset-top, 0px)",
  left: "env(safe-area-inset-left, 0px)",
  right: "env(safe-area-inset-right, 0px)",
  width: "auto",
};

export function insetTopBar(bar: { style: { setProperty(name: string, value: string): void } } | undefined): void {
  for (const [k, v] of Object.entries(TOP_BAR_INSET)) bar?.style.setProperty(k, v);
}

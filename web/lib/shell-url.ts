import { isNativeShell, nativeServerConfig } from "./native";
import { postClientLog } from "./client-log";
import { shellUrlNeedsAlign } from "./shell-url-match";

const ALIGN_KEY = "cstra.shellUrlAlignedAt";

/** 壳启动时调一次：记下保存的地址（排障用），写法不一致就修正并让壳重载。10 分钟内只修一次，防止重载死循环。 */
export async function alignShellServerUrl(): Promise<void> {
  const cfg = isNativeShell() ? nativeServerConfig() : null;
  if (!cfg) return;
  const saved = await cfg.get().catch(() => "");
  const origin = window.location.origin;
  postClientLog(`[shell] serverURL=${saved || "(未设置)"} origin=${origin}`);
  if (!shellUrlNeedsAlign(saved, origin)) return;
  try {
    if (Date.now() - Number(localStorage.getItem(ALIGN_KEY) || 0) < 10 * 60_000) return;
    localStorage.setItem(ALIGN_KEY, String(Date.now()));
  } catch {
    return; // 记不下时间就不冒险重载：宁可不修，也不要在重载里打转
  }
  postClientLog(`[shell] 服务器地址写法与页面不一致，对齐为 ${origin} 并重载`);
  await cfg.set(origin).catch((e: unknown) => postClientLog(`[shell] 对齐失败: ${(e as Error)?.message ?? e}`));
}

/** 壳里的「刷新」：交给原生侧重建 WebView 并从服务器地址重新加载，不产生会被判站外的页面导航。
 *  返回 false = 不在壳里 / 插件不可用，调用方自己刷新。 */
export async function reloadShell(): Promise<boolean> {
  const cfg = isNativeShell() ? nativeServerConfig() : null;
  if (!cfg) return false;
  await cfg.set(window.location.origin);
  return true;
}

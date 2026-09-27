/**
 * 中继网页 → 本机直连的纯逻辑（运行时在 local-hop.ts；单测 tests/web-local-hop.test.ts，根 tsconfig 无 dom lib，这里不碰 window）。
 * 本机识别：中继说「浏览器与这台机器出口 IP 相同」（GET /host 的 localEntry.sameNetwork）+ 桌面浏览器 → 去探 http://127.0.0.1:<端口>/local-probe，
 * fp 对得上就是同一台电脑。手机不探：Android Chrome 会为回环请求弹「访问本机应用」授权，而手机上永远探不到。
 */

export interface LocalEntry {
  port: number;
  sameNetwork: boolean;
}

/** 桌面浏览器：不是手机 / 平板（iPadOS 报 Mac UA，靠触点数认出来） */
export function isDesktopBrowser(ua: string, maxTouchPoints: number): boolean {
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(ua)) return false;
  return !(/Macintosh/.test(ua) && maxTouchPoints > 1);
}

/**
 * 探不通时要不要给手动横幅：只有 Safari——它拦「https 页面 → http 回环」，探测注定失败，而用户可能正坐在这台 Mac 前。
 * Chrome / Firefox 探得通（Chrome 先弹授权），探不通就说明不是这台电脑（或用户拒了），同网的其它电脑上不该冒出横幅。
 */
export function probeBlockedByBrowser(ua: string): boolean {
  return /Safari\//.test(ua) && !/Chrome|Chromium|CriOS|FxiOS|Firefox|Edg\//.test(ua);
}

/** 本机入口（直托管前端的 bridge）：固定用 127.0.0.1，与探测同一个地址；只保留 /chat 认的查询参数 */
export function localEntryUrl(port: number, search: string, handoffId?: string): string {
  const keep = new URLSearchParams();
  const agent = new URLSearchParams(search).get("agent");
  if (agent) keep.set("agent", agent);
  const q = keep.toString();
  return `http://127.0.0.1:${port}/chat${q ? `?${q}` : ""}${handoffId ? `#handoff=${handoffId}` : ""}`;
}

/** 探测响应的 fp 与当前机器一致才算：同一台电脑上可能还跑着别的实例（另一个 HOME 的沙箱） */
export function probeMatches(body: unknown, fp: string): boolean {
  return !!body && typeof body === "object" && (body as { fp?: unknown }).fp === fp;
}

export function handoffIdFromHash(hash: string): string | null {
  const m = /^#handoff=([A-Za-z0-9_-]{16,64})$/.exec(hash);
  return m ? m[1] : null;
}

/**
 * 跟着切到本机的浏览器本地偏好。只带原始偏好（主题 / 字体 / 气泡参数存的是用户填的原文），不带预生成的 *_css——
 * 本机页面用各自的解析器重建，免得带进一段不受控的 CSS；机器相关的键（API 基址、邀请处理）不带。
 */
const HANDOFF_KEYS = new Set([
  "cstra_theme", "cstra_lang", "cstra_sbw", "cstra_pinned", "cstra_proj_collapsed", "cstra_last_agent",
  "cstra_devmode", "cstra_kb_fix", "cstra_theme_vars", "cstra_font_prefs", "cstra_chat_prefs",
]);
const DRAFT_PREFIX = "cstra_draft_";

export function isHandoffKey(key: string): boolean {
  return HANDOFF_KEYS.has(key) || (key.startsWith(DRAFT_PREFIX) && key.length > DRAFT_PREFIX.length);
}

interface ReadableStorage {
  readonly length: number;
  key(i: number): string | null;
  getItem(key: string): string | null;
}
interface WritableStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function collectHandoff(storage: ReadableStorage): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    const v = k && isHandoffKey(k) ? storage.getItem(k) : null;
    if (k && v !== null) out[k] = v;
  }
  return out;
}

/** 只补本机缺的键：本机页面上已经改过的偏好不被中继那边的旧值盖掉。返回写入的键 */
export function applyHandoff(entries: Record<string, unknown>, storage: WritableStorage): string[] {
  const written: string[] = [];
  for (const [k, v] of Object.entries(entries)) {
    if (!isHandoffKey(k) || typeof v !== "string" || storage.getItem(k) !== null) continue;
    storage.setItem(k, v);
    written.push(k);
  }
  return written;
}

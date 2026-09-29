/**
 * 根层兜底的「清除本地缓存并重载」：坏掉的本地数据（草稿、偏好、折叠状态、各类缓存）让页面每次打开都崩时，光重载救不回来。
 * 清 localStorage 与 sessionStorage，只留下面三个：配对凭据在 IndexedDB（lib/machines.ts）不受影响，
 * API 基址镜像是 client-log 打点用的（启动时会从 IndexedDB 重写），主题 / 语言是枚举值、读的时候就校验。
 */
export const KEEP_ON_RESET: readonly string[] = ["cstra_api_base", "cstra_theme", "cstra_lang"];

export interface ResettableStorage {
  readonly length: number;
  key(index: number): string | null;
  removeItem(key: string): void;
}

/** 返回删掉的键数；拿不到存储（隐私模式抛 SecurityError）就跳过那一份 */
export function clearLocalCaches(stores: (ResettableStorage | null | undefined)[]): number {
  let removed = 0;
  for (const s of stores) {
    if (!s) continue;
    try {
      const keys: string[] = [];
      for (let i = 0; i < s.length; i++) {
        const k = s.key(i);
        if (k !== null && !KEEP_ON_RESET.includes(k)) keys.push(k);
      }
      for (const k of keys) s.removeItem(k);
      removed += keys.length;
    } catch {
      // 存储被禁用时读写都会抛：这一份本来就没东西可清，照常重载
    }
  }
  return removed;
}

/**
 * 消息时间的拆分格式（纯函数，无 import，tests/ 直测）：
 * date = 非今天时的 `MM-DD`（不带年，owner 2026-09-27），hms = `HH:mm:ss`（PC 侧槽），hm = `HH:mm`（移动端头像行）。
 */
export interface TsParts {
  date: string | null;
  hms: string;
  hm: string;
}

export function fmtTsParts(iso?: string, now: Date = new Date()): TsParts | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return {
    date: sameDay ? null : `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    hms: `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`,
    hm: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };
}

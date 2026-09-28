/**
 * 消息时间的拆分格式（纯函数，无 import，tests/ 直测）：
 * date = 非今天时的 `MM-DD`（不带年，owner 2026-09-27），hms = `HH:mm:ss`（PC 侧槽），hm = `HH:mm`（移动端头像行）。
 * 一律按设备本地时区；需要写明时区的地方（悬停全称）用 fmtUtcOffset。
 */
export interface TsParts {
  date: string | null;
  hms: string;
  hm: string;
}

const pad = (n: number) => String(n).padStart(2, "0");
const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const mmdd = (d: Date) => `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

function parse(iso?: string): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

export function fmtTsParts(iso?: string, now: Date = new Date()): TsParts | null {
  const d = parse(iso);
  if (!d) return null;
  return {
    date: sameDay(d, now) ? null : mmdd(d),
    hms: `${hm(d)}:${pad(d.getSeconds())}`,
    hm: hm(d),
  };
}

/** 该时刻所在时区的偏移：`UTC+8`、`UTC+5:30`、`UTC-3`、`UTC+0` */
export function fmtUtcOffset(d: Date): string {
  const off = -d.getTimezoneOffset();
  const a = Math.abs(off);
  return `UTC${off < 0 ? "-" : "+"}${Math.floor(a / 60)}${a % 60 ? `:${pad(a % 60)}` : ""}`;
}

/**
 * 将来的时刻（值守截止、额度退避「等到」）：day = 按自然日是今天 / 明天 / 其它（其它带 `MM-DD`，同样不带年），
 * full = 悬停用的全称 `YYYY-MM-DD HH:mm UTC+8`。「今天 / 明天」的文字由调用方翻译。
 */
export interface DueParts {
  day: "today" | "tomorrow" | "other";
  date: string;
  hm: string;
  full: string;
}

export function fmtDueParts(iso?: string, now: Date = new Date()): DueParts | null {
  const d = parse(iso);
  if (!d) return null;
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return {
    day: sameDay(d, now) ? "today" : sameDay(d, tomorrow) ? "tomorrow" : "other",
    date: mmdd(d),
    hm: hm(d),
    full: `${d.getFullYear()}-${mmdd(d)} ${hm(d)} ${fmtUtcOffset(d)}`,
  };
}

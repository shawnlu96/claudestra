/**
 * 值守界面的时间计算（纯函数，无 import，tests/web-mission-time.test.ts 直测）。
 * 一律按本设备（手机 / 浏览器）的时区：徽章按它显示，「11:00」也按它换算，两边才对得上。
 */

/**
 * 弹框里手填的截止时间 → 发给 bridge 的值。`HH:MM` 在这里按本设备时区换成 ISO（已过就算明天），
 * 因为 bridge 的 parseUntil 用的是电脑的时区——电脑在东京、手机在上海时，填 05:45 会变成手机上的 04:45。
 * `+2h` / `+90m` 与时区无关、ISO 已经带时区，都原样发；格式不对也原样发，让 bridge 报错。
 */
export function resolveUntil(raw: string, now: Date = new Date()): string {
  const s = raw.trim();
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return s;
  const d = new Date(now);
  d.setHours(Number(m[1]), Number(m[2]), 0, 0);
  if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
  return d.toISOString();
}

/**
 * 徽章下一次该重算「现在」的时刻距今多少毫秒：下一个本地零点（今天 / 明天会变），
 * 退避中还要算上 resumeAt（「等到」该换回「截止」）。多等 1 秒，免得醒得早一点还算在前一天。
 */
export function nextRefreshMs(now: number, resumeAt?: string): number {
  const d = new Date(now);
  let at = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
  const r = resumeAt ? Date.parse(resumeAt) : NaN;
  if (r > now && r < at) at = r;
  return at - now + 1000;
}

/**
 * 兜底检查：上次取的「现在」（shown）到真实现在（real）之间，本地日期变了或跨过了 resumeAt，就该重算。
 * 正常情况下计时器会准时刷新，这里只接住计时器被系统睡眠拖晚的情况。
 */
export function isStale(shown: number, real: number, resumeAt?: string): boolean {
  if (new Date(shown).toDateString() !== new Date(real).toDateString()) return true;
  const r = resumeAt ? Date.parse(resumeAt) : NaN;
  return r > shown && r <= real;
}

/**
 * 浮层相对徽章左边缘的水平位移（px）：优先和徽章左对齐，右边放不下就往左挪，挪到屏幕左边距为止。
 * 按浮层实测宽度算（不是最大宽度），窄屏上短浮层也不会被误判成放不下。
 */
export function tipShift(badgeLeft: number, tipWidth: number, viewportWidth: number, margin = 8): number {
  const maxLeft = viewportWidth - margin - tipWidth;
  const left = Math.max(margin, Math.min(badgeLeft, maxLeft));
  return left - badgeLeft;
}

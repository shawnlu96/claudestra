import { getLang } from "@/lib/i18n";

/** 相对时间标签(owner 2026-07-14:「显示多少秒前/分钟前/小时分前/天前」)。
 *  消费方注意保鲜:相对时间会过期,长驻视图配个 30s tick 重渲染。
 *  组件里配合 useLang() 订阅,切语言即时换写法。 */
export function fmtAgo(ts?: number | null): string {
  if (!ts) return "";
  const en = getLang() === "en";
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return en ? `${s}s ago` : `${s}秒前`;
  const m = Math.floor(s / 60);
  if (m < 60) return en ? `${m}m ago` : `${m}分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) {
    const rm = m % 60;
    if (en) return rm ? `${h}h ${rm}m ago` : `${h}h ago`;
    return rm ? `${h}小时${rm}分前` : `${h}小时前`;
  }
  const d = Math.floor(h / 24);
  return en ? `${d}d ago` : `${d}天前`;
}

/** 秒级时间戳（消息/工具卡点开时显示）。跨天带日期，当天只时分秒。 */
export function fmtTs(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  const hms = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  return sameDay ? hms : `${d.getMonth() + 1}-${pad(d.getDate())} ${hms}`;
}

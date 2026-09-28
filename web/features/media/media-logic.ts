/**
 * 图片与文件视图的纯逻辑（无 React，tests/web-media-logic.test.ts 直测）：按天分组、分页合并去重、
 * 大图查看器的「第 n / 共 N」换算、时间筛选的起止、文件大小与类型展示。
 * 服务端列表恒为时间倒序（最新在前）；查看器按时间正序（左 = 更早，和微信一样往右翻是更新的）。
 */
import type { MediaItem, MediaPage } from "@/lib/api/media";
import { uiAgentName } from "@/lib/chat/agents";
import { isSelfSource } from "@/lib/chat/history-shape";

const pad = (n: number) => String(n).padStart(2, "0");

/** 设备本地时区的 YYYY-MM-DD；没时间的归到 "" */
export function dayKey(ts: string | null): string {
  if (!ts) return "";
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export interface DayGroup {
  day: string;
  items: MediaItem[];
}

/** 已按时间倒序的列表 → 按天分组（组内保持原顺序） */
export function groupByDay(items: MediaItem[]): DayGroup[] {
  const out: DayGroup[] = [];
  for (const it of items) {
    const day = dayKey(it.ts);
    const last = out[out.length - 1];
    if (last && last.day === day) last.items.push(it);
    else out.push({ day, items: [it] });
  }
  return out;
}

/** 分组标题：今天 / 昨天 / 同年 MM-DD / 跨年 YYYY-MM-DD（中文 key，渲染时过 t()） */
export function dayLabel(day: string, now: Date = new Date()): { key: "今天" | "昨天" | null; text: string } {
  if (!day) return { key: null, text: "" };
  if (day === dayKey(now.toISOString())) return { key: "今天", text: "" };
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  if (day === dayKey(y.toISOString())) return { key: "昨天", text: "" };
  return { key: null, text: day.startsWith(`${now.getFullYear()}-`) ? day.slice(5) : day };
}

/** 往后追加一页（更早的），按 id 去重——并发的两次加载不会把同一项塞两遍 */
export function appendOlder(list: MediaItem[], page: MediaItem[]): MediaItem[] {
  const seen = new Set(list.map((i) => i.id));
  return [...list, ...page.filter((i) => !seen.has(i.id))];
}

/**
 * 查看器用的「窗口」：服务端倒序页 + 它前面还有多少更新的（newerCount）→ 正序里第几张。
 * 正序下标 = total - 1 - 倒序位置；倒序位置 = newerCount + 页内下标。
 */
export function chronoIndex(total: number, newerCount: number, pageIndex: number): number {
  return total - 1 - (newerCount + pageIndex);
}

/** 一页落进稀疏的正序表（下标 → 项）；返回新表，不改旧表 */
export function placePage(slots: Map<number, MediaItem>, page: Pick<MediaPage, "items" | "total" | "newerCount">): Map<number, MediaItem> {
  const next = new Map(slots);
  page.items.forEach((it, i) => {
    const idx = chronoIndex(page.total, page.newerCount, i);
    if (idx >= 0) next.set(idx, it);
  });
  return next;
}

export type TimeRange = "all" | "7d" | "30d" | "90d" | "year";

/** 时间筛选 → since（毫秒）；all = 不限 */
export function sinceOf(range: TimeRange, now = Date.now()): number | undefined {
  const day = 86_400_000;
  if (range === "7d") return now - 7 * day;
  if (range === "30d") return now - 30 * day;
  if (range === "90d") return now - 90 * day;
  if (range === "year") return now - 365 * day;
  return undefined;
}

export function fmtSize(bytes: number | null): string {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/** 扩展名大写（列表里的类型徽标）；没有扩展名给 FILE */
export function extBadge(name: string): string {
  const m = /\.([A-Za-z0-9]{1,6})$/.exec(name);
  return m ? m[1].toUpperCase() : "FILE";
}

/** 查看器取哪个版本：GIF / SVG 原样（转 JPEG 会丢动画 / 矢量），其余用服务端显示版 */
export function wantsDisplayVariant(name: string): boolean {
  return !/\.(gif|svg)$/i.test(name);
}

/** 浏览器能直接预览的文件（新标签打开），其余直接下载 */
export function previewable(name: string): boolean {
  return /\.(pdf|txt|log|json|md|csv|png|jpe?g|gif|webp|svg)$/i.test(name);
}

/** 谁发的：agent 发的写 agent 名；入站按发送者 id 认本人（别人的设备 / guest / Discord 用户写对方的名字） */
export function whoLabel(item: Pick<MediaItem, "dir" | "agent" | "sender" | "senderId">, self: ReadonlySet<string>, t: (s: string) => string): string {
  if (item.dir === "out") return uiAgentName(item.agent);
  return isSelfSource(item.sender ?? undefined, item.senderId ?? undefined, self) ? t("我发的") : item.sender || t("别人发的");
}

/** web/features/media/media-logic：按天分组、分页合并、查看器正序下标、时间筛选、展示格式；lib/api/media 的查询串 */
import { describe, expect, test } from "bun:test";
import { appendOlder, chronoIndex, dayKey, dayLabel, extBadge, fmtSize, groupByDay, placePage, previewable, sinceOf, wantsDisplayVariant } from "@/features/media/media-logic";
import { mediaQueryString, type MediaItem } from "@/lib/api/media";

const item = (id: string, ts: string | null): MediaItem => ({
  id, agent: "agent-x", sessionId: "s", seq: 1, ts, dir: "in", sender: null, name: `${id}.png`, size: 1, mime: "image/png", kind: "image", cat: "image", available: true,
});
const local = (y: number, mo: number, d: number, h = 12) => new Date(y, mo - 1, d, h).toISOString();

describe("按天分组", () => {
  test("倒序列表按本地日期切组，组内保持顺序；没时间的单独一组", () => {
    const list = [item("a", local(2026, 9, 28, 20)), item("b", local(2026, 9, 28, 8)), item("c", local(2026, 9, 27)), item("d", null)];
    expect(groupByDay(list).map((g) => [g.day, g.items.map((i) => i.id)])).toEqual([
      ["2026-09-28", ["a", "b"]],
      ["2026-09-27", ["c"]],
      ["", ["d"]],
    ]);
    expect(dayKey("not a date")).toBe("");
  });
  test("标题：今天 / 昨天 / 同年 MM-DD / 跨年全写", () => {
    const now = new Date(2026, 8, 28, 10);
    expect(dayLabel("2026-09-28", now)).toEqual({ key: "今天", text: "" });
    expect(dayLabel("2026-09-27", now)).toEqual({ key: "昨天", text: "" });
    expect(dayLabel("2026-03-01", now).text).toBe("03-01");
    expect(dayLabel("2025-12-31", now).text).toBe("2025-12-31");
    expect(dayLabel("", now)).toEqual({ key: null, text: "" });
  });
});

describe("分页与查看器下标", () => {
  test("appendOlder 按 id 去重", () => {
    expect(appendOlder([item("a", null), item("b", null)], [item("b", null), item("c", null)]).map((i) => i.id)).toEqual(["a", "b", "c"]);
  });
  test("倒序页 → 正序下标：total=10，前面还有 3 条更新的，页内第 0 条是正序第 6 张", () => {
    expect(chronoIndex(10, 3, 0)).toBe(6);
    expect(chronoIndex(10, 0, 0)).toBe(9);
    const slots = placePage(new Map(), { items: [item("n", null), item("m", null)], total: 10, newerCount: 3 });
    expect([...slots].map(([i, it]) => [i, it.id])).toEqual([[6, "n"], [5, "m"]]);
  });
  test("新图在翻看期间进来（total 与 newerCount 同时 +1），已有项的下标不变", () => {
    const a = placePage(new Map(), { items: [item("m", null)], total: 10, newerCount: 4 });
    const b = placePage(new Map(), { items: [item("m", null)], total: 11, newerCount: 5 });
    expect([...a.keys()]).toEqual([...b.keys()]);
  });
});

describe("筛选与展示", () => {
  test("时间范围", () => {
    const now = 1_000_000_000_000;
    expect(sinceOf("all", now)).toBeUndefined();
    expect(sinceOf("7d", now)).toBe(now - 7 * 86_400_000);
    expect(sinceOf("year", now)).toBe(now - 365 * 86_400_000);
  });
  test("大小 / 扩展名 / 显示版 / 可预览", () => {
    expect([fmtSize(null), fmtSize(512), fmtSize(2048), fmtSize(50 * 1024), fmtSize(3.5 * 1024 * 1024)]).toEqual(["", "512 B", "2.0 KB", "50 KB", "3.5 MB"]);
    expect([extBadge("a.tar.gz"), extBadge("README")]).toEqual(["GZ", "FILE"]);
    expect([wantsDisplayVariant("a.HEIC"), wantsDisplayVariant("a.gif"), wantsDisplayVariant("a.svg")]).toEqual([true, false, false]);
    expect([previewable("a.pdf"), previewable("a.zip")]).toEqual([true, false]);
  });
  test("查询串：master 会话名映射回 bridge 名，空值不带", () => {
    expect(mediaQueryString({ agent: "worker", kind: "image", q: "  " }, { before: "1_a", limit: 40 })).toBe("agent=worker&kind=image&before=1_a&limit=40");
    expect(mediaQueryString({}, { name: "a b.png", session: "s1", seq: 3 })).toBe("name=a+b.png&session=s1&seq=3");
  });
});

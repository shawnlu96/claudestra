/** 子 DAG 已完成区的分段 + 搜索纯函数（web/features/collab/dag/focus-done-model.ts，team-project-SUBDAG5）[验收线 1] */
import { describe, expect, test } from "bun:test";
import { doneSections, type DoneRow } from "../web/features/collab/dag/focus-done-model";

const HOUR = 60 * 60_000, DAY = 24 * HOUR;
const TODAY = Date.UTC(2026, 9, 14) - 8 * HOUR; // 固定值，函数不读时区：随便取一个「本地 0 点」
const row = (nodeKey: string, at: number | null, oneLine = `卡 ${nodeKey}`): DoneRow => ({ nodeKey, oneLine, at, round: 1, cancelled: false });
const keys = (xs: DoneRow[]) => xs.map((x) => x.nodeKey);

describe("按天分段", () => {
  test("0 点整归今天，前一毫秒归昨天；昨天 0 点整归昨天，再前一毫秒归更早", () => {
    const s = doneSections([row("t0", TODAY), row("y1", TODAY - 1), row("y0", TODAY - DAY), row("e1", TODAY - DAY - 1)], TODAY, "");
    expect([keys(s.today), keys(s.yesterday), keys(s.earlier), keys(s.undated)]).toEqual([["t0"], ["y1", "y0"], ["e1"], []]);
  });

  test("每段保持入参顺序（at 降序原样）", () => {
    const done = [row("a", TODAY + 5 * HOUR), row("b", TODAY + 2 * HOUR), row("c", TODAY - 3 * HOUR), row("d", TODAY - 20 * HOUR),
      row("e", TODAY - 30 * HOUR), row("f", TODAY - 90 * HOUR), row("g", null), row("h", null)];
    const s = doneSections(done, TODAY, "");
    expect([keys(s.today), keys(s.yesterday), keys(s.earlier), keys(s.undated)]).toEqual([["a", "b"], ["c", "d"], ["e", "f"], ["g", "h"]]);
  });

  test("全部没有 at：全进 undated，其余三段空", () => {
    const s = doneSections([row("a", null), row("b", null), row("c", null)], TODAY, "");
    expect(s).toEqual({ today: [], yesterday: [], earlier: [], undated: [row("a", null), row("b", null), row("c", null)] });
  });

  test("有的有 at 有的没有：null 的进 undated，其余照常分段", () => {
    const s = doneSections([row("a", TODAY + HOUR), row("x", null), row("b", TODAY - 50 * HOUR), row("y", null)], TODAY, "");
    expect([keys(s.today), keys(s.yesterday), keys(s.earlier), keys(s.undated)]).toEqual([["a"], [], ["b"], ["x", "y"]]);
  });

  test("空列表四段都空", () => {
    expect(doneSections([], TODAY, "")).toEqual({ today: [], yesterday: [], earlier: [], undated: [] });
  });
});

describe("搜索：先匹配再分段", () => {
  const done = [row("SUBDAG4", TODAY + HOUR, "已完成区平铺列表"), row("ui-fix", TODAY - HOUR, "修 Search 框焦点"), row("d30", TODAY - 80 * HOUR, "合并队列收尾"),
    row("n-null", null, "没有时间的那张")];

  test("按 key 命中，大小写不敏感，首尾空格去掉", () => {
    const s = doneSections(done, TODAY, "  subdag4 ");
    expect([keys(s.today), keys(s.yesterday), keys(s.earlier), keys(s.undated)]).toEqual([["SUBDAG4"], [], [], []]);
  });

  test("按一句话命中，大小写不敏感", () => {
    expect(keys(doneSections(done, TODAY, "SEARCH").yesterday)).toEqual(["ui-fix"]);
    expect(keys(doneSections(done, TODAY, "队列").earlier)).toEqual(["d30"]);
    expect(keys(doneSections(done, TODAY, "时间").undated)).toEqual(["n-null"]);
  });

  test("部分匹配也算：key 片段同时命中多段，各段仍按原顺序", () => {
    const s = doneSections(done, TODAY, "d");
    expect([keys(s.today), keys(s.yesterday), keys(s.earlier)]).toEqual([["SUBDAG4"], [], ["d30"]]);
  });

  test("没有匹配四段都空；只有空格等于不搜", () => {
    expect(doneSections(done, TODAY, "zzz")).toEqual({ today: [], yesterday: [], earlier: [], undated: [] });
    expect(doneSections(done, TODAY, "   ")).toEqual(doneSections(done, TODAY, ""));
  });
});

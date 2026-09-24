import { beforeEach, describe, expect, test } from "bun:test";
import {
  clearSel,
  clickMessage,
  clickSelect,
  getShare,
  inRange,
  resetShare,
  selRange,
  setShareOn,
  subscribeShare,
  toggleShare,
} from "@/features/chat/share-mode";

const order = ["m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8", "m9", "m10"];
const r = (sel: ReturnType<typeof clickSelect>) => selRange(sel, order);

describe("clickSelect（连续范围选择）", () => {
  test("没选时点一条 → 只选它", () => {
    expect(r(clickSelect(null, "m5", order))).toEqual({ lo: 4, hi: 4 });
  });
  test("点 5 再点 10 → [5,10]；点 5 再点 3 → [3,5]", () => {
    const s5 = clickSelect(null, "m5", order);
    expect(r(clickSelect(s5, "m10", order))).toEqual({ lo: 4, hi: 9 });
    expect(r(clickSelect(s5, "m3", order))).toEqual({ lo: 2, hi: 4 });
  });
  test("范围外继续点 → 扩到那一条", () => {
    const s = clickSelect(clickSelect(null, "m5", order), "m10", order);
    expect(r(clickSelect(s, "m3", order))).toEqual({ lo: 2, hi: 9 });
  });
  test("范围内点 → 近的端点挪过来（收缩）", () => {
    const s = clickSelect(clickSelect(null, "m3", order), "m10", order);
    expect(r(clickSelect(s, "m4", order))).toEqual({ lo: 3, hi: 9 });
    expect(r(clickSelect(s, "m9", order))).toEqual({ lo: 2, hi: 8 });
  });
  test("只剩自己再点 → 清空", () => {
    expect(clickSelect(clickSelect(null, "m5", order), "m5", order)).toBeNull();
  });
  test("端点从列表消失 → 视为没选，下次点击重新起范围", () => {
    const s = clickSelect(clickSelect(null, "m1", order), "m3", order);
    const shorter = order.slice(2); // m1 没了
    expect(selRange(s, shorter)).toBeNull();
    expect(selRange(clickSelect(s, "m6", shorter), shorter)).toEqual({ lo: 3, hi: 3 });
  });
  test("点不在列表里的 id → 不变", () => {
    const s = clickSelect(null, "m5", order);
    expect(clickSelect(s, "nope", order)).toBe(s);
  });
  test("「显示更早」往前插入后范围不漂（按 id 换算）", () => {
    const s = clickSelect(clickSelect(null, "m5", order), "m7", order);
    const longer = ["m0a", "m0b", ...order];
    expect(selRange(s, longer)).toEqual({ lo: 6, hi: 8 });
  });
  test("inRange", () => {
    expect(inRange({ lo: 2, hi: 4 }, 3)).toBe(true);
    expect(inRange({ lo: 2, hi: 4 }, 5)).toBe(false);
    expect(inRange(null, 0)).toBe(false);
  });
});

describe("share store", () => {
  beforeEach(() => resetShare());
  test("进出模式；退出清选区", () => {
    let n = 0;
    const off = subscribeShare(() => n++);
    toggleShare();
    expect(getShare().on).toBe(true);
    clickMessage("m2", order);
    clickMessage("m4", order);
    expect(selRange(getShare().sel, order)).toEqual({ lo: 1, hi: 3 });
    setShareOn(false);
    expect(getShare()).toEqual({ on: false, sel: null });
    expect(n).toBe(4);
    off();
  });
  test("重复 setShareOn 同值不通知；clearSel 无选区不通知", () => {
    let n = 0;
    subscribeShare(() => n++);
    setShareOn(false);
    clearSel();
    expect(n).toBe(0);
  });
});

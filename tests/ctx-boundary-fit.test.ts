import { describe, expect, test } from "bun:test";
import {
  boxShows, compactTiers, describeCompactPlan, fitsInputBox, inputCols, inputRowsNeeded, inputRowsVisible, ourRemainder, tiersThatFit,
} from "../src/lib/ctx-boundary-fit.js";
import { DEFAULT_KEEP_LIST, normalizeCompactKeep, type CompactKeep } from "../src/lib/ctx-boundary-policy.js";

const kp = (s: string): CompactKeep => {
  const r = normalizeCompactKeep(s);
  if (!r.ok) throw new Error(r.why);
  return r.keep;
};
const DFLT = `/compact ${DEFAULT_KEEP_LIST}`;
// 09-29 私有 tmux 里真 CC 2.1.283 实测用的三段字（中英混排 800 字、纯英文 709 字）
const MIXED = `/compact ${"保留 T36 卡号、branch task/t36-ctx-boundary、worktree 路径、head 98bb5a5a 和 PR #171；未完成的步骤 and the step in flight; ".repeat(12).slice(0, 791)}`;
const ASCII = `/compact ${"keep the task card, branch, worktree, head and PR number; unfinished steps; ".repeat(10).slice(0, 700)}`;
const CJK800 = kp("保留卡号分支和当前进度，".repeat(80).slice(0, 800));

describe("输入框尺寸（真 CC 实测，adv2 P2-1）", () => {
  test("每行放宽减 4 列；最多显示 max(3, ⌊高/2⌋−5) 行，12 行以下按 1 行", () => {
    expect([16, 80, 120, 200].map(inputCols)).toEqual([12, 76, 116, 196]);
    const measured: [number, number][] = [[12, 3], [16, 3], [20, 5], [24, 7], [30, 10], [40, 15], [50, 20], [60, 25]];
    for (const [h, rows] of measured) expect(inputRowsVisible(h)).toBe(rows);
    expect([8, 10, 11].map((h) => inputRowsVisible(h))).toEqual([1, 1, 1]);
  });

  test("行数上限只在 fullscreen 渲染器下有（#171 审查 P2-1）：默认渲染器按整屏减 6 行，渲染器不明按 fullscreen", () => {
    expect([24, 30, 40].map((h) => inputRowsVisible(h, false))).toEqual([18, 24, 34]); // 真 CC 52×40 默认渲染器完整显示 34 行
    expect(inputRowsVisible(24, true)).toBe(7);
    const dflt = (width: number, height: number) => ({ width, height, fullscreen: false });
    const full = (width: number, height: number) => ({ width, height, fullscreen: true });
    // 52 列、高不到 30：默认清单（48 列时 9 行）在默认渲染器下放得下，不再退到只发 /compact；fullscreen 下照旧放不下
    for (const h of [16, 20, 24]) {
      expect([h, fitsInputBox(DFLT, dflt(52, h))]).toEqual([h, true]);
      expect([h, fitsInputBox(DFLT, full(52, h))]).toEqual([h, false]);
    }
    expect(tiersThatFit("compact", CJK800, dflt(52, 24)).fit.map((t) => t.tier)).toEqual(["default", "bare"]);
    expect(tiersThatFit("compact", CJK800, { width: 52, height: 24 }).fit.map((t) => t.tier)).toEqual(["bare"]); // 不明 = fullscreen
    // 默认渲染器下 800 字在 120×24 要 14 行、能显示 18 行：不退档；太长会长出屏幕的照样退
    expect(fitsInputBox(`/compact ${CJK800}`, dflt(120, 24))).toBe(true);
    expect(fitsInputBox(`/compact ${CJK800}`, dflt(52, 24))).toBe(false);
  });

  test("折行行数和真 CC 逐行一致（24 列默认清单少算一行，所以放不放得下要留一行余量）", () => {
    // [字, 窗口宽, 真 CC 显示的行数]；只列没被截断的
    const measured: [string, number, number][] = [
      [DFLT, 16, 26], [DFLT, 20, 21], [DFLT, 30, 13], [DFLT, 40, 9], [DFLT, 60, 7], [DFLT, 80, 5], [DFLT, 100, 4], [DFLT, 120, 3],
      [MIXED, 60, 19], [MIXED, 80, 15], [MIXED, 100, 11], [MIXED, 120, 9],
      [ASCII, 30, 29], [ASCII, 40, 22], [ASCII, 60, 13], [ASCII, 80, 10], [ASCII, 100, 8], [ASCII, 120, 7],
    ];
    for (const [text, w, rows] of measured) expect([w, inputRowsNeeded(text, inputCols(w))]).toEqual([w, rows]);
    expect(inputRowsNeeded(DFLT, inputCols(24))).toBe(16); // 真 CC 17 行
  });

  test("验收的四档窗口：默认清单和 800 字清单各自放不放得下", () => {
    const sizes = [[40, 24], [80, 24], [100, 40], [120, 40]].map(([width, height]) => ({ width, height }));
    expect(sizes.map((s) => fitsInputBox(DFLT, s))).toEqual([false, true, true, true]);
    expect(sizes.map((s) => fitsInputBox(`/compact ${CJK800}`, s))).toEqual([false, false, false, true]); // 120×40 要 14 行、显示 15 行（adv2 实测对上）
    expect(sizes.map((s) => fitsInputBox(MIXED, s))).toEqual([false, false, true, true]);
    expect(sizes.map((s) => fitsInputBox("/compact", s))).toEqual([true, true, true, true]);
    // 12 行以下只按 1 行算：/compact 行尾还空着就放得下，折成两行就不行；窄到一行不到 2 列算放不下
    expect(fitsInputBox("/compact", { width: 80, height: 10 })).toBe(true);
    expect(fitsInputBox("/compact", { width: 12, height: 10 })).toBe(false);
    expect(fitsInputBox("/compact", { width: 12, height: 24 })).toBe(true); // 真 CC 8×24 也画得出（折成两行）
    expect(fitsInputBox("/compact", { width: 5, height: 24 })).toBe(false);
  });
});

describe("退档：自定清单 → 默认清单 → 只发 /compact", () => {
  test("按窗口挑；save-compact 只有一档；窗口大小读不到就不估", () => {
    const keep = kp("只留卡号和分支");
    expect(compactTiers("compact", keep).map((t) => t.tier)).toEqual(["keep", "default", "bare"]);
    expect(compactTiers("compact", null).map((t) => t.tier)).toEqual(["default", "bare"]);
    expect(compactTiers("save-compact", keep)).toEqual([{ tier: "save", line: "/save-compact" }]);
    expect(tiersThatFit("compact", CJK800, { width: 80, height: 24 }).fit.map((t) => t.tier)).toEqual(["default", "bare"]);
    expect(tiersThatFit("compact", CJK800, { width: 40, height: 24 }).fit.map((t) => t.tier)).toEqual(["bare"]);
    expect(tiersThatFit("compact", CJK800, null).fit.map((t) => t.tier)).toEqual(["keep", "default", "bare"]);
    expect(tiersThatFit("save-compact", null, { width: 5, height: 24 }).fit).toEqual([]);
  });

  test("dry-run 写明会退到哪一档、或者会跳过", () => {
    expect(describeCompactPlan("compact", null, { width: 120, height: 40 })).toBe(DFLT);
    expect(describeCompactPlan("compact", CJK800, { width: 80, height: 24 })).toBe(`${DFLT}（窗口 80×24 放不下自定保留清单，退到默认保留清单）`);
    expect(describeCompactPlan("compact", null, { width: 40, height: 24 })).toBe("/compact（窗口 40×24 放不下默认保留清单，退到只发 /compact）");
    expect(describeCompactPlan("compact", null, { width: 5, height: 24 })).toBe("窗口 5×24 连 /compact 都放不下：跳过并提醒 owner");
  });
});

describe("框里是不是自己的字：截断时认后半截，删到一半时按实际剩下的算", () => {
  const size = { width: 80, height: 24 }; // 最多显示 7 行
  test("显示区没满就得完全一样；满了只要是后半截", () => {
    expect(boxShows("abc", 1, "a b c", size)).toBe(true); // 去空白后比
    expect(boxShows("bc", 1, "abc", size)).toBe(false);
    expect(boxShows("bc", 7, "abc", size)).toBe(true);
    expect(boxShows("bc", 7, "abc", null)).toBe(false); // 不知道窗口多大：不认后半截
    expect(boxShows("", 7, "abc", size)).toBe(false);
    expect(boxShows("bx", 7, "abc", size)).toBe(false);
  });

  test("一批退格不知道生效了几个：框里是前 [长度−n, 长度] 个字里的哪一段就删哪一段；拿不准就不删", () => {
    expect(ourRemainder("/compactabcdef", 1, "/compact abcdefgh", 3, null)).toBe("/compact abcdef");
    expect(ourRemainder("/compactabcdefgh", 1, "/compact abcdefgh", 3, null)).toBe("/compact abcdefgh");
    expect(ourRemainder("/compactabcde", 1, "/compact abcdefgh", 2, null)).toBeNull(); // 删多了：不是它
    expect(ourRemainder("", 0, "abc", 3, null)).toBe(""); // 已经删完了
    expect(ourRemainder("", 0, "abc", 0, null)).toBeNull(); // 框空了但一个退格都没在途：不是自己删的
    expect(ourRemainder("ab", 1, "ab ", 1, null)).toBe("ab"); // 只差空白：取短的，少删
    // 重复的字 + 截断：几个长度都对得上，拿不准
    expect(ourRemainder("abab", 7, "abababab", 2, size)).toBeNull();
    expect(ourRemainder("abab", 7, "abababab", 1, size)).toBe("abababab");
  });
});

import { describe, expect, test } from "bun:test";
import { basisFromText, findingBasis, nearFindingLine, nearMarkLine } from "../src/lib/review-converge-basis.js";

// i28-CONV6 acceptance 1: a near marker answers its first acceptance line; the strict readers answer exactly what they did before.
const NEAR: [string, number][] = [["[验收线 1、2;PM 定 4]", 1], ["[验收线 3;PM 定 7]", 3], ["[验收线 4；PM 记 06:26]", 4]];
const VOID = ["[验收线 3 不适用]", "[PM 定 4;验收线 3]", "[验收线 0;x]", "[验收线 1234;x]"];

describe("near markers", () => {
  test("labels, then ; ； , ， and a note: the first line counts", () => {
    for (const [mark, n] of NEAR) expect([mark, nearMarkLine(`P1 标题 ${mark} 说明`)]).toEqual([mark, n]);
    expect(nearMarkLine("【验收线 5，见规格 PM 定】")).toBe(5);
    expect(nearMarkLine("[acceptance 2 , PM note]")).toBe(2);
    expect(nearMarkLine("[验收线 2、回归;说明]")).toBe(2);
  });

  test("void spellings stay void", () => {
    for (const mark of VOID) expect([mark, nearMarkLine(mark)]).toEqual([mark, null]);
    for (const mark of ["[验收线 3、PM 定]", "[验收线 1;]", "[回归;说明]", "[7;说明]", "[验收线 3;7 处]", "[验收线 1;2", "无标记"]) {
      expect([mark, nearMarkLine(mark)]).toEqual([mark, null]);
    }
  });

  test("whole markers are never near (basisFromText already reads them)", () => {
    for (const mark of ["[验收线 2]", "[验收线 1;验收线 2]", "[验收线 1、2]", "[回归]"]) expect([mark, nearMarkLine(mark)]).toEqual([mark, null]);
    expect(nearMarkLine("[验收线 2] 然后 [验收线 5;PM 定 1]")).toBe(5);
  });

  test("basisFromText / findingBasis answer as before for every listed input", () => {
    for (const mark of [...NEAR.map(([m]) => m), ...VOID]) expect([mark, basisFromText(mark)]).toEqual([mark, null]);
    const f = { findingId: "F1", family: "merge-gate", probe: "src/a.ts:1", description: "[验收线 1、2;PM 定 4] 真 P1" };
    expect(findingBasis(f)).toBeNull();
    expect(nearFindingLine(f)).toBe(1);
    expect(nearFindingLine({ ...f, description: undefined, probe: "[验收线 3;PM 定 7] src/a.ts:1" })).toBe(3);
  });
});

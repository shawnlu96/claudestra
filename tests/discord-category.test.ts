import { describe, test, expect } from "bun:test";
import {
  CATEGORY_NAME_MAX,
  categoryInfos,
  categoryName,
  isParentFullError,
  overflowIndex,
  overflowNames,
  pickCategory,
  placeInCategory,
  renameCategoryFamily,
  type CategoryInfo,
  type CategoryOps,
} from "../src/lib/discord-category.js";

const cat = (id: string, name: string, children: number): CategoryInfo => ({ id, name, children });

describe("pickCategory", () => {
  const cases: Array<[string, CategoryInfo[], ReturnType<typeof pickCategory>]> = [
    ["空 guild → 建 base", [], { create: "proj" }],
    ["base 未满 → 用 base", [cat("a", "proj", 49)], { use: "a" }],
    ["base 满 → 建 base 2", [cat("a", "proj", 50)], { create: "proj 2" }],
    ["base 满、base 2 未满 → 用 base 2", [cat("a", "proj", 50), cat("b", "proj 2", 3)], { use: "b" }],
    ["全满 → 建下一个编号", [cat("a", "proj", 50), cat("b", "proj 2", 50), cat("c", "proj 3", 50)], { create: "proj 4" }],
    ["编号空洞：base 满、base 3 未满 → 先用 base 3", [cat("a", "proj", 50), cat("c", "proj 3", 10)], { use: "c" }],
    ["编号空洞且全满 → 补最小空号 base 2", [cat("a", "proj", 50), cat("c", "proj 3", 50)], { create: "proj 2" }],
    ["顺序按编号不按列表", [cat("c", "proj 3", 0), cat("b", "proj 2", 0), cat("a", "proj", 50)], { use: "b" }],
    ["base 不在、base 2 未满 → 用 base 2", [cat("b", "proj 2", 1)], { use: "b" }],
    [
      "相似名不算（base2 / base 2 旧 / base 02 / base 1 / 别的项目）",
      [cat("a", "proj", 50), cat("x", "proj2", 0), cat("y", "proj 2 旧", 0), cat("z", "proj 02", 0), cat("w", "proj 1", 0), cat("v", "projx 2", 0)],
      { create: "proj 2" },
    ],
    ["同名重复：第一个满了用第二个", [cat("a", "proj", 50), cat("a2", "proj", 7)], { use: "a2" }],
  ];
  for (const [name, cats, want] of cases) test(name, () => expect(pickCategory(cats, "proj")).toEqual(want));

  test("max 可调", () => {
    expect(pickCategory([cat("a", "proj", 5)], "proj", 5)).toEqual({ create: "proj 2" });
  });

  test("超长名截 base、保留后缀，且能被认回来", () => {
    const base = "很".repeat(120);
    const want = categoryName(base, 2);
    expect(want.length).toBe(CATEGORY_NAME_MAX);
    expect(want.endsWith(" 2")).toBe(true);
    expect(pickCategory([cat("a", base, 50)], base)).toEqual({ create: want });
    expect(pickCategory([cat("a", base, 50), cat("b", want, 0)], base)).toEqual({ use: "b" });
    expect(categoryName(base, 1)).toBe(base);
  });
});

describe("overflowIndex / overflowNames", () => {
  test("只认 base 与 base N(N≥2)", () => {
    expect(overflowIndex("proj", "proj")).toBe(1);
    expect(overflowIndex("proj", "proj 12")).toBe(12);
    for (const n of ["proj2", "proj 2 旧", "proj 02", "proj 1", "proj 0", "xproj 2", "proj  2"]) {
      expect(overflowIndex("proj", n)).toBeNull();
    }
  });

  test("列出全部溢出分类，按编号升序，不含 base 本身", () => {
    const cats = [cat("c", "proj 3", 0), cat("a", "proj", 0), cat("x", "proj2", 0), cat("b", "proj 2", 0)];
    expect(overflowNames("proj", cats)).toEqual([
      { id: "b", name: "proj 2", n: 2 },
      { id: "c", name: "proj 3", n: 3 },
    ]);
    expect(overflowNames("proj", [])).toEqual([]);
  });
});

describe("categoryInfos", () => {
  const chans = [
    { id: "cat1", name: "proj", type: 4, parentId: null },
    { id: "cat2", name: "proj 2", type: 4 },
    { id: "t1", name: "a", type: 0, parentId: "cat1" },
    { id: "t2", name: "b", type: 2, parentId: "cat1" },
    { id: "t3", name: "c", type: 0, parentId: "cat2" },
    { id: "t4", name: "d", type: 0, parentId: null },
  ];
  test("各类型频道都计入父分类", () => {
    expect(categoryInfos(chans)).toEqual([cat("cat1", "proj", 2), cat("cat2", "proj 2", 1)]);
  });
  test("excludeId 不计数", () => {
    expect(categoryInfos(chans, "t1")).toEqual([cat("cat1", "proj", 1), cat("cat2", "proj 2", 1)]);
  });
});

test("isParentFullError 认 Discord 表单错误码", () => {
  const msg = "Invalid Form Body\nparent_id[CHANNEL_PARENT_MAX_CHANNELS]: Maximum number of channels in category reached (50)";
  expect(isParentFullError(new Error(msg))).toBe(true);
  expect(isParentFullError(new Error("Missing Permissions"))).toBe(false);
  expect(isParentFullError("CHANNEL_PARENT_MAX_CHANNELS")).toBe(true);
});

function memOps(initial: CategoryInfo[]) {
  const cats = [...initial];
  const calls: string[] = [];
  const ops: CategoryOps = {
    list: () => cats.map((c) => ({ ...c })),
    create: async (name) => {
      calls.push(`create:${name}`);
      const c = cat(`new-${name}`, name, 0);
      cats.push(c);
      return c;
    },
    rename: async (id, name) => {
      calls.push(`rename:${id}:${name}`);
      const c = cats.find((x) => x.id === id);
      if (c) c.name = name;
    },
  };
  return { ops, cats, calls };
}

const fullErr = () => new Error("parent_id[CHANNEL_PARENT_MAX_CHANNELS]: Maximum number of channels in category reached (50)");

describe("placeInCategory", () => {
  test("撞上限只重选一次：缓存说没满、Discord 说满 → 换 base 2", async () => {
    const { ops, calls } = memOps([cat("a", "proj", 49)]);
    const tried: string[] = [];
    const id = await placeInCategory(ops, "proj", async (p) => {
      tried.push(p);
      if (p === "a") throw fullErr();
      return p;
    });
    expect(tried).toEqual(["a", "new-proj 2"]);
    expect(id).toBe("new-proj 2");
    expect(calls).toEqual(["create:proj 2"]);
  });

  test("第二次还撞 → 抛原错误，不再试", async () => {
    const { ops } = memOps([cat("a", "proj", 49)]);
    let n = 0;
    const second = fullErr();
    const p = placeInCategory(ops, "proj", async () => {
      n++;
      throw n === 1 ? fullErr() : second;
    });
    await expect(p).rejects.toBe(second);
    expect(n).toBe(2);
  });

  test("别的错误不重试", async () => {
    const { ops } = memOps([cat("a", "proj", 0)]);
    let n = 0;
    const err = new Error("Missing Permissions");
    await expect(placeInCategory(ops, "proj", async () => { n++; throw err; })).rejects.toBe(err);
    expect(n).toBe(1);
  });
});

describe("renameCategoryFamily", () => {
  test("base 与溢出分类一起改成新名 + 同一后缀，相似名不动", async () => {
    const { ops, cats, calls } = memOps([cat("a", "old", 50), cat("c", "old 3", 1), cat("x", "old2", 0)]);
    await renameCategoryFamily(ops, "old", "new");
    expect(calls).toEqual(["rename:a:new", "rename:c:new 3"]);
    expect(cats.map((c) => c.name)).toEqual(["new", "new 3", "old2"]);
  });

  test("新名已有分类 / 旧名不在 → 不改", async () => {
    const m1 = memOps([cat("a", "old", 0), cat("b", "new", 0)]);
    await renameCategoryFamily(m1.ops, "old", "new");
    expect(m1.calls).toEqual([]);
    const m2 = memOps([cat("c", "old 2", 0)]);
    await renameCategoryFamily(m2.ops, "old", "new");
    expect(m2.calls).toEqual([]);
  });
});

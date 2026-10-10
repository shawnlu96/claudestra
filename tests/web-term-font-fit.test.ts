/** 网页终端汉字补宽（web/features/terminal/term-font-fit.ts）：几个终端各用各的比例互不踩；加载乱序完成时过期的结果丢掉 */
import { afterAll, beforeEach, expect, test } from "bun:test";

type Pending = { family: string; resolve: () => void; reject: (e: Error) => void };
const pending: Pending[] = [];
const added = new Set<string>(), deleted: string[] = [];

class FakeFace {
  constructor(public family: string) {}
  load(): Promise<FakeFace> {
    return new Promise((res, rej) => pending.push({ family: this.family, resolve: () => res(this), reject: rej }));
  }
}
// 同一进程里别的测试文件也看 globalThis：测完还原
const saved = { FontFace: (globalThis as any).FontFace, document: (globalThis as any).document };
afterAll(() => void Object.assign(globalThis, saved));
Object.assign(globalThis, {
  FontFace: FakeFace,
  document: { fonts: { add: (f: FakeFace) => added.add(f.family), delete: (f: FakeFace) => deleted.push(f.family) } },
});
// 路径放变量里：模块是 DOM 代码（FontFace / xterm 类型），别让根 tsconfig（无 dom lib）跟进去检查，web 侧 tsc 管它
const MOD = "../web/features/terminal/term-font-fit";
const { fitCjkGlyphs } = await import(MOD);

/** 一个终端：列数 + 屏宽决定格宽，字号 10 → 放大比例 = (2 × 格宽 − 1) / 10 */
function term(width: number, cols = 10) {
  const t = { cols, options: { fontSize: 10, fontFamily: "Menlo, monospace" } };
  return { t: t as any, box: { querySelector: () => ({ offsetWidth: width }) } as any };
}
const settle = async (family: string, ok = true) => {
  const p = pending.find((x) => x.family === family)!;
  pending.splice(pending.indexOf(p), 1);
  if (ok) p.resolve(); else p.reject(new Error("no font"));
  await new Promise((r) => setTimeout(r, 0));
};

beforeEach(() => void (pending.length = 0));

test("两个终端不同比例：各自换上自己的 face，先加载的不被删", async () => {
  const a = term(60), b = term(70); // 格宽 6 → 110%；7 → 130%
  const pa = fitCjkGlyphs(a.t, a.box), pb = fitCjkGlyphs(b.t, b.box);
  await settle("term-cjk-110");
  await settle("term-cjk-130");
  await Promise.all([pa, pb]);
  expect(a.t.options.fontFamily).toBe('"term-cjk-110", Menlo, monospace');
  expect(b.t.options.fontFamily).toBe('"term-cjk-130", Menlo, monospace');
  expect(deleted).toEqual([]);
  expect([...added]).toEqual(expect.arrayContaining(["term-cjk-110", "term-cjk-130"]));
  // 同比例再调：已是这个 face，不重复加载
  await fitCjkGlyphs(a.t, a.box);
  expect(pending).toEqual([]);
});

test("同一终端加载乱序完成：后发的先到就用它，先发的晚到被丢掉", async () => {
  const x = term(80); // 150%
  const first = fitCjkGlyphs(x.t, x.box);
  x.box.querySelector = () => ({ offsetWidth: 90 }); // 屏变宽：170%
  const second = fitCjkGlyphs(x.t, x.box);
  await settle("term-cjk-170");
  await settle("term-cjk-150");
  await Promise.all([first, second]);
  expect(x.t.options.fontFamily).toBe('"term-cjk-170", Menlo, monospace');
});

test("加载失败不缓存：下次同比例重试", async () => {
  const y = term(100); // 190%
  const p = fitCjkGlyphs(y.t, y.box);
  await settle("term-cjk-190", false);
  await p;
  expect(y.t.options.fontFamily).toBe("Menlo, monospace");
  const again = fitCjkGlyphs(y.t, y.box);
  await settle("term-cjk-190");
  await again;
  expect(y.t.options.fontFamily).toBe('"term-cjk-190", Menlo, monospace');
});

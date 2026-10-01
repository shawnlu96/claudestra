/**
 * 借入 peer 的「同时最多跑几单」（i28-R7d）：输入框的解析与夹取、−/+ 连点合并成一次保存、「对方只开了 M 个」徽章、
 * 嵌框整句的拆分；以及借入 / 出借两个区与 peer 卡上不再只写「借入」「出借」「上限」。
 */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import type { PeerView } from "@/features/borrow/borrow-api";
import { BOX, coalescer, grantedSlots, lenderCap, parseMaxOpen, serialLatest, splitAtBox, type Timers } from "@/features/borrow/borrow-model";
import { fillParams } from "@/lib/i18n-fill";
import { BORROW_DICT } from "@/lib/i18n-dict-borrow";

describe("输入框里的上限", () => {
  test("合法值原样", () => {
    expect(parseMaxOpen("20", 20)).toEqual({ value: 20, clamped: false });
    expect(parseMaxOpen(" 7 ", 20)).toEqual({ value: 7, clamped: false });
    expect(parseMaxOpen("１２", 20)).toEqual({ value: 12, clamped: false }); // 中文输入法的全角数字
  });
  test("越界夹到 1..limit，并标出夹过（界面抖一下）", () => {
    expect(parseMaxOpen("0", 20)).toEqual({ value: 1, clamped: true });
    expect(parseMaxOpen("21", 20)).toEqual({ value: 20, clamped: true });
    expect(parseMaxOpen("99999999999999999999", 20)).toEqual({ value: 20, clamped: true });
  });
  test("空值、非数字、负数、小数 → null（退回原值，不存）", () => {
    for (const raw of ["", "   ", "abc", "1e3", "-3", "2.5", "3单", "0x10"]) expect(parseMaxOpen(raw, 20)).toBeNull();
  });
  test("任何输入都存不出 1..20 以外的值", () => {
    for (const raw of ["0", "21", "", "x", "-1", "100", "1", "20"]) {
      const p = parseMaxOpen(raw, 20);
      if (p) expect(p.value >= 1 && p.value <= 20 && Number.isInteger(p.value)).toBe(true);
    }
  });
});

/** 假时钟：set 记下回调，advance 到点就跑 */
function fakeTimers() {
  let now = 0;
  let seq = 0;
  const due = new Map<number, { at: number; fn: () => void }>();
  const timers = {
    set: (fn: () => void, ms: number) => (due.set(++seq, { at: now + ms, fn }), seq),
    clear: (id: number) => void due.delete(id),
  } as unknown as Timers;
  const advance = (ms: number) => {
    now += ms;
    for (const [id, t] of [...due]) if (t.at <= now) (due.delete(id), t.fn());
  };
  return { timers, advance };
}

describe("−/+ 连点合并成一次保存", () => {
  test("连点 + 5 下（间隔 < 600ms）只存 1 次，存的是最后的值", () => {
    const { timers, advance } = fakeTimers();
    const saved: number[] = [];
    const c = coalescer<number>(600, (n) => saved.push(n), timers);
    for (let n = 13; n <= 17; n++) {
      c.push(n);
      advance(200);
    }
    expect(saved).toEqual([]);
    advance(599);
    expect(saved).toEqual([17]);
    advance(5000);
    expect(saved).toEqual([17]);
  });
  test("停手超过 600ms 再点算新的一次", () => {
    const { timers, advance } = fakeTimers();
    const saved: number[] = [];
    const c = coalescer<number>(600, (n) => saved.push(n), timers);
    c.push(4);
    advance(600);
    c.push(5);
    advance(600);
    expect(saved).toEqual([4, 5]);
  });
  test("flush 立刻交出（卸载、改用输入框前），之后不再重复；cancel 丢掉", () => {
    const { timers, advance } = fakeTimers();
    const saved: number[] = [];
    const c = coalescer<number>(600, (n) => saved.push(n), timers);
    c.push(8);
    c.flush();
    c.flush();
    advance(1000);
    expect(saved).toEqual([8]);
    c.push(9);
    c.cancel();
    advance(1000);
    expect(saved).toEqual([8]);
  });
});

const ticks = async () => {
  for (let k = 0; k < 10; k++) await Promise.resolve();
};

/** 可控的「写 lend.json」：每次写返回一个手动 resolve / reject 的 Promise，按完成顺序落盘 */
function fakeStore(initial: number) {
  const state = { value: initial, started: [] as number[], latestDone: [] as number[] };
  const gates: { v: number; ok: () => void; fail: () => void }[] = [];
  const submit = serialLatest<number>(async (v, isLatest) => {
    state.started.push(v);
    await new Promise<void>((ok, fail) => gates.push({ v, ok, fail: () => fail(new Error("409")) }));
    state.value = v;
    if (isLatest()) state.latestDone.push(v);
  });
  const settle = async (i: number, ok = true) => {
    await ticks();
    (ok ? gates[i]!.ok : gates[i]!.fail)();
    await ticks();
  };
  return { state, submit, settle, gates };
}

describe("同一 peer 的保存串行、最后提交的赢", () => {
  test("微调 flush 出 13 在飞时又输入 20：20 等 13 写完才写，最后是 20（不会被 13 盖掉）", async () => {
    const { state, submit, settle } = fakeStore(12);
    const a = submit(13);
    await ticks(); // 13 已经发出去了，用户这才输完 20 回车
    const b = submit(20);
    await ticks();
    expect(state.started).toEqual([13]); // 不并发：20 还没开始
    await settle(0);
    expect(state.value).toBe(13);
    expect(state.started).toEqual([13, 20]);
    await settle(1);
    await Promise.all([a, b]);
    expect(state.value).toBe(20);
    expect(state.latestDone).toEqual([20]); // 只有最后一次收尾（清 draft / busy）
  });
  test("还没发出就被更新的值顶掉：只写最后那个", async () => {
    const { state, submit, settle } = fakeStore(5);
    void submit(6);
    void submit(7);
    await settle(0);
    expect(state.started).toEqual([7]);
    expect(state.value).toBe(7);
  });
  test("在飞时又连着提交两次：中间那个被顶掉不写", async () => {
    const { state, submit, settle } = fakeStore(5);
    void submit(6);
    await ticks();
    void submit(7);
    void submit(8);
    await settle(0);
    await settle(1);
    expect(state.started).toEqual([6, 8]);
    expect(state.value).toBe(8);
  });
  test("前一个失败不卡住队列，后一个照写", async () => {
    const { state, submit, settle } = fakeStore(5);
    const warn = console.warn;
    console.warn = () => {};
    try {
      void submit(9);
      await ticks();
      const last = submit(10);
      await settle(0, false);
      await settle(1);
      await last;
      expect(state.value).toBe(10);
    } finally {
      console.warn = warn;
    }
  });
});

const reported = (codex: number, claude = 0): Pick<PeerView, "reported"> => ({ reported: { codex: { total: codex, busy: 0 }, claude: { total: claude, busy: 0 } } });

describe("对方只开了 M 个", () => {
  test("对方名额 = 各家族 total 相加；没上报 → null", () => {
    expect(grantedSlots(reported(3))).toBe(3);
    expect(grantedSlots(reported(2, 5))).toBe(7);
    expect(grantedSlots({ reported: null })).toBeNull();
  });
  test("名额小于上限才显示 M", () => {
    expect(lenderCap(reported(3), 12)).toBe(3);
    expect(lenderCap(reported(0), 2)).toBe(0);
    expect(lenderCap(reported(3, 4), 12)).toBe(7);
  });
  test("名额不小于上限、或没上报 → 不显示", () => {
    expect(lenderCap(reported(12), 12)).toBeNull();
    expect(lenderCap(reported(20), 12)).toBeNull();
    expect(lenderCap(reported(6, 6), 12)).toBeNull(); // 单看哪家都不够，加起来够

    expect(lenderCap({ reported: null }, 12)).toBeNull();
  });
});

describe("嵌框整句", () => {
  const KEY = "{name} 的电脑：同时最多跑 {box} 单";
  test("中英文都恰好一个框，名字在句里", () => {
    for (const s of [KEY, BORROW_DICT[KEY]!]) {
      for (const n of [1, 12]) {
        const filled = fillParams(s, { name: "Sekai-MacBook", n, box: BOX });
        expect(filled.split(BOX).length).toBe(2);
        expect(filled).toContain("Sekai-MacBook");
      }
    }
  });
  test("拆成框前、框后", () => {
    expect(splitAtBox(fillParams(KEY, { name: "lab-box", box: BOX }))).toEqual(["lab-box 的电脑：同时最多跑", "单"]);
    expect(splitAtBox(fillParams(BORROW_DICT[KEY]!, { name: "lab-box", n: 1, box: BOX }))).toEqual(["On lab-box's machine, run up to", "order at a time"]);
    expect(splitAtBox("no box")).toEqual(["no box", ""]);
  });
});

describe("文案写明方向", () => {
  const code = (p: string) => readFileSync(new URL(`../web/${p}`, import.meta.url), "utf8");
  const LEND_WORDS = code("features/lend/lend-i18n.ts");
  test("两个区的标题写出方向，中英文都有", () => {
    expect(code("features/borrow/borrow-panel.tsx")).toContain('t("借别人的电脑跑我的活")');
    expect(BORROW_DICT["借别人的电脑跑我的活"]).toBe("Borrow others' machines");
    expect(code("features/lend/lend-panel.tsx")).toContain('t("把我的电脑借给别人")');
    expect(LEND_WORDS).toContain('"把我的电脑借给别人": "Lend my machine"');
  });
  test("界面上不再只写「借入」「出借」「上限」", () => {
    const shown = [code("features/borrow/borrow-panel.tsx"), code("features/borrow/borrow-bits.tsx"), code("features/borrow/borrow-peer-card.tsx"), code("features/lend/lend-panel.tsx")]
      .join("\n")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|\s)\/\/.*$/gm, "$1");
    for (const w of ["借入", "出借", "上限"]) expect(shown).not.toContain(`t("${w}")`);
    for (const w of ["借入", "出借", "上限"]) expect(Object.keys(BORROW_DICT)).not.toContain(w);
    expect(LEND_WORDS).not.toContain('"出借":');
    expect(Object.values(BORROW_DICT).join("\n")).not.toMatch(/^(Borrow|Max|Lending)$/m);
  });
});

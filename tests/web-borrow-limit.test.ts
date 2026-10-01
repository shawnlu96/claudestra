/**
 * 借入 peer 的「同时最多跑几单」（i28-R7d）：输入框的解析与夹取、按 peer 的保存器（连点合并、跨卡片最后提交的赢、删后不复活）、「对方只开了 M 个」徽章、
 * 嵌框整句的拆分；以及借入 / 出借两个区与 peer 卡上不再只写「借入」「出借」「上限」。
 */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import type { PeerView } from "@/features/borrow/borrow-api";
import { afterSave, BOX, grantedSlots, lenderCap, parseMaxOpen, peerSaver, splitAtBox, type Timers } from "@/features/borrow/borrow-model";
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

const ticks = async () => {
  for (let k = 0; k < 10; k++) await Promise.resolve();
};

type Op = { kind: "put" | "del"; peer: string; v?: number };
/** 可控的 bridge：每个 PUT / DELETE 挂起，按下标手动放行（ok）或打回（fail）；store 是按完成顺序落盘的 lend.json */
function fakeBridge() {
  const store = new Map<string, number>([["lab-box", 12]]);
  const ops: Op[] = [];
  const gates: { ok: () => void; fail: () => void }[] = [];
  const hold = (op: Op, apply: () => void) => {
    ops.push(op);
    return new Promise<void>((ok, fail) => gates.push({ ok: () => (apply(), ok()), fail: () => fail(new Error("409")) }));
  };
  const io = {
    put: (peer: string, v: number) => hold({ kind: "put", peer, v }, () => store.set(peer, v)),
    del: (peer: string) => hold({ kind: "del", peer }, () => store.delete(peer)),
  };
  const settle = async (i: number, ok = true) => {
    await ticks();
    (ok ? gates[i]!.ok : gates[i]!.fail)();
    await ticks();
  };
  return { store, ops, io, settle };
}

function rig() {
  const { timers, advance } = fakeTimers();
  const b = fakeBridge();
  const saver = peerSaver<string, number>(b.io, (peer) => peer, timers);
  /** 一张卡：after 记下它收尾时拿到的结果（只有最后一次提交才收尾） */
  const card = () => {
    const ends: boolean[] = [];
    return { ends, save: (v: number, delayMs = 0) => saver.save("lab-box", v, (ok) => void ends.push(ok), delayMs) };
  };
  return { ...b, saver, advance: async (ms: number) => (advance(ms), await ticks()), card };
}
const puts = (ops: Op[]) => ops.filter((o) => o.kind === "put").map((o) => o.v);

describe("−/+ 连点合并成一次保存", () => {
  test("连点 + 5 下（间隔 < 600ms）只存 1 次，存的是最后的值", async () => {
    const r = rig();
    const c = r.card();
    for (let n = 13; n <= 17; n++) {
      c.save(n, 600);
      await r.advance(200);
    }
    expect(r.ops).toEqual([]);
    await r.advance(599);
    expect(puts(r.ops)).toEqual([17]);
    await r.settle(0);
    await r.advance(5000);
    expect(puts(r.ops)).toEqual([17]);
    expect(r.store.get("lab-box")).toBe(17);
    expect(c.ends).toEqual([true]);
  });
  test("停手超过 600ms 再点算新的一次", async () => {
    const r = rig();
    const c = r.card();
    c.save(4, 600);
    await r.advance(600);
    await r.settle(0);
    c.save(5, 600);
    await r.advance(600);
    expect(puts(r.ops)).toEqual([4, 5]);
  });
  test("点完 + 就关了设置（卡片卸载）：计时在模块里，照样存", async () => {
    const r = rig();
    r.card().save(13, 600); // 这张卡随后卸载，没有任何 flush
    await r.advance(600);
    await r.settle(0);
    expect(r.store.get("lab-box")).toBe(13);
  });
  test("停手前改用输入框回车 20：只存 20，微调的 13 作废", async () => {
    const r = rig();
    const c = r.card();
    c.save(13, 600);
    await r.advance(100);
    c.save(20);
    await r.settle(0);
    await r.advance(5000);
    expect(puts(r.ops)).toEqual([20]);
    expect(r.store.get("lab-box")).toBe(20);
  });
});

describe("同一 peer 跨卡片串行、最后提交的赢", () => {
  test("卸载后重新挂载：旧卡在飞的 13 不会盖掉新卡输入的 20", async () => {
    const r = rig();
    const old = r.card();
    old.save(13, 600);
    await r.advance(600); // 旧卡已卸载，PUT 13 在飞
    const fresh = r.card(); // 重新打开设置，新卡
    fresh.save(20);
    await ticks();
    expect(puts(r.ops)).toEqual([13]); // 不并发：20 等 13 写完
    await r.settle(0);
    await r.settle(1);
    expect(puts(r.ops)).toEqual([13, 20]);
    expect(r.store.get("lab-box")).toBe(20);
    expect(old.ends).toEqual([]); // 旧卡不收尾
    expect(fresh.ends).toEqual([true]);
  });
  test("在飞时连发多次：中间被顶掉不写，最后一次生效", async () => {
    const r = rig();
    const c = r.card();
    c.save(6);
    await ticks();
    c.save(7);
    c.save(8);
    c.save(9);
    await r.settle(0);
    await r.settle(1);
    expect(puts(r.ops)).toEqual([6, 9]);
    expect(r.store.get("lab-box")).toBe(9);
    expect(c.ends).toEqual([true]);
  });
  test("前一个失败不卡住队列，后一个照写；最后一次失败才收尾成 false（回弹 + 抖）", async () => {
    const r = rig();
    const warn = console.warn;
    console.warn = () => {};
    try {
      const c = r.card();
      c.save(9);
      await ticks();
      c.save(10);
      await r.settle(0, false);
      await r.settle(1, false);
      expect(puts(r.ops)).toEqual([9, 10]);
      expect(c.ends).toEqual([false]);
      expect(r.store.get("lab-box")).toBe(12);
    } finally {
      console.warn = warn;
    }
  });
  test("不同 peer 互不排队", async () => {
    const r = rig();
    r.saver.save("a", 1);
    r.saver.save("b", 2);
    await ticks();
    expect(r.ops.map((o) => o.peer)).toEqual(["a", "b"]);
  });
});

describe("上一次的刷新还没回来就又点了（卡片收尾 afterSave）", () => {
  test("12 → + 存 13，刷新挂起时再快点 + 五下：旧收尾不清新 draft，最后存 18 不是 17", async () => {
    const r = rig();
    const card = { draft: null as number | null };
    const reloads: (() => void)[] = [];
    let shown = 12; // 卡片显示 = draft ?? 刷新拿到的服务端值
    const after = afterSave({
      reload: () => new Promise<void>((done) => reloads.push(() => ((shown = r.store.get("lab-box")!), done()))),
      ok: () => undefined,
      fail: () => undefined,
      settle: () => void (card.draft = null),
    });
    const plus = () => {
      card.draft = (card.draft ?? shown) + 1;
      r.saver.save("lab-box", card.draft, after, 600);
    };
    plus();
    await r.advance(600);
    await r.settle(0); // PUT 13 写完，刷新还挂着
    plus(); // 14
    reloads.shift()!(); // 旧刷新回来（服务端 13）
    await ticks();
    expect(card.draft).toBe(14); // 旧收尾已不是最新，不清 draft
    for (let k = 0; k < 4; k++) plus();
    await r.advance(600);
    await r.settle(1);
    reloads.shift()!();
    await ticks();
    expect(puts(r.ops)).toEqual([13, 18]);
    expect(card.draft).toBeNull(); // 最后一次收尾
  });
  test("失败只抖、最新才收尾", async () => {
    const calls: string[] = [];
    const after = afterSave({ reload: async () => void calls.push("reload"), ok: () => void calls.push("ok"), fail: () => void calls.push("fail"), settle: () => void calls.push("settle") });
    await after(false, () => true);
    await after(true, () => false);
    expect(calls).toEqual(["fail", "settle", "reload", "ok"]);
  });
});

describe("删除和还没发出的微调交错：删掉的 peer 不复活", () => {
  test("点 + 后 600ms 内删除：微调作废，只发 DELETE；之后旧卡的保存一律丢掉", async () => {
    const r = rig();
    const c = r.card();
    c.save(13, 600);
    await r.advance(100);
    const del = r.saver.remove("lab-box");
    await r.settle(0);
    await del;
    await r.advance(5000); // 原来的停手计时到点
    c.save(14); // 已卸载的旧卡再交一次（任何路径）
    c.save(15, 600);
    await r.advance(5000);
    expect(r.ops).toEqual([{ kind: "del", peer: "lab-box" }]);
    expect(r.store.has("lab-box")).toBe(false);
  });
  test("PUT 在飞时删除：等它写完再 DELETE，DELETE 最后落下", async () => {
    const r = rig();
    r.card().save(13);
    await ticks();
    const del = r.saver.remove("lab-box");
    await ticks();
    expect(r.ops.map((o) => o.kind)).toEqual(["put"]);
    await r.settle(0);
    await r.settle(1);
    await del;
    expect(r.ops.map((o) => o.kind)).toEqual(["put", "del"]);
    expect(r.store.has("lab-box")).toBe(false);
  });
  test("删除失败：peer 还在，之后的保存照常写", async () => {
    const r = rig();
    const warn = console.warn;
    console.warn = () => {};
    try {
      const del = r.saver.remove("lab-box");
      await r.settle(0, false);
      expect(await del.then(() => "ok", () => "fail")).toBe("fail");
      r.card().save(7);
      await r.settle(1);
      expect(r.store.get("lab-box")).toBe(7);
    } finally {
      console.warn = warn;
    }
  });
  test("删后重新添加（create）：恢复保存", async () => {
    const r = rig();
    const del = r.saver.remove("lab-box");
    await r.settle(0);
    await del;
    const add = r.saver.create("lab-box", 3);
    await r.settle(1);
    await add;
    r.card().save(4);
    await r.settle(2);
    expect(r.store.get("lab-box")).toBe(4);
    expect(r.ops.map((o) => o.kind)).toEqual(["del", "put", "put"]);
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

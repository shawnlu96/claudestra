/**
 * lib/arrival-order.ts 与 bridge/turn-cuts.ts 的叫停记录（T13f）：先后只比到达序号；序号落盘、重启接着涨；
 * 终端里的事件晚两秒读到，按会话记录时刻回推位置：和 bridge 事件同一毫秒拿不准时判「停」在后；两条终端事件之间按时刻再按行序。
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArrivalOrder, isAfter, laterOf, type SeqFile } from "../src/lib/arrival-order.js";
import { arrivalSeqVerdict } from "../src/lib/doctor-arrival.js";
import { HeldQueue } from "../src/bridge/held-queue.js";
import type { Envelope } from "../src/bridge/router.js";
import { TurnCuts } from "../src/bridge/turn-cuts.js";
import type { ProgramInput } from "../src/lib/program-input.js";

const T0 = Date.parse("2026-09-30T08:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const tmp = (name: string) => join(mkdtempSync(join(tmpdir(), "arrival-")), name);
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("ArrivalOrder", () => {
  test("同一毫秒连领：严格递增；isAfter 只看号", () => {
    const o = new ArrivalOrder(null, () => T0);
    const [a, b, c] = [o.order(), o.order(), o.order()];
    expect(a.seq < b.seq && b.seq < c.seq).toBe(true);
    expect(isAfter(b, a)).toBe(true);
    expect(isAfter(a, b)).toBe(false);
    expect(isAfter(a, { ...a })).toBe(false);
    expect(laterOf(c, a)).toBe(c);
    expect(laterOf(undefined, a)).toBe(a);
  });

  test("落盘：重启后接着涨，哪怕时钟往回拨了", () => {
    const path = tmp("seq.json");
    const first = new ArrivalOrder(path, () => T0);
    const last = [1, 2, 3].map(() => first.take()).pop()!;
    const again = new ArrivalOrder(path, () => T0 - 3_600_000);
    expect(again.take()).toBeGreaterThan(last);
  });

  test("号文件丢了：按启动时刻起号，仍比上次运行领过的大", () => {
    const path = tmp("seq.json");
    const first = new ArrivalOrder(path, () => T0);
    const last = first.take();
    rmSync(path);
    expect(new ArrivalOrder(path, () => T0 + 1_000).take()).toBeGreaterThan(last);
  });

  test("终端事件回推：排在它那一刻之前到的之后；同一毫秒到的，停排在后、不是停排在前", () => {
    let now = T0;
    const o = new ArrivalOrder(null, () => now);
    const a = o.order();
    now = T0 + 1_000;
    const b = o.order();
    const stopAtB = o.backdate(T0 + 1_000, true);
    const goAtB = o.backdate(T0 + 1_000, false);
    expect(isAfter(stopAtB, b)).toBe(true);
    expect(isAfter(b, goAtB)).toBe(true);
    const mid = o.backdate(T0 + 500, false);
    expect(isAfter(mid, a) && isAfter(b, mid)).toBe(true);
    expect(isAfter(o.backdate(T0 + 600, true), mid)).toBe(true); // 同一段里的两条终端事件按时刻排
    expect(isAfter(goAtB, stopAtB)).toBe(true); // 两条终端事件之间按会话记录的先后（同一毫秒按行序），不看回推落点（P2-1）
  });
});

function book(path: string | null = null, keys: () => Promise<ProgramInput[]> = async () => []) {
  let now = T0;
  const b = new TurnCuts(path, () => now, keys);
  return { b, tick: (ms: number) => void (now += ms), at: () => now };
}
const stop = (b: TurnCuts, stopOrder = b.arrivals.order()) => b.record({ channelId: "ch", agent: "a", cause: "stopword", tools: { inflight: [] }, stopOrder });
const interrupted = (at: number) => ({ type: "turn_interrupted", ts: iso(at + 2_000), data: { ts: iso(at) }, chatId: "ch", agent: "a" });
const typed = (at: number, isStop = false) => ({ type: "terminal_input", ts: iso(at + 2_000), data: { stop: isStop, ts: iso(at) }, chatId: "ch", agent: "a" });

describe("叫停记录按到达序号", () => {
  test("停字收尾一拍里 owner 又说了一句（到达号更大）：记停时直接带上解除", () => {
    const { b } = book();
    const heard = b.arrivals.order();
    b.noteHuman("ch", false);
    stop(b, heard);
    expect(b.interruptHold("ch")).toBeNull();
  });

  test("早到的旧停不盖掉后到的新停", () => {
    const { b } = book();
    const old = b.arrivals.order();
    b.noteHuman("ch", false);
    const newer = b.arrivals.order();
    stop(b, newer);
    stop(b, old);
    expect(b.stopMark("ch")?.order).toEqual(newer);
    expect(b.interruptHold("ch")).toBe("stopped");
  });

  test("重启：owner 在押住的旧停之后开过口，从盘上认得（T13e r1 P1-1 重启版）", () => {
    const path = tmp("cuts.json");
    const a = book(path);
    const held = a.b.arrivals.order();
    stop(a.b, held);
    a.b.noteHuman("ch", false);
    const again = book(path).b;
    expect(again.spokeAfter("ch", held)).toBe(true);
    stop(again, held); // 旧停出队再记一次：不重新挂起
    expect(again.interruptHold("ch")).toBeNull();
  });

  test("重启前的停，重启后 owner 开口能解开（新号一定更大）", () => {
    const path = tmp("cuts.json");
    stop(book(path).b);
    const again = book(path).b;
    expect(again.interruptHold("ch")).toBe("stopped");
    again.noteHuman("ch", false);
    expect(again.interruptHold("ch")).toBeNull();
  });

  test("老版本落的叫停记录没有序号：之后的开口照样解除", () => {
    const path = tmp("cuts.json");
    writeFileSync(path.replace(/\.json$/, "-stops.json"), JSON.stringify({ ch: { at: T0 - 1_000 } }));
    const { b } = book(path);
    expect(b.interruptHold("ch")).toBe("stopped");
    b.noteHuman("ch", false);
    expect(b.interruptHold("ch")).toBeNull();
  });
});

describe("终端里的事件晚读到（wf2 stop-semantics-4）", () => {
  test("终端里按的 Esc 读到之前，owner 在网页说了继续：记停时带上解除，不卡到再开口", async () => {
    const slowKeys = async (): Promise<ProgramInput[]> => (await Bun.sleep(20), []);
    const { b, tick } = book(null, slowKeys);
    tick(1_000);
    b.noteHuman("ch", false); // 网页「继续」T0+1s 到
    tick(1_000);
    b.onEvent(interrupted(T0)); // T0 那一下 Esc，T0+2s 才读到
    await Bun.sleep(40);
    expect(b.get("ch")?.cause).toBe("terminal");
    expect(b.interruptHold("ch")).toBeNull();
  });

  test("对照：Esc 之后没再开口 → 停着", async () => {
    const { b, tick } = book();
    tick(2_000);
    b.onEvent(interrupted(T0));
    await flush();
    expect(b.interruptHold("ch")).toBe("stopped");
  });

  test("「停」之前的终端输入晚读到，不能解开之后才到的停", async () => {
    const { b, tick } = book();
    tick(1_000);
    stop(b); // T0+1s 网页「停」
    tick(1_000);
    b.onEvent(typed(T0)); // T0 在终端里敲的，T0+2s 才读到
    await flush();
    expect(b.interruptHold("ch")).toBe("stopped");
  });
});

describe("终端里同一毫秒的两行（T13f r1 P2-1）", () => {
  test("先按 Esc、同一毫秒又敲了一句（两行都记在 T）：按读到的行序，后一行解除前一行的停；同一毫秒有没有 bridge 事件都一样", async () => {
    for (const bridgeAtT of [false, true]) {
      const { b, tick, at } = book();
      const T = at();
      if (bridgeAtT) b.arrivals.take(); // 同一毫秒 bridge 也领过号：停和不是停的回推落点不同，不能拿 seq 比
      tick(2_000);
      b.onEvent(interrupted(T));
      b.onEvent(typed(T));
      await Bun.sleep(5);
      expect(b.get("ch")?.cause).toBe("terminal");
      expect(b.interruptHold("ch")).toBeNull();
    }
  });

  test("反过来：先敲一句、同一毫秒再按 Esc → 停着；更早的一行晚读到也盖不过更晚的停", async () => {
    const { b, tick, at } = book();
    const T = at();
    tick(2_000);
    b.onEvent(typed(T));
    b.onEvent(interrupted(T));
    await Bun.sleep(5);
    expect(b.interruptHold("ch")).toBe("stopped");
    b.onEvent(typed(T - 1)); // 更早那一刻的输入，这时才读到
    await flush();
    expect(b.interruptHold("ch")).toBe("stopped");
  });

  test("行序跟着叫停记录落盘：重启后同一毫秒的下一行照样认得先后", async () => {
    const path = tmp("cuts.json");
    const { b, tick, at } = book(path);
    const T = at();
    tick(2_000);
    b.onEvent(interrupted(T));
    await Bun.sleep(5);
    const saved = JSON.parse(readFileSync(path.replace(/\.json$/, "-stops.json"), "utf-8")).ch;
    expect(saved).toMatchObject({ t: T, n: expect.any(Number) });
  });
});

describe("号不倒退（T13f r1 P2-2）", () => {
  test("号文件丢了、时钟又往回拨：盘上叫停记录的号垫底，重启后 owner 开口照样解除", () => {
    const path = tmp("cuts.json");
    stop(book(path).b);
    rmSync(path.replace(/\.json$/, "-seq.json"));
    const again = new TurnCuts(path, () => T0 - 3_600_000);
    expect(again.interruptHold("ch")).toBe("stopped");
    again.noteHuman("ch", false);
    expect(again.interruptHold("ch")).toBeNull();
  });

  test("押着的消息的号也垫底（bridge.ts 启动时）", () => {
    const q = new HeldQueue(null);
    const env = { to: { kind: "local", channelId: "ch" }, meta: { arrivalSeq: (T0 + 3_600_000) * 1_000 } } as unknown as Envelope; // 时钟往回拨了一小时
    q.holdEnv(env);
    const o = new ArrivalOrder(null, () => T0);
    o.atLeast(q.maxArrivalSeq());
    expect(o.take()).toBeGreaterThan((T0 + 3_600_000) * 1_000);
  });

  test("两个 bridge 写同一份号文件：后发现的一方跳过对方预留的号，记下来；doctor 一天内报 warn", () => {
    const path = tmp("seq.json");
    const a = new ArrivalOrder(path, () => T0);
    const b = new ArrivalOrder(path, () => T0);
    const fromA = a.take();
    const fromB = b.take();
    expect(fromB).toBeGreaterThanOrEqual(fromA + 1_000);
    const file = JSON.parse(readFileSync(path, "utf-8")) as SeqFile;
    expect(file.foreign?.at).toBe(T0);
    expect(arrivalSeqVerdict(file, T0 + 60_000)[0]).toMatchObject({ status: "warn", name: "到达序号" });
    expect(arrivalSeqVerdict(file, T0 + 2 * 86_400_000)).toEqual([]);
    expect(arrivalSeqVerdict({ ceiling: 1 }, T0)).toEqual([]);
  });
});

describe("盘上写坏的号不卡死（T13f r2 P2-1）", () => {
  const increasing = (o: ArrivalOrder) => {
    const [a, b] = [o.take(), o.take()];
    return Number.isSafeInteger(a) && b > a;
  };

  test("号文件的上限是 1e300：当读不了，按启动时刻起号，号照样递增", () => {
    const path = tmp("seq.json");
    writeFileSync(path, JSON.stringify({ ceiling: 1e300 }));
    expect(increasing(new ArrivalOrder(path, () => T0))).toBe(true);
  });

  test("垫底给了 NaN / 1e300 / 2^53 / 字符串：跳过，号照样递增", () => {
    const o = new ArrivalOrder(null, () => T0);
    for (const bad of [NaN, 1e300, 2 ** 53, "5" as unknown as number]) o.atLeast(bad);
    expect(increasing(o)).toBe(true);
  });

  test("叫停记录里停和开口的号是 1e300：坏的去掉并写回盘，之后 owner 开口照样解除", () => {
    const path = tmp("cuts.json");
    const stops = path.replace(/\.json$/, "-stops.json");
    writeFileSync(stops, JSON.stringify({ ch: { at: T0, seq: 1e300 }, ch2: { at: T0, seq: 5, go: { seq: 1e300 } } }));
    const { b } = book(path);
    expect(b.interruptHold("ch")).toBe("stopped");
    expect(b.interruptHold("ch2")).toBe("stopped"); // 坏的开口不算解除
    b.noteHuman("ch", false);
    expect(b.interruptHold("ch")).toBeNull();
    expect(JSON.parse(readFileSync(stops, "utf-8")).ch2.go).toBeUndefined();
  });

  test("押后队列里的到达号是 1e300 / 字符串：去掉并写回盘，垫底只看好的", () => {
    const path = tmp("held.json");
    const item = (seq: unknown) => ({ env: { to: { kind: "local", channelId: "ch" }, from: { kind: "api" }, meta: { arrivalSeq: seq } }, to: { channelId: "ch" }, heldAt: T0 });
    writeFileSync(path, JSON.stringify({ ch: [item(1e300), item("7"), item(42)] }));
    const q = new HeldQueue(path);
    expect(q.maxArrivalSeq()).toBe(42);
    expect(q.get("ch")?.map((i) => i.env.meta.arrivalSeq)).toEqual([undefined, undefined, 42]);
    expect(JSON.parse(readFileSync(path, "utf-8")).ch.map((i: HeldItemJson) => i.env.meta.arrivalSeq)).toEqual([undefined, undefined, 42]);
  });
});
type HeldItemJson = { env: { meta: { arrivalSeq?: unknown } } };

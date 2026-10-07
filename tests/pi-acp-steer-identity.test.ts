/**
 * 叫停回执（voided）按身份对上 pi 实际入队的那条（PR #705 返工）：真 AcpTurnLoop + AcpSession + PiAcpServer + piLinkOver，
 * 假 pi 照 pi 1.0.3 的 prompt 写：入队前先 await input hook（可改写正文 / 当场 handled），入队时 queue_update 先于 queued 回包，
 * 消费时 queue_update 先于 user 的 message_start，clear_queue 先发 queue_update 再回包。每条排队消息记着它是第几条 prompt
 * （= 第几条插话，扩展自己塞的记 0），清掉的宿主插话就是「真相」。只认能证明是自己的那条：认不出的宁可不报，也不能报错人。
 */
import { describe, expect, test } from "bun:test";
import { piLinkOver, type PiProc } from "../src/lib/acp/pi-adapter/pi-link.ts";
import { PiAcpServer } from "../src/lib/acp/pi-adapter/server.ts";
import type { RpcWire } from "../src/lib/acp/rpc.ts";
import { AcpSession } from "../src/lib/acp/session.ts";
import { AcpTurnLoop } from "../src/lib/acp/turn.ts";
import type { AcpFailure } from "../src/lib/acp/failures.ts";

type Rec = Record<string, any>;
/** input hook：返回改写后的正文，undefined = 扩展当场处理掉（handled，不入队） */
type Hook = (text: string, n: number) => Promise<string | undefined>;

function pipePair(): [RpcWire, RpcWire] {
  const side = () => ({ data: (_: string) => {}, close: (_: string) => {} });
  const a = side(), b = side();
  const wire = (me: ReturnType<typeof side>, peer: ReturnType<typeof side>): RpcWire => ({
    write: (line) => peer.data(line), onData: (cb) => void (me.data = cb as (c: string) => void), onClose: (cb) => void (me.close = cb),
    close: (why) => (peer.close(why), me.close(why)),
  });
  return [wire(a, b), wire(b, a)];
}

async function until(cond: () => boolean, what: string): Promise<void> {
  const end = Date.now() + 3_000;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`等不到：${what}`);
    await Bun.sleep(5);
  }
}

function gate<T>() {
  let open!: (v: T) => void;
  return { promise: new Promise<T>((r) => (open = r)), open };
}

/**
 * 假 pi（一直在跑）：steer 的 prompt 过 hook 后排队；n = 第几条 prompt。instant = 入队后当场注入上下文，和回包同一批输出；
 * extension = 这条入队之后、回包之前，扩展也往 steering 塞一条（n = 0）
 */
function fakePi(hook: Hook) {
  let onData: (c: string) => void = () => {};
  let n = 0;
  let instant = false;
  let extension: string | undefined;
  const queue: { text: string; n: number }[] = [];
  const cleared: number[] = [];
  const emit = (...recs: Rec[]) => onData(`${recs.map((r) => JSON.stringify(r)).join("\n")}\n`);
  const queueUpdate = () => ({ type: "queue_update", steering: queue.map((q) => q.text), followUp: [] });
  const proc: PiProc = {
    wire: {
      write(line) {
        const c = JSON.parse(line);
        const ok = (data: unknown = {}) => ({ id: c.id, type: "response", command: c.type, success: true, data });
        if (c.type === "clear_queue") {
          const out = queue.splice(0);
          cleared.push(...out.map((q) => q.n));
          return emit(queueUpdate(), ok({ steering: out.map((q) => q.text), followUp: [] }));
        }
        if (c.type !== "prompt") return emit(ok());
        const me = ++n;
        void hook(c.message, me).then((text) => {
          if (text === undefined) return emit(ok({ disposition: "handled" }));
          queue.push({ text, n: me });
          const pushed = queueUpdate();
          if (extension !== undefined) {
            queue.push({ text: extension, n: 0 });
            extension = undefined;
            return emit(pushed, queueUpdate(), ok({ disposition: "queued" }));
          }
          if (!instant) return emit(pushed, ok({ disposition: "queued" }));
          queue.shift();
          const message = { role: "user", content: [{ type: "text", text }] };
          emit(pushed, ok({ disposition: "queued" }), queueUpdate(), { type: "message_start", message }, { type: "message_end", message });
        });
      },
      onData: (cb) => void (onData = cb as (c: string) => void),
      onClose: () => {},
      close: () => {},
    },
    stop: () => {},
    exited: new Promise(() => {}),
  };
  /** pi 把队首注入上下文（pi 按正文 indexOf 删，队首就是第一条同正文的） */
  const consume = () => {
    const head = queue.shift()!;
    const message = { role: "user", content: [{ type: "text", text: head.text }] };
    emit(queueUpdate(), { type: "message_start", message }, { type: "message_end", message });
  };
  return {
    proc, emit, consume, instant: (on: boolean) => void (instant = on), extensionAppends: (t: string) => void (extension = t),
    prompts: () => n, queued: () => queue.map((q) => q.n), cleared: () => [...cleared],
  };
}

/** 宿主这一侧照生产接线：回合一直在跑，之后的消息都走 steer；叫停 = session.cancel → loop.voided（同 lib/acp/abort.ts） */
async function rig(hook: Hook, steerTimeoutMs?: number) {
  const pi = fakePi(hook);
  const [hostWire, adapterWire] = pipePair();
  const logs: string[] = [];
  const log = (m: string) => logs.push(m);
  new PiAcpServer(adapterWire, { openPi: () => piLinkOver(pi.proc, log), newSessionId: () => "s1", log, exit: () => {}, steerTimeoutMs });
  const session = new AcpSession(hostWire, { onUpdate: () => {}, onPermission: async () => null, log });
  await session.initialize();
  await session.create("/w");
  pi.emit({ type: "agent_start" });
  const failures: AcpFailure[] = [];
  const loop = new AcpTurnLoop({ prompt: () => new Promise(() => {}), steer: (text, id) => session.steer(text, id), reportStop: async () => ({}),
    onFailure: (f) => failures.push(f), log });
  await loop.submit("busy");
  const ids: string[] = [];
  /** 第 n 条插话的 message_id 是 ids[n - 1]（宿主按到达顺序发 steer，适配器按序发给 pi） */
  const submit = (text: string, id: string) => (ids.push(id), loop.submit(text, id));
  const cancel = async () => {
    const r = await session.cancel();
    return { ...r, voided: loop.voided(r), truth: pi.cleared().filter((n) => n > 0).map((n) => ids[n - 1]) };
  };
  return { pi, submit, cancel, logs, failures };
}

describe("Pi 叫停回执：voided 对上 pi 实际入队的那条", () => {
  test("扩展把第一条处理掉（handled，不入队），同正文第二条入队被清 → 只报第二条", async () => {
    const h = await rig(async (text, n) => (n === 1 ? undefined : text));
    expect(await h.submit("同一句", "already-handled")).toBe("steer");
    expect(await h.submit("同一句", "queued-second")).toBe("steer");
    expect(await h.cancel()).toMatchObject({ cleared: ["同一句"], voided: ["queued-second"], truth: ["queued-second"] });
  });

  test("异步 input hook：先发的 hook 慢时后发的不越过它进 pi；入队顺序 = 发出顺序，先消费一条、再清一条，voided 是被清的那条", async () => {
    const slow = gate<string>();
    const h = await rig((text, n) => (n === 1 ? slow.promise : Promise.resolve(text)));
    const first = h.submit("同一句", "m-first");
    await until(() => h.pi.prompts() === 1, "第一条进 pi");
    const second = h.submit("同一句", "m-second");
    await Bun.sleep(30);
    expect(h.pi.prompts()).toBe(1); // 第一条还在过 hook：第二条押在适配器里，不会先入队
    slow.open("同一句");
    expect([await first, await second]).toEqual(["steer", "steer"]);
    expect(h.pi.queued()).toEqual([1, 2]);
    h.pi.consume();
    expect(await h.cancel()).toMatchObject({ cleared: ["同一句"], voided: ["m-second"], truth: ["m-second"] });
  });

  test("input hook 改写正文：消费、清队列都按改写后的正文对上身份", async () => {
    const h = await rig(async (text) => `rewritten:${text}`);
    await h.submit("同一句", "m1");
    h.pi.consume();
    await h.submit("同一句", "m2");
    expect(await h.cancel()).toMatchObject({ cleared: ["rewritten:同一句"], voided: ["m2"], truth: ["m2"] });
  });

  test("回包和 pi 注入上下文的 message_start 同一批到：这条照样算已执行，不留成陈旧的一条", async () => {
    const h = await rig(async (text) => `rewritten:${text}`);
    h.pi.instant(true);
    await h.submit("同一句", "m1");
    h.pi.instant(false);
    await h.submit("同一句", "m2");
    expect(await h.cancel()).toMatchObject({ cleared: ["rewritten:同一句"], voided: ["m2"], truth: ["m2"] });
  });

  test("扩展在宿主插话入队后、回包前也塞了一条：认不出是哪条 → 不记身份；宿主那条已执行、扩展那条被清，voided 为空", async () => {
    const h = await rig(async (text) => text);
    h.pi.extensionAppends("扩展自己的");
    await h.submit("宿主消息", "host-already-consumed");
    expect(h.logs.some((l) => l.includes("新增了 2 条，认不出"))).toBe(true);
    h.pi.consume(); // pi 执行宿主那条
    expect(await h.cancel()).toMatchObject({ cleared: ["扩展自己的"], clearedIds: [], voided: [], truth: [] });
  });

  test("hook 一直不回：到 steer 超时就放开下一条，下一条照常入队、身份对；卡住那条之后才入队的不报作废", async () => {
    const stuck = gate<string>();
    const h = await rig((text, n) => (n === 1 ? stuck.promise : Promise.resolve(text)), 50);
    expect(await h.submit("卡住的", "m-stuck")).toBe("unknown"); // 写出后超时 → 投递不明：宿主不重发、出卡（tests/pi-acp-steer-failure.test.ts）
    expect(h.logs.some((l) => l.includes("steering 出错"))).toBe(false); // 没走改排队
    expect(h.failures.some((f) => f.kind === "error" && f.deliveryUnknown === true && f.message.includes("超时"))).toBe(true); // 超时文字进了投递不明卡
    expect(await h.submit("下一条", "m-next")).toBe("steer");
    expect(h.pi.queued()).toEqual([2]);
    stuck.open("卡住的");
    await until(() => h.pi.queued().length === 2, "卡住那条晚到入队");
    expect(await h.cancel()).toMatchObject({ cleared: ["下一条", "卡住的"], voided: ["m-next"] }); // m-stuck 投递不明、没进 steered 账，本来就不在作废候选里
  });

  // 卡住那条在下一条过 hook 期间晚到入队：下一条的窗口里新增了两条，认不出 → 不记身份（否则把卡住那条的正文记到下一条头上，消费它时就错销了下一条）
  test("超时那条在下一条入队前晚到：下一条认不出，宁可不报，也不报错人", async () => {
    const stuck = gate<string>();
    const next = gate<string>();
    const h = await rig((_text, n) => (n === 1 ? stuck.promise : next.promise), 50);
    expect(await h.submit("卡住的", "m-stuck")).toBe("unknown");
    const second = h.submit("下一条", "m-next");
    await until(() => h.pi.prompts() === 2, "下一条进 pi");
    stuck.open("卡住的");
    await until(() => h.pi.queued().length === 1, "卡住那条晚到入队");
    next.open("下一条");
    expect(await second).toBe("steer");
    expect(h.logs.some((l) => l.includes("新增了 2 条，认不出"))).toBe(true);
    h.pi.consume(); // pi 执行的是卡住那条
    expect(await h.cancel()).toMatchObject({ cleared: ["下一条"], clearedIds: [], voided: [] });
  });
});

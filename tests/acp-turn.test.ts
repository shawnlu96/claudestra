import { describe, expect, test } from "bun:test";
import { AcpTurnLoop, hookPromptText, type PromptOutcome, type SteerResult, type StopReport, type TurnIO } from "../src/lib/acp/turn.ts";
import type { AcpFailure } from "../src/lib/acp/failures.ts";

const tick = () => new Promise((r) => setTimeout(r, 0));
const deferred = <T,>() => {
  let resolve!: (x: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};

/**
 * 假适配器：prompt / steer 都挂着，测试里手动放行。live 记「此刻在跑的回合数」（prompt 进行中 + 已开始的外部回合），
 * 任何时刻超过 1 就是重叠——审查的 P1 就是要它恒 ≤ 1。
 */
function fixture(opts: { verdicts?: { block?: boolean; reason?: string }[]; noSteer?: boolean } = {}) {
  const prompts: string[] = [];
  const stops: StopReport[] = [];
  const failures: AcpFailure[] = [];
  const pending: { resolve: (o: PromptOutcome) => void; end: () => void }[] = [];
  const steers = new Map<string, (r: SteerResult) => void>();
  const verdicts = [...(opts.verdicts ?? [])];
  let live = 0;
  let maxLive = 0;
  const enter = () => (maxLive = Math.max(maxLive, ++live));
  const io: TurnIO = {
    prompt: (text) => {
      prompts.push(text);
      enter();
      const d = deferred<PromptOutcome>();
      let ended = false;
      const end = () => void (ended || (live--, (ended = true)));
      pending.push({ resolve: (o) => (end(), d.resolve(o)), end });
      return d.promise;
    },
    ...(opts.noSteer
      ? {}
      : {
          steer: (text: string) => {
            const d = deferred<SteerResult>();
            steers.set(text, d.resolve);
            return d.promise;
          },
        }),
    reportStop: async (r) => {
      stops.push(r);
      return verdicts.shift() ?? {};
    },
    onFailure: (f) => failures.push(f),
    log: () => {},
  };
  /** 适配器拿 steer 的消息另起一轮：回合立刻开始（live+1），返回 done 的放行器 */
  const startExternal = (text: string) => {
    enter();
    const d = deferred<PromptOutcome>();
    steers.get(text)!({ outcome: "startedNewTurn", done: d.promise });
    return (o: PromptOutcome = { kind: "done" }) => (live--, d.resolve(o));
  };
  /** 适配器里当前这轮已经结束，但 prompt 的回包还没被我们处理（协议允许的窗口） */
  const endInAdapter = () => pending[0].end();
  const finish = async (o: PromptOutcome = { kind: "done" }) => {
    await tick();
    pending.shift()!.resolve(o);
    await tick();
  };
  return { loop: new AcpTurnLoop(io), io, prompts, stops, failures, steers, startExternal, endInAdapter, finish, maxLive: () => maxLive };
}

describe("AcpTurnLoop · 基本", () => {
  test("空闲时直接开一轮；返回后按 Stop hook 契约上报，回到空闲", async () => {
    const f = fixture();
    expect(await f.loop.submit("<channel>a</channel>")).toBe("prompt");
    expect(f.loop.busy).toBe(true);
    await f.finish();
    expect(f.prompts).toEqual(["<channel>a</channel>"]);
    expect(f.stops).toEqual([{ event: "Stop", stopHookActive: false }]);
    expect(f.loop.busy).toBe(false);
  });

  test("忙时 steering 插进当前回合，不另开一轮", async () => {
    const f = fixture();
    await f.loop.submit("a");
    const b = f.loop.submit("b");
    f.steers.get("b")!({ outcome: "injected" });
    expect(await b).toBe("steer");
    await f.finish();
    expect(f.prompts).toEqual(["a"]);
    expect(f.stops.length).toBe(1);
    expect(f.loop.busy).toBe(false);
  });

  test("不支持 steering：忙时排队，这轮返回后把排着的拼成一轮", async () => {
    const f = fixture({ noSteer: true });
    await f.loop.submit("a");
    expect(await f.loop.submit("b")).toBe("queued");
    expect(await f.loop.submit("c")).toBe("queued");
    expect(f.loop.queued).toBe(2);
    await f.finish();
    expect(f.prompts).toEqual(["a", "b\n\nc"]);
    await f.finish();
    expect(f.stops.length).toBe(2);
    expect(f.loop.busy).toBe(false);
  });

  test("steering 出错按插不进处理：在原位置变回 prompt", async () => {
    const f = fixture();
    f.io.steer = () => Promise.reject(new Error("rpc down"));
    await f.loop.submit("a");
    expect(await f.loop.submit("b")).toBe("queued");
    await f.finish();
    expect(f.prompts).toEqual(["a", "b"]);
  });
});

describe("AcpTurnLoop · 统一调度（审查 P1）", () => {
  test("steer 在途时 A 返回：不宣告空闲、不开新 prompt；C 也走 steering 排在 B 后面，不和 B 的外部回合重叠", async () => {
    const f = fixture();
    await f.loop.submit("A");
    const b = f.loop.submit("B");
    await f.finish(); // A 返回，B 的 steering 还没落定
    expect(f.loop.busy).toBe(true);
    const c = f.loop.submit("C"); // 以前：被判空闲，直接 prompt(C)
    const endB = f.startExternal("B"); // 适配器其实早就为 B 开了一轮
    expect(await b).toBe("steer");
    f.steers.get("C")!({ outcome: "injected" }); // 适配器把 C 插进了 B 那一轮
    expect(await c).toBe("steer");
    expect(f.prompts).toEqual(["A"]);
    endB();
    await tick();
    await tick();
    expect(f.stops.length).toBe(2);
    expect(f.maxLive()).toBe(1);
    expect(f.loop.busy).toBe(false);
  });

  test("补 reply 不越过已登记的外部回合：先等外部回合结束，再补 <hook_prompt>", async () => {
    const f = fixture({ verdicts: [{ block: true, reason: "reply please" }] });
    await f.loop.submit("A");
    const b = f.loop.submit("B");
    f.endInAdapter(); // A 在适配器里已经结束……
    const endB = f.startExternal("B"); // ……B 的 startedNewTurn 先于 A 的回包被处理
    await b;
    await f.finish(); // A 返回，bridge 说没回复
    expect(f.prompts).toEqual(["A"]); // 以前：这里已经 prompt(<hook_prompt>) 了
    endB();
    await tick();
    await tick();
    expect(f.prompts).toEqual(["A", hookPromptText("reply please")]);
    await f.finish();
    expect(f.stops).toEqual([
      { event: "Stop", stopHookActive: false },
      { event: "Stop", stopHookActive: false },
      { event: "Stop", stopHookActive: true },
    ]);
    expect(f.maxLive()).toBe(1);
  });

  test("并发 steering 先后失败：按到达顺序拼，不按失败回包的顺序", async () => {
    const f = fixture();
    await f.loop.submit("A");
    const b = f.loop.submit('<channel from="B">first</channel>');
    const c = f.loop.submit('<channel from="C">second</channel>');
    f.steers.get('<channel from="C">second</channel>')!({ outcome: "failed" });
    await c;
    f.steers.get('<channel from="B">first</channel>')!({ outcome: "failed" });
    await b;
    await f.finish();
    expect(f.prompts[1]).toBe('<channel from="B">first</channel>\n\n<channel from="C">second</channel>');
  });

  test("外部回合在调度器排到它之前就结束了：done 已经记下，照常上报一次，不会卡住", async () => {
    const f = fixture();
    await f.loop.submit("A");
    const b = f.loop.submit("B");
    f.endInAdapter();
    const endB = f.startExternal("B");
    await b;
    endB(); // B 先结束了，A 的回包还没处理
    await f.finish();
    await tick();
    expect(f.stops.length).toBe(2);
    expect(f.loop.busy).toBe(false);
  });

  test("B、C 都在途时 B 另起一轮、C 失败：C 等 B 的外部回合结束后再 prompt", async () => {
    const f = fixture();
    await f.loop.submit("A");
    const b = f.loop.submit("B");
    const c = f.loop.submit("C");
    await f.finish();
    const endB = f.startExternal("B");
    f.steers.get("C")!({ outcome: "failed" });
    await Promise.all([b, c]);
    expect(f.prompts).toEqual(["A"]);
    endB();
    await tick();
    await tick();
    expect(f.prompts).toEqual(["A", "C"]);
    await f.finish();
    expect(f.maxLive()).toBe(1);
  });
});

describe("AcpTurnLoop · 收尾", () => {
  test("bridge 说没 reply（block）→ 补一轮 <hook_prompt>，只补一次，补的那轮 stopHookActive=true", async () => {
    const f = fixture({ verdicts: [{ block: true, reason: "回 chat_id=1" }, { block: true, reason: "again" }] });
    await f.loop.submit("a");
    await f.finish();
    expect(f.prompts).toEqual(["a", hookPromptText("回 chat_id=1")]);
    await f.finish();
    expect(f.prompts.length).toBe(2);
    expect(f.stops).toEqual([
      { event: "Stop", stopHookActive: false },
      { event: "Stop", stopHookActive: true },
    ]);
    expect(f.loop.busy).toBe(false);
  });

  test("打断：cancelled → StopFailure + interrupt，不补 reply", async () => {
    const f = fixture({ verdicts: [{ block: true, reason: "x" }] });
    await f.loop.submit("a");
    await f.finish({ kind: "cancelled" });
    expect(f.stops).toEqual([{ event: "StopFailure", stopHookActive: false, interrupt: true }]);
    expect(f.prompts.length).toBe(1);
  });

  test("失败：交给 onFailure 出卡，上报 StopFailure；prompt 本身抛错也按失败走，循环不死", async () => {
    const f = fixture();
    const quota: AcpFailure = { kind: "quota", key: "air:t1:error", message: "You've hit your usage limit." };
    await f.loop.submit("a");
    await f.finish({ kind: "failed", failure: quota });
    expect(f.failures).toEqual([quota]);
    expect(f.stops).toEqual([{ event: "StopFailure", stopHookActive: false }]);

    const g = fixture();
    g.io.prompt = () => Promise.reject(new Error("acp 连接断了（exit）"));
    await g.loop.submit("x");
    await tick();
    await tick();
    expect(g.failures[0]).toMatchObject({ kind: "error", message: "acp 连接断了（exit）" });
    expect(g.loop.busy).toBe(false);
  });

  test("上报失败（bridge 不在）、IO 自己抛错都不卡循环，排着的照样开下一轮", async () => {
    const f = fixture({ noSteer: true });
    f.io.reportStop = () => Promise.reject(new Error("ECONNREFUSED"));
    await f.loop.submit("a");
    await f.loop.submit("b");
    await f.finish();
    expect(f.prompts).toEqual(["a", "b"]);

    const g = fixture({ noSteer: true });
    g.io.onFailure = () => {
      throw new Error("card sink down");
    };
    await g.loop.submit("a");
    await g.loop.submit("b");
    await g.finish({ kind: "failed", failure: { kind: "error", key: "k", message: "m" } });
    expect(g.prompts).toEqual(["a", "b"]);
    expect(g.stops[0]).toEqual({ event: "StopFailure", stopHookActive: false }); // 出卡失败也照样上报回合结束
  });
});

describe("AcpTurnLoop · IO 同步抛错 / 提前 reject（审查第 2 轮）", () => {
  test("steer 同步抛错（适配器进程已退出）：submit 不抛，占位在原处变回 prompt，busy 能回到 false，之后照常开 prompt", async () => {
    const f = fixture();
    await f.loop.submit("A");
    f.io.steer = () => {
      throw new Error("adapter process already exited");
    };
    expect(await f.loop.submit("B")).toBe("queued");
    await f.finish({ kind: "failed", failure: { kind: "error", key: "exit", message: "exit" } });
    expect(f.prompts).toEqual(["A", "B"]);
    await f.finish();
    expect(f.loop.busy).toBe(false);
    f.io.steer = undefined;
    expect(await f.loop.submit("C")).toBe("prompt");
    expect(f.prompts).toEqual(["A", "B", "C"]);
  });

  test("prompt / reportStop 同步抛错：按失败收尾、照常上报，排着的继续开", async () => {
    const f = fixture({ noSteer: true });
    let n = 0;
    const realPrompt = f.io.prompt;
    f.io.prompt = (t) => {
      if (n++ === 0) throw new Error("stdin closed");
      return realPrompt(t);
    };
    await f.loop.submit("a");
    await f.loop.submit("b");
    await tick();
    expect(f.failures[0]).toMatchObject({ kind: "error", message: "stdin closed" });
    expect(f.stops[0]).toEqual({ event: "StopFailure", stopHookActive: false });
    expect(f.prompts).toEqual(["b"]);

    const g = fixture({ noSteer: true });
    g.io.reportStop = () => {
      throw new Error("sync boom");
    };
    await g.loop.submit("a");
    await g.loop.submit("b");
    await g.finish();
    expect(g.prompts).toEqual(["a", "b"]);
  });

  test("外部回合的 done 在排到它之前就 reject：不产生 unhandled rejection，按失败收尾", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      const f = fixture();
      await f.loop.submit("A");
      const b = f.loop.submit("B");
      let failB!: (e: unknown) => void;
      const done = new Promise<PromptOutcome>((_, reject) => (failB = reject));
      f.steers.get("B")!({ outcome: "startedNewTurn", done });
      await b;
      failB(new Error("adapter exited before external was picked"));
      await tick();
      await tick();
      await f.finish({ kind: "failed", failure: { kind: "error", key: "exit", message: "adapter exited" } });
      await tick();
      expect(unhandled).toEqual([]);
      expect(f.stops.map((s) => s.event)).toEqual(["StopFailure", "StopFailure"]);
      expect(f.failures.map((x) => x.message)).toEqual(["adapter exited", "adapter exited before external was picked"]);
      expect(f.loop.busy).toBe(false);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("AcpTurnLoop · 失败去重键", () => {
  test("传输层失败按单调序号给键：同一毫秒里两次失败也是两张卡（不能用 Date.now）", async () => {
    const f = fixture({ noSteer: true });
    f.io.prompt = () => Promise.reject(new Error("acp 连接断了"));
    const realNow = Date.now;
    Date.now = () => 1_790_000_000_000; // 钉死时间：两次失败落在同一毫秒
    try {
      await f.loop.submit("a");
      await tick();
      await f.loop.submit("b");
      await tick();
    } finally {
      Date.now = realNow;
    }
    expect(f.failures.length).toBe(2);
    expect(new Set(f.failures.map((x) => x.key)).size).toBe(2);
  });
});

import { describe, expect, test } from "bun:test";
import { AcpTurnLoop, acpSlotCall, hookPromptText, type PromptOutcome, type SteerResult, type StopReport, type TurnIO } from "../src/lib/acp/turn.ts";
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

describe("AcpTurnLoop · 叫停作废按身份对（R18）", () => {
  test("每条插话带不同的 deliveryId；有 clearedIds 只认身份（未知 / 空 = 不报），没有才按正文（老适配器，行为不变）", async () => {
    const ids: string[] = [];
    const loop = new AcpTurnLoop({
      prompt: () => new Promise(() => {}), // 一直在跑：之后的消息都走 steer
      steer: async (_text, deliveryId) => (ids.push(deliveryId), { outcome: "injected" }),
      reportStop: async () => ({}), onFailure: () => {}, log: () => {},
    });
    await loop.submit("busy");
    expect([await loop.submit("x", "m1"), await loop.submit("x", "m2")]).toEqual(["steer", "steer"]);
    expect(new Set(ids).size).toBe(2);
    expect(loop.voided({ cleared: ["x"] })).toEqual(["m1", "m2"]);
    expect(loop.voided({ cleared: ["x"], clearedIds: [ids[1]!] })).toEqual(["m2"]);
    expect(loop.voided({ cleared: ["x"], clearedIds: ["unknown"] })).toEqual([]);
    expect(loop.voided({ cleared: ["x"], clearedIds: [] })).toEqual([]);
  });
});

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

  test("忙时 /compact 独占下一轮 prompt，不经 steering 也不和普通消息拼接", async () => {
    const f = fixture();
    await f.loop.submit("work");
    expect(f.loop.submitCommand("/compact")).toBe("queued");
    expect(f.steers.has("/compact")).toBe(false);
    await f.finish();
    expect(f.prompts).toEqual(["work", "/compact"]);
    await f.finish();
    expect(f.stops).toHaveLength(2);
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

/**
 * 独占槽（codex-compact N1）的内存 IO：按发生顺序记 prompt / steer / stop / slot / cancel，等的都是具体事件（when），不靠 sleep。
 * cancel 只是记账的探针：调度器从不该调它（运行中的槽 uncancellable，排队的槽撤掉不发东西）。
 */
function slotFixture(opts: { noSteer?: boolean } = {}) {
  const events: string[] = [];
  const waits: { pred: (e: string) => boolean; resolve: () => void }[] = [];
  const push = (e: string) => {
    events.push(e);
    for (const w of waits.filter((x) => x.pred(e))) waits.splice(waits.indexOf(w), 1), w.resolve();
  };
  const when = (e: string) => new Promise<void>((resolve) => (events.includes(e) ? resolve() : waits.push({ pred: (x) => x === e, resolve })));
  const turns = new Map<string, (o: PromptOutcome) => void>();
  let holdStop: Promise<void> | null = null;
  let onSlotEnd: ((e: { opId: string; gen: number; outcome: string }) => void) | null = null;
  const io: TurnIO & { cancel(): Promise<void> } = {
    prompt: (text) => {
      const d = deferred<PromptOutcome>();
      turns.set(text, d.resolve);
      push(`prompt:${text}`);
      return d.promise;
    },
    ...(opts.noSteer ? {} : { steer: async (text: string) => (push(`steer:${text}`), { outcome: "injected" as const }) }),
    reportStop: async (r) => {
      push(`stop:${r.event}`);
      if (holdStop) await holdStop;
      return {};
    },
    onFailure: () => {},
    onSlotEnd: (e) => (push(`slot:${e.opId}#${e.gen}:${e.outcome}`), onSlotEnd?.(e)),
    cancel: async () => push("cancel"),
    log: () => {},
  };
  const end = (text: string, o: PromptOutcome = { kind: "done" }) => turns.get(text)!(o);
  return {
    loop: new AcpTurnLoop(io), events, when, end,
    hold: () => { const d = deferred<void>(); holdStop = d.promise; return () => ((holdStop = null), d.resolve()); },
    onSlotEnd: (cb: typeof onSlotEnd) => void (onSlotEnd = cb),
  };
}

describe("AcpTurnLoop · 独占槽（codex-compact N1）", () => {
  test("复现测试：command 在跑时入站只排队、不 steer，按到达顺序在命令之后跑（旧：steer 进压缩那一轮）", async () => {
    const f = slotFixture();
    expect(f.loop.submitCommand("/compact", "op-1")).toBe("prompt");
    expect(await f.loop.submit("a")).toBe("queued");
    expect(await f.loop.submit("b")).toBe("queued");
    expect(f.events.filter((e) => e.startsWith("steer:"))).toEqual([]);
    f.end("/compact");
    await f.when("prompt:a\n\nb");
    expect(f.events).toEqual(["prompt:/compact", "stop:Stop", "slot:op-1#1:done", "prompt:a\n\nb"]);
  });

  test("op 槽（保存交接那一轮）在跑时也不 steer；普通业务轮照旧 steer", async () => {
    const f = slotFixture();
    expect(await f.loop.submit("work")).toBe("prompt");
    expect(await f.loop.submit("插话")).toBe("steer");
    f.end("work");
    await f.when("stop:Stop");
    f.loop.submitOp("save", "op-s");
    await f.when("prompt:save");
    expect(await f.loop.submit("x")).toBe("queued");
    expect(f.events.filter((e) => e.startsWith("steer:"))).toEqual(["steer:插话"]);
  });

  test("op 槽不和前后 prompt 合批；旧的 submitCommand(text) 照旧独占一轮", async () => {
    const f = slotFixture({ noSteer: true });
    await f.loop.submit("a");
    await f.loop.submit("b");
    expect(f.loop.submitOp("save", "op-s")).toBe("queued");
    await f.loop.submit("c");
    expect(f.loop.submitCommand("/status")).toBe("queued");
    await f.loop.submit("d");
    for (const t of ["a", "b", "save", "c", "/status", "d"]) {
      await f.when(`prompt:${t}`);
      f.end(t);
    }
    expect(f.events.filter((e) => e.startsWith("prompt:"))).toEqual(["prompt:a", "prompt:b", "prompt:save", "prompt:c", "prompt:/status", "prompt:d"]);
    expect(f.events).toContain("slot:op-s#1:done");
  });

  test("排队中的槽 cancelSlot → revoked：不开回合、不发取消；再撤 gone，状态记 ended/revoked", async () => {
    const f = slotFixture({ noSteer: true });
    await f.loop.submit("work");
    expect(f.loop.submitCommand("/compact", "op-1")).toBe("queued");
    expect(f.loop.slotStatus("op-1")).toEqual({ state: "queued", opId: "op-1", gen: 1 });
    const waited = f.loop.waitSlot("op-1");
    expect(f.loop.cancelSlot("op-1")).toBe("revoked");
    expect(await waited).toEqual({ state: "ended", opId: "op-1", gen: 1, outcome: "revoked" });
    expect(f.loop.cancelSlot("op-1")).toBe("gone");
    f.end("work");
    await f.when("stop:Stop");
    void f.loop.submit("next");
    await f.when("prompt:next");
    expect(f.events).toEqual(["prompt:work", "slot:op-1#1:revoked", "stop:Stop", "prompt:next"]);
  });

  test("在跑的槽 uncancellable：不发取消、不提前报 cancelled，结局按实际（failed）上报", async () => {
    const f = slotFixture();
    f.loop.submitCommand("/compact", "op-1");
    expect(f.loop.cancelSlot("op-1")).toBe("uncancellable");
    expect(f.loop.slotStatus("op-1")).toEqual({ state: "running", opId: "op-1", gen: 1 });
    f.end("/compact", { kind: "failed", failure: { kind: "error", key: "k", message: "压缩失败" } });
    expect(await f.loop.waitSlot("op-1")).toEqual({ state: "ended", opId: "op-1", gen: 1, outcome: "failed" });
    expect(f.events).not.toContain("cancel");
  });

  test("迟到的旧 gen 碰不到同 opId 的新槽；opId 已有在排 / 在跑的槽 → duplicate", async () => {
    const f = slotFixture();
    await f.loop.submit("work");
    f.loop.submitCommand("/compact", "op-1");
    expect(f.loop.submitCommand("/compact", "op-1")).toBe("duplicate");
    expect(f.loop.cancelSlot("op-1", 1)).toBe("revoked");
    f.loop.submitCommand("/compact", "op-1");
    expect(f.loop.cancelSlot("op-1", 1)).toBe("gone");
    expect(f.loop.slotStatus("op-1")).toEqual({ state: "queued", opId: "op-1", gen: 2 });
    expect(f.loop.cancelSlot("op-1", 2)).toBe("revoked");
  });

  test("复现测试：slot_status wait 带不存在 / 旧 gen 不挂到同 opId 的新代次上，立即回 gone / 旧代次真实结局（旧：等到新槽结束）", async () => {
    const f = slotFixture();
    const status = (gen: number, wait: boolean) => acpSlotCall(f.loop, { op: "slot_status", opId: "same", hostId: "h", gen, wait }, "h")!;
    f.loop.submitCommand("/compact", "same"); // gen=1 在跑，prompt 一直不 resolve
    const gone = { ok: true, slot: { state: "gone", opId: "same", hostId: "h" } };
    expect(await status(99, true)).toEqual(gone); // 旧实现在这里一直挂着
    expect(await status(99, false)).toEqual(gone);
    expect(f.loop.slotStatus("same")).toEqual({ state: "running", opId: "same", gen: 1 });

    const g = slotFixture();
    const old = (wait: boolean) => acpSlotCall(g.loop, { op: "slot_status", opId: "same", hostId: "h", gen: 1, wait }, "h")!;
    await g.loop.submit("work");
    g.loop.submitCommand("/compact", "same");
    expect(g.loop.cancelSlot("same", 1)).toBe("revoked");
    g.loop.submitCommand("/compact", "same"); // gen=2 排在 work 后面
    const revoked = { ok: true, slot: { state: "ended", opId: "same", gen: 1, outcome: "revoked", hostId: "h" } };
    expect(await old(true)).toEqual(revoked);
    expect(await old(false)).toEqual(revoked);
    expect(g.loop.slotStatus("same")).toEqual({ state: "queued", opId: "same", gen: 2 });
    const cur = acpSlotCall(g.loop, { op: "slot_status", opId: "same", hostId: "h", gen: 2, wait: true }, "h")!;
    g.end("work");
    await g.when("prompt:/compact");
    g.end("/compact");
    expect(await cur).toEqual({ ok: true, slot: { state: "ended", opId: "same", gen: 2, outcome: "done", hostId: "h" } });
    expect(g.events).not.toContain("cancel");
  });
});

describe("AcpTurnLoop · 撤槽不落到下一业务轮（三种交错）", () => {
  /** 先跑 op 槽、后面排一条业务 prompt；返回 cancelSlot 的结果 */
  const setup = () => {
    const f = slotFixture();
    f.loop.submitCommand("/compact", "op-1");
    void f.loop.submit("biz");
    return f;
  };
  const settled = async (f: ReturnType<typeof slotFixture>, outcome: string) => {
    await f.when("prompt:biz");
    f.end("biz");
    await f.when("slot:op-1#1:" + outcome);
    await new Promise<void>((r) => void f.loop.waitSlot("op-1").then(() => r()));
    expect(f.events).not.toContain("cancel");
    expect(f.events.filter((e) => e.startsWith("stop:")).at(-1)).toBe("stop:Stop"); // 业务轮正常收尾，不是被取消
  };

  test("1. 目标轮 prompt 已 resolve、宿主还没收尾（Stop 上报中）：uncancellable，什么都不发", async () => {
    const f = setup();
    const release = f.hold();
    f.end("/compact");
    await f.when("stop:Stop");
    expect(f.loop.cancelSlot("op-1")).toBe("uncancellable");
    release();
    await settled(f, "done");
    await f.when("stop:Stop");
    expect(f.events.slice(0, 4)).toEqual(["prompt:/compact", "stop:Stop", "slot:op-1#1:done", "prompt:biz"]);
  });

  test("2. 目标轮已收尾、下一轮开之前：gone，下一轮照常开", async () => {
    const f = setup();
    const seen: string[] = [];
    f.onSlotEnd(() => seen.push(f.loop.cancelSlot("op-1"), String(f.events.includes("prompt:biz"))));
    f.end("/compact", { kind: "cancelled" });
    await settled(f, "cancelled");
    expect(seen).toEqual(["gone", "false"]);
  });

  test("3. 下一业务轮已经在跑：gone，业务轮不受影响", async () => {
    const f = setup();
    f.end("/compact");
    await f.when("prompt:biz");
    expect(f.loop.cancelSlot("op-1")).toBe("gone");
    expect(f.loop.slotStatus("op-1")).toEqual({ state: "ended", opId: "op-1", gen: 1, outcome: "done" });
    await settled(f, "done");
  });
});

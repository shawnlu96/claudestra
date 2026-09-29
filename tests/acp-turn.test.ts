import { describe, expect, test } from "bun:test";
import { AcpTurnLoop, hookPromptText, type PromptOutcome, type SteerOutcome, type StopReport, type TurnIO } from "../src/lib/acp/turn.ts";
import type { AcpFailure } from "../src/lib/acp/failures.ts";

/** 手动放行的假适配器：prompt / 外部回合都挂着，测试里 finish() 才返回 */
function fakeIO(opts: { steer?: (text: string) => SteerOutcome; verdicts?: { block?: boolean; reason?: string }[] } = {}) {
  const prompts: string[] = [];
  const stops: StopReport[] = [];
  const failures: AcpFailure[] = [];
  const waiters: ((o: PromptOutcome) => void)[] = [];
  const verdicts = [...(opts.verdicts ?? [])];
  let externalWaits = 0;
  const io: TurnIO = {
    prompt: (text) => {
      prompts.push(text);
      return new Promise((r) => waiters.push(r));
    },
    ...(opts.steer ? { steer: async (text: string) => opts.steer!(text) } : {}),
    waitExternalTurn: () => {
      externalWaits++;
      return new Promise((r) => waiters.push(r));
    },
    reportStop: async (r) => {
      stops.push(r);
      return verdicts.shift() ?? {};
    },
    onFailure: (f) => failures.push(f),
    log: () => {},
  };
  const settle = () => new Promise((r) => setTimeout(r, 0));
  const finish = async (o: PromptOutcome = { kind: "done" }) => {
    await settle();
    waiters.shift()!(o);
    await settle();
  };
  return { io, prompts, stops, failures, finish, settle, externalWaits: () => externalWaits };
}

describe("AcpTurnLoop", () => {
  test("空闲时直接开一轮；返回后按 Stop hook 契约上报，回到空闲", async () => {
    const f = fakeIO();
    const loop = new AcpTurnLoop(f.io);
    expect(await loop.submit("<channel>a</channel>")).toBe("prompt");
    expect(loop.busy).toBe(true);
    await f.finish();
    expect(f.prompts).toEqual(["<channel>a</channel>"]);
    expect(f.stops).toEqual([{ event: "Stop", stopHookActive: false }]);
    expect(loop.busy).toBe(false);
  });

  test("忙时 steering 插进当前回合，不另开一轮", async () => {
    const f = fakeIO({ steer: () => "injected" });
    const loop = new AcpTurnLoop(f.io);
    await loop.submit("a");
    expect(await loop.submit("b")).toBe("steer");
    await f.finish();
    expect(f.prompts).toEqual(["a"]);
    expect(f.stops.length).toBe(1);
  });

  test("不支持 steering：忙时排队，这轮返回后把排着的拼成一轮", async () => {
    const f = fakeIO();
    const loop = new AcpTurnLoop(f.io);
    await loop.submit("a");
    expect(await loop.submit("b")).toBe("queued");
    expect(await loop.submit("c")).toBe("queued");
    expect(loop.queued).toBe(2);
    await f.finish();
    expect(f.prompts).toEqual(["a", "b\n\nc"]);
    await f.finish();
    expect(f.stops.length).toBe(2);
    expect(loop.busy).toBe(false);
  });

  test("steering 插不进（failed / 抛错）就排队", async () => {
    let n = 0;
    const f = fakeIO({
      steer: () => {
        if (n++) throw new Error("rpc down");
        return "failed";
      },
    });
    const loop = new AcpTurnLoop(f.io);
    await loop.submit("a");
    expect(await loop.submit("b")).toBe("queued");
    expect(await loop.submit("c")).toBe("queued");
    await f.finish();
    expect(f.prompts[1]).toBe("b\n\nc");
  });

  test("竞态：适配器拿 steer 的消息另起一轮（startedNewTurn）→ 等它结束再上报，排在还没开的 prompt 前面", async () => {
    const outcomes: SteerOutcome[] = ["failed", "startedNewTurn"];
    const f = fakeIO({ steer: () => outcomes.shift()! });
    const loop = new AcpTurnLoop(f.io);
    await loop.submit("a");
    await loop.submit("b"); // failed → 排队
    expect(await loop.submit("c")).toBe("steer"); // startedNewTurn → 外部回合排在 b 前面
    await f.finish(); // a 返回
    expect(f.externalWaits()).toBe(1);
    expect(f.prompts).toEqual(["a"]); // b 还得等外部回合
    await f.finish(); // 外部回合结束
    expect(f.prompts).toEqual(["a", "b"]);
    await f.finish();
    expect(f.stops.map((s) => s.event)).toEqual(["Stop", "Stop", "Stop"]);
  });

  test("bridge 说没 reply（block）→ 补一轮 <hook_prompt>，只补一次，补的那轮 stopHookActive=true", async () => {
    const f = fakeIO({ verdicts: [{ block: true, reason: "回 chat_id=1" }, { block: true, reason: "again" }] });
    const loop = new AcpTurnLoop(f.io);
    await loop.submit("a");
    await f.finish();
    expect(f.prompts).toEqual(["a", hookPromptText("回 chat_id=1")]);
    await f.finish();
    expect(f.prompts.length).toBe(2);
    expect(f.stops).toEqual([
      { event: "Stop", stopHookActive: false },
      { event: "Stop", stopHookActive: true },
    ]);
    expect(loop.busy).toBe(false);
  });

  test("打断：cancelled → StopFailure + interrupt，不补 reply", async () => {
    const f = fakeIO({ verdicts: [{ block: true, reason: "x" }] });
    const loop = new AcpTurnLoop(f.io);
    await loop.submit("a");
    await f.finish({ kind: "cancelled" });
    expect(f.stops).toEqual([{ event: "StopFailure", stopHookActive: false, interrupt: true }]);
    expect(f.prompts.length).toBe(1);
  });

  test("失败：交给 onFailure 出卡，上报 StopFailure；prompt 本身抛错也按失败走，循环不死", async () => {
    const f = fakeIO();
    const quota: AcpFailure = { kind: "quota", key: "air:t1:error", message: "You've hit your usage limit." };
    const loop = new AcpTurnLoop(f.io);
    await loop.submit("a");
    await f.finish({ kind: "failed", failure: quota });
    expect(f.failures).toEqual([quota]);
    expect(f.stops).toEqual([{ event: "StopFailure", stopHookActive: false }]);

    const g = fakeIO();
    g.io.prompt = () => Promise.reject(new Error("acp 连接断了（exit）"));
    const loop2 = new AcpTurnLoop(g.io);
    await loop2.submit("x");
    await g.settle();
    await g.settle();
    expect(g.failures[0]).toMatchObject({ kind: "error", message: "acp 连接断了（exit）" });
    expect(loop2.busy).toBe(false);
  });

  test("上报失败（bridge 不在）不卡循环，排着的照样开下一轮", async () => {
    const f = fakeIO();
    f.io.reportStop = () => Promise.reject(new Error("ECONNREFUSED"));
    const loop = new AcpTurnLoop(f.io);
    await loop.submit("a");
    await loop.submit("b");
    await f.finish();
    expect(f.prompts).toEqual(["a", "b"]);
  });
});

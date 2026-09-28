/**
 * lib/preempt-cooldown.ts + preemptIfBusy 的 cooldown 参数（N7 复核 P1）：Discord 入站先打断一次后，
 * 紧跟着的 deliverToLocal 不能再发第二次 C-c——空闲的 CC 短窗内收到两次 C-c 会退出。
 */
import { describe, expect, test } from "bun:test";
import { PreemptCooldown } from "../src/lib/preempt-cooldown.js";
import { preemptIfBusy } from "../src/lib/runtimes/window-ops.js";

describe("PreemptCooldown", () => {
  test("打断后冷却期内不 ready，过期后恢复；各频道各算各的", () => {
    const c = new PreemptCooldown(4_000);
    const t0 = 1_790_000_000_000;
    expect(c.ready("a", t0)).toBe(true);
    c.mark("a", t0);
    expect(c.ready("a", t0 + 400)).toBe(false);
    expect(c.ready("b", t0 + 400)).toBe(true);
    expect(c.ready("a", t0 + 4_001)).toBe(true);
  });
});

describe("Discord 抢占与 deliverToLocal 共用冷却", () => {
  test("Discord 路径打断后，400ms 内 deliverToLocal 那道判不到 ready，不发第二次 C-c", async () => {
    const cooldown = new PreemptCooldown(4_000);
    const keys: string[] = [];
    const interrupt = async () => (keys.push("C-c"), ["C-c"] as const);
    expect(await preemptIfBusy("w", "claude-code", async () => "busy", interrupt, cooldown.for("ch"))).toBe(true);
    expect(keys).toEqual(["C-c"]);
    // deliverToLocal 的抢占条件是 preemptCooldown.ready(to.channelId)
    expect(cooldown.ready("ch", Date.now() + 400)).toBe(false);
  });

  test("冷却期内 Discord 路径自己也不再判、不再发键", async () => {
    const cooldown = new PreemptCooldown(4_000);
    cooldown.mark("ch");
    let judged = 0;
    const r = await preemptIfBusy("w", undefined, async () => (judged++, "busy"), async () => ["C-c"], cooldown.for("ch"));
    expect(r).toBe(false);
    expect(judged).toBe(0);
  });

  test("没发出键（空闲 / 发键失败）不占冷却", async () => {
    const cooldown = new PreemptCooldown(4_000);
    await preemptIfBusy("w", undefined, async () => "idle", async () => ["C-c"], cooldown.for("ch"));
    await preemptIfBusy("w", undefined, async () => "busy", async () => { throw new Error("tmux gone"); }, cooldown.for("ch"));
    expect(cooldown.ready("ch")).toBe(true);
  });
});

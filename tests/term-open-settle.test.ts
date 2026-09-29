import { describe, expect, test } from "bun:test";
import { createOpenSettle, revealStatus, streamEndStatus, streamErrorStatus, type TermStatus } from "../web/features/terminal/open-settle";

// 终端连上后等输出停下来才揭开（尺寸一变 CC 会整段重画，边画边揭开就是一段「往下滚」）
describe("createOpenSettle", () => {
  test("start 之后静默 quietMs 才触发；期间的输出顺延，字节累计", async () => {
    const fired: number[] = [];
    const s = createOpenSettle((bytes) => fired.push(bytes), 40, 1000);
    s.data(5); // start 前的输出只计数
    s.start();
    await Bun.sleep(25);
    s.data(10);
    await Bun.sleep(25);
    expect(fired).toEqual([]); // 被顺延了
    await Bun.sleep(40);
    expect(fired).toEqual([15]);
  });
  test("一直有输出也不会永远不揭开：maxMs 兜底，只触发一次", async () => {
    const fired: number[] = [];
    const s = createOpenSettle((bytes) => fired.push(bytes), 30, 80);
    s.start();
    for (let i = 0; i < 8; i++) {
      await Bun.sleep(15);
      s.data(1);
    }
    await Bun.sleep(60);
    expect(fired.length).toBe(1);
  });
  test("cancel 之后不再触发", async () => {
    let n = 0;
    const s = createOpenSettle(() => n++, 10, 50);
    s.start();
    s.cancel();
    await Bun.sleep(70);
    expect(n).toBe(0);
  });
});

// 按 terminal-view.tsx 的调用顺序模拟：open 帧 → settle.start()，之后在揭开计时（quietMs～maxMs）里
// 收到 exit 帧 / 流收尾 / 流出错。修之前回调无条件 setStatus("connected")，会把 exited / error 覆盖掉，
// 遮罩、「重新连接」按钮和自愈重连一起消失。
describe("揭开计时里终端退出 / 断流", () => {
  function harness() {
    let status: TermStatus = "connecting";
    const setStatus = (v: TermStatus | ((s: TermStatus) => TermStatus)) => {
      status = typeof v === "function" ? v(status) : v;
    };
    const settle = createOpenSettle(() => setStatus(revealStatus), 20, 60);
    let opened = false;
    return {
      get status() { return status; },
      open() { opened = true; settle.start(); },
      exitFrame() { settle.cancel(); setStatus("exited"); },
      streamEnd() { settle.cancel(); setStatus(streamEndStatus(opened)); },
      streamError() { settle.cancel(); setStatus(streamErrorStatus); },
    };
  }

  test("exit 帧先到、流随后收尾：计时到点后仍是 exited", async () => {
    const h = harness();
    h.open();
    await Bun.sleep(5);
    h.exitFrame();
    h.streamEnd();
    await Bun.sleep(120);
    expect(h.status).toBe("exited");
  });
  test("没有 exit 帧、流直接收尾：标成 exited，不停在「连接中」", async () => {
    const h = harness();
    h.open();
    h.streamEnd();
    expect(h.status).toBe("exited");
    await Bun.sleep(120);
    expect(h.status).toBe("exited");
  });
  test("流在揭开前出错：保持 error", async () => {
    const h = harness();
    h.open();
    h.streamError();
    await Bun.sleep(120);
    expect(h.status).toBe("error");
  });
  test("正常路径：静默后揭开成 connected，之后流收尾 → exited", async () => {
    const h = harness();
    h.open();
    await Bun.sleep(120);
    expect(h.status).toBe("connected");
    h.streamEnd();
    expect(h.status).toBe("exited");
  });
  test("回调就算晚到也只改「连接中」；open 前流收尾保持原样", () => {
    expect(revealStatus("connecting")).toBe("connected");
    expect(revealStatus("exited")).toBe("exited");
    expect(revealStatus("error")).toBe("error");
    expect(streamEndStatus(false)("connecting")).toBe("connecting");
    expect(streamEndStatus(false)("connected")).toBe("exited");
    expect(streamEndStatus(true)("error")).toBe("error");
    expect(streamErrorStatus("connecting")).toBe("error");
    expect(streamErrorStatus("exited")).toBe("exited");
  });
});

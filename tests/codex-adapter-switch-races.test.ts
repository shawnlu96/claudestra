// 切换上线门槛的故障竞争（CXF-S）：打断和插话同时到达自研适配器。假 app-server + 宿主真用的 AcpSession（tests/helpers/codex-fake-app.ts）。
// 其余几种在别处：切换时宿主在回合中 / 起不来退上游 → codex-adapter-switch.test.ts、acp-host-runtime-switch.test.ts；
// app-server 回合中崩溃 → codex-adapter-shutdown.test.ts R8 R23。
import { describe, expect, test } from "bun:test";
import { harness, tick, until, type Rec } from "./helpers/codex-fake-app.ts";

type H = ReturnType<typeof harness>;
const started = (h: H, t: string) => ({ method: "turn/started", params: { threadId: h.f.thread, turn: { id: t, items: [], status: "inProgress" } } });
const completed = (h: H, t: string, status = "completed") => ({ method: "turn/completed", params: { threadId: h.f.thread, turn: { id: t, items: [], status, error: null } } });

/** 开一轮并让它跑起来（turn/started 已到）：返回 prompt 的 promise 和 turn/start 的请求 id 表 */
async function running(h: H) {
  const ids: number[] = [];
  h.f.on("turn/start", (_p, id) => void ids.push(id));
  const p = h.session.prompt("一");
  await until(() => ids.length === 1, "turn/start");
  h.f.feed({ id: ids[0]!, result: { turn: { id: "M0", items: [], status: "inProgress" } } }, started(h, "M0"));
  h.f.turn = "M0";
  await until(() => h.statuses().includes("active"), "active");
  return { p, ids };
}

/** 收尾之后：下一轮照常开始、照常结束，没有多出来的 interrupt */
async function nextTurnWorks(h: H, ids: number[]) {
  const p2 = h.session.prompt("二");
  await until(() => ids.length === 2, "第二轮 turn/start");
  h.f.feed({ id: ids[1]!, result: { turn: { id: "M1", items: [], status: "inProgress" } } }, started(h, "M1"), completed(h, "M1"));
  expect(await p2).toEqual({ kind: "done" });
  expect(h.f.calls("turn/interrupt")).toHaveLength(1);
}

describe("打断和插话同时到达", () => {
  test("同一拍里先插话后打断：只 interrupt 一次，插话要么注入后按「已丢弃」提示、要么失败，不另起回合；下一轮正常", async () => {
    const h = harness();
    await h.open();
    const { p, ids } = await running(h);
    const steer = h.session.steer("顺便把测试也跑了");
    const cancel = h.session.cancel();
    await cancel;
    await until(() => h.f.calls("turn/interrupt").length === 1, "interrupt");
    h.f.feed(completed(h, "M0", "interrupted"));
    expect(await p).toEqual({ kind: "cancelled" });
    const r = await steer;
    expect(["injected", "failed"]).toContain(r.outcome);
    if (r.outcome === "injected") expect(h.updates.map((u: Rec) => u._meta?.claudestra?.notice).find(Boolean)).toContain("顺便把测试也跑了");
    await tick(20);
    expect(ids).toHaveLength(1); // 插话没有在打断之后另起一轮
    await nextTurnWorks(h, ids);
  });

  test("同一拍里先打断后插话：插话不注入被打断的那一轮；等它收尾后要么失败、要么作为新一轮开始，不悬挂", async () => {
    const h = harness();
    await h.open();
    const { p, ids } = await running(h);
    const cancel = h.session.cancel();
    const steer = h.session.steer("还有一件事");
    await cancel;
    await until(() => h.f.calls("turn/interrupt").length === 1, "interrupt");
    h.f.feed(completed(h, "M0", "interrupted"));
    expect(await p).toEqual({ kind: "cancelled" });
    expect(h.f.calls("turn/steer")).toHaveLength(0); // 没往已叫停的回合里塞
    await tick(30); // 插话的去向：被叫停的那轮收尾后另起一轮，或直接失败
    if (ids.length === 2) { // 作为新一轮：带着插话的正文开始，照常收尾
      h.f.feed({ id: ids[1]!, result: { turn: { id: "M1", items: [], status: "inProgress" } } }, started(h, "M1"), completed(h, "M1"));
      const r = await steer;
      expect(r.outcome).toBe("startedNewTurn");
      expect(await (r as { done: Promise<unknown> }).done).toEqual({ kind: "done" });
      expect(JSON.stringify(h.f.calls("turn/start")[1])).toContain("还有一件事");
    } else expect(await steer).toEqual({ outcome: "failed" });
    expect(h.f.calls("turn/interrupt")).toHaveLength(1);
  });

  test("打断撞上回合自己收尾，同一拍又来插话：回合只收尾一次，插话不悬挂", async () => {
    const h = harness();
    await h.open();
    const { p, ids } = await running(h);
    const cancel = h.session.cancel();
    h.f.feed(completed(h, "M0", "completed")); // 收尾和打断谁先到适配器都可能：done / cancelled 都对，不能两次收尾
    const steer = h.session.steer("赶上了吗");
    await cancel;
    expect(["done", "cancelled"]).toContain((await p).kind);
    await tick(30);
    const starts = h.f.calls("turn/start").length;
    if (starts === 2) h.f.feed({ id: ids[1]!, result: { turn: { id: "M1", items: [], status: "inProgress" } } }, started(h, "M1"), completed(h, "M1")); // 插话在收尾后另起了一轮
    const r = await steer;
    expect(["failed", "startedNewTurn", "injected", "deliveredUnknown"]).toContain(r.outcome);
    if (r.outcome === "startedNewTurn") await (r as { done: Promise<unknown> }).done;
    expect(h.updates.filter((u: Rec) => u._meta?.codex?.threadStatus?.type === "idle").length).toBe(starts);
    expect(h.f.calls("turn/interrupt").length).toBeLessThanOrEqual(1);
  });
});

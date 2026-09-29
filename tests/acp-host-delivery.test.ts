/**
 * ACP 宿主送给 bridge 的两样东西不能丢（Shawn 本机 Codex r4 的探针改成的回归，断言都朝安全方向）：
 * - P1-2 流式条目：bridge 回 false（watcher 还没挂好）/ 断线 / 重启时留在出站队列里重送，全部确认之前不报成功的 Stop；
 * - P2 权限请求：按 permId 出卡，bridge 经 acp_call 作答，宿主确认还在等才算数；超时 / 适配器退出撤卡，重连登记后补发。
 * 宿主本体是真的，适配器、bridge 连接、/hook 都是假的（不起子进程）。
 */
import { describe, expect, test } from "bun:test";
import { AcpHost } from "../src/lib/acp/host.ts";
import type { StopReport } from "../src/lib/acp/turn.ts";

type Link = { onRegistered(): void; onDown(why: string): void; onFrame(m: Record<string, unknown>): void };
type Accept = (frame: any, n: number) => boolean | { ok: true; lost: number; bridgeEpoch?: string } | "throw";
const text = (t: string) => ({ type: "assistant", message: { content: [{ type: "text", text: t }] } });
const STOP: StopReport = { event: "Stop", stopHookActive: false };

function unitHost(accept: Accept, timings: { drainMs?: number; permissionMs?: number } = {}) {
  const events: string[] = [];
  const sent: any[] = [];
  const stops: any[] = [];
  let link!: Link;
  let up = true;
  let n = 0;
  const host = new AcpHost(
    {
      channelId: "acp-unit", agentName: "probe", sessionId: "sid", cwd: "/tmp", mcpName: "claudestra", agentCmd: ["fake"],
      env: { base: {}, bunBin: "bun", channelServer: "x", mcpName: "claudestra", logsDir: "/tmp" },
      timings: { retryMs: [5], drainMs: 1_000, permissionMs: 60_000, ...timings },
    },
    {
      spawn: () => { throw new Error("单测不起适配器"); },
      makeLink: (d) => {
        link = d as unknown as Link;
        return {
          connect() {},
          send: (f: any) => (up ? (sent.push(f), true) : false),
          async request(f: any) {
            if (!up) throw new Error("bridge 连接还没好");
            const r = accept(f, ++n);
            events.push(`${r === true ? "accepted" : "rejected"}:${f.firstSeq}:${f.entries.map((e: any) => e.message.content[0].text).join(",")}`);
            if (r === "throw") throw new Error("等回包超时");
            return r;
          },
          close() {},
          get up() { return up; },
        } as any;
      },
      startProxy: () => ({ url: "ws://127.0.0.1:1/?t=fake", onBridgeFrame: () => false, failInFlight() {}, close() {} }) as any,
      postHook: async (b) => (events.push(b.event), stops.push(b), {}),
      markReady: async () => {},
      log: () => {},
    },
  );
  const h = host as any;
  const flushing = (...ts: string[]) => (h.translator = { flush: () => ts.map(text), push: () => [] });
  return { host, h, events, sent, stops, link: () => link, setUp: (v: boolean) => void (up = v), flushing };
}

describe("流式条目：没确认就不算送到（r4 P1-2）", () => {
  test("bridge 确认毒条目已丢：本轮 StopFailure；累计丢失数没增长时下一轮可正常 Stop", async () => {
    const u = unitHost(() => ({ ok: true, lost: 1 }));
    u.link().onRegistered();
    u.flushing("first");
    await u.h.reportStop(STOP);
    expect(u.stops.at(-1)?.event).toBe("StopFailure");
    u.flushing("second");
    await u.h.reportStop(STOP);
    expect(u.stops.at(-1)?.event).toBe("Stop");
  });

  test("bridge 重启使累计丢失计数从头算：新一轮同为 1 条仍报 StopFailure", async () => {
    const u = unitHost((_f, n) => ({ ok: true, lost: 1, bridgeEpoch: n === 1 ? "old" : "new" }));
    u.link().onRegistered();
    u.flushing("before restart");
    await u.h.reportStop(STOP);
    u.flushing("after restart");
    await u.h.reportStop(STOP);
    expect(u.stops.map((s) => s.event)).toEqual(["StopFailure", "StopFailure"]);
  });

  test("bridge 永不确认时重送有上限，丢掉批次并按 StopFailure 收尾", async () => {
    const u = unitHost(() => false, { drainMs: 300 });
    u.link().onRegistered();
    u.flushing("stuck");
    await u.h.reportStop(STOP);
    expect(u.stops.at(-1)?.event).toBe("StopFailure");
    expect(u.events.filter((e) => e.startsWith("rejected"))).toHaveLength(9);
  });

  test("首条落在注册窗口里：登记前只排队；登记后 watcher 还没挂好回 false 就重送；确认之后才报 Stop", async () => {
    const u = unitHost((_f, n) => n > 2);
    u.h.pushEntries([text("first")]);
    expect(u.events).toEqual([]);
    u.link().onRegistered();
    u.flushing("final");
    expect(await u.h.reportStop(STOP)).toEqual({});
    expect(u.events.at(-1)).toBe("Stop");
    expect(u.events.filter((e) => e.startsWith("rejected"))).toHaveLength(2);
    expect(u.events.filter((e) => e.startsWith("accepted")).join(" ")).toContain("first");
    expect(u.events.join(" ")).toContain("final");
    expect(u.events.indexOf("Stop")).toBeGreaterThan(u.events.findIndex((e) => e.startsWith("accepted") && e.includes("final")));
  });

  // 原探针：bridge 对最后一批回 false，宿主仍然报了 Stop
  test("bridge 一直不确认（回 false）：不报成功的 Stop，按 StopFailure 报", async () => {
    const u = unitHost(() => false, { drainMs: 60 });
    u.link().onRegistered();
    u.flushing("final answer");
    await u.h.reportStop(STOP);
    expect(u.events).not.toContain("Stop");
    expect(u.stops).toEqual([{ channelId: "acp-unit", event: "StopFailure", stopHookActive: false, acpDeliveryWarning: true }]);
    expect(u.events.filter((e) => e === "rejected:1:final answer").length).toBeGreaterThan(0);
  });

  test("bridge 重启：断线期间的条目重送；旧 watcher 已失去已确认的正文，保守报可能丢失", async () => {
    const u = unitHost(() => true);
    u.link().onRegistered();
    u.h.pushEntries([text("a")]);
    await new Promise((r) => setTimeout(r, 20));
    u.setUp(false);
    u.h.pushEntries([text("b")]);
    u.link().onDown("bridge 重启");
    u.flushing("c");
    const stop = u.h.reportStop(STOP);
    await new Promise((r) => setTimeout(r, 30));
    expect(u.events).not.toContain("Stop");
    u.setUp(true);
    u.link().onRegistered();
    await stop;
    expect(u.events).toEqual(["accepted:1:a", "accepted:2:b,c", "StopFailure"]);
    expect(u.stops[0]).toMatchObject({ acpDeliveryWarning: true });
  });

  test("队列溢出：即使剩余条目后来都确认了，这轮也按可能丢失报 StopFailure", async () => {
    const u = unitHost(() => true);
    u.h.pushEntries(Array.from({ length: 5_001 }, (_, i) => text(String(i))));
    u.link().onRegistered();
    await u.h.reportStop(STOP);
    expect(u.events).not.toContain("Stop");
    expect(u.stops).toEqual([{ channelId: "acp-unit", event: "StopFailure", stopHookActive: false, acpDeliveryWarning: true }]);
  });
});

describe("权限请求：按 permId、宿主确认还在等（r4 P1-1 / P2）", () => {
  const card = { toolCallId: "c1", title: "rm", detail: "rm -rf x", options: [{ id: "allow_once", label: "Allow", style: "success" }] };
  const call = (u: ReturnType<typeof unitHost>, id: string, permId: string) => u.link().onFrame({ type: "acp_call", id, op: "permission", permId, optionId: "allow_once" });
  const result = (u: ReturnType<typeof unitHost>, id: string) => u.sent.find((f) => f.type === "acp_call_result" && f.id === id);

  test("bridge 作答 → 返回选项、回 ok；同一个再答一次 → 不在等了", async () => {
    const u = unitHost(() => true);
    u.link().onRegistered();
    const answer = u.h.askPermission(card);
    const frame = u.sent.find((f) => f.type === "acp_permission");
    const permId = String(frame.permId); // 先取出来：bun 的 toMatchObject 配 asymmetric matcher 会把被比对象上的这个字段改掉
    expect(permId).toMatch(/^[0-9a-f]{12}-1$/);
    expect(frame.card).toEqual(card);
    call(u, "k1", permId);
    expect(await answer).toBe("allow_once");
    expect(result(u, "k1")).toMatchObject({ ok: true });
    call(u, "k2", permId);
    expect(result(u, "k2")).toMatchObject({ ok: false, error: expect.stringContaining("不在等") });
  });

  test("等太久：按取消回适配器、通知 bridge 撤卡；之后 bridge 再来作答 → 不在等了", async () => {
    const u = unitHost(() => true, { permissionMs: 20 });
    u.link().onRegistered();
    const answer = u.h.askPermission(card);
    const { permId } = u.sent.find((f) => f.type === "acp_permission");
    expect(await answer).toBeNull();
    expect(u.sent.find((f) => f.gone)).toMatchObject({ type: "acp_permission", permId, gone: expect.stringContaining("没人答") });
    call(u, "k3", permId);
    expect(result(u, "k3")).toMatchObject({ ok: false });
  });

  test("适配器退出：在等的都按取消收尾并撤卡", async () => {
    const u = unitHost(() => true);
    u.link().onRegistered();
    const answer = u.h.askPermission(card);
    u.h.stopping = true; // 不让它真去重起适配器
    u.h.onAdapterExit(null, 137, Date.now());
    expect(await answer).toBeNull();
    expect(u.sent.find((f) => f.gone)).toMatchObject({ gone: "适配器退出了" });
  });

  test("断线期间出的请求、以及重连（bridge 重启）时还在等的：登记上了补发同一个 permId", async () => {
    const u = unitHost(() => true);
    u.setUp(false);
    const answer = u.h.askPermission(card);
    expect(u.sent).toEqual([]);
    u.setUp(true);
    u.link().onRegistered();
    const [first] = u.sent.filter((f) => f.type === "acp_permission");
    u.link().onRegistered();
    const again = u.sent.filter((f) => f.type === "acp_permission");
    expect(again).toHaveLength(2);
    expect(again[1].permId).toBe(first.permId);
    call(u, "k4", first.permId);
    expect(await answer).toBe("allow_once");
  });

  test("打断立刻撤权限卡：旧批准即使在 StopFailure 之前到也不能落地", async () => {
    const u = unitHost(() => true);
    u.link().onRegistered();
    const answer = u.h.askPermission(card);
    const { permId } = u.sent.find((f) => f.type === "acp_permission");
    u.link().onFrame({ type: "abort", id: "cut-1" });
    expect(await answer).toBeNull();
    expect(u.sent.find((f) => f.permId === permId && f.gone)).toMatchObject({ gone: "回合已打断" });
    call(u, "stale-cut", permId);
    expect(result(u, "stale-cut")).toMatchObject({ ok: false });
  });
});

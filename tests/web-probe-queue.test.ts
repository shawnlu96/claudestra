/**
 * T37b r3b / r4：试解析排队（web/lib/chat/probe-queue.ts）——按 Worker 自己量的耗时判 slow、卡住的杀掉重起、
 * Worker 起不来退回同步（null）、结论缓存。
 */
import { describe, expect, test } from "bun:test";
import { createProbeQueue, type ProbeReply, type ProbeWorker } from "@/lib/chat/probe-queue";

type Behavior = "ok" | "complex" | "over" | "hang" | "silent";
/** 假 Worker：按 md 决定怎么回。over = 算完了但自己量的耗时超预算；hang = 开工后不再回（解析卡住）；silent = 连开工都不回 */
function fakeSpawner(behave: (md: string) => Behavior) {
  const log = { spawned: 0, terminated: 0, jobs: [] as string[] };
  const spawn = (): ProbeWorker => {
    log.spawned++;
    const w: ProbeWorker = {
      onmessage: null,
      onerror: null,
      terminate: () => void log.terminated++,
      postMessage(msg) {
        const { id, payload } = msg as { id: number; payload: { md: string } };
        log.jobs.push(payload.md);
        const b = behave(payload.md);
        if (b === "silent") return;
        const reply = (d: ProbeReply) => queueMicrotask(() => w.onmessage?.({ data: d }));
        reply({ id, started: true });
        if (b !== "hang") setTimeout(() => reply({ id, ok: b !== "complex", ms: b === "over" ? 31 : 5 }), 1);
      },
    };
    return w;
  };
  return { spawn, log };
}

const opts = { budget: 30, start: 60 };

describe("createProbeQueue", () => {
  test("ok / complex 照实返回，并缓存", async () => {
    const { spawn, log } = fakeSpawner((md) => (md === "bad" ? "complex" : "ok"));
    const q = createProbeQueue(spawn, opts);
    expect(await q.probe("good", { md: "good" })).toBe("ok");
    expect(await q.probe("bad", { md: "bad" })).toBe("complex");
    expect(q.cached("good")).toBe("ok");
    expect(await q.probe("good", { md: "good" })).toBe("ok");
    expect(log.jobs).toEqual(["good", "bad"]);
    expect(log.spawned).toBe(1);
  });

  test("超预算判 slow：杀掉 Worker，下一段重新起一个", async () => {
    const { spawn, log } = fakeSpawner((md) => (md === "bomb" ? "hang" : "ok"));
    const q = createProbeQueue(spawn, opts);
    const [a, b] = await Promise.all([q.probe("bomb", { md: "bomb" }), q.probe("after", { md: "after" })]);
    expect(a).toBe("slow");
    expect(b).toBe("ok");
    expect(log.terminated).toBe(1);
    expect(log.spawned).toBe(2);
    expect(q.available()).toBe(true);
  });

  test("按 Worker 自己量的耗时判：超预算判 slow（主线程收消息晚不影响），不杀 Worker", async () => {
    const { spawn, log } = fakeSpawner((md) => (md === "long" ? "over" : "ok"));
    const q = createProbeQueue(spawn, opts);
    expect(await q.probe("long", { md: "long" })).toBe("slow");
    expect(await q.probe("short", { md: "short" })).toBe("ok");
    expect(log.terminated).toBe(0);
    expect(log.spawned).toBe(1);
  });

  test("主线程卡 100 ms 才处理消息：按 Worker 量的耗时判，不改判 slow", async () => {
    const { spawn } = fakeSpawner(() => "ok");
    const q = createProbeQueue(spawn, opts);
    const p = q.probe("busy", { md: "busy" });
    const end = performance.now() + 100; // 模拟主线程在渲染：消息和计时器都排着
    while (performance.now() < end);
    expect(await p).toBe("ok");
  });

  test("同一段并发只解析一次", async () => {
    const { spawn, log } = fakeSpawner(() => "ok");
    const q = createProbeQueue(spawn, opts);
    expect(await Promise.all([q.probe("x", { md: "x" }), q.probe("x", { md: "x" })])).toEqual(["ok", "ok"]);
    expect(log.jobs).toEqual(["x"]);
  });

  test("迟迟不开工 = Worker 起不来：当前和排队的都返回 null，之后不再用 Worker", async () => {
    const { spawn } = fakeSpawner(() => "silent");
    const q = createProbeQueue(spawn, opts);
    expect(await Promise.all([q.probe("a", { md: "a" }), q.probe("b", { md: "b" })])).toEqual([null, null]);
    expect(q.available()).toBe(false);
    expect(await q.probe("c", { md: "c" })).toBeNull();
  });

  test("构造 Worker 就抛错（不支持 / CSP）：返回 null", async () => {
    const q = createProbeQueue(() => {
      throw new Error("no worker");
    }, opts);
    expect(await q.probe("a", { md: "a" })).toBeNull();
    expect(q.available()).toBe(false);
  });

  test("Worker 报错（脚本加载失败）：返回 null", async () => {
    let w: ProbeWorker | undefined;
    const q = createProbeQueue(() => {
      w = { onmessage: null, onerror: null, terminate() {}, postMessage: () => queueMicrotask(() => w!.onerror?.(new Error("load"))) };
      return w;
    }, opts);
    expect(await q.probe("a", { md: "a" })).toBeNull();
  });
});

/**
 * T37b r3b：试解析排队（web/lib/chat/probe-queue.ts）——超预算判 slow 并杀掉 Worker、Worker 起不来退回同步（null）、结论缓存。
 */
import { describe, expect, test } from "bun:test";
import { createProbeQueue, type ProbeReply, type ProbeWorker } from "@/lib/chat/probe-queue";

type Behavior = "ok" | "complex" | "hang" | "silent";
/** 假 Worker：按 md 决定怎么回。hang = 开工后不再回（解析卡住）；silent = 连开工都不回（脚本没加载） */
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
        if (b !== "hang") setTimeout(() => reply({ id, ok: b === "ok" }), 1);
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

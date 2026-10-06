/**
 * /clear 会话轮转必须按 agent 的运行时去找新会话。三个入口都不传 runtime，
 * 以前缺省去 CC 的目录找：Pi 的新会话永远找不到，120s 后静默超时（registry / watcher / 历史冻在旧会话）。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createClearRotation } from "../src/bridge/clear-rotation.js";
import { REGISTRY_PATH } from "../src/lib/registry.js";

function harness(clientRuntime: string | undefined) {
  const listedWith: (string | undefined)[] = [];
  const manager: string[][] = [];
  let rewatched: { sid: string; runtime: string | undefined } | null = null;
  const schedule = createClearRotation({
    clientRuntime: () => clientRuntime,
    runManager: async (...args) => {
      manager.push(args);
      return args[0] === "list" ? { agents: [] } : { ok: true };
    },
    rewatch: (_name, _cwd, sid, _cid, runtime) => void (rewatched = { sid, runtime }),
    listSessionIds: (_cwd, runtime) => {
      listedWith.push(runtime);
      return listedWith.length === 1 ? ["old"] : ["new", "old"]; // 快照时只有旧会话，之后出现新会话
    },
  });
  const done = async () => {
    for (let i = 0; i < 40 && !rewatched; i++) await Bun.sleep(100);
    return rewatched;
  };
  return { schedule, listedWith, manager, done };
}

describe("scheduleClearRotation 按运行时找新会话", () => {
  let prior: string | null = null;
  beforeAll(() => {
    prior = existsSync(REGISTRY_PATH) ? readFileSync(REGISTRY_PATH, "utf8") : null;
    writeFileSync(REGISTRY_PATH, JSON.stringify({ agents: { "agent-pi": { runtime: "pi", channelId: "p1", status: "active" } } }));
  });
  afterAll(() => (prior === null ? unlinkSync(REGISTRY_PATH) : writeFileSync(REGISTRY_PATH, prior)));

  test("Pi 连接自报的运行时：到 Pi 的目录找、认领新会话、按 Pi 重挂 watcher", async () => {
    const h = harness("pi");
    h.schedule("agent-pi", "p1", "/w", "old");
    expect(await h.done()).toEqual({ sid: "new", runtime: "pi" });
    expect(h.listedWith.every((r) => r === "pi")).toBe(true);
    expect(h.manager).toContainEqual(["set-session", "agent-pi", "new", "--expected", "old"]);
  });

  test("连接没自报（断线重连中）时退回 registry 的运行时", async () => {
    const h = harness(undefined);
    h.schedule("agent-pi", "p1", "/w", "old");
    expect(await h.done()).toEqual({ sid: "new", runtime: "pi" });
    expect(h.listedWith[0]).toBe("pi");
  });

  test("CC agent（两边都没有运行时）照旧按 CC 找", async () => {
    const h = harness(undefined);
    h.schedule("agent-cc", "c1", "/w", "old");
    expect(await h.done()).toEqual({ sid: "new", runtime: undefined });
    expect(h.listedWith[0]).toBeUndefined();
  });
});

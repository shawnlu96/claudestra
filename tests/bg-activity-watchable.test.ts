/**
 * BML-1：bg-activity / model-drift 只看 Claude Code agent。
 * codex / pi 的会话不在 ~/.claude/projects，推路径会落到全库扫描（Bun 1.3.14 下每次漏原生内存）。
 */
import { afterAll, beforeAll, describe, test, expect } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { isWatchableAgent, pollBgActivitiesForTest, watchableAgents } from "../src/bridge/bg-activity-watcher.js";
import { subscribeEvents, type BridgeEvent } from "../src/bridge/event-bus.js";
import { isDriftCheckable } from "../src/bridge/model-drift.js";
import { jsonlMissCacheSizeForTest, projectJsonlPath, subagentsDir } from "../src/lib/jsonl-cost.js";
import type { RegistryAgent } from "../src/lib/registry.js";

const base: RegistryAgent = { name: "agent-x", status: "active", channelId: "1", sessionId: "s", cwd: "/tmp/x" };

describe.each([
  ["isWatchableAgent", isWatchableAgent],
  ["isDriftCheckable", isDriftCheckable],
] as const)("%s", (_name, pred) => {
  test("没有 runtime（老 agent）与 claude-code 保留", () => {
    expect(pred(base)).toBe(true);
    expect(pred({ ...base, runtime: "claude-code" })).toBe(true);
  });

  test("pi / codex 排除", () => {
    expect(pred({ ...base, runtime: "pi" })).toBe(false);
    expect(pred({ ...base, runtime: "codex" })).toBe(false);
  });

  test("缺 channelId / sessionId / cwd 排除", () => {
    expect(pred({ ...base, channelId: undefined })).toBe(false);
    expect(pred({ ...base, sessionId: undefined })).toBe(false);
    expect(pred({ ...base, cwd: undefined })).toBe(false);
  });
});

test("model-drift 只看 active", () => {
  expect(isDriftCheckable({ ...base, status: "stopped" })).toBe(false);
});

describe("watchableAgents + 真 tick：CC agent 照常发现 subagent / 后台 shell，codex / pi 不进扫描", () => {
  let root = "";
  let oldHome: string | undefined;
  let unsub = () => {};
  const events: BridgeEvent[] = [];
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "bg-watchable-"));
    oldHome = process.env.HOME;
    process.env.HOME = join(root, "home");
    unsub = subscribeEvents({ allow: (e) => e.agent.startsWith("watchable-") }, (e) => events.push(e));
  });
  afterAll(() => {
    unsub();
    process.env.HOME = oldHome;
    rmSync(root, { recursive: true, force: true });
  });

  test("cc 两类活动都开流；pi / codex 没事件、也没触发全库兜底", async () => {
    const entry = (name: string, runtime?: string) => ({
      status: "active", channelId: `local-${name}`, cwd: join(root, "proj", name), sessionId: `sess-${name}`, ...(runtime ? { runtime } : {}),
    });
    const registry = join(root, "registry.json");
    writeFileSync(registry, JSON.stringify({ agents: {
      "watchable-cc": entry("cc"), "watchable-pi": entry("pi", "pi"), "watchable-codex": entry("codex", "codex"),
    } }));
    const listed = await watchableAgents(registry);
    expect(listed.map((a) => a.name)).toEqual(["watchable-cc"]);

    const cc = listed[0];
    const jsonl = projectJsonlPath(cc.cwd, cc.sessionId);
    mkdirSync(join(jsonl, ".."), { recursive: true });
    writeFileSync(jsonl, "");
    const subs = subagentsDir(cc.cwd, cc.sessionId);
    mkdirSync(subs, { recursive: true });
    const tasks = join(root, "tasks");
    mkdirSync(tasks, { recursive: true });

    let clock = 1_800_000_000_000;
    const missBefore = jsonlMissCacheSizeForTest();
    const poll = () => pollBgActivitiesForTest({ now: () => (clock += 10_000), agents: () => watchableAgents(registry), shellDir: () => tasks });
    await poll(); // 首轮 baseline
    writeFileSync(join(subs, "agent-w1.jsonl"), JSON.stringify({ type: "user", timestamp: new Date(clock).toISOString(), message: { role: "user", content: [{ type: "text", text: "go" }] } }) + "\n");
    writeFileSync(join(tasks, "w2.output"), "running\n");
    appendFileSync(jsonl, JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "Command running in background with ID: w2" }] } }) + "\n");
    await poll();

    const started = (id: string) => events.filter((e) => e.type === "bg_task_started" && (e.data as { id?: string }).id === id);
    expect(started("agent-w1")[0]?.data).toMatchObject({ kind: "subagent" });
    expect(started("w2")[0]?.data).toMatchObject({ kind: "shell" });
    expect(events.filter((e) => e.agent !== "watchable-cc")).toEqual([]);
    expect(jsonlMissCacheSizeForTest()).toBe(missBefore);
  });
});

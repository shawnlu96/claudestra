/**
 * v2.9+ lib/registry.ts 单测：registry.json 单点读取 —— 字段归一 / active 过滤 / 容错
 */

import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readRegistryAgents, readActiveAgents } from "../src/lib/registry.js";

function writeRegistry(obj: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "registry-test-"));
  const p = join(dir, "registry.json");
  writeFileSync(p, typeof obj === "string" ? obj : JSON.stringify(obj));
  return p;
}

describe("readRegistryAgents", () => {
  test("字段归一：cwd 缺失时回退历史字段 dir，非字符串字段丢弃", async () => {
    const p = writeRegistry({
      agents: {
        "agent-a": { status: "active", channelId: "111", sessionId: "s1", cwd: "/repo/a" },
        "agent-b": { status: "active", channelId: "222", sessionId: "s2", dir: "/repo/b" },
        "agent-c": { status: "killed", channelId: 333, purpose: "旧数据" },
      },
    });
    const all = await readRegistryAgents(p);
    expect(all.length).toBe(3);
    expect(all.find((a) => a.name === "agent-a")?.cwd).toBe("/repo/a");
    expect(all.find((a) => a.name === "agent-b")?.cwd).toBe("/repo/b");
    // channelId 是 number（脏数据）→ undefined，不抛错
    expect(all.find((a) => a.name === "agent-c")?.channelId).toBeUndefined();
  });

  test("active 过滤", async () => {
    const p = writeRegistry({
      agents: {
        "agent-a": { status: "active" },
        "agent-b": { status: "killed" },
        "agent-c": {},
      },
    });
    const active = await readActiveAgents(p);
    expect(active.map((a) => a.name)).toEqual(["agent-a"]);
  });

  test("external 布尔字段被完整映射(2026-08-26 Codex review:曾被 str() 帮手丢掉)", async () => {
    const p = writeRegistry({
      agents: {
        "agent-ext": { status: "active", external: true },
        "agent-plain": { status: "active" },
        "agent-dirty": { status: "active", external: "yes" },
      },
    });
    const all = await readRegistryAgents(p);
    expect(all.find((a) => a.name === "agent-ext")?.external).toBe(true);
    expect(all.find((a) => a.name === "agent-plain")?.external).toBe(false);
    // 脏数据(非布尔)按 false 处理,不抛
    expect(all.find((a) => a.name === "agent-dirty")?.external).toBe(false);
  });

  test("容错：文件缺失 / 坏 JSON / 无 agents 键都返回空数组", async () => {
    expect(await readRegistryAgents("/no/such/registry.json")).toEqual([]);
    expect(await readRegistryAgents(writeRegistry("not json{{{"))).toEqual([]);
    expect(await readRegistryAgents(writeRegistry({ something: "else" }))).toEqual([]);
  });
});

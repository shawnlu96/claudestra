/**
 * v2.9+ lib/registry.ts 单测：registry.json 单点读取 —— 字段归一 / active 过滤 / 容错
 */

import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readRegistryAgents, readActiveAgents, isMasterAgent } from "../src/lib/registry.js";

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

  test("runtime 字段被读出（v2.23+ Pi 会话纳管；漏读 = Pi agent 被当成 Claude Code 起）", async () => {
    const p = writeRegistry({
      agents: {
        "agent-pi": { status: "active", runtime: "pi" },
        "agent-cc": { status: "active" },
      },
    });
    const all = await readRegistryAgents(p);
    expect(all.find((a) => a.name === "agent-pi")?.runtime).toBe("pi");
    expect(all.find((a) => a.name === "agent-cc")?.runtime).toBeUndefined();
  });
});

// ── isMasterAgent（2026-09-18 大总管恒判 dead）──────────────────────────────
// registry 的**键**是 `agent-master`，tmux 窗口名和 CLI 参数却是裸 `master`。
// 只认一种就会在两处对不上：`manager.ts list` 的孤儿检测只比 `agent-*` 窗口名，
// 于是 `agent-master` 永远不在集合里 → 恒判 dead → launcher 每分钟 restart 一次
// → 而 master 的 channelId 按设计为空、restart 硬要求它 ⇒ 永远失败。
// 实测 3678 次空转后才被发现。
describe("isMasterAgent", () => {
  test("两种写法都认（这正是本 bug 的成因）", () => {
    expect(isMasterAgent("master")).toBe(true);
    expect(isMasterAgent("agent-master")).toBe(true);
  });

  test("普通 agent 不认", () => {
    expect(isMasterAgent("agent-market-maker")).toBe(false);
    expect(isMasterAgent("market-maker")).toBe(false);
  });

  test("名字里含 master 但不是大总管 → 不认（别写成 includes）", () => {
    expect(isMasterAgent("agent-master-plan")).toBe(false);
    expect(isMasterAgent("masterful")).toBe(false);
    expect(isMasterAgent("agent-remaster")).toBe(false);
  });

  test("空值安全", () => {
    expect(isMasterAgent(undefined)).toBe(false);
    expect(isMasterAgent(null)).toBe(false);
    expect(isMasterAgent("")).toBe(false);
  });
});

import { normalizeRegistryAgents, readRegistryAgentsSync } from "../src/lib/registry";
import { mkdtempSync as mkdtempP11, writeFileSync as writeP11 } from "fs";
import { tmpdir as tmpdirP11 } from "os";
import { join as joinP11 } from "path";

describe("registry 读者：损坏 ≠ 空", () => {
  test("脏条目（null）→ 空数组，不抛", () => {
    expect(normalizeRegistryAgents({ agents: { x: null } })).toEqual([]);
    expect(normalizeRegistryAgents(null)).toEqual([]);
  });

  test("运行中文件被写坏 → 沿用上次成功值（async / sync 各自）", async () => {
    const dir = mkdtempP11(joinP11(tmpdirP11(), "reg-corrupt-"));
    const p = joinP11(dir, "registry.json");
    writeP11(p, JSON.stringify({ agents: { a: { status: "active", channelId: "1" } } }));
    expect((await readRegistryAgents(p)).map((a) => a.name)).toEqual(["a"]);
    expect(readRegistryAgentsSync(p).map((a) => a.name)).toEqual(["a"]);
    writeP11(p, "{half");
    expect((await readRegistryAgents(p)).map((a) => a.name)).toEqual(["a"]);
    expect(readRegistryAgentsSync(p).map((a) => a.name)).toEqual(["a"]);
  });

  test("冷启动就坏 / 不存在 → 空数组", async () => {
    const dir = mkdtempP11(joinP11(tmpdirP11(), "reg-cold-"));
    const p = joinP11(dir, "registry.json");
    expect(await readRegistryAgents(p)).toEqual([]);
    writeP11(p, "{half");
    expect(await readRegistryAgents(p)).toEqual([]);
    expect(readRegistryAgentsSync(p)).toEqual([]);
  });
});

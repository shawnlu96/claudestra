/**
 * agent 设置文件（lib/agent-settings.ts）跟着 create / kill / remove / rename 走，含做到一半再跑的补跑路径。
 * 命令用 tests/resumable-world 的假世界跑（registry / 窗口 / 频道都是假件），设置文件落在 tests/preload.ts 隔离的临时状态目录。
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { makeWorld } from "./resumable-world";
import { agentSettingsPath, setSkillOverride } from "../src/lib/agent-settings";
import { abandonCreate, beginCreate, commitCreate, newCreateRun, recordCreate } from "../src/manager/create-guard";
import { runKill, runRemove } from "../src/manager/agent-kill";
import { runRename } from "../src/manager/agent-rename";
import type { AgentInfo } from "../src/manager/core";

const LIVE: AgentInfo = { project: "/p", purpose: "live", created: "t0", status: "active", channelId: "ch1", notes: "", cwd: "/p", sessionId: "s1" };
const pending = { op: "rename" as const, pid: 1, startedAt: "2026-09-28T10:00:00Z", from: "agent-a" };
const has = (name: string) => existsSync(agentSettingsPath(name));
const overridesOf = (name: string) => JSON.parse(readFileSync(agentSettingsPath(name), "utf8")).skillOverrides;
const clear = async (...names: string[]) => { for (const n of names) if (has(n)) await setSkillOverride(n, "pdf", "on"); };

describe("rename", () => {
  test("首次：挪过去；目标位置有删过的 agent 留下的旧文件也会被替换", async () => {
    await clear("agent-a", "agent-b");
    await setSkillOverride("agent-a", "pdf", "off");
    await setSkillOverride("agent-b", "save", "off"); // 同名旧 agent 删了但文件还在
    const w = makeWorld({ reg: { socket: "s", agents: { "agent-a": LIVE } }, windows: ["agent-a"], channels: new Set(["ch1"]) });
    expect((await runRename("a", "b", w.deps)).ok).toBe(true);
    expect(has("agent-a")).toBe(false);
    expect(overridesOf("agent-b")).toEqual({ pdf: "off" });
  });
  test("首次、源没有文件：清掉目标位置的旧文件（不继承删过的 agent 的开关）", async () => {
    await clear("agent-a", "agent-b");
    await setSkillOverride("agent-b", "save", "off");
    const w = makeWorld({ reg: { socket: "s", agents: { "agent-a": LIVE } }, windows: ["agent-a"], channels: new Set(["ch1"]) });
    await runRename("a", "b", w.deps);
    expect(has("agent-b")).toBe(false);
  });
  test("补跑、上次 registry 已迁、文件还没挪：这次挪过去", async () => {
    await clear("agent-a", "agent-b");
    await setSkillOverride("agent-a", "pdf", "off");
    const w = makeWorld({ reg: { socket: "s", agents: { "agent-b": { ...LIVE, pending } } }, channels: new Set(["ch1"]) });
    expect(await runRename("a", "b", w.deps)).toMatchObject({ ok: true, resumed: true });
    expect(has("agent-a")).toBe(false);
    expect(overridesOf("agent-b")).toEqual({ pdf: "off" });
  });
  test("补跑、上次文件已经挪过去：目标原样保留，不删", async () => {
    await clear("agent-a", "agent-b");
    await setSkillOverride("agent-b", "pdf", "off");
    const w = makeWorld({ reg: { socket: "s", agents: { "agent-b": { ...LIVE, pending } } }, channels: new Set(["ch1"]) });
    await runRename("a", "b", w.deps);
    expect(overridesOf("agent-b")).toEqual({ pdf: "off" });
  });
  test("补跑、旧名已被新 agent 占用：两边的文件都不动", async () => {
    await clear("agent-a", "agent-b");
    await setSkillOverride("agent-a", "save", "off"); // 新 agent 自己的
    await setSkillOverride("agent-b", "pdf", "off");
    const w = makeWorld({ reg: { socket: "s", agents: { "agent-b": { ...LIVE, pending }, "agent-a": { ...LIVE, channelId: "chA" } } }, channels: new Set(["ch1"]) });
    await runRename("a", "b", w.deps);
    expect(overridesOf("agent-a")).toEqual({ save: "off" });
    expect(overridesOf("agent-b")).toEqual({ pdf: "off" });
  });
});

describe("kill / remove / create", () => {
  test("kill 只是停止：保留；remove：删", async () => {
    await setSkillOverride("agent-k", "pdf", "off");
    const w = makeWorld({ reg: { socket: "s", agents: { "agent-k": LIVE } }, windows: ["agent-k"], channels: new Set(["ch1"]) });
    expect((await runKill("agent-k", w.deps)).ok).toBe(true);
    expect(has("agent-k")).toBe(true);
    expect((await runRemove("agent-k", w.deps)).ok).toBe(true);
    expect(has("agent-k")).toBe(false);
  });
  test("create 成功提交后才删同名旧文件；失败放弃时停止的同名 agent 的档位还在", async () => {
    const stopped = { ...LIVE, status: "stopped" as const };
    for (const commit of [false, true]) {
      await setSkillOverride("agent-c", "pdf", "off");
      const w = makeWorld({ reg: { socket: "s", agents: { "agent-c": stopped } }, channels: new Set(["ch1"]) });
      const run = newCreateRun();
      expect((await beginCreate("agent-c", "c", { project: "/p", purpose: "new", cwd: "/p" }, w.deps, run)).ok).toBe(true);
      const ch = w.createChannel("agent-c");
      await recordCreate("agent-c", { channelId: ch }, w.deps, run);
      if (commit) expect(await commitCreate("agent-c", { ...LIVE, channelId: ch }, w.deps, run)).toBe("ok");
      else await abandonCreate("agent-c", { channelId: ch }, w.deps, run);
      expect(has("agent-c")).toBe(!commit);
      if (!commit) expect(w.st.reg.agents["agent-c"]).toMatchObject({ status: "stopped" }); // 旧条目被放回
    }
  });
});

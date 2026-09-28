/**
 * agent 设置文件（lib/agent-settings.ts）跟着 create / kill / remove / rename 走，含做到一半再跑的补跑路径。
 * 命令用 tests/resumable-world 的假世界跑（registry / 窗口 / 频道都是假件），设置文件落在 tests/preload.ts 隔离的临时状态目录。
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { makeWorld } from "./resumable-world";
import { agentSettingsPath, releaseNameForFreshAgent, removeAgentSettings, setSkillOverride } from "../src/lib/agent-settings";
import { abandonCreate, beginCreate, commitCreate, newCreateRun, recordCreate } from "../src/manager/create-guard";
import { runKill, runRemove } from "../src/manager/agent-kill";
import { runRename } from "../src/manager/agent-rename";
import type { AgentInfo } from "../src/manager/core";

const LIVE: AgentInfo = { project: "/p", purpose: "live", created: "t0", status: "active", channelId: "ch1", notes: "", cwd: "/p", sessionId: "s1" };
const pending = { op: "rename" as const, pid: 1, startedAt: "2026-09-28T10:00:00Z", from: "agent-a" };
const has = (name: string) => existsSync(agentSettingsPath(name));
const overridesOf = (name: string) => JSON.parse(readFileSync(agentSettingsPath(name), "utf8")).skillOverrides;
const clear = (...names: string[]) => { for (const n of names) removeAgentSettings(n); };

describe("rename", () => {
  test("首次：挪过去；目标位置有删过的 agent 留下的旧文件也会被替换", async () => {
    clear("agent-a", "agent-b");
    await setSkillOverride("agent-a", "pdf", "off");
    await setSkillOverride("agent-b", "save", "off"); // 同名旧 agent 删了但文件还在
    const w = makeWorld({ reg: { socket: "s", agents: { "agent-a": LIVE } }, windows: ["agent-a"], channels: new Set(["ch1"]) });
    expect((await runRename("a", "b", w.deps)).ok).toBe(true);
    expect(has("agent-a")).toBe(false);
    expect(overridesOf("agent-b")).toEqual({ pdf: "off" });
  });
  test("首次、源没有文件：清掉目标位置的旧文件（不继承删过的 agent 的开关）", async () => {
    clear("agent-a", "agent-b");
    await setSkillOverride("agent-b", "save", "off");
    const w = makeWorld({ reg: { socket: "s", agents: { "agent-a": LIVE } }, windows: ["agent-a"], channels: new Set(["ch1"]) });
    await runRename("a", "b", w.deps);
    expect(has("agent-b")).toBe(false);
  });
  test("补跑、上次 registry 已迁、文件还没挪：这次挪过去", async () => {
    clear("agent-a", "agent-b");
    await setSkillOverride("agent-a", "pdf", "off");
    const w = makeWorld({ reg: { socket: "s", agents: { "agent-b": { ...LIVE, pending } } }, channels: new Set(["ch1"]) });
    expect(await runRename("a", "b", w.deps)).toMatchObject({ ok: true, resumed: true });
    expect(has("agent-a")).toBe(false);
    expect(overridesOf("agent-b")).toEqual({ pdf: "off" });
  });
  test("补跑、上次文件已经挪过去：目标原样保留，不删", async () => {
    clear("agent-a", "agent-b");
    await setSkillOverride("agent-b", "pdf", "off");
    const w = makeWorld({ reg: { socket: "s", agents: { "agent-b": { ...LIVE, pending } } }, channels: new Set(["ch1"]) });
    await runRename("a", "b", w.deps);
    expect(overridesOf("agent-b")).toEqual({ pdf: "off" });
  });
  test("补跑、旧名已被新 agent 占用：两边的文件都不动", async () => {
    clear("agent-a", "agent-b");
    await setSkillOverride("agent-a", "save", "off"); // 新 agent 自己的
    await setSkillOverride("agent-b", "pdf", "off");
    const w = makeWorld({ reg: { socket: "s", agents: { "agent-b": { ...LIVE, pending }, "agent-a": { ...LIVE, channelId: "chA" } } }, channels: new Set(["ch1"]) });
    await runRename("a", "b", w.deps);
    expect(overridesOf("agent-a")).toEqual({ save: "off" });
    expect(overridesOf("agent-b")).toEqual({ pdf: "off" });
  });
});

describe("rename 做到一半被砍、新进程补跑（resumable-world 的 crashAfter）", () => {
  const start = () => makeWorld({ reg: { socket: "s", agents: { "agent-a": LIVE } }, windows: ["agent-a"], channels: new Set(["ch1"]) });
  // save#1 = registry 已迁、文件还没挪；其余都在挪完之后
  for (const cut of ["save#1", "renameWindow#1", "renameLedger#1", "renameChannel#1", "save#2"]) {
    test(`砍在 ${cut}：补跑后文件在新名下、旧名下没有；再跑一次也不删`, async () => {
      clear("agent-a", "agent-b");
      await setSkillOverride("agent-a", "pdf", "off");
      const w = start();
      w.crashAfter(cut);
      await expect(runRename("a", "b", w.deps)).rejects.toThrow();
      expect(has(cut === "save#1" ? "agent-a" : "agent-b")).toBe(true); // 砍的时候文件在哪
      w.restart();
      const r = await runRename("a", "b", w.deps);
      expect(r.ok).toBe(cut !== "save#2"); // 砍在最后一次落盘之后 = 其实已做完，补跑找不到 agent-a
      expect(has("agent-a")).toBe(false);
      expect(overridesOf("agent-b")).toEqual({ pdf: "off" });
      await runRename("a", "b", w.deps); // 已经做完：找不到 agent-a，什么都不碰
      expect(overridesOf("agent-b")).toEqual({ pdf: "off" });
    });
  }
  test("砍在 registry 之后、同名新 agent 已建好并调过技能：补跑不碰新 agent 的文件，也不拿它当源", async () => {
    clear("agent-a", "agent-b");
    await setSkillOverride("agent-a", "pdf", "off");
    const w = start();
    w.crashAfter("save#1");
    await expect(runRename("a", "b", w.deps)).rejects.toThrow();
    w.restart();
    w.st.reg.agents["agent-a"] = { ...LIVE, channelId: "chA", purpose: "新来的" }; // 新 agent 建成时旧文件已被 commitCreate 删，这份是它自己调的
    await setSkillOverride("agent-a", "pdf", "on");
    await setSkillOverride("agent-a", "save", "off");
    const r = await runRename("a", "b", w.deps);
    expect(r).toMatchObject({ ok: true, resumed: true });
    expect(overridesOf("agent-a")).toEqual({ save: "off" });
    expect(has("agent-b")).toBe(false);
  });
});

describe("rename 砍断后、补跑之前有人插进来（adv3 P2-2）", () => {
  const cutAfterRegistry = async () => {
    clear("agent-a", "agent-b");
    await setSkillOverride("agent-a", "pdf", "off");
    // 已停止的 agent 改名（没有窗口：窗口还在的话同名 create 会被拒）
    const w = makeWorld({ reg: { socket: "s", agents: { "agent-a": { ...LIVE, status: "stopped" } } }, channels: new Set(["ch1"]) });
    w.crashAfter("save#1");
    await expect(runRename("a", "b", w.deps)).rejects.toThrow();
    w.restart();
    return w;
  };
  test("同名 create 提交：旧名的文件是改名那位的，替它挪到新名，不删；之后补跑（旧名被占）也不动", async () => {
    const w = await cutAfterRegistry();
    const run = newCreateRun();
    expect((await beginCreate("agent-a", "a", { project: "/p", purpose: "new", cwd: "/p" }, w.deps, run)).ok).toBe(true);
    const ch = w.createChannel("agent-a");
    await recordCreate("agent-a", { channelId: ch }, w.deps, run);
    expect(await commitCreate("agent-a", { ...LIVE, channelId: ch }, w.deps, run)).toBe("ok");
    expect(has("agent-a")).toBe(false); // 新 agent 不继承
    expect(overridesOf("agent-b")).toEqual({ pdf: "off" });
    expect(await runRename("a", "b", w.deps)).toMatchObject({ ok: true, resumed: true });
    expect(has("agent-a")).toBe(false);
    expect(overridesOf("agent-b")).toEqual({ pdf: "off" });
  });
  test("没有 rename 在补跑时照旧删同名旧文件", () => {
    clear("agent-a", "agent-b");
    return setSkillOverride("agent-a", "pdf", "off").then(() => {
      releaseNameForFreshAgent("agent-a", { "agent-b": { pending: { op: "kill" } }, "agent-a": {} });
      expect(has("agent-a")).toBe(false);
      expect(has("agent-b")).toBe(false);
    });
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

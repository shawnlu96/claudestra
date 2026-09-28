/** lib/agent-settings.ts：按 agent 的设置文件（skillOverrides）读写与启动参数；状态目录由 tests/preload.ts 隔离到临时目录 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  agentSettingsPath,
  allSkillOverrides,
  applySkillOverride,
  isSettingsAgentName,
  removeAgentSettings,
  renameAgentSettings,
  setSkillOverride,
  settingsLaunchArgs,
  skillOverridesOf,
} from "../src/lib/agent-settings.js";
import { buildClaudeCommand } from "../src/lib/claude-launch.js";
import { claudeLaunchOptions } from "../src/lib/runtimes/claude-code.js";
import { sandboxLaunchArgs } from "../src/lib/sandbox-env.js";

const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));

describe("applySkillOverride / skillOverridesOf（纯函数）", () => {
  test("on = 删键（显式写 on 会让 /skills 菜单那一项被锁）；表空了连 skillOverrides 一起删；其它键原样保留", () => {
    const a = applySkillOverride({ model: "x" }, "pdf", "off");
    expect(a).toEqual({ model: "x", skillOverrides: { pdf: "off" } });
    const b = applySkillOverride(a, "save", "name-only");
    expect(b.skillOverrides).toEqual({ pdf: "off", save: "name-only" });
    expect(applySkillOverride(applySkillOverride(b, "pdf", "on"), "save", "on")).toEqual({ model: "x" });
  });
  test("脏条目丢掉：非法档位、非法名字、on 都不算覆盖", () => {
    const o = skillOverridesOf({ skillOverrides: { ok: "off", bad: "maybe", "a b": "off", on1: "on", "anthropic-skills:pdf": "user-invocable-only" } });
    expect(o).toEqual({ ok: "off", "anthropic-skills:pdf": "user-invocable-only" });
    expect(skillOverridesOf({ skillOverrides: ["x"] })).toEqual({});
  });
  test("agent 名挡掉逃出目录的写法", () => {
    for (const bad of ["", "../x", "a/b", "a\\b", ".hidden"]) expect(isSettingsAgentName(bad)).toBe(false);
    for (const ok of ["master", "agent-foo", "agent-中文"]) expect(isSettingsAgentName(ok)).toBe(true);
    expect(() => agentSettingsPath("../etc")).toThrow();
  });
});

describe("setSkillOverride（写者）", () => {
  test("写文件、全开回来后删文件；不认识的键不动", async () => {
    const p = agentSettingsPath("agent-t1");
    await setSkillOverride("agent-t1", "pdf", "off");
    expect(readJson(p)).toEqual({ skillOverrides: { pdf: "off" } });
    await setSkillOverride("agent-t1", "pdf", "on");
    expect(existsSync(p)).toBe(false);
    writeFileSync(p, JSON.stringify({ env: { A: "1" } }));
    await setSkillOverride("agent-t1", "save", "off");
    await setSkillOverride("agent-t1", "save", "on");
    expect(readJson(p)).toEqual({ env: { A: "1" } });
  });
  test("磁盘上是坏文件就拒写，不覆盖", async () => {
    const p = agentSettingsPath("agent-t2");
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, "{oops");
    await expect(setSkillOverride("agent-t2", "pdf", "off")).rejects.toThrow();
    expect(readFileSync(p, "utf8")).toBe("{oops");
  });
  test("allSkillOverrides / rename / remove", async () => {
    await setSkillOverride("agent-t3", "pdf", "off");
    expect(allSkillOverrides()["agent-t3"]).toEqual({ pdf: "off" });
    renameAgentSettings("agent-t3", "agent-t3b");
    expect(existsSync(agentSettingsPath("agent-t3"))).toBe(false);
    expect(allSkillOverrides()["agent-t3b"]).toEqual({ pdf: "off" });
    removeAgentSettings("agent-t3b");
    expect(allSkillOverrides()["agent-t3b"]).toBeUndefined();
    removeAgentSettings("agent-never"); // 文件不在是常态，不抛
  });
});

describe("启动参数", () => {
  test("settingsLaunchArgs：文件在且非空才带路径", () => {
    expect(settingsLaunchArgs({ path: null, settings: null })).toEqual([]);
    expect(settingsLaunchArgs({ path: "/s/a.json", settings: {} })).toEqual([]);
    expect(settingsLaunchArgs({ path: "/s/a.json", settings: { skillOverrides: { a: "off" } } })).toEqual(["--settings", "/s/a.json"]);
  });
  test("buildClaudeCommand：没文件不带 --settings；有文件带路径；坏文件不带（宁可不带也不能让 CC 起不来）", async () => {
    const base = { channelId: "1", bridgeUrl: "ws://localhost:3847", sessionId: "s" };
    expect(buildClaudeCommand({ ...base, settingsAgent: "agent-t4" })).not.toContain("--settings");
    await setSkillOverride("agent-t4", "pdf", "off");
    expect(buildClaudeCommand({ ...base, settingsAgent: "agent-t4" })).toContain(`--settings ${agentSettingsPath("agent-t4")}`);
    expect(buildClaudeCommand(base)).not.toContain("--settings");
    writeFileSync(agentSettingsPath("agent-t4"), "not json");
    expect(buildClaudeCommand({ ...base, settingsAgent: "agent-t4" })).not.toContain("--settings");
  });
  test("沙箱：agent 设置与沙箱的 statusLine 合成一份，只有一个 --settings，沙箱覆盖优先", () => {
    const args = sandboxLaunchArgs("claudestra", "/bin/bun", "/repo/src", { skillOverrides: { a: "off" }, statusLine: { type: "command", command: "evil" } });
    expect(args.filter((a) => a === "--settings")).toHaveLength(1);
    expect(JSON.parse(args[args.indexOf("--settings") + 1])).toEqual({
      skillOverrides: { a: "off" },
      statusLine: { type: "command", command: "/repo/scripts/statusline-usage.sh" },
    });
  });
  test("CC 适配器原样转交 settingsName（resume 不注入 agentName，但也要带设置文件）", () => {
    const o = claudeLaunchOptions({ mode: "resume", channelId: "1", bridgeUrl: "ws://x", sessionId: "s", settingsName: "agent-x" });
    expect(o.settingsAgent).toBe("agent-x");
    expect(o.agentName).toBeUndefined();
  });
});

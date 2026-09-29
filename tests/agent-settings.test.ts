/** lib/agent-settings.ts：按 agent 的设置文件（skillOverrides）读写与启动参数；状态目录由 tests/preload.ts 隔离到临时目录 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
// runtimes/index 要先于 runtimes/claude-code 加载（main 上原有的循环依赖；单独跑本文件时顺序反了会 TDZ）
import "../src/lib/runtimes/index.js";
import {
  agentSettingsPath,
  allSkillOverrides,
  applySkillOverride,
  dropLaunchSettings,
  isSettingsAgentName,
  isSkillName,
  launchSettingsFor,
  launchSnapshotPath,
  MAX_LAUNCH_SETTINGS_BYTES,
  outsideSkillOverrides,
  removeAgentSettings,
  renameAgentSettings,
  setSkillOverride,
  settingsLaunchArgs,
  skillOverridesOf,
} from "../src/lib/agent-settings.js";
import { buildClaudeCommand } from "../src/lib/claude-launch.js";
import { logPath } from "../src/lib/log-paths.js";
import { claudeLaunchOptions } from "../src/lib/runtimes/claude-code.js";
import { sandboxLaunchArgs } from "../src/lib/sandbox-env.js";
import { statePath } from "../src/lib/paths.js";
import { ownStateDirForFile } from "./state-files.ts";

// 用例按「没文件」断言：共享状态目录里别的测试留下的 agent-settings/ 会让它们挂（脏目录重跑实测）
ownStateDirForFile(statePath("agent-settings"));

const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));
/** 序列化后正好 bytes 字节的 { skillOverrides: {...} }（最后一个键名补齐长度） */
function bigOverrides(bytes: number): { skillOverrides: Record<string, string> } {
  const o: Record<string, string> = {};
  for (let i = 0; JSON.stringify({ skillOverrides: o }).length < bytes - 40; i++) o[`skill-${String(i).padStart(4, "0")}`] = "off";
  const pad = bytes - JSON.stringify({ skillOverrides: { ...o, z: "off" } }).length;
  o[`z${"x".repeat(pad)}`] = "off";
  return { skillOverrides: o };
}

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
  test("技能名：首字符要字母数字（挡 __proto__、- 开头）", () => {
    for (const ok of ["pdf", "anthropic-skills:pdf", "discord:access", "a.b_c-d"]) expect(isSkillName(ok)).toBe(true);
    for (const bad of ["__proto__", "-x", ":x", "a b", "a/b", "", "x".repeat(129)]) expect(isSkillName(bad)).toBe(false);
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
  test("aliases：同步技能的裸名别名一并清掉", async () => {
    const p = agentSettingsPath("agent-t5");
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ skillOverrides: { docx: "off", save: "off" } }));
    await setSkillOverride("agent-t5", "anthropic-skills:docx", "name-only", ["docx"]);
    expect(readJson(p)).toEqual({ skillOverrides: { save: "off", "anthropic-skills:docx": "name-only" } });
  });
  test("rename 到一个删过的名字：源文件不在也要清掉目标位置的旧文件；删 / 挪失败只报警不抛", async () => {
    await setSkillOverride("agent-stale", "pdf", "off");
    renameAgentSettings("agent-none", "agent-stale");
    expect(existsSync(agentSettingsPath("agent-stale"))).toBe(false);
    mkdirSync(agentSettingsPath("agent-dir"), { recursive: true }); // 同名的是个目录：unlink 抛 EISDIR / EPERM
    expect(() => removeAgentSettings("agent-dir")).not.toThrow();
  });
  test("outsideSkillOverrides：全局 / 项目 / 项目本地三处；cwd 就是家目录时不重复算", () => {
    const home = mkdtempSync(join(tmpdir(), "outside-home-"));
    const cwd = join(home, "proj");
    mkdirSync(join(home, ".claude"), { recursive: true });
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ skillOverrides: { pdf: "off", on1: "on" } }));
    writeFileSync(join(cwd, ".claude", "settings.local.json"), JSON.stringify({ skillOverrides: { save: "name-only" } }));
    writeFileSync(join(cwd, ".claude", "settings.json"), "{bad");
    expect(outsideSkillOverrides(cwd, home)).toEqual([
      { source: "user", overrides: { pdf: "off" } },
      { source: "local", overrides: { save: "name-only" } },
    ]);
    expect(outsideSkillOverrides(home, home)).toEqual([{ source: "user", overrides: { pdf: "off" } }]);
    writeFileSync(join(home, ".claude", "settings.local.json"), JSON.stringify({ skillOverrides: { docx: "off" } }));
    expect(outsideSkillOverrides(home, home)).toEqual([{ source: "user", overrides: { pdf: "off" } }, { source: "local", overrides: { docx: "off" } }]);
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
  test("只内联白名单里的键：手写进文件的 env（密钥）不进命令行", async () => {
    const p = agentSettingsPath("agent-t7");
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: "sk-secret" }, skillOverrides: { pdf: "off" } }));
    expect(launchSettingsFor("agent-t7")).toEqual({ skillOverrides: { pdf: "off" } });
    expect(buildClaudeCommand({ channelId: "1", bridgeUrl: "ws://localhost:3847", sessionId: "s", settingsAgent: "agent-t7" })).not.toContain("sk-secret");
  });
  test("settingsLaunchArgs：非空才带；不超上限内联 JSON、不落快照（正好等于上限也内联）", () => {
    expect(settingsLaunchArgs({}, "agent-t9")).toEqual([]);
    expect(settingsLaunchArgs({ skillOverrides: { a: "off" } }, "agent-t9")).toEqual(["--settings", '{"skillOverrides":{"a":"off"}}']);
    const edge = bigOverrides(MAX_LAUNCH_SETTINGS_BYTES);
    expect(Buffer.byteLength(JSON.stringify(edge))).toBe(MAX_LAUNCH_SETTINGS_BYTES);
    expect(settingsLaunchArgs(edge, "agent-t9")).toEqual(["--settings", JSON.stringify(edge)]);
    expect(existsSync(launchSnapshotPath("agent-t9"))).toBe(false);
  });
  test("超长：写快照（0600、内容就是那份 JSON）传路径，bridge 日志里记警告；就绪后 dropLaunchSettings 删掉", () => {
    const big = bigOverrides(MAX_LAUNCH_SETTINGS_BYTES + 1);
    const args = settingsLaunchArgs(big, "agent-t8");
    const snap = launchSnapshotPath("agent-t8");
    expect(args).toEqual(["--settings", snap]);
    expect(readJson(snap)).toEqual(big);
    expect(statSync(snap).mode & 0o777).toBe(0o600);
    expect(readFileSync(logPath("bridge", "err"), "utf8")).toMatch(/\[agent-settings\] ⚠ agent-t8 的启动设置 8193 字节，超过内联上限 8192/);
    expect(allSkillOverrides()["launch"]).toBeUndefined(); // 快照目录不算一个 agent
    dropLaunchSettings("agent-t8");
    expect(existsSync(snap)).toBe(false);
    dropLaunchSettings("agent-t8"); // 不在也不抛
    dropLaunchSettings("../evil"); // 非法名直接不碰
  });
  test("超长写入不再拒：设置文件照写，buildClaudeCommand 带快照路径不带内容；remove 连快照一起删", async () => {
    const p = agentSettingsPath("agent-t10");
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ skillOverrides: bigOverrides(MAX_LAUNCH_SETTINGS_BYTES).skillOverrides }));
    await setSkillOverride("agent-t10", "one-more-skill-with-a-long-name", "off");
    expect(readJson(p).skillOverrides["one-more-skill-with-a-long-name"]).toBe("off");
    const cmd = buildClaudeCommand({ channelId: "1", bridgeUrl: "ws://localhost:3847", sessionId: "s", settingsAgent: "agent-t10" });
    expect(cmd).toContain(`--settings ${launchSnapshotPath("agent-t10")}`);
    expect(cmd).not.toContain("one-more-skill-with-a-long-name");
    expect(Buffer.byteLength(cmd)).toBeLessThan(MAX_LAUNCH_SETTINGS_BYTES);
    expect(readJson(launchSnapshotPath("agent-t10")).skillOverrides["one-more-skill-with-a-long-name"]).toBe("off");
    removeAgentSettings("agent-t10");
    expect(existsSync(p)).toBe(false);
    expect(existsSync(launchSnapshotPath("agent-t10"))).toBe(false);
  });
  test("沙箱超长：合成后的一份（含 statusLine）落快照，仍只有一个 --settings", () => {
    const args = sandboxLaunchArgs("claudestra", "/bin/bun", "/repo/src", bigOverrides(MAX_LAUNCH_SETTINGS_BYTES), "agent-t11");
    expect(args.filter((a) => a === "--settings")).toHaveLength(1);
    expect(args[args.indexOf("--settings") + 1]).toBe(launchSnapshotPath("agent-t11"));
    expect(readJson(launchSnapshotPath("agent-t11")).statusLine).toEqual({ type: "command", command: "/repo/scripts/statusline-usage.sh" });
    dropLaunchSettings("agent-t11");
  });
  test("buildClaudeCommand：没文件不带 --settings；有文件内联传内容（不传路径：CC 读之前文件被删也起得来）；坏文件不带", async () => {
    const base = { channelId: "1", bridgeUrl: "ws://localhost:3847", sessionId: "s" };
    expect(buildClaudeCommand({ ...base, settingsAgent: "agent-t4" })).not.toContain("--settings");
    await setSkillOverride("agent-t4", "pdf", "off");
    const cmd = buildClaudeCommand({ ...base, settingsAgent: "agent-t4" });
    expect(cmd).toContain(`--settings '{"skillOverrides":{"pdf":"off"}}'`);
    expect(cmd).not.toContain(agentSettingsPath("agent-t4"));
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

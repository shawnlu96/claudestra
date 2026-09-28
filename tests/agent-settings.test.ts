/** lib/agent-settings.ts：按 agent 的设置文件（skillOverrides）读写与启动参数；状态目录由 tests/preload.ts 隔离到临时目录 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
// runtimes/index 要先于 runtimes/claude-code 加载（main 上原有的循环依赖；单独跑本文件时顺序反了会 TDZ）
import "../src/lib/runtimes/index.js";
import {
  agentSettingsPath,
  allSkillOverrides,
  applySkillOverride,
  isSettingsAgentName,
  isSkillName,
  launchSettingsFor,
  MAX_LAUNCH_SETTINGS_BYTES,
  outsideSkillOverrides,
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
  test("写入前卡长度：超过上限拒写（tmux 单条命令约 16KB 就发不出去），文件原样不动", async () => {
    const big: Record<string, string> = {};
    for (let i = 0; big && JSON.stringify(big).length < MAX_LAUNCH_SETTINGS_BYTES - 40; i++) big[`skill-${String(i).padStart(4, "0")}`] = "off";
    const p = agentSettingsPath("agent-t8");
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ skillOverrides: big }));
    const before = readFileSync(p, "utf8");
    await expect(setSkillOverride("agent-t8", "one-more-skill-with-a-long-name", "off")).rejects.toThrow(/上限/);
    expect(readFileSync(p, "utf8")).toBe(before);
    await setSkillOverride("agent-t8", "skill-0000", "on"); // 往回调总是允许
  });
  test("settingsLaunchArgs：非空才带，内联 JSON", () => {
    expect(settingsLaunchArgs({})).toEqual([]);
    expect(settingsLaunchArgs({ skillOverrides: { a: "off" } })).toEqual(["--settings", '{"skillOverrides":{"a":"off"}}']);
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

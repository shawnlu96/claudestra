/**
 * rename-floka-MCP1：按会话保存 MCP 命名族、watcher 双认工具前缀（src/lib/floka-mcp/）。
 * 「fake 启动」= 照 CC 的加载规则（用户级注册 + --mcp-config 同名覆盖 + --settings 的 deniedMcpServers 拒绝名单 + --strict-mcp-config）
 * 数出一次启动会起几个 channel-server；拒绝名单对用户级注册生效是 CC 2.1.299 实测（见 lib/floka-mcp/launch.ts）。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { familyOfTool, parseRenameMcpMode, type RenameMcpMode } from "../src/lib/floka-mcp/families.ts";
import { explicitMcpName, selectMcpName, type McpSelectInput } from "../src/lib/floka-mcp/select.ts";
import { hasFamilyRecords, readSessionFamily, writeSessionFamily, writeObserveReport } from "../src/lib/floka-mcp/store.ts";
import { mcpConfigArgs, mcpEnvSuffix, mcpSessionIdArgs, planMcpLaunch, withMcpFamilySettings, type McpLaunchDeps, type McpLaunchRequest } from "../src/lib/floka-mcp/launch.ts";
import { isOwnMcpTool } from "../src/lib/floka-mcp/recognize.ts";
import { buildClaudeCommand } from "../src/lib/claude-launch.ts";

const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-8222-222222222222";
const S3 = "33333333-3333-4333-8333-333333333333";
const AGENT_ENV = { DISCORD_CHANNEL_ID: "123", MCP_NAME: "claudestra" }; // 会话里再起的 manager 继承到的前缀

let root: string;
let observeRoot: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "floka-mcp-"));
  observeRoot = join(root, "observe");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** 真落盘（临时目录）的依赖；mode 可变，模拟切档 / 回滚；新会话 id 依次取 ids */
function deps(mode: { v: RenameMcpMode }, env: Record<string, string | undefined> = {}, logs: string[] = [], ids: string[] = []): McpLaunchDeps {
  const fam = join(root, "fam");
  return {
    mode: () => mode.v,
    env,
    readSession: (id) => readSessionFamily(id, fam),
    writeSession: (id, f, a) => writeSessionFamily(id, f, a, fam),
    newSessionId: () => ids.shift() ?? crypto.randomUUID(),
    observe: (a, r) => writeObserveReport(a, r, observeRoot),
    log: (l) => void logs.push(l),
  };
}

/** 一次启动的 MCP 相关参数（与 buildClaudeCommand 同一组合，非沙箱） */
function launchArgs(r: McpLaunchRequest, d: McpLaunchDeps, cred?: string) {
  const c = planMcpLaunch(r, d);
  const own = withMcpFamilySettings({}, c);
  const settings = Object.keys(own).length ? ["--settings", JSON.stringify(own)] : [];
  const args = ["--dangerously-load-development-channels", `server:${c.name}`, ...settings, ...mcpConfigArgs(c, cred, false), ...mcpSessionIdArgs(c)];
  return { c, args, env: `MCP_NAME=${c.name}${mcpEnvSuffix(c)}` };
}

/** fake CC：按加载规则数出会起的 MCP 服务（名字 → 是不是 channel-server） */
function fakeCcServers(userLevel: Record<string, boolean>, args: string[]): string[] {
  let servers: Record<string, boolean> = { ...userLevel };
  const denied = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--strict-mcp-config") servers = {};
    if (args[i] === "--settings") for (const d of JSON.parse(args[i + 1]).deniedMcpServers ?? []) denied.add(d.serverName);
  }
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "--mcp-config") continue;
    for (const [k, v] of Object.entries(JSON.parse(args[i + 1]).mcpServers as Record<string, { args: string[] }>)) servers[k] = v.args.some((a) => a.endsWith("channel-server.ts"));
  }
  return Object.entries(servers).filter(([k, isChannel]) => isChannel && !denied.has(k)).map(([k]) => k);
}
const USER_LEVEL = { claudestra: true, mem0: false };

const sel = (p: Partial<McpSelectInput>) => selectMcpName({ mode: "off", explicit: null, kind: "new", stored: null, ...p });

describe("[验收线 1] 新 / 旧 / 恢复会话的命名族", () => {
  test("开关：缺省、写错、非字符串一律 off", () => {
    expect(parseRenameMcpMode({})).toBe("off");
    expect(parseRenameMcpMode({ rename: { mcp: "On" } })).toBe("off");
    expect(parseRenameMcpMode({ rename: { mcp: 1 } })).toBe("off");
    expect(parseRenameMcpMode({ rename: { mcp: "observe" } })).toBe("observe");
    expect(parseRenameMcpMode({ rename: { mcp: "on" } })).toBe("on");
  });

  test("on：新会话 floka 并记下；未记录的旧会话续接 / 分叉保留 claudestra", () => {
    expect(sel({ mode: "on", sessionId: S1 })).toEqual({ name: "floka", family: "floka", source: "default", recordSession: { sessionId: S1, family: "floka" } });
    expect(sel({ mode: "on", kind: "resume", sessionId: S1 })).toMatchObject({ name: "claudestra", source: "legacy" });
    expect(sel({ mode: "on", kind: "fork", sessionId: S1 })).toEqual({ name: "claudestra", family: "claudestra", source: "legacy" });
    expect(sel({ mode: "on", kind: "resume", sessionId: S1, stored: "floka" })).toMatchObject({ name: "floka", source: "session" });
  });

  test("off / observe：新会话仍是 claudestra；observe 只报 on 会用 floka，不记会话", () => {
    expect(sel({ sessionId: S1 })).toEqual({ name: "claudestra", family: "claudestra", source: "default" });
    const o = sel({ mode: "observe", sessionId: S1 });
    expect(o).toMatchObject({ name: "claudestra", would: "floka" });
    expect(o.recordSession).toBeUndefined();
  });

  test("显式 MCP_NAME 在三个档位都生效，且不碰会话记录", () => {
    for (const mode of ["off", "observe", "on"] as const) {
      const c = sel({ mode, explicit: "myorch", sessionId: S1, kind: "resume", stored: "floka" });
      expect(c).toEqual({ name: "myorch", family: null, source: "explicit" });
    }
    expect(explicitMcpName({ MCP_NAME: "myorch" })).toBe("myorch");
    expect(explicitMcpName({ DISCORD_CHANNEL_ID: "1", MCP_NAME: "myorch" })).toBe("myorch");
    expect(explicitMcpName({ MCP_NAME: "floka" })).toBe("floka"); // 运维自己注册了 floka
    expect(explicitMcpName({ MCP_NAME: "claudestra" })).toBeNull(); // setup 向导写进 .env 的缺省值
    expect(explicitMcpName(AGENT_ENV)).toBeNull(); // 旧会话前缀继承来的
    expect(explicitMcpName({ ...AGENT_ENV, MCP_NAME: "floka", MCP_NAME_SOURCE: "family" })).toBeNull(); // 新族会话前缀继承来的
    expect(explicitMcpName({ MCP_NAME: "claudestra", MCP_NAME_SOURCE: "explicit" })).toBe("claudestra"); // 钉住族名
    expect(explicitMcpName({ MCP_NAME: " ", MCP_NAME_SOURCE: "explicit" })).toBeNull();
  });

  test("会话 id 启动前未知（无 id 全新 / 分叉）：现取 id 用 --session-id 钉住，记录只绑在那个会话上", () => {
    const d = deps({ v: "on" }, {}, [], [S2, S1]);
    const master = launchArgs({ agent: "master" }, d);
    expect(master.c).toMatchObject({ name: "floka", assignedSessionId: S2 });
    expect(master.args.slice(-2)).toEqual(["--session-id", S2]);
    expect(readSessionFamily(S2, join(root, "fam"))).toBe("floka");
    expect(planMcpLaunch({ agent: "master", resumeId: S2 }, d)).toMatchObject({ name: "floka", source: "session" });
    // 分叉一个新族会话：新会话的 id 也先钉住、记成 floka；原会话不动
    const fork = planMcpLaunch({ agent: "a1", resumeId: S2, forkSession: true }, d);
    expect(fork).toMatchObject({ name: "floka", assignedSessionId: S1 });
    expect(planMcpLaunch({ agent: "a1", resumeId: S1 }, d).name).toBe("floka");
    // 同一 agent 再续接一个没记录的旧会话 → claudestra
    expect(planMcpLaunch({ agent: "a1", resumeId: S3 }, d).name).toBe("claudestra");
    // 旧族的分叉 / 无 id 启动不取 id，命令与改造前相同
    expect(planMcpLaunch({ agent: "a1", resumeId: S3, forkSession: true }, d).assignedSessionId).toBeUndefined();
    expect(planMcpLaunch({ agent: "master" }, deps({ v: "off" })).assignedSessionId).toBeUndefined();
  });

  test("复现 pending-family-unbound：无 id 全新启动后续接任一未记录的旧会话，仍是 claudestra 且不记 floka", () => {
    const d = deps({ v: "on" });
    expect(planMcpLaunch({ agent: "master" }, d).name).toBe("floka");
    expect(planMcpLaunch({ agent: "master", resumeId: S2 }, d)).toMatchObject({ name: "claudestra", source: "legacy" });
    expect(readSessionFamily(S2, join(root, "fam"))).toBeNull();
  });

  test("回滚新默认（on → off）不改变已有会话：floka 会话续接仍是 floka，新会话回 claudestra", () => {
    const mode = { v: "on" as RenameMcpMode };
    const d = deps(mode);
    expect(planMcpLaunch({ agent: "a1", sessionId: S1 }, d).name).toBe("floka");
    mode.v = "off";
    expect(planMcpLaunch({ agent: "a1", resumeId: S1 }, d).name).toBe("floka");
    expect(planMcpLaunch({ agent: "a2", sessionId: S2 }, d).name).toBe("claudestra");
    expect(readSessionFamily(S2, join(root, "fam"))).toBeNull();
  });

  test("会话里再起的 manager 与 .env 缺省值不挡 on 档；前缀带来源，子启动认得出", () => {
    const mode = { v: "on" as RenameMcpMode };
    const child = launchArgs({ agent: "a1", sessionId: S1 }, deps(mode, AGENT_ENV));
    expect(child.env).toBe("MCP_NAME=floka MCP_NAME_SOURCE=family");
    expect(explicitMcpName({ ...AGENT_ENV, MCP_NAME: "floka", MCP_NAME_SOURCE: "family" })).toBeNull(); // 这个会话里再起的 manager
    expect(launchArgs({ agent: "a2", sessionId: S2 }, deps(mode, { MCP_NAME: "claudestra" })).c.name).toBe("floka");
    const pinned = launchArgs({ agent: "a2", sessionId: S2 }, deps(mode, { MCP_NAME: "claudestra", MCP_NAME_SOURCE: "explicit" }));
    expect(pinned.env).toBe("MCP_NAME=claudestra MCP_NAME_SOURCE=explicit");
    expect(launchArgs({ agent: "a3", sessionId: S2 }, deps({ v: "off" }, { MCP_NAME: "myorch" })).env).toBe("MCP_NAME=myorch"); // off：与改造前同
  });

  test("新族记不下来就退回 claudestra（不能起了新名却续接认不出）", () => {
    const logs: string[] = [];
    const d = { ...deps({ v: "on" }, {}, logs), writeSession: () => { throw new Error("disk full"); } };
    expect(planMcpLaunch({ agent: "a1", sessionId: S1 }, d)).toMatchObject({ name: "claudestra", source: "legacy" });
    expect(logs.join("\n")).toContain("disk full");
    const noId = planMcpLaunch({ agent: "master" }, { ...deps({ v: "on" }, {}, logs, ["not-a-uuid"]) });
    expect(noId).toMatchObject({ name: "claudestra", source: "legacy" }); // 取到的 id 不合法也退回，且不带 --session-id
    expect(mcpSessionIdArgs(noId)).toEqual([]);
  });

  test("会话 id / agent 名不合法不落盘、不逃出目录", () => {
    expect(() => writeSessionFamily("../x", "floka", "a", root)).toThrow();
    expect(readSessionFamily("../x", root)).toBeNull();
    expect(readdirSync(root)).toEqual([]);
  });
});

describe("[验收线 2] 每个 agent 只起一个可注册的 channel-server", () => {
  const cases: Array<[string, McpLaunchRequest, RenameMcpMode, Record<string, string>]> = [
    ["on 新会话", { agent: "a1", sessionId: S1 }, "on", {}],
    ["on 旧会话续接", { agent: "a1", resumeId: S2 }, "on", {}],
    ["on 无 id 全新大总管", { agent: "master" }, "on", {}],
    ["off 新会话", { agent: "a1", sessionId: S1 }, "off", {}],
    ["observe 新会话", { agent: "a1", sessionId: S1 }, "observe", {}],
    ["on 钉住旧族名", { agent: "a1", sessionId: S1 }, "on", { MCP_NAME: "claudestra", MCP_NAME_SOURCE: "explicit" }],
  ];
  for (const [label, req, mode, env] of cases) {
    for (const cred of [undefined, "/tmp/cred-file"]) {
      test(`${label}${cred ? "（带启动凭据）" : ""}`, () => {
        const { c, args } = launchArgs(req, deps({ v: mode }, env), cred);
        expect(fakeCcServers(USER_LEVEL, args)).toEqual([c.name]);
      });
    }
  }

  test("复现 explicit-floka-double-server：显式 MCP_NAME=floka 也只起 floka 一个（三档、带不带凭据）", () => {
    for (const mode of ["off", "observe", "on"] as const)
      for (const cred of [undefined, "/tmp/cred-file"]) {
        const { c, args } = launchArgs({ agent: "a1", sessionId: S1 }, deps({ v: mode }, { MCP_NAME: "floka" }), cred);
        expect(c).toMatchObject({ name: "floka", source: "explicit" });
        expect(fakeCcServers(USER_LEVEL, args)).toEqual(["floka"]);
      }
  });

  test("回滚到 off 后续接 floka 会话：仍只起 floka 一个", () => {
    writeSessionFamily(S1, "floka", "a1", join(root, "fam"));
    const { c, args } = launchArgs({ agent: "a1", resumeId: S1 }, deps({ v: "off" }));
    expect(c.name).toBe("floka");
    expect(fakeCcServers(USER_LEVEL, args)).toEqual(["floka"]);
  });

  test("floka 会话：拒掉 claudestra、自带 floka 一项、允许 floka 工具；已有的 settings 键保留", () => {
    const c = planMcpLaunch({ agent: "a1", sessionId: S1 }, deps({ v: "on" }));
    const own = withMcpFamilySettings({ skillOverrides: { x: "off" }, permissions: { deny: ["Bash(x:*)"], allow: ["Read"] } }, c);
    expect(own).toEqual({
      skillOverrides: { x: "off" },
      deniedMcpServers: [{ serverName: "claudestra" }],
      permissions: { deny: ["Bash(x:*)"], allow: ["Read", "mcp__floka__*"] },
    });
    const cfg = JSON.parse(mcpConfigArgs(c, "/tmp/cred", false)[1]).mcpServers;
    expect(Object.keys(cfg)).toEqual(["floka"]);
    expect(Object.values(cfg)[0]).toMatchObject({ env: { CLAUDESTRA_CALLER_CRED_FILE: "/tmp/cred" } });
    expect(mcpConfigArgs(c, undefined, true)).toEqual([]); // 沙箱没凭据：sandboxLaunchArgs 用本次名字给严格配置
  });

  test("旧 stdio holder 不退出、不替换：切档只影响之后的启动，在跑会话的启动参数与改造前一致", () => {
    const calls: string[] = [];
    const d = deps({ v: "on" });
    const spy: McpLaunchDeps = {
      ...d,
      writeSession: (...a) => { calls.push("writeSession"); d.writeSession(...a); },
    };
    const old = launchArgs({ agent: "a1", resumeId: S2 }, spy);
    expect(old.args).toEqual(["--dangerously-load-development-channels", "server:claudestra"]); // 与 off 档 / 改造前同一组参数
    expect(old.env).toBe("MCP_NAME=claudestra");
    expect(calls).toEqual([]); // 不写记录、不发信号、不重启、不改别的会话
  });

  test("buildClaudeCommand（off，缺省）：服务名、--settings、--mcp-config 都与改造前相同", () => {
    const cmd = buildClaudeCommand({ channelId: "c1", bridgeUrl: "ws://localhost:3847", sessionId: S1 });
    expect(cmd).toContain("--dangerously-load-development-channels server:claudestra");
    expect(cmd).toContain("MCP_NAME=claudestra ");
    expect(cmd).not.toContain("deniedMcpServers");
    expect(cmd).not.toContain("--mcp-config");
    expect(cmd).not.toContain("MCP_NAME_SOURCE");
    const fork = buildClaudeCommand({ channelId: "c1", bridgeUrl: "ws://localhost:3847", resumeId: S1, forkSession: true });
    expect(fork).toContain(`--resume ${S1} --fork-session`);
    expect(fork).not.toContain("--session-id");
    expect(buildClaudeCommand({ channelId: "c1", bridgeUrl: "ws://localhost:3847" })).not.toContain("--session-id");
  });
});

describe("[验收线 3] 两族工具输出各显示一次；off / observe 不变", () => {
  const transcript = ["mcp__claudestra__reply", "mcp__floka__reply", "mcp__floka__send_to_agent", "Read", "mcp__mem0__memory_search"];

  test("有过新族会话：两族前缀都认作本系统工具（不进工具行），每条只归一个族", () => {
    const shown = transcript.filter((n) => !isOwnMcpTool(n, "mcp__claudestra__", () => true));
    expect(shown).toEqual(["Read", "mcp__mem0__memory_search"]);
    expect(transcript.map(familyOfTool)).toEqual(["claudestra", "floka", "floka", null, null]);
  });

  test("从没起过新族会话（off / observe）：只认配置的前缀，与改造前相同", () => {
    const shown = transcript.filter((n) => !isOwnMcpTool(n, "mcp__claudestra__", () => false));
    expect(shown).toEqual(["mcp__floka__reply", "mcp__floka__send_to_agent", "Read", "mcp__mem0__memory_search"]);
  });

  test("observe 只写报告：不建会话记录、不取会话 id，bridge 的前缀识别不被打开", () => {
    const d = deps({ v: "observe" });
    expect(planMcpLaunch({ agent: "a1", sessionId: S1 }, d).name).toBe("claudestra");
    expect(planMcpLaunch({ agent: "master" }, d)).toMatchObject({ name: "claudestra", would: "floka" });
    expect(planMcpLaunch({ agent: "master" }, d).assignedSessionId).toBeUndefined();
    expect(hasFamilyRecords(join(root, "fam"))).toBe(false);
    expect(readdirSync(observeRoot).sort()).toEqual(["a1.json", "master.json"]);
    expect(existsSync(join(root, "fam"))).toBe(false);
  });

  test("off：零写入（不建目录）", () => {
    for (const r of [{ agent: "a1", sessionId: S1 }, { agent: "a1", resumeId: S2 }, { agent: "master" }, { agent: "a1", resumeId: S2, forkSession: true }])
      planMcpLaunch(r, deps({ v: "off" }));
    expect(readdirSync(root)).toEqual([]);
  });

  test("on 起过新族会话后 bridge 开始认新族前缀；历史记录只在状态目录，不碰 transcript", () => {
    const fam = join(root, "fam");
    expect(hasFamilyRecords(fam)).toBe(false);
    planMcpLaunch({ agent: "a1", sessionId: S1 }, deps({ v: "on" }));
    expect(hasFamilyRecords(fam)).toBe(true);
    expect(readdirSync(root)).toEqual(["fam"]);
    expect(readdirSync(join(fam, "sessions"))).toEqual([`${S1}.json`]);
  });
});

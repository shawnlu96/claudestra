/**
 * Pi 的 acp 版生命周期（lib/runtimes/pi-acp.ts）与它在 manager / bridge 里的接线：启动命令、适配器选择、transport 检查、
 * 同名 MCP 撞名闸（pi-adapter/mcp-clash.ts）、pi-settings 的分流。tmux 版 Pi 的选择、策略、启动命令逐字钉住不变。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { settingsRoute } from "../src/bridge/runtime-settings-routes.ts";
import { noteAcpChannel } from "../src/bridge/acp-state.ts";
import { ACP_RUNTIME_ENV, PI_ARGS_ENV } from "../src/lib/acp/host-runtime.ts";
import { piMcpClash } from "../src/lib/acp/pi-adapter/mcp-clash.ts";
import { shellEscape } from "../src/lib/claude-launch.ts";
import { pathOverrideAssignments } from "../src/lib/paths.ts";
import { buildPiCommand, PI_EXTENSION_PATH } from "../src/lib/pi-launch.ts";
import { ACP_CONTROL, acpExitPrelude } from "../src/lib/runtimes/acp-control.ts";
import { controlFor, managedFor, piAdapter, transportsOf } from "../src/lib/runtimes/index.ts";
import { PI_CONTROL, piLaunchOptions } from "../src/lib/runtimes/pi.ts";
import { buildPiAcpHostCommand, piAcpAdapter, piAcpArgs } from "../src/lib/runtimes/pi-acp.ts";
import type { LaunchSpec } from "../src/lib/runtimes/types.ts";
import { transportRefusal } from "../src/manager/acp-lifecycle.ts";

const root = mkdtempSync(join(tmpdir(), "pi-acp-runtime-"));
const agentDir = join(root, "agent");
const work = join(root, "work");
const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
beforeAll(() => {
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(work, ".pi"), { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir; // buildLaunchCommand 的撞名闸读 process.env：别碰真 ~/.pi
});
afterAll(() => {
  if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
  rmSync(root, { recursive: true, force: true });
});
const writeMcp = (file: string, servers: Record<string, unknown> | string) => writeFileSync(file, typeof servers === "string" ? servers : JSON.stringify({ mcpServers: servers }));

const SPEC: LaunchSpec = {
  mode: "resume", channelId: "123", bridgeUrl: "ws://localhost:3847", sessionId: "019a-pi", agentName: "agent-pa", purpose: "写代码",
  model: "flash", effort: "high", extras: { piEnv: { base: "minimal" } },
};
const O = { bunBin: "/opt/bun", repoRoot: "/repo", env: {} as Record<string, string | undefined> };

describe("tmux 版 Pi 不变（钉住）", () => {
  test("缺省 / tmux 仍选 piAdapter：策略、退出指令、registry 字段、启动命令与改动前逐字相同", () => {
    expect(managedFor("pi")).toBe(piAdapter);
    expect(managedFor("pi", "tmux")).toBe(piAdapter);
    expect(controlFor("pi")).toBe(PI_CONTROL);
    expect(controlFor("pi", "tmux")).toBe(PI_CONTROL);
    expect(piAdapter.exitCommand).toBe("/quit");
    expect(piAdapter.callerCred).toBeUndefined();
    expect(piAdapter.registryFields({ ...SPEC, extras: {} })).toEqual({ runtime: "pi" });
    const spec = { ...SPEC, extras: {} };
    const cmd = piAdapter.buildLaunchCommand(spec);
    expect(cmd).toBe(buildPiCommand(piLaunchOptions(spec)));
    expect(cmd).toBe(
      `DISCORD_CHANNEL_ID=123 BRIDGE_URL=ws://localhost:3847 BRIDGE_PORT=3847 CLAUDESTRA_AGENT=agent-pa${pathOverrideAssignments(shellEscape)} pi --approve`
      + ` --extension ${PI_EXTENSION_PATH} --session-id 019a-pi --name agent-pa --model flash --thinking high`
      + ` --append-system-prompt ${shellEscape("你是 Claudestra 编排系统中的 agent「agent-pa」。你的职责: 写代码")}`,
    );
  });
});

describe("acp 版的选择与启动命令", () => {
  test("只有 transport=acp 选它：策略与 Codex acp 同一份，来源部分与 tmux 版共用，退出走宿主", () => {
    expect(transportsOf("pi")).toEqual(["tmux", "acp"]);
    const a = managedFor("pi", "acp")!;
    expect(a).toBe(piAcpAdapter);
    expect(a.control).toBe(ACP_CONTROL);
    expect(controlFor("pi", "acp")).toBe(ACP_CONTROL);
    expect(a.scanSessions).toBe(piAdapter.scanSessions);
    expect(a.translateLine).toBe(piAdapter.translateLine);
    expect(a.waitReady).toBe(piAdapter.waitReady);
    expect(a.beforeLaunch).toBe(piAdapter.beforeLaunch);
    expect(a.exitPrelude).toBe(acpExitPrelude);
    expect([a.exitCommand, a.inbound, a.turnEnd, a.callerCred, a.prepareSession]).toEqual(["", "acp-host", "acp-host", "env", undefined]);
    expect(a.registryFields(SPEC)).toEqual({ runtime: "pi", transport: "acp", piEnv: { base: "minimal" } });
  });

  test("前缀给宿主身份、运行时、模型档位与 pi 参数；能力档与 tmux 版相同，职责和回复规则走 --append-system-prompt", () => {
    const cmd = buildPiAcpHostCommand(SPEC, O);
    expect(cmd).toStartWith(
      `DISCORD_CHANNEL_ID=123 BRIDGE_URL=ws://localhost:3847 CLAUDESTRA_AGENT=agent-pa CLAUDESTRA_SESSION_ID=019a-pi MCP_NAME=claudestra ${ACP_RUNTIME_ENV}=pi PI_BIN=pi`
      + ` CLAUDESTRA_ACP_MODEL=flash CLAUDESTRA_ACP_EFFORT=high ${PI_ARGS_ENV}=`,
    );
    expect(cmd).toEndWith(" /opt/bun /repo/src/acp-host.ts");
    const args = piAcpArgs(SPEC, "agent-pa", "/repo");
    expect(cmd).toContain(` ${PI_ARGS_ENV}=${shellEscape(JSON.stringify(args))} `);
    expect(args.slice(0, 6)).toEqual(["--approve", "--no-extensions", "--no-skills", "--no-prompt-templates", "--name", "agent-pa"]);
    expect(args[6]).toBe("--append-system-prompt");
    expect(args[7]).toContain("你的职责: 写代码");
    expect(args[7]).toContain("Reply rules");
    expect(args).toHaveLength(8);
    expect(cmd).not.toContain("CLAUDESTRA_CODEX_PREAMBLE"); // 系统提示每次起 pi 都带，不要重启前言
  });

  test("档位只放 pi 认的；不信任项目 → --no-approve；缺 agent 名 / 会话 id 报错；沙箱里拒（沙箱策略另行设计）", () => {
    expect(buildPiAcpHostCommand({ ...SPEC, effort: "ultracode", model: undefined }, O)).not.toMatch(/CLAUDESTRA_ACP_(EFFORT|MODEL)/);
    expect(piAcpArgs({ ...SPEC, extras: { piEnv: { trustProject: false } } }, "agent-pa", "/repo")[0]).toBe("--no-approve");
    expect(() => buildPiAcpHostCommand({ ...SPEC, agentName: undefined }, O)).toThrow("agent 名");
    expect(() => buildPiAcpHostCommand({ ...SPEC, sessionId: "" }, O)).toThrow("会话 id");
    expect(() => buildPiAcpHostCommand(SPEC, { ...O, env: { CLAUDESTRA_SANDBOX: "1", CLAUDESTRA_SANDBOX_ROOT: "/tmp/sb" } })).toThrow("沙箱");
  });
});

describe("同名 MCP 撞名闸：pi 的 mcp.json 会静默顶掉 channel-server，起 pi 之前就拒", () => {
  test("用户级与项目级都查；`-` 与 `_` 算同名；坏 JSON 按 pi 的做法跳过；不撞返回 null", () => {
    const global = join(agentDir, "mcp.json");
    const project = join(work, ".pi", "mcp.json");
    expect(piMcpClash(["claudestra"], work, agentDir)).toBeNull();
    writeMcp(global, { other: { command: "x" } });
    writeMcp(project, { "claude-stra": { command: "x" } });
    expect(piMcpClash(["claudestra"], work, agentDir)).toBeNull();
    expect(piMcpClash(["claude_stra"], work, agentDir)).toContain(project);
    expect(piMcpClash(["claude_stra"], "", agentDir)).toBeNull(); // 没有 cwd 只查用户级
    writeMcp(global, { claudestra: { command: "x", enabled: false } });
    expect(piMcpClash(["claudestra"], work, agentDir)).toContain(`${global} 里有名为「claudestra」`);
    writeMcp(global, "{ not json");
    writeMcp(project, {});
    expect(piMcpClash(["claudestra"], work, agentDir)).toBeNull();
  });

  test("transport 命令先拦（registry 不动）；restart 时 buildLaunchCommand 也拦，不起一个没有 reply 的宿主", () => {
    const env = { PI_CODING_AGENT_DIR: agentDir };
    writeMcp(join(agentDir, "mcp.json"), {});
    writeMcp(join(work, ".pi", "mcp.json"), {});
    expect(transportRefusal({ runtime: "pi", cwd: work }, "pa", "acp", env)).toBeNull();
    expect(transportRefusal({ runtime: "pi", cwd: work }, "pa", "tmux", env)).toBeNull();
    writeMcp(join(work, ".pi", "mcp.json"), { claudestra: { command: "x" } });
    expect(transportRefusal({ runtime: "pi", cwd: work }, "pa", "acp", env)).toContain("顶掉");
    expect(transportRefusal({ runtime: "pi", cwd: work }, "pa", "acp", { ...env, MCP_NAME: "cs2" })).toBeNull();
    expect(transportRefusal({ runtime: "pi", cwd: work }, "pa", "tmux", env)).toBeNull(); // tmux 版走扩展的 ws，不受影响
    expect(() => piAcpAdapter.buildLaunchCommand({ ...SPEC, cwd: work })).toThrow("顶掉");
    writeMcp(join(work, ".pi", "mcp.json"), {});
    expect(piAcpAdapter.buildLaunchCommand({ ...SPEC, cwd: work })).toContain(`${ACP_RUNTIME_ENV}=pi`);
  });
});

describe("pi-settings 分流", () => {
  test("ACP 宿主连着才走 acpSettings（会话里改）；tmux 版 Pi 仍注入扩展命令，Codex 照旧", () => {
    const ch = "local-pi-settings-route";
    noteAcpChannel(ch, undefined);
    expect(settingsRoute("pi", ch)).toBe("pi");
    expect(settingsRoute("pi", undefined)).toBe("pi");
    expect(settingsRoute("codex", ch)).toBe("codex");
    noteAcpChannel(ch, "acp");
    expect(settingsRoute("pi", ch)).toBe("acp");
    expect(settingsRoute("codex", ch)).toBe("acp");
    noteAcpChannel(ch, "tmux"); // 切回 tmux 后扩展重新登记
    expect(settingsRoute("pi", ch)).toBe("pi");
  });
});

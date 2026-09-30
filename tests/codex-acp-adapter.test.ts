import { describe, expect, test } from "bun:test";
import { buildAcpHostCommand, codexAcpAdapter, createCodexAcpAdapter } from "../src/lib/runtimes/codex-acp.ts";
import { readCodexRunning, recordCodexRunning } from "../src/lib/codex-version.ts";
import type { WindowOps } from "../src/lib/runtimes/types.ts";
import { codexAdapter, controlFor, managedFor, requireManaged } from "../src/lib/runtimes/index.ts";
import { CODEX_ACP_CONTROL } from "../src/lib/runtimes/codex.ts";
import { decodePreambleEnv } from "../src/lib/codex-thread.ts";
import { transportRefusal } from "../src/manager/acp-lifecycle.ts";
import { parseCreateArgs } from "../src/manager/create-args.ts";
import { assertSandboxRuntime } from "../src/lib/sandbox.ts";
import { sandboxEnv, sandboxLayout, sandboxManagerRefusal } from "../src/lib/sandbox-env.ts";
import { acpAgentCommand, adapterEnv } from "../src/lib/acp/adapter-proc.ts";
import { isRepoStub, repoStubPath } from "../src/lib/acp/stub.ts";
import type { LaunchSpec } from "../src/lib/runtimes/types.ts";

const SPEC: LaunchSpec = { mode: "resume", channelId: "123", bridgeUrl: "ws://localhost:3847", sessionId: "019a-sid", agentName: "agent-cx", purpose: "写代码" };
const O = { bunBin: "/opt/bun", repoRoot: "/repo", codexBin: "/usr/local/bin/codex", env: {} as Record<string, string | undefined> };

describe("buildAcpHostCommand", () => {
  test("环境变量前缀 + bun acp-host.ts；resume 带职责前言（与 tmux 同一份），new 不带", () => {
    const cmd = buildAcpHostCommand(SPEC, O);
    const head = "DISCORD_CHANNEL_ID=123 BRIDGE_URL=ws://localhost:3847 CLAUDESTRA_AGENT=agent-cx CLAUDESTRA_SESSION_ID=019a-sid MCP_NAME=claudestra";
    expect(cmd).toStartWith(`${head} CLAUDESTRA_CODEX_BIN=/usr/local/bin/codex CLAUDESTRA_ACP_DEVELOPER=`);
    expect(cmd).toEndWith(" /opt/bun /repo/src/acp-host.ts");
    const pre = /CLAUDESTRA_CODEX_PREAMBLE='([^']+)'/.exec(cmd)![1];
    expect(decodePreambleEnv(pre)).toContain("你的职责: 写代码");
    const clearPre = /CLAUDESTRA_ACP_CLEAR_PREAMBLE='([^']+)'/.exec(cmd)![1];
    expect(decodePreambleEnv(clearPre)).toContain("你的职责: 写代码");
    const developer = /CLAUDESTRA_ACP_DEVELOPER='([^']+)'/.exec(cmd)![1];
    expect(Buffer.from(developer, "base64").toString("utf8")).toContain("你的职责: 写代码");
    expect(buildAcpHostCommand({ ...SPEC, mode: "new" }, O)).not.toContain("CLAUDESTRA_CODEX_PREAMBLE");
  });

  test("模型 / 推理强度给宿主（接上线程后 set_config_option）；Claude 的模型名早拒", () => {
    const cmd = buildAcpHostCommand({ ...SPEC, model: "gpt-5.6-luna", effort: "high" }, O);
    expect(cmd).toContain("CLAUDESTRA_ACP_MODEL=gpt-5.6-luna CLAUDESTRA_ACP_EFFORT=high");
    expect(() => buildAcpHostCommand({ ...SPEC, model: "opus" }, O)).toThrow("Claude 的模型");
  });

  test("沙箱的 stub 设置原样透传；缺 agent 名 / thread id 直接报错", () => {
    const cmd = buildAcpHostCommand(SPEC, { ...O, env: { CLAUDESTRA_ACP_AGENT: '["bun","/repo/scripts/acp-stub.ts"]' } });
    expect(cmd).toContain(`CLAUDESTRA_ACP_AGENT='["bun","/repo/scripts/acp-stub.ts"]'`);
    expect(() => buildAcpHostCommand({ ...SPEC, agentName: undefined }, O)).toThrow("agent 名");
    expect(() => buildAcpHostCommand({ ...SPEC, sessionId: "" }, O)).toThrow("thread id");
    expect(buildAcpHostCommand({ ...SPEC, agentName: undefined, settingsName: "agent-cx" }, O)).toContain("CLAUDESTRA_AGENT=agent-cx");
  });
});

describe("适配器选择（managedFor / requireManaged 带 transport）", () => {
  test("缺省 / tmux 与原来一样；codex + acp → ACP 版（来源部分与 tmux 版同一套）", () => {
    expect(managedFor("codex")).toBe(codexAdapter);
    expect(managedFor("codex", "tmux")).toBe(codexAdapter);
    const a = managedFor("codex", "acp")!;
    expect(a).toBe(codexAcpAdapter);
    expect(a.control).toBe(CODEX_ACP_CONTROL);
    expect(a.control).toBe(controlFor("codex", "acp"));
    expect(a.scanSessions).toBe(codexAdapter.scanSessions);
    expect(a.registryFields(SPEC)).toEqual({ runtime: "codex", transport: "acp" });
    expect(a.isValidSessionId("019a0000-0000-7000-8000-00000000abcd")).toBe(true);
    expect(a.isValidSessionId("not-a-thread")).toBe(false);
    expect(a.discoverSessionId).toBeUndefined();
    expect(a.onExitPane).toBeUndefined();
    expect("binPath" in a).toBe(false); // ACP 不继承 tmux 适配器的可变状态与探测器
  });

  test("不支持 acp 的运行时：managedFor 返回 null，requireManaged 报清楚", () => {
    expect(managedFor("pi", "acp")).toBeNull();
    expect(managedFor(undefined, "acp")).toBeNull();
    expect(() => requireManaged("pi", "acp")).toThrow("不支持 transport=acp");
  });

  test("resume 原样返回 thread id", async () => {
    expect(await codexAcpAdapter.prepareSession!(SPEC)).toEqual({ sessionId: "019a-sid" });
  });
});

describe("transport 命令的检查", () => {
  test("只有 codex 能切 acp；大总管不切；不存在的报清楚", () => {
    expect(transportRefusal({ runtime: "pi" }, "x", "acp", { CLAUDESTRA_ACP_AGENT: "[\"stub\"]" })).toContain("不支持 transport=acp");
    expect(transportRefusal({ runtime: "codex" }, "master", "tmux")).toBe("大总管不切 transport");
    expect(transportRefusal(undefined, "ghost", "acp")).toContain("不存在");
    expect(transportRefusal({ runtime: "codex" }, "x", "tmux")).toBeNull();
    expect(transportRefusal({ runtime: "codex" }, "x", "acp", { CLAUDESTRA_ACP_AGENT: "[\"stub\"]" })).toBeNull();
    expect(transportRefusal({ runtime: "codex" }, "x", "acp", { CLAUDESTRA_SANDBOX: "1", CLAUDESTRA_ACP_AGENT: "[\"evil\"]" })).toContain("沙箱里不认");
    expect(transportRefusal({ runtime: "codex" }, "x", "tmux", { CLAUDESTRA_SANDBOX: "1" })).toContain("只许 ACP stub");
  });
});

describe("create --transport 与沙箱闸门", () => {
  test("--transport 只收 tmux / acp", () => {
    expect(parseCreateArgs(["cx", "/w", "--runtime", "codex", "--transport", "acp"])).toMatchObject({ runtimeFlag: "codex", transportFlag: "acp" });
    expect(parseCreateArgs(["cx", "/w", "--transport", "ssh"])).toMatchObject({ error: expect.stringContaining("tmux 或 acp") });
  });

  test("沙箱只放 codex + acp（适配器固定是 stub）；tmux 版 Codex 照旧拒", () => {
    const sandbox = { CLAUDESTRA_SANDBOX: "1", CLAUDESTRA_SANDBOX_ROOT: "/tmp/sb" };
    expect(() => assertSandboxRuntime("codex", sandbox, "acp")).not.toThrow();
    expect(() => assertSandboxRuntime("codex", sandbox)).toThrow("只支持 Claude Code");
    expect(() => assertSandboxRuntime("claude-code", sandbox)).not.toThrow();
    expect(sandboxManagerRefusal(["create", "cx", "/w", "--runtime", "codex", "--transport", "acp"])).toBeNull();
    expect(sandboxManagerRefusal(["create", "cx", "/w", "--runtime", "codex"])).toBeNull(); // 缺省 ACP，在 manager 入口选 stub
    expect(sandboxManagerRefusal(["create", "cx", "/w", "--runtime", "codex", "--transport", "tmux"])).toContain("只支持 Claude Code runtime");
    expect(sandboxManagerRefusal(["transport", "cx", "acp"])).toBeNull();
    expect(sandboxManagerRefusal(["transport", "cx", "tmux"])).toContain("只许 ACP stub");
  });
});

// Shawn 本机 Codex r4 P1-3 的探针改成的回归：沙箱只准本仓的协议 stub，外部 override 不继承、不认、带着就拒；ACP 这条链的 HOME 隔离
describe("沙箱：CLAUDESTRA_ACP_AGENT 冒充不了 stub（r4 P1-3）", () => {
  const arbitrary = '["bun","/tmp/fake-real-codex-acp.js"]';
  const layout = sandboxLayout("/tmp/acp-sandbox-probe");
  const env = sandboxEnv({ PATH: "/usr/bin", HOME: "/tmp/fake-owner-home", CLAUDESTRA_ACP_AGENT: arbitrary }, {
    layout, port: 25001, deny: { ports: [3847], dirs: ["/tmp/fake-production-state"] },
  });
  const stub = repoStubPath()!;

  test("本仓 stub 按真实路径认；沙箱不继承外部的 override", () => {
    expect(stub).toEndWith("/scripts/acp-stub.ts");
    expect(isRepoStub(["bun", stub])).toBe(true);
    expect(isRepoStub(["bun", "/tmp/fake-real-codex-acp.js"])).toBe(false);
    expect(env.CLAUDESTRA_ACP_AGENT).toBeUndefined();
  });

  test("沙箱里任意 argv 的 override：起适配器时不认（固定起本仓 stub），建 / 切 acp 时直接拒", () => {
    const smuggled = { ...env, CLAUDESTRA_ACP_AGENT: arbitrary };
    expect(acpAgentCommand(smuggled, "bun")).toEqual({ cmd: ["bun", stub], stub: true });
    expect(acpAgentCommand(env, "bun")).toEqual({ cmd: ["bun", stub], stub: true });
    expect(() => assertSandboxRuntime("codex", smuggled, "acp")).toThrow("不认 CLAUDESTRA_ACP_AGENT");
    expect(buildAcpHostCommand(SPEC, { ...O, env: smuggled })).not.toContain("CLAUDESTRA_ACP_AGENT");
  });

  test("沙箱外的 override 照旧可用，但只有本仓 stub 才算 stub（别的 argv 按真适配器对待）", () => {
    expect(acpAgentCommand({ CLAUDESTRA_ACP_AGENT: arbitrary }, "bun")).toEqual({ cmd: ["bun", "/tmp/fake-real-codex-acp.js"], stub: false });
    expect(acpAgentCommand({ CLAUDESTRA_ACP_AGENT: JSON.stringify(["bun", stub]) }, "bun")).toEqual({ cmd: ["bun", stub], stub: true });
  });

  test("ACP 这条链的 HOME / CODEX_HOME 在沙箱根下：宿主命令、适配器环境（含 create 引导）都是", () => {
    const home = `${layout.root}/acp-home`;
    const aenv = adapterEnv({ base: env, bunBin: "bun", channelServer: "/x/channel-server.ts", mcpName: "claudestra", logsDir: "/tmp/l" });
    expect(aenv.HOME).toBe(home);
    expect(aenv.CODEX_HOME).toBe(`${home}/.codex`);
    expect(aenv.CLAUDESTRA_ACP_AGENT).toBeUndefined();
    const cmd = buildAcpHostCommand(SPEC, { ...O, env });
    expect(cmd).toContain(`HOME=${home} `);
    expect(cmd).toContain(`CODEX_HOME=${home}/.codex `);
    expect(adapterEnv({ base: { HOME: "/Users/me" }, bunBin: "bun", channelServer: "x", mcpName: "m", logsDir: "/l" }).HOME).toBe("/Users/me");
  });
});

describe("ACP 运行版本来源", () => {
  test("beforeLaunch 只清掉上一次的记录，不探版本：真正的运行版本由宿主起适配器前记（codex-version noteAcpCodexRunning）", async () => {
    recordCodexRunning("agent-acpv", "0.157.0");
    let versionProbes = 0;
    const a = createCodexAcpAdapter({
      resolveBin: async () => "/x/codex",
      run: async (cmd: string[]) => (cmd[1] === "--version" && versionProbes++, { ok: true, out: "", err: "" }),
    });
    const opts: Record<string, string> = {};
    const win = { name: "agent-acpv", target: "master:agent-acpv", setOption: async (k: string, v: string) => ((opts[k] = v), true) } as unknown as WindowOps;
    await a.beforeLaunch!(win);
    expect(readCodexRunning("agent-acpv")).toBeUndefined();
    expect(versionProbes).toBe(0);
    expect(opts["@claudestra_ready"]).toBe("0");
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { buildAcpHostCommand, codexAcpAdapter } from "../src/lib/runtimes/codex-acp.ts";
import { codexAdapter, controlFor, managedFor, requireManaged } from "../src/lib/runtimes/index.ts";
import { CODEX_ACP_CONTROL } from "../src/lib/runtimes/codex.ts";
import { decodePreambleEnv } from "../src/lib/codex-thread.ts";
import { transportRefusal } from "../src/manager/acp-lifecycle.ts";
import { parseCreateArgs } from "../src/manager/create-args.ts";
import { assertSandboxRuntime } from "../src/lib/sandbox.ts";
import { sandboxManagerRefusal } from "../src/lib/sandbox-env.ts";
import type { LaunchSpec } from "../src/lib/runtimes/types.ts";

const SPEC: LaunchSpec = { mode: "resume", channelId: "123", bridgeUrl: "ws://localhost:3847", sessionId: "019a-sid", agentName: "agent-cx", purpose: "写代码" };
const O = { bunBin: "/opt/bun", repoRoot: "/repo", codexBin: "/usr/local/bin/codex", env: {} as Record<string, string | undefined> };

describe("buildAcpHostCommand", () => {
  test("环境变量前缀 + bun acp-host.ts；resume 带职责前言（与 tmux 同一份），new 不带", () => {
    const cmd = buildAcpHostCommand(SPEC, O);
    const head = "DISCORD_CHANNEL_ID=123 BRIDGE_URL=ws://localhost:3847 CLAUDESTRA_AGENT=agent-cx CLAUDESTRA_SESSION_ID=019a-sid MCP_NAME=claudestra";
    expect(cmd).toStartWith(`${head} CLAUDESTRA_CODEX_BIN=/usr/local/bin/codex CLAUDESTRA_CODEX_PREAMBLE=`);
    expect(cmd).toEndWith(" /opt/bun /repo/src/acp-host.ts");
    const pre = /CLAUDESTRA_CODEX_PREAMBLE='([^']+)'/.exec(cmd)![1];
    expect(decodePreambleEnv(pre)).toContain("你的职责: 写代码");
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
  });

  test("不支持 acp 的运行时：managedFor 返回 null，requireManaged 报清楚", () => {
    expect(managedFor("pi", "acp")).toBeNull();
    expect(managedFor(undefined, "acp")).toBeNull();
    expect(() => requireManaged("pi", "acp")).toThrow("不支持 transport=acp");
  });

  test("fork 在 acp 试点里直接拒；resume 原样返回 thread id", async () => {
    await expect(codexAcpAdapter.prepareSession!({ ...SPEC, mode: "fork" })).rejects.toThrow("不支持 fork");
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
  });
});

describe("create --transport 与沙箱闸门", () => {
  const saved = process.env.CLAUDESTRA_ACP_AGENT;
  afterEach(() => {
    if (saved === undefined) delete process.env.CLAUDESTRA_ACP_AGENT;
    else process.env.CLAUDESTRA_ACP_AGENT = saved;
  });

  test("--transport 只收 tmux / acp", () => {
    expect(parseCreateArgs(["cx", "/w", "--runtime", "codex", "--transport", "acp"])).toMatchObject({ runtimeFlag: "codex", transportFlag: "acp" });
    expect(parseCreateArgs(["cx", "/w", "--transport", "ssh"])).toMatchObject({ error: expect.stringContaining("tmux 或 acp") });
  });

  test("沙箱只放 codex + acp + stub；tmux 版 Codex、没配 stub 的 acp 照旧拒", () => {
    const sandbox = { CLAUDESTRA_SANDBOX: "1", CLAUDESTRA_SANDBOX_ROOT: "/tmp/sb" };
    expect(() => assertSandboxRuntime("codex", { ...sandbox, CLAUDESTRA_ACP_AGENT: "[\"stub\"]" }, "acp")).not.toThrow();
    expect(() => assertSandboxRuntime("codex", { ...sandbox, CLAUDESTRA_ACP_AGENT: "[\"stub\"]" })).toThrow();
    expect(() => assertSandboxRuntime("codex", sandbox, "acp")).toThrow("acp 要配 stub");
    expect(() => assertSandboxRuntime("claude-code", sandbox)).not.toThrow();
    process.env.CLAUDESTRA_ACP_AGENT = "[\"stub\"]";
    expect(sandboxManagerRefusal(["create", "cx", "/w", "--runtime", "codex", "--transport", "acp"])).toBeNull();
    expect(sandboxManagerRefusal(["create", "cx", "/w", "--runtime", "codex"])).toContain("只支持 Claude Code runtime");
    delete process.env.CLAUDESTRA_ACP_AGENT;
    expect(sandboxManagerRefusal(["create", "cx", "/w", "--runtime", "codex", "--transport", "acp"])).toContain("只支持 Claude Code runtime");
    expect(sandboxManagerRefusal(["transport", "cx", "acp"])).toBeNull();
  });
});

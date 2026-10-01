/**
 * ACP 宿主按运行时分的那几处（lib/acp/host-runtime.ts）+ 跟着去 Codex 化的小件：Codex 那一行与改动前逐项相同；
 * Pi 的回环代理 token 只走 mcpServers；registry 的裸模型 id 对上 provider/id；中性忙闲键；文案带运行时称呼；Pi 只看版本的就绪闸。
 */
import { describe, expect, test } from "bun:test";
import { adapterEnv, type AdapterEnvSpec } from "../src/lib/acp/adapter-proc.ts";
import { parseConfigOptions, resolveConfigValue } from "../src/lib/acp/config.ts";
import { classifyAirFailure } from "../src/lib/acp/failures.ts";
import { ACP_RUNTIME_ENV, acpRuntime, PI_ARGS_ENV } from "../src/lib/acp/host-runtime.ts";
import { permissionCard } from "../src/lib/acp/permissions.ts";
import { PI_ACP_ADAPTER_MAIN } from "../src/lib/acp/pi-adapter/main.ts";
import { checkAcpReadyFor, probePiAcp } from "../src/lib/acp/readiness.ts";
import { threadStatusOf } from "../src/lib/acp/updates.ts";
import { BOOTSTRAP_PROMPT } from "../src/lib/codex-launch.ts";

const SPEC: AdapterEnvSpec = {
  base: { PATH: "/usr/bin", HOME: "/h", TMUX: "/tmp/t,1,0", TMUX_PANE: "%1", BRIDGE_URL: "ws://127.0.0.1:3847", BRIDGE_PORT: "3847", DISCORD_CHANNEL_ID: "999", PI_CODING_AGENT_DIR: "/pi" },
  bunBin: "/opt/bun",
  channelServer: "/repo/src/channel-server.ts",
  mcpName: "claudestra",
  logsDir: "/l",
  channel: { channelId: "123", proxyUrl: "ws://127.0.0.1:5555/?token=SECRET", agentName: "agent-p", sessionId: "s-1" },
};

describe("acpRuntime 表", () => {
  test("缺省 codex（老的宿主命令不带变量）；认不出的值直接抛", () => {
    expect(acpRuntime().id).toBe("codex");
    expect(acpRuntime("").id).toBe("codex");
    expect(acpRuntime("pi").id).toBe("pi");
    expect(() => acpRuntime("claude-code")).toThrow(ACP_RUNTIME_ENV);
  });

  test("Codex 那一行与改动前一致：环境就是 adapterEnv，mcpServers 不传（channel-server 在 CODEX_CONFIG 里），/clear 带引导轮", () => {
    const codex = acpRuntime("codex");
    expect(codex.adapterEnv(SPEC)).toEqual(adapterEnv(SPEC));
    expect(JSON.parse(adapterEnv(SPEC).CODEX_CONFIG!).mcp_servers.claudestra.command).toBe("/opt/bun");
    expect(codex.mcpServers(SPEC)).toEqual([]);
    expect(codex.clearBootstrap).toBe(BOOTSTRAP_PROMPT);
    expect([codex.label, codex.logLabel]).toEqual(["Codex", "codex-acp"]);
  });

  test("钉住：Pi 的回环代理地址和 token 只在 mcpServers 里，适配器（以及 pi、pi 的 bash）的环境里没有", () => {
    const pi = acpRuntime("pi");
    const env = pi.adapterEnv(SPEC);
    expect(JSON.stringify(env)).not.toContain("SECRET");
    for (const k of ["BRIDGE_URL", "BRIDGE_PORT", "DISCORD_CHANNEL_ID", "TMUX", "TMUX_PANE", "CODEX_CONFIG", "INITIAL_AGENT_MODE"]) expect(env[k]).toBeUndefined();
    expect(env).toMatchObject({ PATH: "/usr/bin", HOME: "/h", PI_CODING_AGENT_DIR: "/pi" });
    expect(pi.mcpServers(SPEC)).toEqual([{
      name: "claudestra",
      command: "/opt/bun",
      args: ["/repo/src/channel-server.ts"],
      env: [
        { name: "DISCORD_CHANNEL_ID", value: "123" },
        { name: "BRIDGE_URL", value: "ws://127.0.0.1:5555/?token=SECRET" },
        { name: "CLAUDESTRA_AGENT", value: "agent-p" },
        { name: "CLAUDESTRA_RUNTIME", value: "pi" },
        { name: "CLAUDESTRA_SESSION_ID", value: "s-1" },
        { name: "MCP_NAME", value: "claudestra" },
      ],
    }]);
    expect(pi.mcpServers({ ...SPEC, channel: undefined })).toEqual([]);
    expect(pi.clearBootstrap).toBeUndefined();
    expect([pi.label, pi.logLabel]).toEqual(["Pi", "pi-acp"]);
  });

  test("Pi 的适配器命令：宿主自己的 bun 跑仓库里的 main.ts，启动命令给的参数原样接上；出借 worker / 沙箱 / 参数坏了都拒", () => {
    const pi = acpRuntime("pi");
    expect(pi.agentCommand({ [PI_ARGS_ENV]: JSON.stringify(["--approve", "--no-extensions"]) }, "/opt/bun", false))
      .toEqual({ cmd: ["/opt/bun", PI_ACP_ADAPTER_MAIN, "--approve", "--no-extensions"], stub: false });
    expect(pi.agentCommand({}, "/opt/bun", false)).toEqual({ cmd: ["/opt/bun", PI_ACP_ADAPTER_MAIN], stub: false });
    expect(pi.agentCommand({}, "/opt/bun", true)).toMatchObject({ error: expect.stringContaining("出借 worker") });
    expect(pi.agentCommand({ CLAUDESTRA_SANDBOX: "1" }, "/opt/bun", false)).toMatchObject({ error: expect.stringContaining("沙箱") });
    expect(pi.agentCommand({ [PI_ARGS_ENV]: "--approve" }, "/opt/bun", false)).toMatchObject({ error: expect.stringContaining(PI_ARGS_ENV) });
    expect(pi.agentCommand({ [PI_ARGS_ENV]: "[1]" }, "/opt/bun", false)).toMatchObject({ error: expect.stringContaining(PI_ARGS_ENV) });
  });
});

describe("resolveConfigValue：registry 的值对上会话选项", () => {
  const opts = parseConfigOptions([
    { id: "model", type: "select", currentValue: "ds/v4", options: [{ value: "ds/v4" }, { value: "ds/flash" }, { value: "or/meta/llama" }, { value: "a/dup" }, { value: "b/dup" }] },
    { id: "reasoning_effort", type: "select", currentValue: "high", options: [{ value: "off" }, { value: "high" }] },
  ]);

  test("裸模型 id 补上唯一的 provider/；模型 id 自己带斜杠也认；原值在选项里就不动", () => {
    expect(resolveConfigValue(opts, "model", "flash")).toBe("ds/flash");
    expect(resolveConfigValue(opts, "model", "meta/llama")).toBe("or/meta/llama");
    expect(resolveConfigValue(opts, "model", "ds/v4")).toBe("ds/v4");
    expect(resolveConfigValue(opts, "reasoning_effort", "high")).toBe("high");
  });

  test("两家同名、没有匹配、没有这一项：原样交回（后面的 configRefusal 照常拒，不猜）", () => {
    expect(resolveConfigValue(opts, "model", "dup")).toBe("dup");
    expect(resolveConfigValue(opts, "model", "llama")).toBe("llama");
    expect(resolveConfigValue(opts, "reasoning_effort", "low")).toBe("low");
    expect(resolveConfigValue(opts, "fast-mode", "on")).toBe("on");
  });

  test("Codex 的选项不带斜杠：结果和不归一时一样", () => {
    const codex = parseConfigOptions([{ id: "model", type: "select", currentValue: "gpt-5.5", options: [{ value: "gpt-5.5" }, { value: "gpt-5.6-luna" }] }]);
    for (const v of ["gpt-5.5", "gpt-5.6-luna", "luna", "5.5", "openai/gpt-5.5"]) expect(resolveConfigValue(codex, "model", v)).toBe(v);
  });
});

describe("忙闲键与文案按运行时", () => {
  test("threadStatusOf 认 codex-acp 的 _meta.codex，也认 Pi 适配器的中性 _meta.claudestra", () => {
    const info = (meta: Record<string, unknown>) => ({ sessionUpdate: "session_info_update", _meta: meta });
    expect(threadStatusOf(info({ codex: { threadStatus: { type: "idle" } } }))).toBe("idle");
    expect(threadStatusOf(info({ claudestra: { threadStatus: { type: "active" } } }))).toBe("active");
    expect(threadStatusOf(info({ other: { threadStatus: { type: "idle" } } }))).toBeNull();
    expect(threadStatusOf({ sessionUpdate: "agent_message_chunk", _meta: { claudestra: { threadStatus: { type: "idle" } } } })).toBeNull();
  });

  test("授权卡、AIR 失败的兜底标题带运行时称呼，缺省仍是 Codex", () => {
    const params = { toolCall: { toolCallId: "t", title: "rm x" }, options: [{ optionId: "ok", name: "允许", kind: "allow_once" }] };
    expect(permissionCard(params)!.title).toBe("Codex 请求授权：rm x");
    expect(permissionCard(params, "Pi")!.title).toBe("Pi 请求授权：rm x");
    const air = { id: "f1", revision: 1, category: "unknown", severity: "error", title: "", actions: [] };
    expect(classifyAirFailure(air).message).toBe("Codex 回合失败（unknown）");
    expect(classifyAirFailure(air, "Pi").message).toBe("Pi 回合失败（unknown）");
  });
});

describe("就绪闸：Pi 只看 pi 在不在、版本够不够", () => {
  const runner = (out: string, ok = true) => async () => ({ ok, out, err: "" });

  test("0.99.0 起才有内置 MCP；读不出版本号按够了放行；pi 起不来就拒", async () => {
    expect(await probePiAcp(runner("0.99.2\n"))).toEqual({ ok: true });
    expect(await probePiAcp(runner("pi 0.99.0"))).toEqual({ ok: true });
    expect(await probePiAcp(runner("0.98.9"))).toMatchObject({ ok: false, reason: expect.stringContaining("0.99.0") });
    expect(await probePiAcp(runner("dev build"))).toEqual({ ok: true });
    expect(await probePiAcp(runner("", false))).toMatchObject({ ok: false, reason: expect.stringContaining("找不到 pi") });
  });

  test("按运行时分派：pi 走版本探测；其余照旧走 Codex 的判据（沙箱里认 stub）", async () => {
    const calls: string[][] = [];
    const run = async (cmd: string[]) => (calls.push(cmd), { ok: true, out: "0.99.1", err: "" });
    expect(await checkAcpReadyFor("pi", true, { run })).toEqual({ ok: true });
    expect(calls.map((c) => c.at(-1))).toEqual(["--version"]);
    const sandbox = { env: { CLAUDESTRA_SANDBOX: "1" }, stub: () => null };
    expect(await checkAcpReadyFor("codex", true, sandbox)).toMatchObject({ ok: false, reason: expect.stringContaining("stub") });
    expect(await checkAcpReadyFor(undefined, true, sandbox)).toMatchObject({ ok: false, reason: expect.stringContaining("stub") });
  });
});

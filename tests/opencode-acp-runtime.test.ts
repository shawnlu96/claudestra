/** OpenCode 运行时的接线：注册表、宿主运行时、启动命令、模型必填、transport 选择、catalog 模型清单。docs/runtimes/opencode-acp.md */
import { describe, expect, test } from "bun:test";
import { acpRuntime, opencodeConfigContent } from "../src/lib/acp/host-runtime";
import { opencodeBin, opencodeDirsEnv } from "../src/lib/acp/opencode-bin";
import { parseOpencodeModels, opencodeModels, resetOpencodeModelsCache } from "../src/lib/opencode-models";
import { ACP_CONTROL } from "../src/lib/runtimes/acp-control";
import { controlFor, managedFor, manageableRuntimeIds, requireManaged, sourceFor, transportsOf } from "../src/lib/runtimes/index";
import { buildOpencodeAcpHostCommand, OPENCODE_MODEL_REQUIRED, opencodeAcpAdapter } from "../src/lib/runtimes/opencode-acp";
import { parseCreateArgs } from "../src/manager/create-args";
import { chooseCreateTransport, transportRefusal } from "../src/manager/acp-lifecycle";

describe("注册表", () => {
  test("sourceFor / managedFor / controlFor / transportsOf 认 opencode，只走 acp", () => {
    expect(sourceFor("opencode").id).toBe("opencode");
    expect(managedFor("opencode", "acp")).toBe(opencodeAcpAdapter);
    expect(managedFor("opencode")).toBe(opencodeAcpAdapter); // 清单 / 可用性查询不带 transport
    expect(controlFor("opencode", "acp")).toBe(ACP_CONTROL);
    expect(transportsOf("opencode")).toEqual(["acp"]);
    expect(manageableRuntimeIds()).toContain("opencode");
    expect(requireManaged("opencode", "acp").registryFields({} as never)).toEqual({ runtime: "opencode", transport: "acp" });
  });

  test("老运行时不受影响", () => {
    expect(transportsOf("codex")).toEqual(["tmux", "acp"]);
    expect(transportsOf("claude-code")).toEqual(["tmux"]);
    expect(managedFor("pi")?.acpOnly).toBeUndefined();
  });

  test("transport：opencode 缺省 acp，点名 tmux 拒；切 tmux 被拒", async () => {
    expect(await chooseCreateTransport("opencode")).toEqual({ transport: "acp" });
    await expect(chooseCreateTransport("opencode", "tmux")).rejects.toThrow("只能走 ACP");
    expect(transportRefusal({ runtime: "opencode" }, "x", "tmux", {})).toContain("不支持 transport=tmux");
  });
});

describe("模型必填", () => {
  test("create 不给 --model 早拒，给了照常", () => {
    expect(parseCreateArgs(["a", "/tmp", "--runtime", "opencode"])).toEqual({ error: OPENCODE_MODEL_REQUIRED });
    expect(parseCreateArgs(["a", "/tmp", "--runtime=opencode", "--model", "  "])).toEqual({ error: OPENCODE_MODEL_REQUIRED });
    const ok = parseCreateArgs(["a", "/tmp", "--runtime", "opencode", "--model", "opencode/big-pickle"]);
    expect("error" in ok ? ok.error : ok.model).toBe("opencode/big-pickle");
    expect("error" in parseCreateArgs(["a", "/tmp", "--runtime", "pi"])).toBe(false); // 别的运行时不要求
  });

  test("启动命令兜底再拒（resume / restart 走不到 create-args）", () => {
    expect(() => buildOpencodeAcpHostCommand({ ...SPEC, model: undefined }, O)).toThrow(OPENCODE_MODEL_REQUIRED);
  });
});

const SPEC = {
  mode: "new" as const, channelId: "c1", bridgeUrl: "ws://127.0.0.1:3847", sessionId: "ses_abc", agentName: "agent-oc",
  purpose: "试", model: "opencode/big-pickle", cwd: "/w",
};
const O = { bunBin: "/opt/bun", repoRoot: "/repo", opencodeBin: "/nvm/bin/opencode", env: {} as Record<string, string | undefined> };

describe("启动命令", () => {
  test("带运行时、模型、OpenCode 绝对路径、全文前言；接回只带短前言", () => {
    const cmd = buildOpencodeAcpHostCommand(SPEC, O);
    expect(cmd).toContain("CLAUDESTRA_ACP_RUNTIME=opencode");
    expect(cmd).toContain("OPENCODE_BIN=/nvm/bin/opencode");
    expect(cmd).toContain("CLAUDESTRA_ACP_MODEL=opencode/big-pickle");
    expect(cmd).toEndWith("/opt/bun /repo/src/acp-host.ts");
    const pre = (c: string) => c.match(/CLAUDESTRA_CODEX_PREAMBLE=(\S+)/)?.[1]?.replace(/'/g, "") ?? "";
    expect(pre(buildOpencodeAcpHostCommand({ ...SPEC, mode: "resume" }, O)).length).toBeLessThan(pre(cmd).length);
  });

  test("没装 opencode / 缺会话 id 抛", () => {
    expect(() => buildOpencodeAcpHostCommand(SPEC, { ...O, opencodeBin: null })).toThrow("npm i -g opencode-ai");
    expect(() => buildOpencodeAcpHostCommand({ ...SPEC, sessionId: "" }, O)).toThrow("会话 id");
  });

  test("会话 id 只认 ses_…", () => {
    expect(opencodeAcpAdapter.isValidSessionId("ses_2a9Xk")).toBe(true);
    expect(opencodeAcpAdapter.isValidSessionId("0f8fad5b-d9cb-469f-a165-70867728950e")).toBe(false);
  });
});

describe("宿主运行时", () => {
  const rt = acpRuntime("opencode");
  const spec = {
    base: { CLAUDESTRA_ACP_MODEL: "opencode/x", OPENCODE_BIN: "/b/opencode", TMUX: "t", BRIDGE_URL: "ws://h" }, bunBin: "/opt/bun",
    channelServer: "/repo/src/channel-server.ts", mcpName: "claudestra", logsDir: "/l",
    channel: { channelId: "c1", proxyUrl: "http://127.0.0.1:9/x", agentName: "agent-oc", sessionId: "ses_1" },
  };

  test("直连 opencode acp，不起适配器进程；出借 worker 拒", () => {
    expect(rt.agentCommand({ OPENCODE_BIN: "/bin/sh" }, "/opt/bun", false)).toEqual({ cmd: ["/bin/sh", "acp", "--cwd", process.cwd()], stub: false });
    expect(rt.agentCommand({ OPENCODE_BIN: "/bin/sh" }, "/opt/bun", true)).toHaveProperty("error");
    expect(rt.agentCommand({ OPENCODE_BIN: "/nope/opencode" }, "/opt/bun", false)).toHaveProperty("error");
  });

  test("环境：模型 + 全放行的权限进 OPENCODE_CONFIG_CONTENT，tmux / bridge 变量不下传", () => {
    const env = rt.adapterEnv(spec);
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT!)).toEqual({
      model: "opencode/x", permission: { "*": "allow", external_directory: "allow", doom_loop: "allow", question: "deny" }, autoupdate: false,
    });
    expect(env.TMUX).toBeUndefined();
    expect(env.BRIDGE_URL).toBeUndefined();
    expect(env.OPENCODE_BIN).toBeUndefined();
  });

  test("channel-server 以 stdio mcpServers 交下去，BRIDGE_URL 指回环代理", () => {
    const [m] = rt.mcpServers(spec);
    expect(m).toMatchObject({ name: "claudestra", command: "/opt/bun", args: ["/repo/src/channel-server.ts"] });
    expect(m!.env).toContainEqual({ name: "BRIDGE_URL", value: "http://127.0.0.1:9/x" });
    expect(m!.env).toContainEqual({ name: "CLAUDESTRA_RUNTIME", value: "opencode" });
    expect(rt.mcpServers({ ...spec, clean: true })).toEqual([]);
  });

  test("压缩来源 command-end、工具推迟、MCP 改名；Codex / Pi 的来源不变；不要 /clear 引导轮", () => {
    expect(rt.compactFrom).toBe("command-end");
    expect(rt.translator!("cs")).toEqual({ deferPendingTools: true, mcpUnderscoreServers: ["cs"] });
    expect(rt.clearBootstrap).toBeUndefined();
    expect(acpRuntime("codex").compactFrom).toBe("compaction-update");
    expect(acpRuntime("pi").compactFrom).toBe("claudestra-meta");
    expect(acpRuntime("codex").translator).toBeUndefined();
  });

  test("没给模型时配置里不写 model（manager 已早拒，这里不替它默认）", () => {
    expect(JSON.parse(opencodeConfigContent(undefined)).model).toBeUndefined();
  });
});

describe("二进制与沙箱目录", () => {
  test("OPENCODE_BIN 优先；否则按 npm 的 bin 目录找", () => {
    expect(opencodeBin({ OPENCODE_BIN: "/bin/sh" })).toBe("/bin/sh");
    expect(opencodeBin({}, () => ({ npm: "/x/npm", binDir: "/nonexistent" }))).toBeNull();
    expect(opencodeBin({}, () => null)).toBeNull();
  });

  test("沙箱里 OpenCode 的家目录挪进沙箱根，沙箱外不动", () => {
    expect(opencodeDirsEnv({})).toEqual({});
    const d = opencodeDirsEnv({ CLAUDESTRA_SANDBOX: "1", CLAUDESTRA_SANDBOX_ROOT: "/sb" });
    expect(d.HOME).toBe("/sb/acp-home");
    expect(d.XDG_DATA_HOME).toBe("/sb/acp-home/.local/share");
  });
});

describe("模型清单", () => {
  test("解析 opencode models 输出，丢掉非 provider/model 的行", () => {
    expect(parseOpencodeModels("opencode/big-pickle\nwarn: x\n\nanthropic/claude-x\nopencode/big-pickle\n")).toEqual(["opencode/big-pickle", "anthropic/claude-x"]);
  });

  test("成功缓存、失败不缓存", async () => {
    resetOpencodeModelsCache();
    let calls = 0;
    const fail = async () => (calls++, { ok: false, out: "", err: "boom" });
    expect(await opencodeModels(fail, "/b", 0)).toEqual([]);
    const ok = async () => (calls++, { ok: true, out: "opencode/a\n", err: "" });
    expect(await opencodeModels(ok, "/b", 1)).toEqual(["opencode/a"]);
    expect(await opencodeModels(fail, "/b", 2)).toEqual(["opencode/a"]);
    expect(calls).toBe(2);
    resetOpencodeModelsCache();
  });
});

/** OpenCode 运行时的接线：注册表、宿主运行时、启动命令、模型必填、transport 选择、catalog 模型清单。docs/runtimes/opencode-acp.md */
import { describe, expect, test } from "bun:test";
import { acpRuntime, opencodeConfigContent } from "../src/lib/acp/host-runtime";
import { opencodeBin, opencodeDirsEnv } from "../src/lib/acp/opencode-bin";
import { enforceOpencodeModel } from "../src/lib/acp/opencode-model-check";
import { AcpIncompatibleError } from "../src/lib/acp/protocol";
import { parseOpencodeModels, opencodeModels, resetOpencodeModelsCache } from "../src/lib/opencode-models";
import { ACP_CONTROL } from "../src/lib/runtimes/acp-control";
import { controlFor, managedFor, manageableRuntimeIds, requireManaged, sourceFor, transportsOf } from "../src/lib/runtimes/index";
import { buildOpencodeAcpHostCommand, OPENCODE_MODEL_REQUIRED, opencodeAcpAdapter } from "../src/lib/runtimes/opencode-acp";
import { waitOpencodeReady } from "../src/lib/runtimes/opencode-ready";
import { parseCreateArgs } from "../src/manager/create-args";
import { chooseCreateTransport, refuseResumeEarly, transportRefusal } from "../src/manager/acp-lifecycle";

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
    const noEff = parseCreateArgs(["a", "/tmp", "--runtime", "opencode", "--model", "opencode/x", "--effort", "high"]);
    expect("error" in noEff ? noEff.error : noEff.effort).toBeUndefined(); // OpenCode 没有 effort：提示后丢弃
    const piEff = parseCreateArgs(["a", "/tmp", "--runtime", "pi", "--effort", "high"]);
    expect("error" in piEff ? piEff.error : piEff.effort).toBe("high");
  });

  test("resume / 收编不带 --model 在建频道前就拒；别的运行时不要求", () => {
    expect(() => refuseResumeEarly(opencodeAcpAdapter, false, undefined)).toThrow(OPENCODE_MODEL_REQUIRED);
    expect(() => refuseResumeEarly(opencodeAcpAdapter, false, "opencode/big-pickle")).not.toThrow();
    expect(() => refuseResumeEarly(managedFor("codex", "acp")!, false, undefined)).not.toThrow();
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
    expect(parseOpencodeModels("opencode/big-pickle\nwarn: x\n\nanthropic/claude-x\nopencode/big-pickle\nopenrouter/anthropic/claude-sonnet-4.5\n")).toEqual([
      "opencode/big-pickle", "anthropic/claude-x", "openrouter/anthropic/claude-sonnet-4.5",
    ]);
    expect(parseOpencodeModels("zz/a+b\nzz/ok\n")).toEqual(["zz/ok"]); // 与 isSafeModelArg 对齐：不收 +
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

describe("模型必须真的生效（enforceOpencodeModel）", () => {
  const CHOICES = ["opencode/big-pickle", "opencode/x", "zz/anthropic/claude-x"];
  const opts = (current: string) => [{ id: "model", name: "Model", currentValue: current, choices: CHOICES.map((value) => ({ value, name: value })) }];
  const fake = (current: string, set: { ok: true } | { ok: false; error: string }, moves: boolean) => {
    const s: any = { configOptions: opts(current) };
    s.setConfig = async (_id: string, v: string) => {
      if (moves) s.configOptions = opts(v);
      return set;
    };
    return s;
  };
  const OK = { ok: true } as const;

  test("生效：不抛", async () => {
    await enforceOpencodeModel(fake("opencode/big-pickle", OK, true), "opencode/x");
  });

  test("set 说成功但实际还在免费缺省：拒，报给的和实际的", async () => {
    await expect(enforceOpencodeModel(fake("opencode/big-pickle", OK, false), "opencode/x")).rejects.toThrow("给的 opencode/x，实际 opencode/big-pickle");
  });

  test("不在选项里 / 没登记：拒（AcpIncompatibleError）", async () => {
    await expect(enforceOpencodeModel(fake("opencode/big-pickle", OK, true), "opencode/nope")).rejects.toThrow(AcpIncompatibleError);
    await expect(enforceOpencodeModel(fake("opencode/big-pickle", OK, true), undefined)).rejects.toThrow(AcpIncompatibleError);
  });

  test("逐字匹配：只给后半段会被换 provider 的，拒并报出全名", async () => {
    const e = enforceOpencodeModel(fake("opencode/big-pickle", OK, true), "anthropic/claude-x");
    await expect(e).rejects.toThrow(AcpIncompatibleError);
    await expect(enforceOpencodeModel(fake("opencode/big-pickle", OK, true), "anthropic/claude-x")).rejects.toThrow("写全 zz/anthropic/claude-x");
  });

  test("RPC 出错（超时 / 崩溃）不是模型不被接受：普通 Error，宿主会退避重起", async () => {
    const e = await enforceOpencodeModel(fake("opencode/big-pickle", { ok: false, error: "请求超时" }, false), "opencode/x").catch((x) => x);
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(AcpIncompatibleError);
    expect(e.message).toContain("会重试");
  });
});

describe("就绪等待：宿主拒起就立刻返回（waitOpencodeReady）", () => {
  const { mkdtempSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const dir = mkdtempSync(`${tmpdir()}/oc-ready-`);
  const win = (opt: () => string | null): any => ({
    name: "agent-oc", target: "t", capture: async () => "", getOption: async () => opt(), childPids: async () => [1], sleep: (ms: number) => Bun.sleep(ms),
  });

  test("本次启动之后的「不再重起」→ 带原因失败返回，不等满预算", async () => {
    const log = `${dir}/refused.log`;
    writeFileSync(log, `${new Date(Date.now() - 3600_000).toISOString()} 适配器接不上线程：旧的（不再重起；…）\n`);
    const t0 = Date.now();
    const pending = waitOpencodeReady(win(() => null), { rounds: 2_000, pollMs: 5 }, log); // 预算 10s
    writeFileSync(log, `${new Date().toISOString()} 适配器接不上线程：OpenCode 模型不被接受：给的 a/b（不再重起；不标就绪…）\n`, { flag: "a" });
    const r = await pending;
    expect(r).toEqual({ ready: false, reason: "exited", detail: "宿主拒起：OpenCode 模型不被接受：给的 a/b" });
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  test("只有旧的拒起记录、标记到了：就绪", async () => {
    const log = `${dir}/old.log`;
    writeFileSync(log, `${new Date(Date.now() - 3600_000).toISOString()} 适配器接不上线程：旧的（不再重起；…）\n`);
    let n = 0;
    expect(await waitOpencodeReady(win(() => (++n > 3 ? "1" : null)), { rounds: 50, pollMs: 5 }, log)).toEqual({ ready: true });
  });
});

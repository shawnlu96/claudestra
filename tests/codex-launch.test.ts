import { describe, expect, test } from "bun:test";
import {
  BOOTSTRAP_MARKER,
  CODEX_MCP_ENV_VARS,
  bootstrapArgs,
  buildCodexCommand,
  codexEffort,
  codexModel,
  codexPermissionFlags,
  parseBootstrapThreadId,
  probeCodexQueue,
  resolveCodexBinary,
  tomlString,
  type CodexLaunchSpec,
} from "../src/lib/codex-launch.js";

const SID = "01a0ca4b-ebca-7b23-b5a2-87941f333018";
const spec = (over: Partial<CodexLaunchSpec> = {}): CodexLaunchSpec => ({
  mode: "resume",
  sessionId: SID,
  agentName: "agent-x",
  channelId: "999000111",
  bridgeUrl: "ws://127.0.0.1:3847",
  bridgePort: "3847",
  cwd: "/tmp/work dir",
  codexBin: "/opt/homebrew/bin/codex",
  bunBin: "/opt/homebrew/bin/bun",
  claudestraHome: "/repo",
  ...over,
});

/** 用真 shell 把命令行拆回 argv —— 断言的是 shell 最终交给 codex 的东西，而不是字符串长相 */
async function shellArgv(cmd: string): Promise<{ env: Record<string, string>; argv: string[] }> {
  const script = `set -- ${cmd.replace(/^((?:[A-Z_]+=\S* )+)/, "")}; for a in "$@"; do printf '%s\\0' "$a"; done`;
  const out = await new Response(Bun.spawn(["/bin/sh", "-c", script], { stdout: "pipe" }).stdout).text();
  const env: Record<string, string> = {};
  const envScript = `${(cmd.match(/^((?:[A-Z_]+=\S* )+)/) || ["", ""])[1]} env`;
  const envOut = await new Response(Bun.spawn(["/bin/sh", "-c", envScript], { stdout: "pipe", env: {} }).stdout).text();
  for (const line of envOut.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) env[line.slice(0, i)] = line.slice(i + 1);
  }
  return { env, argv: out.split("\0").slice(0, -1) };
}

describe("tomlString", () => {
  test("JSON 转义是 TOML basic string 的子集；DEL 与孤立代理另行处理", () => {
    expect(tomlString('a"b\\c\nd')).toBe('"a\\"b\\\\c\\nd"');
    expect(tomlString("中文")).toBe('"中文"');
    expect(tomlString("x\x7fy")).toBe('"x\\u007fy"');
    expect(tomlString("a\uD800b")).toBe('"a�b"');
  });
});

describe("buildCodexCommand", () => {
  test("resume：env 前缀 + 固定 flag 顺序，shell 拆回来逐项正确", async () => {
    const cmd = buildCodexCommand(spec(), "RULES");
    const { env, argv } = await shellArgv(cmd);
    expect(env).toMatchObject({
      DISCORD_CHANNEL_ID: "999000111",
      BRIDGE_URL: "ws://127.0.0.1:3847",
      BRIDGE_PORT: "3847",
      CLAUDESTRA_AGENT: "agent-x",
      CLAUDESTRA_RUNTIME: "codex",
      CLAUDESTRA_SESSION_ID: SID,
      CLAUDESTRA_CODEX_BIN: "/opt/homebrew/bin/codex",
      MCP_NAME: "claudestra",
    });
    expect(argv.slice(0, 5)).toEqual([
      "/opt/homebrew/bin/codex", "resume", SID,
      "--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust",
    ]);
    const cfgs = argv.filter((_, i) => argv[i - 1] === "-c");
    expect(cfgs[0]).toBe("check_for_update_on_startup=false");
    // 目录信任必须是内联表（点号路径实测无效）
    expect(cfgs[1]).toBe('projects={"/tmp/work dir"={trust_level="trusted"}}');
    expect(cfgs[2]).toBe('mcp_servers.claudestra.command="/opt/homebrew/bin/bun"');
    expect(cfgs[3]).toBe('mcp_servers.claudestra.args=["/repo/src/channel-server.ts"]');
    expect(cfgs[4]).toBe(`mcp_servers.claudestra.env_vars=[${CODEX_MCP_ENV_VARS.map((v) => `"${v}"`).join(",")}]`);
    expect(cfgs[5]).toBe('hooks.Stop=[{hooks=[{type="command",command="/opt/homebrew/bin/bun /repo/src/hooks/typing-hook.ts",timeout=10}]}]');
    expect(cfgs[6]).toStartWith("hooks.Interrupt=");
    expect(cfgs[7]).toStartWith('developer_instructions="');
    expect(cfgs[7]).toContain("RULES");
    expect(cmd).not.toContain("notify"); // 会顶掉用户全局的 notify
  });

  test("channel-server 拿得到就绪标记所需的 TMUX / TMUX_PANE", () => {
    expect(CODEX_MCP_ENV_VARS).toContain("TMUX");
    expect(CODEX_MCP_ENV_VARS).toContain("TMUX_PANE");
    expect(CODEX_MCP_ENV_VARS).toContain("CLAUDESTRA_RUNTIME");
  });

  test("new 与 resume 同一条命令；fork 换子命令且不报 sid（由线程锁发现）", async () => {
    expect(buildCodexCommand(spec({ mode: "new" }), "R")).toBe(buildCodexCommand(spec(), "R"));
    const { env, argv } = await shellArgv(buildCodexCommand(spec({ mode: "fork" }), "R"));
    expect(argv.slice(0, 3)).toEqual(["/opt/homebrew/bin/codex", "fork", SID]);
    expect(env.CLAUDESTRA_SESSION_ID).toBe("");
  });

  test("职责 / project 上下文 / 引号换行都能完整穿过 shell + TOML", async () => {
    const purpose = `审 PR，别碰 'main'\n第二行 "引号" $HOME`;
    const { argv } = await shellArgv(buildCodexCommand(spec({ purpose, projectContext: "project: p1" }), "R"));
    const di = argv.find((a) => a.startsWith("developer_instructions="))!;
    const text = JSON.parse(di.slice("developer_instructions=".length));
    expect(text).toContain("agent「agent-x」");
    expect(text).toContain(purpose);
    expect(text).toContain("project: p1");
  });

  test("model / effort 映射；Claude 的档位直接报错", async () => {
    const { argv } = await shellArgv(buildCodexCommand(spec({ model: "gpt-5.5", effort: "max" }), "R"));
    expect(argv).toContain("-m");
    expect(argv[argv.indexOf("-m") + 1]).toBe("gpt-5.5");
    expect(argv).toContain('model_reasoning_effort="xhigh"');
    expect(() => buildCodexCommand(spec({ model: "opus" }), "R")).toThrow();
    expect(() => buildCodexCommand(spec({ permissionMode: "acceptEdits" }), "R")).toThrow();
  });
});

describe("权限 / effort / model", () => {
  test("只放行 bypassPermissions（auto 是它的旧名）", () => {
    expect(codexPermissionFlags(undefined)).toEqual(["--dangerously-bypass-approvals-and-sandbox"]);
    expect(codexPermissionFlags("auto")).toEqual(["--dangerously-bypass-approvals-and-sandbox"]);
    for (const m of ["default", "acceptEdits", "plan", "dontAsk"]) expect(() => codexPermissionFlags(m)).toThrow();
  });
  test("effort", () => {
    expect(codexEffort(undefined)).toBeNull();
    expect(codexEffort("default")).toBeNull();
    expect(codexEffort("high")).toBe("high");
    expect(codexEffort("max")).toBe("xhigh");
    expect(() => codexEffort("turbo")).toThrow();
  });
  test("model", () => {
    expect(codexModel("")).toBeNull();
    expect(codexModel("gpt-5.5-codex")).toBe("gpt-5.5-codex");
    expect(() => codexModel("claude-fable-5-1")).toThrow();
  });
});

describe("exec 引导", () => {
  test("argv：不挂 MCP 与 hooks，prompt 带引导标记且在最后", () => {
    const a = bootstrapArgs({ codexBin: "/c", cwd: "/w", channelRules: "R", purpose: "p", effort: "low" });
    expect(a.slice(0, 6)).toEqual(["/c", "exec", "--json", "--skip-git-repo-check", "-C", "/w"]);
    expect(a).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(a.join(" ")).not.toContain("mcp_servers");
    expect(a.join(" ")).not.toContain("hooks.");
    expect(a).toContain('model_reasoning_effort="low"');
    expect(a[a.length - 1].startsWith(BOOTSTRAP_MARKER)).toBe(true);
  });

  test("parseBootstrapThreadId：取首个非空行的 thread.started", () => {
    const out = `{"type":"thread.started","thread_id":"${SID}"}\n{"type":"turn.started"}\n`;
    expect(parseBootstrapThreadId(out)).toBe(SID);
    expect(parseBootstrapThreadId(`\n${out}`)).toBe(SID);
    expect(parseBootstrapThreadId('{"type":"turn.started"}')).toBeNull();
    expect(parseBootstrapThreadId('{"type":"thread.started","thread_id":"../x"}')).toBeNull();
    expect(parseBootstrapThreadId("Reading additional input from stdin...")).toBeNull();
    expect(parseBootstrapThreadId("")).toBeNull();
  });
});

test("resolveCodexBinary：CODEX_TUI_BIN 覆盖优先，否则登录 shell 解析 codex", async () => {
  expect(await resolveCodexBinary(async () => ({ ok: false, out: "", err: "" }), { CODEX_TUI_BIN: "/x/codex" }))
    .toEqual({ link: "/x/codex", real: "/x/codex" });
  let seen: string[] = [];
  const r = await resolveCodexBinary(async (cmd) => {
    seen = cmd;
    return { ok: true, out: "/opt/homebrew/bin/codex\n/opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js\n", err: "" };
  }, {});
  expect(r?.link).toBe("/opt/homebrew/bin/codex");
  expect(seen[2]).toContain("command -v codex");
});

test("probeCodexQueue：按绝对路径跑 queue --help，exit 0 才算可用", async () => {
  let seen: string[] = [];
  expect(await probeCodexQueue(async (cmd) => { seen = cmd; return { ok: true, out: "", err: "" }; }, "/c")).toBe(true);
  expect(seen).toEqual(["/c", "queue", "--help"]);
  expect(await probeCodexQueue(async () => ({ ok: false, out: "", err: "unknown subcommand" }), "/c")).toBe(false);
});

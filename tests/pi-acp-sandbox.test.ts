/**
 * 沙箱里的 Pi（transport=acp）的边界（docs/architecture/pi-acp-sandbox.md）：放行的只有「acp + PI_CODING_AGENT_DIR 逐字等于
 * <沙箱根>/pi-agent」，其余每条拒绝路径各测一次；适配器的参数 / 环境约束；凭据只能显式拷一家 API key，不拷 OAuth 和 !命令，不打印 key。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostEnvBase, type AdapterEnvSpec } from "../src/lib/acp/adapter-proc.ts";
import { acpRuntime, PI_ARGS_ENV } from "../src/lib/acp/host-runtime.ts";
import { PI_ACP_ADAPTER_MAIN } from "../src/lib/acp/pi-adapter/main.ts";
import { SANDBOX_PI_FLAGS, sandboxPiProblem } from "../src/lib/acp/pi-adapter/sandbox-policy.ts";
import { piAgentDir } from "../src/lib/pi-session.ts";
import { buildPiAcpHostCommand, piAcpArgs } from "../src/lib/runtimes/pi-acp.ts";
import type { LaunchSpec } from "../src/lib/runtimes/types.ts";
import { assertSandboxRuntime, sandboxPiAgentDir } from "../src/lib/sandbox.ts";
import { sandboxManagerRefusal } from "../src/lib/sandbox-env.ts";
import { assertSandboxSession } from "../src/lib/sandbox-sessions.ts";
import { chooseCreateTransport } from "../src/manager/acp-lifecycle.ts";
import { cmdPiAuth, copyPiCredential, pickPiCredential } from "../scripts/sandbox-pi-auth.ts";

const root = mkdtempSync(join(tmpdir(), "pi-acp-sbx-"));
const PI_DIR = join(root, "pi-agent");
const ON = { CLAUDESTRA_SANDBOX: "1", CLAUDESTRA_SANDBOX_ROOT: root };
const PINNED = { ...ON, PI_CODING_AGENT_DIR: PI_DIR };

const KEYS = ["CLAUDESTRA_SANDBOX", "CLAUDESTRA_SANDBOX_ROOT", "PI_CODING_AGENT_DIR"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
const withEnv = (env: Record<string, string>) => Object.assign(process.env, env);

describe("闸门：只有 acp + 目录钉在沙箱根才放行", () => {
  test("放行：pi + acp + PI_CODING_AGENT_DIR 逐字等于 <根>/pi-agent；非沙箱一律不管", () => {
    expect(sandboxPiAgentDir(root)).toBe(PI_DIR);
    expect(() => assertSandboxRuntime("pi", PINNED, "acp")).not.toThrow();
    expect(() => assertSandboxRuntime("pi", { PI_CODING_AGENT_DIR: "/anywhere" }, "tmux")).not.toThrow();
  });

  test("拒绝：tmux 版 Pi（不带 transport / 显式 tmux）", () => {
    expect(() => assertSandboxRuntime("pi", PINNED)).toThrow("只支持 Claude Code");
    expect(() => assertSandboxRuntime("pi", PINNED, "tmux")).toThrow("只支持 Claude Code");
  });

  test("拒绝：目录没设、指向 owner 的 ~/.pi、沙箱根下别处、写法不同的同一路径", () => {
    for (const dir of [undefined, "", "/Users/x/.pi/agent", join(root, "other"), `${PI_DIR}/`, `${root}/x/../pi-agent`]) {
      expect(() => assertSandboxRuntime("pi", { ...ON, PI_CODING_AGENT_DIR: dir }, "acp"), String(dir)).toThrow("PI_CODING_AGENT_DIR");
    }
  });

  test("拒绝：沙箱根没设或不是绝对路径（推不出目录）；其它 runtime 与 tmux 版 Codex 照旧拒", () => {
    expect(() => assertSandboxRuntime("pi", { CLAUDESTRA_SANDBOX: "1", PI_CODING_AGENT_DIR: PI_DIR }, "acp")).toThrow("CLAUDESTRA_SANDBOX_ROOT");
    expect(() => assertSandboxRuntime("pi", { ...PINNED, CLAUDESTRA_SANDBOX_ROOT: "rel" }, "acp")).toThrow("CLAUDESTRA_SANDBOX_ROOT");
    expect(() => sandboxPiAgentDir("rel")).toThrow("绝对路径");
    expect(() => assertSandboxRuntime("gemini", PINNED, "acp")).toThrow("只支持 Claude Code");
    expect(() => assertSandboxRuntime("codex", PINNED, "tmux")).toThrow("只支持 Claude Code");
  });

  test("manager 白名单：--runtime pi 缺省 / acp 放行，tmux 拒；transport 切 tmux 拒", () => {
    expect(sandboxManagerRefusal(["create", "p", "/w", "--runtime", "pi"])).toBeNull();
    expect(sandboxManagerRefusal(["create", "p", "/w", "--runtime", "pi", "--transport", "acp"])).toBeNull();
    expect(sandboxManagerRefusal(["create", "p", "/w", "--runtime", "pi", "--transport", "tmux"])).toContain("只支持 Claude Code runtime");
    expect(sandboxManagerRefusal(["transport", "p", "acp"])).toBeNull();
    expect(sandboxManagerRefusal(["transport", "p", "tmux"])).toContain("不起真实 TUI");
  });

  test("create 的 transport：沙箱里 Pi 缺省 acp（点名 tmux 就交给闸门拒）；生产 Pi 缺省仍是 tmux", async () => {
    expect(await chooseCreateTransport("pi")).toEqual({ transport: "tmux" });
    expect(await chooseCreateTransport("pi", "acp")).toEqual({ transport: "tmux" });
    withEnv(ON);
    expect(await chooseCreateTransport("pi")).toEqual({ transport: "acp" });
    expect(await chooseCreateTransport("pi", "tmux")).toEqual({ transport: "tmux" });
  });
});

describe("沙箱里的 Pi 目录：只认推导值", () => {
  test("piAgentDir：沙箱里忽略手设的 PI_CODING_AGENT_DIR（会话发现 / 用量 / 归档都不碰 ~/.pi）；非沙箱照旧认它", () => {
    withEnv({ PI_CODING_AGENT_DIR: "/Users/x/.pi/agent" });
    expect(piAgentDir()).toBe("/Users/x/.pi/agent");
    withEnv(ON);
    expect(piAgentDir()).toBe(PI_DIR);
  });

  test("set-session 认沙箱 Pi 目录里的会话；cwd 不在沙箱根、或会话只在 owner 的 Pi 目录里，都拒", () => {
    const work = join(root, "work");
    mkdirSync(work, { recursive: true });
    const write = (dir: string, id: string, cwd: string) => {
      mkdirSync(join(dir, "sessions", "--x--"), { recursive: true });
      writeFileSync(join(dir, "sessions", "--x--", `2026-10-01T00-00-00-000Z_${id}.jsonl`), `${JSON.stringify({ type: "session", version: 3, id, cwd })}\n`);
    };
    const prodDir = join(root, "prod-pi");
    write(PI_DIR, "pi-ok-1", work);
    write(PI_DIR, "pi-out-1", "/Users/x/repos/app");
    write(prodDir, "pi-prod-1", work);
    withEnv({ ...ON, PI_CODING_AGENT_DIR: prodDir });
    expect(() => assertSandboxSession("pi-ok-1")).not.toThrow();
    expect(() => assertSandboxSession("pi-out-1")).toThrow("沙箱");
    expect(() => assertSandboxSession("pi-prod-1")).toThrow("找不到会话");
  });
});

describe("适配器：参数与环境", () => {
  const args = (...extra: string[]) => JSON.stringify(["--approve", ...SANDBOX_PI_FLAGS, ...extra]);

  test("宿主起适配器前再查：钉住 + 最小发现集放行；目录没钉住 / 少发现开关 / 带加载类参数都拒；生产不管", () => {
    const pi = acpRuntime("pi");
    expect(pi.agentCommand({ ...PINNED, [PI_ARGS_ENV]: args() }, "/opt/bun", false)).toEqual({ cmd: ["/opt/bun", PI_ACP_ADAPTER_MAIN, "--approve", ...SANDBOX_PI_FLAGS], stub: false });
    expect(pi.agentCommand({ ...ON, [PI_ARGS_ENV]: args() }, "/opt/bun", false)).toMatchObject({ error: expect.stringContaining("PI_CODING_AGENT_DIR") });
    expect(pi.agentCommand({ ...PINNED, [PI_ARGS_ENV]: JSON.stringify(["--approve", "--no-extensions"]) }, "/opt/bun", false))
      .toMatchObject({ error: expect.stringContaining("--no-skills") });
    const refused = [["-e", "npm:evil"], ["--extension", "/x.ts"], ["--extension=/x.ts"], ["--skill", "/s"], ["--prompt-template", "/p"], ["--theme", "/t"],
      ["--mcp-config", "/Users/x/.pi/agent/mcp.json"], ["--session-dir", "/Users/x/.pi/agent/sessions"]];
    for (const extra of refused) {
      expect(pi.agentCommand({ ...PINNED, [PI_ARGS_ENV]: args(...extra) }, "/opt/bun", false), extra.join(" ")).toMatchObject({ error: expect.stringContaining("不收") });
    }
    expect(pi.agentCommand({ [PI_ARGS_ENV]: JSON.stringify(["-e", "npm:x"]) }, "/opt/bun", false)).toMatchObject({ stub: false });
  });

  const base = {
    PATH: "/usr/bin", HOME: "/Users/x", BRIDGE_URL: "ws://localhost:23900", BRIDGE_PORT: "23900", DISCORD_CHANNEL_ID: "9", TMUX: "/t,1,0",
    PI_CODING_AGENT_DIR: "/Users/x/.pi/agent", PI_CODING_AGENT_SESSION_DIR: "/Users/x/.pi/agent/sessions",
  };
  const spec = (b: Record<string, string>): AdapterEnvSpec => ({
    base: b, bunBin: "/opt/bun", channelServer: "/repo/src/channel-server.ts", mcpName: "claudestra", logsDir: "/l",
    channel: { channelId: "1", proxyUrl: "ws://127.0.0.1:5555/?token=SECRET", agentName: "agent-p", sessionId: "s" },
  });

  test("沙箱环境：HOME 隔离、目录按根重算、不联网做杂务、不发遥测；只留 bridge 地址不留端口；回环代理 token 照旧不进来", () => {
    const env = acpRuntime("pi").adapterEnv(spec({ ...base, ...ON }));
    expect(env).toMatchObject({ HOME: join(root, "acp-home"), PI_CODING_AGENT_DIR: PI_DIR, PI_OFFLINE: "1", PI_TELEMETRY: "0", BRIDGE_URL: "ws://localhost:23900" });
    for (const k of ["BRIDGE_PORT", "PI_CODING_AGENT_SESSION_DIR", "DISCORD_CHANNEL_ID", "TMUX"]) expect(env[k], k).toBeUndefined();
    expect(JSON.stringify(env)).not.toContain("SECRET");
  });

  test("生产环境逐项不变（就是 hostEnvBase）", () => {
    expect(acpRuntime("pi").adapterEnv(spec(base))).toEqual(hostEnvBase(spec(base)));
  });

  test("适配器进程在沙箱环境里能加载（lib/paths.ts 的总闸要 bridge 地址）；拿掉 BRIDGE_URL 就加载即抛", () => {
    const b = {
      ...ON, PATH: process.env.PATH ?? "", HOME: "/Users/x", BRIDGE_URL: "ws://localhost:23900", CLAUDESTRA_STATE_DIR: join(root, "state"),
      CLAUDESTRA_RUNTIME_DIR: join(root, "run"), CLAUDESTRA_SANDBOX_DENY_PORTS: "3847", BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(root, "bun-cache"),
    };
    const load = (env: Record<string, string>) => Bun.spawnSync([process.execPath, "--no-env-file", "-e", `await import(${JSON.stringify(PI_ACP_ADAPTER_MAIN)})`], { env, stderr: "pipe" });
    const env = acpRuntime("pi").adapterEnv(spec(b));
    mkdirSync(env.HOME!, { recursive: true });
    expect(load(env).exitCode).toBe(0);
    const noUrl = { ...env };
    delete noUrl.BRIDGE_URL;
    const r = load(noUrl);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain("生产端口");
  });

  const SPEC: LaunchSpec = {
    mode: "new", channelId: "1", bridgeUrl: "ws://localhost:23900", sessionId: "019a-pi", agentName: "agent-pa", purpose: "测",
    extras: { piEnv: { extensions: ["npm:evil-pkg"], mcpConfig: "/Users/x/.pi/agent/mcp.json", trustProject: true } },
  };
  test("启动命令：沙箱里带上钉住的目录、只用最小发现集（registry 的能力档不进来），与宿主的复查对得上；没钉住就拒；生产不带目录", () => {
    const o = { bunBin: "/opt/bun", repoRoot: "/repo", env: PINNED };
    const cmd = buildPiAcpHostCommand(SPEC, o);
    expect(cmd).toContain(`PI_CODING_AGENT_DIR=${PI_DIR}`);
    expect(cmd).not.toContain("evil-pkg");
    expect(cmd).not.toContain("mcp-config");
    expect(sandboxPiProblem(PINNED, piAcpArgs(SPEC, "agent-pa", "/repo", true))).toBeNull();
    expect(() => buildPiAcpHostCommand(SPEC, { ...o, env: ON })).toThrow("PI_CODING_AGENT_DIR");
    expect(buildPiAcpHostCommand(SPEC, { ...o, env: {} })).not.toContain("PI_CODING_AGENT_DIR");
    expect(buildPiAcpHostCommand(SPEC, { ...o, env: {} })).toContain("evil-pkg"); // 生产照旧按能力档
  });
});

describe("凭据：只能显式拷一家 API key", () => {
  const src = join(root, "owner-pi");
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, "auth.json"), JSON.stringify({
    deepseek: { type: "api_key", key: "sk-SECRET-ds" },
    openai: { type: "oauth", refresh: "rt-SECRET", access: "at-SECRET", expires: 1 },
    keychain: { type: "api_key", key: "!security find-generic-password -ws x" },
    blank: { type: "api_key", key: " " },
  }));
  writeFileSync(join(src, "models.json"), JSON.stringify({ providers: {
    custom: { baseUrl: "https://llm.example", apiKey: "sk-SECRET-custom", models: [{ id: "m" }] },
    sneaky: { baseUrl: "https://x", apiKey: "k", headers: { X: "!cat ~/.ssh/id_rsa" } },
  } }));

  test("拷一家：目录 0700、文件 0600，和已拷进来的别家合并；models.json 的自定义 provider 也拷", () => {
    const dst = join(root, "dst1");
    expect(copyPiCredential("deepseek", src, dst)).toEqual({ written: [join(dst, "auth.json")] });
    expect(copyPiCredential("custom", src, dst)).toEqual({ written: [join(dst, "models.json")] });
    expect(JSON.parse(readFileSync(join(dst, "auth.json"), "utf8"))).toEqual({ deepseek: { type: "api_key", key: "sk-SECRET-ds" } });
    expect(Object.keys(JSON.parse(readFileSync(join(dst, "models.json"), "utf8")).providers)).toEqual(["custom"]);
    expect(statSync(dst).mode & 0o777).toBe(0o700);
    for (const f of ["auth.json", "models.json"]) expect(statSync(join(dst, f)).mode & 0o777).toBe(0o600);
  });

  test("不拷：OAuth、!命令（auth.json 或 models.json 的任何值）、空 key、不存在的 provider；原因里不带任何值", () => {
    const cases: [string, string][] = [["openai", "OAuth"], ["keychain", "!命令"], ["sneaky", "!命令"], ["blank", "没有 key"], ["nope", "没有 provider"]];
    for (const [p, why] of cases) {
      const r = pickPiCredential(p, JSON.parse(readFileSync(join(src, "auth.json"), "utf8")), JSON.parse(readFileSync(join(src, "models.json"), "utf8")));
      expect(r, p).toMatchObject({ error: expect.stringContaining(why) });
      expect(JSON.stringify(r)).not.toContain("SECRET");
    }
    const bad = join(root, "bad-src");
    mkdirSync(bad, { recursive: true });
    writeFileSync(join(bad, "auth.json"), "{ sk-SECRET-broken");
    expect(JSON.stringify(copyPiCredential("deepseek", bad, join(root, "dst2")))).not.toContain("SECRET");
  });

  test("命令入口：沙箱里的进程不许跑、不是沙箱目录不许写、一次只拷一家；成功的输出里没有 key", () => {
    const fail = (msg: string): never => {
      throw new Error(msg);
    };
    withEnv({ PI_CODING_AGENT_DIR: src });
    expect(() => cmdPiAuth(["deepseek"], root, "不是沙箱", fail)).toThrow("不是沙箱");
    expect(() => cmdPiAuth(["deepseek", "openai"], root, null, fail)).toThrow("一次一家");
    expect(() => cmdPiAuth(["../x"], root, null, fail)).toThrow("用法");
    const logs: string[] = [];
    const log = console.log;
    console.log = (...a: unknown[]) => void logs.push(a.join(" "));
    try {
      cmdPiAuth(["deepseek"], root, null, fail);
    } finally {
      console.log = log;
    }
    expect(logs.join("\n")).toContain(join(PI_DIR, "auth.json"));
    expect(logs.join("\n")).not.toContain("SECRET");
    withEnv(ON);
    expect(() => cmdPiAuth(["deepseek"], root, null, fail)).toThrow("沙箱外");
  });
});

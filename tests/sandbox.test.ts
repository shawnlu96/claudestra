/**
 * lib/sandbox.ts 的纯逻辑 + 各闸门在「不设沙箱开关」时逐字节不变。
 * 起真实沙箱 bridge 的无副作用验证在 tests/sandbox-isolation.test.ts。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  assertSandboxRuntime, canonicalPath, enforceSandboxBridgeEnv, enforceSandboxProcess, isSandbox, outboundAllowed, sandboxAgentDirProblem,
  sandboxBridgeEnvProblems, sandboxBridgeUrlProblem, sandboxDirProblems, sandboxStaticDirProblem, sandboxRootOf, SANDBOX_MARKER,
  normalizeSandboxAgentDir, refuseSandboxDirInProduction,
} from "../src/lib/sandbox.js";
import { assertResumable, assertSandboxSession } from "../src/lib/sandbox-sessions.js";
import { cliWrapperScript } from "../src/lib/cli-install.js";
import { runCodex } from "../src/lib/codex.js";
import { writeClaudeSettings } from "../src/lib/session-recall.js";
import { installRepoSkills } from "../src/lib/skills-install.js";
import { runManagerProcess } from "../src/lib/run-manager.js";
import { productionDeny, sandboxEnv, sandboxLaunchArgs, sandboxLayout, sandboxManagerRefusal } from "../src/lib/sandbox-env.js";
import { pickCcSessionForWindow, type CcSessionEntry } from "../src/lib/cc-sessions.js";
import { assertCreatable } from "../src/manager/core.js";
import { DEFAULT_BRIDGE_PORT, resolveBridgeUrl } from "../src/lib/bridge-url.js";
import { repoEnvVar } from "../src/lib/env-file.js";
import { pathOverrideEnv } from "../src/lib/paths.js";
import { buildClaudeCommand } from "../src/lib/claude-launch.js";
import { sandboxDeniedRoute, sandboxRouteGate } from "../src/bridge/sandbox-routes.js";
import { cleanupBgJob, tryRosterCleanup } from "../src/lib/bg-jobs.js";
import { runSwitchCommand } from "../src/lib/tmux-helper.js";
import { testChildEnv } from "./test-env.ts";

const ON = { CLAUDESTRA_SANDBOX: "1" };
const P = DEFAULT_BRIDGE_PORT;

describe("isSandbox", () => {
  test("1 = 开，空 / 0 = 关，其余写法直接报错（不悄悄当成关）", () => {
    expect(isSandbox({})).toBe(false);
    expect(isSandbox({ CLAUDESTRA_SANDBOX: "0" })).toBe(false);
    expect(isSandbox({ CLAUDESTRA_SANDBOX: " 1 " })).toBe(true);
    expect(() => isSandbox({ CLAUDESTRA_SANDBOX: "true" })).toThrow("不认识");
    expect(() => isSandbox({ CLAUDESTRA_SANDBOX: "yes" })).toThrow("不认识");
  });
});

describe("sandboxDirProblems", () => {
  const prodState = "/Users/x/.claude-orchestrator";
  const prodRun = "/tmp/claude-orchestrator";
  const check = (env: Record<string, string>, stateDir: string, runtimeDir: string) =>
    sandboxDirProblems({ env, stateDir, runtimeDir, defaultStateDir: prodState, defaultRuntimeDir: prodRun });

  test("没设 override → 两条都报", () => {
    expect(check(ON, prodState, prodRun)).toHaveLength(2);
  });
  test("override 指回生产目录、或放进生产目录里面 → 拒绝", () => {
    const env = { ...ON, CLAUDESTRA_STATE_DIR: "x", CLAUDESTRA_RUNTIME_DIR: "y" };
    expect(check(env, prodState, "/tmp/sbx/run").join()).toContain("状态目录");
    expect(check(env, `${prodState}/sandbox`, "/tmp/sbx/run").join()).toContain("重叠");
    expect(check(env, "/tmp/sbx/state", `${prodRun}/x`).join()).toContain("运行目录");
  });
  test("/private/tmp 与 /tmp 是同一个目录（macOS 软链）", () => {
    if (canonicalPath("/tmp") === "/tmp") return; // 非 macOS：没有这层软链
    const env = { ...ON, CLAUDESTRA_STATE_DIR: "x", CLAUDESTRA_RUNTIME_DIR: "y" };
    expect(check(env, "/tmp/sbx/state", "/private/tmp/claude-orchestrator").join()).toContain("运行目录");
  });
  test("独立目录 → 通过", () => {
    const env = { ...ON, CLAUDESTRA_STATE_DIR: "x", CLAUDESTRA_RUNTIME_DIR: "y" };
    expect(check(env, "/tmp/sbx/state", "/tmp/sbx/run")).toEqual([]);
  });
  test("状态目录与运行目录互相包含 → 拒绝", () => {
    const env = { ...ON, CLAUDESTRA_STATE_DIR: "x", CLAUDESTRA_RUNTIME_DIR: "y" };
    expect(check(env, "/tmp/sbx", "/tmp/sbx/run")).toHaveLength(1);
  });
});

describe("bridge 地址与 bridge 环境", () => {
  test("沙箱里的 bridge 地址必须是回环 + 非生产端口", () => {
    expect(sandboxBridgeUrlProblem(`ws://localhost:${P}`, P)).toContain("生产端口");
    expect(sandboxBridgeUrlProblem("ws://10.0.0.2:23900", P)).toContain("回环");
    expect(sandboxBridgeUrlProblem("ws://127.0.0.1:23900", P)).toBeNull();
  });
  test("resolveBridgeUrl：沙箱漏配端口就抛错，非沙箱行为不变", () => {
    expect(() => resolveBridgeUrl({ ...ON })).toThrow("沙箱模式");
    expect(resolveBridgeUrl({ ...ON, BRIDGE_PORT: "23900" })).toBe("ws://localhost:23900");
    expect(resolveBridgeUrl({})).toBe(`ws://localhost:${P}`);
  });
  test("bridge 进程：Discord token / 中继 / 多开端口 / 非回环绑定都拒绝", () => {
    const ok = { ...ON, BRIDGE_PORT: "23900" };
    expect(sandboxBridgeEnvProblems(P, ok)).toEqual([]);
    expect(sandboxBridgeEnvProblems(P, { ...ON })).toHaveLength(1);
    expect(sandboxBridgeEnvProblems(P, { ...ON, BRIDGE_PORT: String(P) })).toHaveLength(1);
    for (const k of ["DISCORD_BOT_TOKEN", "RELAY_URL", "PEER_INGRESS_PORT", "BRIDGE_LEGACY_WEB_PORT", "APNS_KEY_ID"]) {
      expect(sandboxBridgeEnvProblems(P, { ...ok, [k]: "x" }).join()).toContain(k);
    }
    expect(sandboxBridgeEnvProblems(P, { ...ok, BRIDGE_BIND: "0.0.0.0" }).join()).toContain("BRIDGE_BIND");
    expect(() => enforceSandboxBridgeEnv(P, { ...ok, DISCORD_BOT_TOKEN: "t" })).toThrow("DISCORD_BOT_TOKEN");
    expect(sandboxBridgeEnvProblems(P, { DISCORD_BOT_TOKEN: "t" })).toEqual([]); // 非沙箱：不管
  });
});

describe("outboundAllowed", () => {
  const ports = new Set([23900]);
  test("只放行回环上自己的端口", () => {
    expect(outboundAllowed("http://127.0.0.1:23900/hook", ports)).toBe(true);
    expect(outboundAllowed("ws://localhost:23900", ports)).toBe(true);
    expect(outboundAllowed(`http://127.0.0.1:${P}/hook`, ports)).toBe(false);
    expect(outboundAllowed("https://api.github.com/repos/x", ports)).toBe(false);
    expect(outboundAllowed("wss://relay.example.com", ports)).toBe(false);
    expect(outboundAllowed("http://localhost/x", ports)).toBe(false); // 80 端口
    expect(outboundAllowed("not a url", ports)).toBe(false);
    expect(outboundAllowed("data:text/plain,hi", ports)).toBe(true);
  });
});

describe("sandboxEnv", () => {
  test("从零构建：调用者的 BRIDGE_URL / 频道 / token / .env 类配置一个都不带", () => {
    const base = {
      PATH: "/bin", HOME: "/Users/x", BRIDGE_URL: `ws://localhost:${P}`, BRIDGE_PORT: String(P), DISCORD_CHANNEL_ID: "1",
      MCP_NAME: "claudestra", DISCORD_BOT_TOKEN: "t", RELAY_URL: "wss://r", CLAUDESTRA_STATE_DIR: "/prod", HTTPS_PROXY: "http://127.0.0.1:9",
    };
    const env = sandboxEnv(base, { layout: sandboxLayout("/tmp/sbx"), port: 23900, deny: { ports: [P, 3848], dirs: ["/p/state", "/p/run"] } });
    expect(env).toEqual({
      PATH: "/bin", HOME: "/Users/x", HTTPS_PROXY: "http://127.0.0.1:9",
      CLAUDESTRA_SANDBOX: "1", CLAUDESTRA_SANDBOX_ROOT: "/tmp/sbx", CLAUDESTRA_SANDBOX_DENY_PORTS: `${P},3848`,
      CLAUDESTRA_SANDBOX_DENY_DIRS: "/p/state:/p/run", CLAUDESTRA_STATE_DIR: "/tmp/sbx/state", CLAUDESTRA_RUNTIME_DIR: "/tmp/sbx/run",
      MASTER_DIR: "/tmp/sbx/master", BRIDGE_PORT: "23900", BRIDGE_URL: "ws://localhost:23900", BRIDGE_BIND: "127.0.0.1",
      HISTFILE: "/tmp/sbx/shell_history", ZDOTDIR: "/tmp/sbx/zdotdir", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "/tmp/sbx/bun-cache",
      PYTHONDONTWRITEBYTECODE: "1", CODEX_HOME: "/tmp/sbx/acp-home/.codex",
    });
  });
});

describe("生产改过的端口 / 目录", () => {
  test("productionDeny：默认值 + plist / .env 里改过的端口与目录", () => {
    const d = productionDeny(
      [{ BRIDGE_PORT: "13847", PEER_INGRESS_PORT: "3848", WEB_PORT: "x" }, { CLAUDESTRA_STATE_DIR: "/srv/cs", MASTER_DIR: "rel/ignored" }],
      { port: P, dirs: ["/home/x/.cs"] },
    );
    expect(d.ports.sort()).toEqual([13847, 3848, P].sort());
    expect(d.dirs).toEqual(["/home/x/.cs", "/srv/cs"]);
  });
  test("拒绝清单里的端口与目录，和默认值一样被拒", () => {
    const env = { ...ON, CLAUDESTRA_SANDBOX_DENY_PORTS: "13847", CLAUDESTRA_SANDBOX_DENY_DIRS: "/srv/cs", CLAUDESTRA_STATE_DIR: "x", CLAUDESTRA_RUNTIME_DIR: "y" };
    expect(sandboxBridgeEnvProblems(P, { ...env, BRIDGE_PORT: "13847" }).join()).toContain("生产端口");
    expect(() => resolveBridgeUrl({ ...env, BRIDGE_URL: "ws://localhost:13847" })).toThrow("生产端口");
    const dirs = { env, stateDir: "/srv/cs/sbx", runtimeDir: "/tmp/sbx/run", defaultStateDir: "/Users/x/.cs", defaultRuntimeDir: "/tmp/co" };
    expect(sandboxDirProblems(dirs).join()).toContain("/srv/cs");
  });
  test("BRIDGE_PORT 与 BRIDGE_URL 不一致 → 拒绝（出站白名单按 URL 放行）", () => {
    const c = {
      env: { ...ON, CLAUDESTRA_STATE_DIR: "x", CLAUDESTRA_RUNTIME_DIR: "y", BRIDGE_PORT: "23901" },
      stateDir: "/tmp/sbx/state", runtimeDir: "/tmp/sbx/run", defaultStateDir: "/Users/x/.cs", defaultRuntimeDir: "/tmp/co",
      bridgeUrl: () => "ws://localhost:23902",
    };
    expect(() => enforceSandboxProcess(c)).toThrow("不一致");
  });
});

describe("沙箱 agent 的目录与 runtime", () => {
  const root = mkdtempSync(join(tmpdir(), "sbx-root-"));
  mkdirSync(join(root, "work"));
  writeFileSync(join(root, "work", "file"), "");
  const env = { ...ON, CLAUDESTRA_SANDBOX_ROOT: root, HOME: root };
  test("只许建在沙箱根目录下、且目录已存在（不存在时 tmux 会回落到 $HOME）", () => {
    expect(sandboxAgentDirProblem(join(root, "work"), env)).toBeNull();
    expect(sandboxAgentDirProblem(root, env)).not.toBeNull();
    expect(sandboxAgentDirProblem("/Users/x/repos/wt", env)).toContain(root);
    expect(sandboxAgentDirProblem(join(root, "work", "typo"), env)).toContain("不存在");
    expect(sandboxAgentDirProblem(join(root, "work", "file"), env)).toContain("不是目录");
    expect(sandboxAgentDirProblem(`${root}/../elsewhere`, env)).not.toBeNull();
    expect(sandboxAgentDirProblem("work", env)).toContain("绝对路径");
    expect(sandboxAgentDirProblem("~/work", env)).toBeNull(); // HOME 指向沙箱根时 ~ 照常展开
    expect(sandboxAgentDirProblem(`${join(root, "work")} `, env)).toContain("不存在"); // 不 trim：查的就是 tmux 收到的串
    expect(normalizeSandboxAgentDir(` ${join(root, "work")} `, env)).toBe(join(root, "work"));
    expect(normalizeSandboxAgentDir(" /x ", {})).toBe(" /x "); // 非沙箱原样
    expect(sandboxAgentDirProblem("~foo", env)).toContain("~user");
    expect(sandboxAgentDirProblem("/tmp/x", { ...ON })).toContain("CLAUDESTRA_SANDBOX_ROOT");
    expect(sandboxAgentDirProblem("/anywhere", {})).toBeNull();
  });
  test("sandboxRootOf：往上找沙箱标记；生产侧据此拒绝接管沙箱的会话", () => {
    writeFileSync(join(root, SANDBOX_MARKER), "{}");
    expect(sandboxRootOf(join(root, "work", "deeper"))).toBe(canonicalPath(root));
    expect(sandboxRootOf(tmpdir())).toBeNull();
  });
  test("生产侧：create / cron-add 的目录在沙箱根下就拒绝；沙箱里不管", () => {
    expect(() => refuseSandboxDirInProduction(join(root, "work"), "建 agent", {})).toThrow("在沙箱");
    expect(() => refuseSandboxDirInProduction(tmpdir(), "建 agent", {})).not.toThrow();
    expect(() => refuseSandboxDirInProduction("-", "建 cron 任务", {})).not.toThrow();
    expect(() => refuseSandboxDirInProduction(join(root, "work"), "建 agent", env)).not.toThrow();
  });
  test("assertResumable：沙箱里一律拒绝；生产里目录属于沙箱就拒绝", () => {
    expect(() => assertResumable("00000000-0000-4000-8000-000000000000", join(root, "work"))).toThrow("属于沙箱");
    expect(() => assertResumable("00000000-0000-4000-8000-000000000000", tmpdir())).not.toThrow();
    process.env.CLAUDESTRA_SANDBOX = "1";
    try {
      expect(() => assertResumable("00000000-0000-4000-8000-000000000000", tmpdir())).toThrow("沙箱里不许");
    } finally {
      delete process.env.CLAUDESTRA_SANDBOX;
    }
  });
  test("只许 Claude Code runtime", () => {
    expect(() => assertSandboxRuntime("codex", env)).toThrow("Claude Code");
    expect(() => assertSandboxRuntime("pi", env)).toThrow();
    expect(() => assertSandboxRuntime("claude-code", env)).not.toThrow();
    expect(() => assertSandboxRuntime("codex", {})).not.toThrow();
  });
});

describe("sandboxStaticDirProblem", () => {
  test("生产状态目录（含 web-releases）拒绝，worktree 的 web/out 放行", () => {
    const prod = "/Users/x/.claude-orchestrator";
    expect(sandboxStaticDirProblem(`${prod}/web-releases/current`, prod)).toContain("web-releases");
    expect(sandboxStaticDirProblem(prod, prod)).not.toBeNull();
    expect(sandboxStaticDirProblem("/tmp/wt/web/out", prod)).toBeNull();
  });
});

describe("sandboxManagerRefusal", () => {
  test("白名单外的子命令、master、外部共享、非 Claude Code runtime 都拒绝", () => {
    expect(sandboxManagerRefusal(["create", "a", "/tmp/w"])).toBeNull();
    expect(sandboxManagerRefusal(["install-cli"])).toContain("install-cli");
    expect(sandboxManagerRefusal(["update"])).not.toBeNull();
    expect(sandboxManagerRefusal(["resume", "a", "sid"])).not.toBeNull();
    expect(sandboxManagerRefusal(["restart", "--include-master"])).not.toBeNull();
    expect(sandboxManagerRefusal(["create", "a", "/w", "--external"])).not.toBeNull();
    expect(sandboxManagerRefusal(["create", "a", "/w", "--runtime", "pi"])).not.toBeNull();
    expect(sandboxManagerRefusal([])).not.toBeNull();
  });
});

describe("沙箱关掉的 API 与动作", () => {
  const saved = process.env.CLAUDESTRA_SANDBOX;
  afterEach(() => {
    if (saved === undefined) delete process.env.CLAUDESTRA_SANDBOX;
    else process.env.CLAUDESTRA_SANDBOX = saved;
  });

  test("拒绝表：写 settings.json、动会话 / bg job、升级、peer", () => {
    expect(sandboxDeniedRoute("PUT", "/config/claude-defaults")).not.toBeNull();
    expect(sandboxDeniedRoute("GET", "/config/claude-defaults")).toBeNull();
    for (const a of ["manage", "cleanup", "adopt"]) expect(sandboxDeniedRoute("POST", `/sessions/abc/${a}`)).not.toBeNull();
    expect(sandboxDeniedRoute("POST", "/agents/resume")).not.toBeNull();
    expect(sandboxDeniedRoute("POST", "/update")).not.toBeNull();
    expect(sandboxDeniedRoute("GET", "/update/check")).not.toBeNull();
    expect(sandboxDeniedRoute("GET", "/peers")).not.toBeNull();
    expect(sandboxDeniedRoute("POST", "/agents/a/messages")).toBeNull();
    expect(sandboxDeniedRoute("POST", "/agents")).toBeNull();
  });
  test("路由闸：非沙箱放行，沙箱 403", async () => {
    const req = new Request("http://127.0.0.1/api/v1/update", { method: "POST" });
    delete process.env.CLAUDESTRA_SANDBOX;
    expect(sandboxRouteGate(req, new URL(req.url))).toBeNull();
    process.env.CLAUDESTRA_SANDBOX = "1";
    const r = sandboxRouteGate(req, new URL(req.url));
    expect(r?.status).toBe(403);
    expect(((await r!.json()) as { sandbox: boolean }).sandbox).toBe(true);
  });
  test("manager create 的入口校验：沙箱里查目录与 runtime，非沙箱只查名字", () => {
    delete process.env.CLAUDESTRA_SANDBOX;
    expect(() => assertCreatable("a", "/anywhere", "codex")).not.toThrow();
    const root = mkdtempSync(join(tmpdir(), "sbx-create-"));
    mkdirSync(join(root, "work"));
    Object.assign(process.env, { CLAUDESTRA_SANDBOX: "1", CLAUDESTRA_SANDBOX_ROOT: root });
    try {
      expect(() => assertCreatable("a", "/elsewhere", undefined)).toThrow("沙箱 agent 必须建在");
      expect(() => assertCreatable("a", join(root, "work"), "codex")).toThrow("Claude Code");
      expect(() => assertCreatable("a", join(root, "work"), undefined)).not.toThrow();
      expect(() => assertCreatable("a", join(root, "work", "typo"), undefined)).toThrow("不存在");
      expect(assertCreatable("a", `${join(root, "work")} `, undefined)).toBe(join(root, "work")); // 调用方拿到的是规范化后的
      expect(() => assertSandboxSession("00000000-0000-4000-8000-000000000000")).toThrow("找不到会话");
    } finally {
      delete process.env.CLAUDESTRA_SANDBOX_ROOT;
    }
  });
  test("会话认领：沙箱里只按 pid 认，不按 pane 编号（两个 tmux server 的 %N 会撞）", () => {
    const e: CcSessionEntry = { pid: 99999, sessionId: "prod", cwd: "/w", tmux: "master:@1.%3" };
    delete process.env.CLAUDESTRA_SANDBOX;
    expect(pickCcSessionForWindow([e], { childPids: [], paneId: "%3" })?.sessionId).toBe("prod");
    process.env.CLAUDESTRA_SANDBOX = "1";
    expect(pickCcSessionForWindow([e], { childPids: [], paneId: "%3" })).toBeNull();
    expect(pickCcSessionForWindow([e], { childPids: [99999], paneId: "%3" })?.sessionId).toBe("prod");
  });
  test("撞号：生产按 pane 找自己的会话时，同编号 %N 的沙箱会话不会被认走（生产登记还没写的那一刻）", () => {
    delete process.env.CLAUDESTRA_SANDBOX;
    const sbx = { pid: 424242, sessionId: "sandbox-sid", cwd: "/tmp/claudestra-sandbox-23900/work", tmux: "master:@1.%3" } as CcSessionEntry;
    // 生产窗口 %3、cwd 在生产目录：只有沙箱那条凭 pane 撞上 → 不认（撤掉 cwd 条件这里会拿到 sandbox-sid）
    expect(pickCcSessionForWindow([sbx], { childPids: [], paneId: "%3", cwd: "/Users/x/repos/app" })).toBeNull();
    // 合法的 pane 命中：cwd 一致照常认
    const own = { ...sbx, sessionId: "own", cwd: "/Users/x/repos/app" };
    expect(pickCcSessionForWindow([sbx, own], { childPids: [], paneId: "%3", cwd: "/Users/x/repos/app" })?.sessionId).toBe("own");
  });
  test("ask_codex、写 settings.json、装 skill：沙箱里拒绝", async () => {
    process.env.CLAUDESTRA_SANDBOX = "1";
    const r = await runCodex({ prompt: "hi" } as Parameters<typeof runCodex>[0]);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("沙箱");
    await expect(writeClaudeSettings("/nonexistent/settings.json", {})).rejects.toThrow("沙箱里不许");
    expect(() => installRepoSkills("/nonexistent")).toThrow("沙箱里不许"); // manager 的调用都不传 apply（默认就是装）
    expect(() => installRepoSkills("/nonexistent", { apply: false })).not.toThrow(); // doctor 的只读体检照常
  });
  test("全局 claudestra wrapper：带着沙箱环境敲它直接拒绝（不连生产 tmux / launchd）", () => {
    const dir = mkdtempSync(join(tmpdir(), "sbx-wrap-"));
    writeFileSync(join(dir, "claudestra"), cliWrapperScript("/opt/claudestra"));
    const r = Bun.spawnSync(["bash", join(dir, "claudestra"), "ls"], { env: testChildEnv({ PATH: "/usr/bin:/bin", CLAUDESTRA_SANDBOX: "1" }), stdout: "pipe", stderr: "pipe" });
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("沙箱环境");
  });
  test("bridge 拉起的 manager：沙箱里带 --no-env-file，非沙箱命令行不变", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sbx-rm-"));
    const fake = join(dir, "fake-bun");
    writeFileSync(fake, '#!/bin/sh\nprintf \'{"ok":true,"argv":"%s"}\\n\' "$*"\n');
    chmodSync(fake, 0o755);
    const run = (env: Record<string, string>) => runManagerProcess(["list"], { bunPath: fake, managerPath: "/m.ts", env, timeoutMs: 5000 });
    expect((await run({ PATH: process.env.PATH ?? "" })).argv).toBe("run /m.ts list");
    expect((await run({ PATH: process.env.PATH ?? "", CLAUDESTRA_SANDBOX: "1" })).argv).toBe("--no-env-file run /m.ts list");
  });
  test("bg job 清理 / roster 根治、/model /effort 切换：沙箱里直接拒绝，不碰进程与文件", async () => {
    process.env.CLAUDESTRA_SANDBOX = "1";
    expect((await cleanupBgJob("abc-123", { jobsDir: "/nonexistent" })).ok).toBe(false);
    expect((await tryRosterCleanup("abc-123", "/nonexistent/roster.json")).note).toContain("沙箱");
    const io = { capture: async () => { throw new Error("不该 capture"); }, sendLine: async () => { throw new Error("不该发键"); } };
    const r = await runSwitchCommand("master:x", "model", "opus", { io: io as never });
    expect(r.outcome).toBe("rejected");
    expect(r.reason).toContain("沙箱");
  });
});

describe("repoEnvVar", () => {
  test("沙箱不读仓库 .env，非沙箱照读", () => {
    const repo = mkdtempSync(join(tmpdir(), "sbx-env-"));
    try {
      writeFileSync(join(repo, ".env"), "RELAY_URL=wss://prod-relay\n");
      expect(repoEnvVar("RELAY_URL", repo, {})).toBe("wss://prod-relay");
      expect(repoEnvVar("RELAY_URL", repo, { ...ON })).toBe("");
      expect(repoEnvVar("RELAY_URL", repo, { ...ON, RELAY_URL: "x" })).toBe("x");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("启动命令", () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const k of ["CLAUDESTRA_SANDBOX", "CLAUDESTRA_STATE_DIR", "CLAUDESTRA_RUNTIME_DIR", "MCP_NAME"]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
  const opts = {
    channelId: "123", bridgeUrl: "ws://localhost:23901", sessionId: "00000000-0000-4000-8000-000000000000",
    effort: "high", purpose: "p", agentName: "agent-x",
  };

  test("不设沙箱开关：与改动前逐字节相同", () => {
    for (const k of ["CLAUDESTRA_SANDBOX", "CLAUDESTRA_STATE_DIR", "CLAUDESTRA_RUNTIME_DIR"]) delete process.env[k];
    expect(pathOverrideEnv({})).toEqual({});
    expect(buildClaudeCommand(opts)).toBe(
      "DISCORD_CHANNEL_ID=123 BRIDGE_URL=ws://localhost:23901 BRIDGE_PORT=23901 MCP_NAME=claudestra claude " +
        "--dangerously-load-development-channels server:claudestra --dangerously-skip-permissions " +
        "--session-id 00000000-0000-4000-8000-000000000000 --effort high --disallowedTools 'Bash(rm -rf:*) Bash(rm -r:*) " +
        "Bash(rmdir:*) Bash(git push --force:*) Bash(git reset --hard:*) Bash(git clean -f:*) Bash(chmod 777:*) Bash(:(){:|:&};:)' " +
        "--append-system-prompt '你是 Claudestra 编排系统中的 agent「agent-x」。你的职责: p'",
    );
  });

  test("沙箱：前缀带上开关与目录，channel-server 用本仓库的、且只加载它一个 MCP", () => {
    Object.assign(process.env, { CLAUDESTRA_SANDBOX: "1", CLAUDESTRA_STATE_DIR: "/tmp/s/state", CLAUDESTRA_RUNTIME_DIR: "/tmp/s/run" });
    const cmd = buildClaudeCommand(opts);
    expect(cmd).toContain("CLAUDESTRA_STATE_DIR=/tmp/s/state CLAUDESTRA_RUNTIME_DIR=/tmp/s/run CLAUDESTRA_SANDBOX=1 claude");
    expect(cmd).toContain("--strict-mcp-config");
    expect(cmd).toContain(join(import.meta.dir, "..", "src", "channel-server.ts"));
    expect(cmd).toContain(`--settings '{"statusLine":{"type":"command","command":"${join(import.meta.dir, "..", "scripts", "statusline-usage.sh")}"}}'`);
  });

  test("sandboxLaunchArgs：本 checkout 的 channel-server（--no-env-file）与 statusLine，只加载这一个 MCP", () => {
    const [f1, mcp, strict, f2, settings] = sandboxLaunchArgs("claudestra", "/bin/bun", "/repo/src");
    expect([f1, strict, f2]).toEqual(["--mcp-config", "--strict-mcp-config", "--settings"]);
    expect(JSON.parse(mcp!)).toEqual({ mcpServers: { claudestra: { command: "/bin/bun", args: ["--no-env-file", "/repo/src/channel-server.ts"] } } });
    expect(JSON.parse(settings!)).toEqual({ statusLine: { type: "command", command: "/repo/scripts/statusline-usage.sh" } });
  });
});

describe("canonicalPath", () => {
  test("不存在的尾巴原样接在祖先的真实路径后面", () => {
    const d = mkdtempSync(join(tmpdir(), "sbx-canon-"));
    try {
      mkdirSync(join(d, "a"));
      expect(canonicalPath(join(d, "a", "b", "c")).endsWith(join("a", "b", "c"))).toBe(true);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

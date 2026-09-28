/**
 * lib/sandbox.ts 的纯逻辑 + 各闸门在「不设沙箱开关」时逐字节不变。
 * 起真实沙箱 bridge 的无副作用验证在 tests/sandbox-isolation.test.ts。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  canonicalPath, isSandbox, outboundAllowed, sandboxBridgeEnvProblems, sandboxBridgeUrlProblem, sandboxDirProblems,
  sandboxEnv, sandboxLayout, sandboxManagerRefusal, sandboxMcpArgs, enforceSandboxBridgeEnv,
} from "../src/lib/sandbox.js";
import { DEFAULT_BRIDGE_PORT, resolveBridgeUrl } from "../src/lib/bridge-url.js";
import { repoEnvVar } from "../src/lib/env-file.js";
import { pathOverrideEnv } from "../src/lib/paths.js";
import { buildClaudeCommand } from "../src/lib/claude-launch.js";
import { sandboxDeniedRoute, sandboxRouteGate } from "../src/bridge/sandbox-routes.js";
import { cleanupBgJob, tryRosterCleanup } from "../src/lib/bg-jobs.js";
import { runSwitchCommand } from "../src/lib/tmux-helper.js";

const ON = { CLAUDESTRA_SANDBOX: "1" };
const P = DEFAULT_BRIDGE_PORT;

describe("isSandbox", () => {
  test("只认字面量 1", () => {
    expect(isSandbox({})).toBe(false);
    expect(isSandbox({ CLAUDESTRA_SANDBOX: "true" })).toBe(false);
    expect(isSandbox({ CLAUDESTRA_SANDBOX: " 1 " })).toBe(true);
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
    expect(sandboxBridgeUrlProblem(`ws://localhost:${P}`, P)).toContain("生产默认端口");
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
    const env = sandboxEnv(base, { layout: sandboxLayout("/tmp/sbx"), port: 23900 });
    expect(env).toEqual({
      PATH: "/bin", HOME: "/Users/x", HTTPS_PROXY: "http://127.0.0.1:9",
      CLAUDESTRA_SANDBOX: "1", CLAUDESTRA_STATE_DIR: "/tmp/sbx/state", CLAUDESTRA_RUNTIME_DIR: "/tmp/sbx/run",
      MASTER_DIR: "/tmp/sbx/master", BRIDGE_PORT: "23900", BRIDGE_URL: "ws://localhost:23900", BRIDGE_BIND: "127.0.0.1",
      HISTFILE: "/tmp/sbx/shell_history", ZDOTDIR: "/tmp/sbx/zdotdir", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "/tmp/sbx/bun-cache",
    });
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
    expect(cmd).toContain(join(import.meta.dir, "..", "src", "channel-server.ts").replace(/\/tests\/\.\./, ""));
  });

  test("sandboxMcpArgs：同名 server、--no-env-file", () => {
    const [flag, json, strict] = sandboxMcpArgs("claudestra", "/bin/bun", "/repo/src/channel-server.ts");
    expect(flag).toBe("--mcp-config");
    expect(strict).toBe("--strict-mcp-config");
    expect(JSON.parse(json!)).toEqual({ mcpServers: { claudestra: { command: "/bin/bun", args: ["--no-env-file", "/repo/src/channel-server.ts"] } } });
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

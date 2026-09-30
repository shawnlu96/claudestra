/** T94 出借 worker 的白名单环境（src/lib/runtimes/clean-env.ts，接到 codex-acp 启动命令与 ACP 适配器环境） */
import { describe, expect, test } from "bun:test";
import { adapterEnv } from "../src/lib/acp/adapter-proc.js";
import { shellEscape } from "../src/lib/claude-launch.js";
import { buildAcpHostCommand } from "../src/lib/runtimes/codex-acp.js";
import { CLEAN_ENV_FLAG, envIPrefix, isLendWorkerName, LEND_WORKER_MARK, LEND_WORKER_PREFIX, pickWorkerEnv, WORKER_ENV_WHITELIST } from "../src/lib/runtimes/clean-env.js";
import type { LaunchSpec } from "../src/lib/runtimes/types.js";
import { testChildEnv } from "./test-env.js";

/** B 的 daemon 环境里可能有的东西：.env 的键、控制 token、GitHub token、peer 相关、代理 */
const DIRTY: Record<string, string> = {
  PATH: "/usr/bin:/bin", HOME: "/Users/b", USER: "b", LANG: "zh_CN.UTF-8", TERM: "xterm-256color", TMPDIR: "/tmp/b", CODEX_HOME: "/Users/b/.codex",
  DISCORD_BOT_TOKEN: "bot-secret", BRIDGE_CONTROL_TOKEN: "ctl-secret", GH_TOKEN: "gh-secret", GITHUB_TOKEN: "gh2-secret",
  CLAUDESTRA_CALLER_CRED_FILE: "/tmp/cred", CLAUDESTRA_PEER_TOKEN: "peer-secret", HTTPS_PROXY: "http://proxy:8080", SSH_AUTH_SOCK: "/tmp/agent.sock",
  OPENAI_API_KEY: "sk-secret",
};
const SECRETS = ["bot-secret", "ctl-secret", "gh-secret", "gh2-secret", "peer-secret", "sk-secret", "proxy:8080", "agent.sock"];

describe("T94 白名单环境", () => {
  test("只留 PATH HOME USER LANG TERM TMPDIR CODEX_HOME", () => {
    expect([...WORKER_ENV_WHITELIST]).toEqual(["PATH", "HOME", "USER", "LANG", "TERM", "TMPDIR", "CODEX_HOME"]);
    expect(Object.keys(pickWorkerEnv(DIRTY)).sort()).toEqual([...WORKER_ENV_WHITELIST].sort());
  });

  test("按名字认出借 worker：agent-lend-* 才是，别的不是", () => {
    expect(isLendWorkerName(`${LEND_WORKER_PREFIX}abc`)).toBe(true);
    expect(isLendWorkerName("agent-task-t94")).toBe(false);
    expect(isLendWorkerName(undefined)).toBe(false);
  });

  test("env -i 前缀真的清掉继承的变量：在脏环境里跑 /usr/bin/env，只剩白名单与 TMUX_PANE", async () => {
    const proc = Bun.spawn(["/bin/sh", "-c", `${envIPrefix(DIRTY, shellEscape)} /usr/bin/env`], { env: testChildEnv({ ...DIRTY, TMUX_PANE: "%7" }), stdout: "pipe" });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const keys = out.trim().split("\n").map((l) => l.split("=")[0]).sort();
    expect(keys).toEqual([...WORKER_ENV_WHITELIST, "TMUX_PANE"].sort());
    for (const s of SECRETS) expect(out).not.toContain(s);
  });
});

const spec = (agentName: string): LaunchSpec => ({ mode: "resume", channelId: "123", bridgeUrl: "ws://127.0.0.1:3847", sessionId: "thr-1", agentName, cwd: "/w" });

describe("T94 codex-acp 接线", () => {
  test("出借 worker 的宿主命令以 env -i 开头、带干净环境标记，脏环境里的秘密一个都不进命令", () => {
    const cmd = buildAcpHostCommand(spec("agent-lend-0123456789"), { bunBin: "/b/bun", repoRoot: "/r", env: DIRTY });
    expect(cmd.startsWith("env -i ")).toBe(true);
    expect(cmd).toContain(`${CLEAN_ENV_FLAG}=1`);
    for (const s of SECRETS) expect(cmd).not.toContain(s);
  });

  test("普通 agent 的命令不变：不加 env -i、不带标记", () => {
    const cmd = buildAcpHostCommand(spec("agent-codex"), { bunBin: "/b/bun", repoRoot: "/r", env: DIRTY });
    expect(cmd.startsWith("env -i")).toBe(false);
    expect(cmd).not.toContain(CLEAN_ENV_FLAG);
  });

  test("适配器环境（worker 本体）：clean 时只有白名单 + codex 自己的几项，不挂 claudestra MCP、不给回环代理地址", () => {
    const env = adapterEnv({
      base: DIRTY, bunBin: "/b/bun", channelServer: "/r/src/channel-server.ts", mcpName: "claudestra", codexPath: "/b/codex", logsDir: "/l",
      channel: { channelId: "123", proxyUrl: "ws://127.0.0.1:9/tok-secret", agentName: "agent-lend-x", sessionId: "thr-1" }, clean: true,
    });
    expect(Object.keys(env).sort()).toEqual([...WORKER_ENV_WHITELIST, LEND_WORKER_MARK, "CODEX_PATH", "INITIAL_AGENT_MODE", "APP_SERVER_LOGS", "CODEX_CONFIG"].sort());
    expect(env[LEND_WORKER_MARK]).toBe("1"); // worker 里跑的 manager / ledger 靠它认出「不是 owner」
    expect(JSON.stringify(env)).not.toContain("tok-secret");
    expect(JSON.parse(env.CODEX_CONFIG).mcp_servers).toBeUndefined();
    for (const s of SECRETS) expect(JSON.stringify(env)).not.toContain(s);
  });

  test("不 clean 时照旧（回归）：继承环境、挂 MCP", () => {
    const env = adapterEnv({
      base: DIRTY, bunBin: "/b/bun", channelServer: "/r/c.ts", mcpName: "claudestra", logsDir: "/l",
      channel: { channelId: "123", proxyUrl: "ws://127.0.0.1:9/t", agentName: "agent-codex", sessionId: "thr-1" },
    });
    expect(env.GH_TOKEN).toBe("gh-secret");
    expect(env[LEND_WORKER_MARK]).toBeUndefined();
    expect(JSON.parse(env.CODEX_CONFIG).mcp_servers.claudestra).toBeDefined();
  });
});

/** T94 出借 worker 的白名单环境（src/lib/runtimes/clean-env.ts，接到 codex-acp 启动命令与 ACP 适配器环境） */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acpAgentCommand, adapterEnv, spawnAdapter } from "../src/lib/acp/adapter-proc.js";
import { shellEscape } from "../src/lib/claude-launch.js";
import { buildAcpHostCommand } from "../src/lib/runtimes/codex-acp.js";
import { BUN_NO_AUTOLOAD, CLEAN_ENV_FLAG, envIPrefix, isLendWorkerName, LEND_WORKER_MARK, LEND_WORKER_PREFIX, pickWorkerEnv, WORKER_ENV_WHITELIST } from "../src/lib/runtimes/clean-env.js";
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

  test("状态 / 运行目录改过就带上（worker 里的 lend submit 与自停兜底要找到同一个 journal）；沙箱变量只在沙箱里带", () => {
    const dirs = { CLAUDESTRA_STATE_DIR: "/s/state", CLAUDESTRA_RUNTIME_DIR: "/s/run" };
    const lab = { CLAUDESTRA_SANDBOX: "1", CLAUDESTRA_SANDBOX_ROOT: "/s", CLAUDESTRA_SANDBOX_DENY_PORTS: "3847", CLAUDESTRA_LAB_ROOT: "/l", BRIDGE_PORT: "24101" };
    expect(pickWorkerEnv({ ...DIRTY, ...dirs })).toMatchObject(dirs);
    expect(Object.keys(pickWorkerEnv({ ...DIRTY, ...dirs, ...lab })).sort()).toEqual([...WORKER_ENV_WHITELIST, ...Object.keys(dirs), ...Object.keys(lab)].sort());
    expect(pickWorkerEnv({ ...DIRTY, CLAUDESTRA_SANDBOX_ROOT: "/s", BRIDGE_PORT: "13847" })).toEqual(pickWorkerEnv(DIRTY));
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

  test("沙箱里的干净模式保留宿主的 bridge 地址（不是带 token 的回环代理），worker 里的 manager 才过得了沙箱的端口检查", () => {
    const base = { ...DIRTY, CLAUDESTRA_SANDBOX: "1", CLAUDESTRA_SANDBOX_ROOT: "/s", BRIDGE_URL: "ws://127.0.0.1:24101" };
    const env = adapterEnv({
      base, bunBin: "/b/bun", channelServer: "/r/c.ts", mcpName: "claudestra", logsDir: "/l",
      channel: { channelId: "123", proxyUrl: "ws://127.0.0.1:9/tok-secret", agentName: "agent-lend-x", sessionId: "thr-1" }, clean: true,
    });
    expect(env.BRIDGE_URL).toBe("ws://127.0.0.1:24101");
    expect(JSON.stringify(env)).not.toContain("tok-secret");
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

/**
 * 外来 clone：.env 是指向「宿主」假凭据文件的软链，另有 .env.local / .env.development / .env.test 普通文件，bunfig.toml 配了 preload。
 * 探针脚本打印它看到的几个假变量和 preload 有没有跑。只用假值，不碰真凭据。
 */
function hostileClone(): { clone: string; probe: string; fakeRoot: string } {
  const base = mkdtempSync(join(tmpdir(), "lend-autoload-"));
  const host = join(base, "host");
  const clone = join(base, "clone");
  const fakeRoot = join(base, "root");
  for (const d of [host, clone, join(fakeRoot, "src")]) mkdirSync(d, { recursive: true });
  writeFileSync(join(host, ".env"), "GH_TOKEN=fake-host-gh\nBRIDGE_CONTROL_TOKEN=fake-host-ctl\n");
  symlinkSync(join(host, ".env"), join(clone, ".env"));
  writeFileSync(join(clone, ".env.local"), "FAKE_LOCAL=1\n");
  writeFileSync(join(clone, ".env.development"), "FAKE_DEV=1\n");
  writeFileSync(join(clone, ".env.test"), "FAKE_TEST=1\n");
  writeFileSync(join(clone, "pre.ts"), "(globalThis as { __pre?: string }).__pre = 'ran';\n");
  writeFileSync(join(clone, "bunfig.toml"), 'preload = ["./pre.ts"]\n');
  const keys = ["GH_TOKEN", "BRIDGE_CONTROL_TOKEN", "FAKE_LOCAL", "FAKE_DEV", "FAKE_TEST"];
  const body = `console.log("PROBE" + JSON.stringify({ env: ${JSON.stringify(keys)}.filter((k) => process.env[k]), pre: (globalThis as { __pre?: string }).__pre ?? null }));\n`;
  const probe = join(base, "probe.ts");
  writeFileSync(probe, body);
  writeFileSync(join(fakeRoot, "src", "acp-host.ts"), body); // 宿主命令跑的是 <repoRoot>/src/acp-host.ts：换成探针
  return { clone, probe, fakeRoot };
}
const probeOut = (out: string) => JSON.parse(/PROBE(.*)/.exec(out)![1]!) as { env: string[]; pre: string | null };

describe("T94 外来 clone 里起 bun：不自动加载 .env* / bunfig.toml（r1 P1-1）", () => {
  test("对照：不加参数的 bun 在这个 clone 里确实会读到软链 .env 并跑 preload（证明探针有效）", async () => {
    const { clone, probe } = hostileClone();
    const p = Bun.spawn([process.execPath, probe], { cwd: clone, env: testChildEnv(), stdout: "pipe" });
    const got = probeOut(await new Response(p.stdout).text());
    expect(got.env).toContain("GH_TOKEN");
    expect(got.pre).toBe("ran");
  });

  test("宿主命令（create / restart 都走它）：在 clone 里真跑，没有 .env* 里的变量，preload 没跑", async () => {
    const { clone, fakeRoot } = hostileClone();
    const cmd = buildAcpHostCommand(spec("agent-lend-0123456789"), { bunBin: process.execPath, repoRoot: fakeRoot, env: DIRTY });
    expect(cmd).toContain(BUN_NO_AUTOLOAD.join(" "));
    const p = Bun.spawn(["/bin/sh", "-c", cmd], { cwd: clone, env: testChildEnv(DIRTY), stdout: "pipe" });
    expect(probeOut(await new Response(p.stdout).text())).toEqual({ env: [], pre: null });
  });

  test("适配器 argv（宿主与 create 引导都用 acpAgentCommand）：clean 时经 spawnAdapter 在 clone 里起，同样什么都没加载", async () => {
    const { clone, probe } = hostileClone();
    const lab = { CLAUDESTRA_SANDBOX: "1" };
    const got = acpAgentCommand(lab, process.execPath, undefined, true);
    if ("error" in got) throw new Error(got.error);
    expect(got.cmd.slice(0, -1)).toEqual([process.execPath, ...BUN_NO_AUTOLOAD]);
    const env = { ...testChildEnv(), ...adapterEnv({ base: DIRTY, bunBin: process.execPath, channelServer: "/r/c.ts", mcpName: "claudestra", logsDir: "/l", clean: true }) };
    const proc = spawnAdapter([...got.cmd.slice(0, -1), probe], env, clone, () => {});
    let out = "";
    proc.wire.onData((c) => (out += typeof c === "string" ? c : new TextDecoder().decode(c)));
    await proc.exited;
    await Bun.sleep(50);
    expect(probeOut(out)).toEqual({ env: [], pre: null });
    expect(acpAgentCommand(lab, "/b/bun")).toMatchObject({ cmd: ["/b/bun", expect.any(String)] }); // 普通 agent 不变
  });

  test("出借 worker 不认 CLAUDESTRA_ACP_AGENT 手工覆盖", () => {
    expect(acpAgentCommand({ CLAUDESTRA_ACP_AGENT: '["bun","x.ts"]' }, "/b/bun", undefined, true)).toMatchObject({ error: expect.stringContaining("不认") });
  });
});

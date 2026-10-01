import { afterEach, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildLendClaudeCommand, claudeWorkerPlan, removeClaudeWorkerConfig, type ClaudeWorkerPlan } from "../src/lib/lend-claude-worker.js";
import { receiveClaudeToken, serveClaudeToken } from "../src/lib/lend-claude-worker-auth.js";
import { DEFAULT_DISALLOWED } from "../src/lib/claude-launch.js";
import { profileRefusal, profileTools } from "../src/lib/lend-mcp-profile.js";
import { acpHostVerdict } from "../src/lib/worker-liveness.js";
import type { LaunchSpec } from "../src/lib/runtimes/types.js";

const dirs: string[] = [];
const temp = () => { const p = mkdtempSync(join(tmpdir(), "cc-lend-")); dirs.push(p); return p; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const spec: LaunchSpec = { mode: "new", channelId: "channel-1", sessionId: "550e8400-e29b-41d4-a716-446655440000", cwd: "/work/clone",
  agentName: "agent-lend-test", callerCredFile: "/caller-once", bridgeUrl: "ws://localhost:4567" };
const arg = (p: ClaudeWorkerPlan, flag: string) => p.argv[p.argv.indexOf(flag) + 1];

test("干净 argv/env：独立 HOME/config、strict MCP、空 settings sources、沿用权限护栏；不继承 owner 设置", () => {
  const p = claudeWorkerPlan(spec, "/private/run", "/auth.sock", { PATH: "/bin", HOME: "/owner", GH_TOKEN: "gh-secret", CODEX_HOME: "/codex",
    CLAUDE_CONFIG_DIR: "/owner/.claude", CLAUDE_CODE_OAUTH_TOKEN: "oauth-secret", ANTHROPIC_API_KEY: "api-secret", HTTP_PROXY: "proxy" }, "/bin/claude");
  expect(p.env).toMatchObject({ HOME: "/private/run/home", CLAUDE_CONFIG_DIR: "/private/run/config", CLAUDESTRA_MCP_PROFILE: "lend", CLAUDESTRA_LEND_WORKER: "1" });
  for (const key of ["GH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "HTTP_PROXY", "CODEX_HOME"]) expect(p.env[key]).toBeUndefined();
  expect(p.argv).toContain("--strict-mcp-config");
  expect(p.argv).toContain("--dangerously-skip-permissions");
  expect(arg(p, "--setting-sources")).toBe("");
  expect(arg(p, "--disallowedTools")).toBe(DEFAULT_DISALLOWED.join(" "));
  expect(JSON.parse(arg(p, "--settings"))).toMatchObject({ disableAllHooks: true, autoMemoryEnabled: false,
    claudeMdExcludes: expect.arrayContaining(["/work/CLAUDE.md", "/work/.claude/**", "/AGENTS.md"]) });
  expect(JSON.stringify(p)).not.toMatch(/gh-secret|oauth-secret|api-secret|\/owner|\/codex/);
  const strict = claudeWorkerPlan({ ...spec, permissionMode: "plan", extras: { disallowedPreset: "strict" } }, "/run", "/a", {}, "/claude");
  expect(arg(strict, "--permission-mode")).toBe("plan");
  expect(strict.argv).not.toContain("--dangerously-skip-permissions");
  expect(strict.argv).not.toContain("--allow-dangerously-skip-permissions");
  expect(arg(strict, "--disallowedTools")).toContain("Bash(sudo:*)");
});

test("MCP 只有 lend 服务，env -i 隔断 OAuth；列表和调用同样 fail closed", () => {
  const p = claudeWorkerPlan(spec, "/run", "/auth", {}, "/claude");
  const servers = JSON.parse(arg(p, "--mcp-config")).mcpServers as Record<string, { command: string; args: string[] }>;
  expect(Object.keys(servers)).toHaveLength(1);
  const m = Object.values(servers)[0];
  expect(m.command).toBe("/usr/bin/env");
  expect(m.args[0]).toBe("-i");
  expect(m.args).toContain("--no-env-file");
  expect(m.args).toContain("--config=/dev/null");
  const env = Object.fromEntries(m.args.filter((a) => /^[A-Z_]+=/.test(a)).map((a) => [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)]));
  expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  const tools = ["ask", "deliver", "take_order", "take_review", "submit_verdict", "whoami", "reply", "send_to_agent"].map((name) => ({ name }));
  expect(profileTools(tools, env).map((t) => t.name)).toEqual(tools.slice(0, 6).map((t) => t.name));
  for (const t of tools.slice(0, 6)) expect(profileRefusal(t.name, env)).toBeNull();
  expect(profileRefusal("send_to_agent", env)?.isError).toBe(true);
  delete env.CLAUDESTRA_MCP_PROFILE;
  expect(profileRefusal("reply", env)?.isError).toBe(true);
  env.CLAUDESTRA_MCP_PROFILE = "typo";
  expect(profileTools(tools, env)).toEqual([]);
  expect(profileRefusal("take_review", env)?.isError).toBe(true);
});

test("启动代次不复制 HOME 文件；token 仅一次 socket 交接，不落文件/命令行；每代单独目录", async () => {
  const root = temp();
  const owner = join(root, "owner");
  mkdirSync(join(owner, ".claude"), { recursive: true });
  for (const file of ["CLAUDE.md", "settings.json", "memory.md", "plugins.json", "skills.json"]) writeFileSync(join(owner, ".claude", file), "owner-private");
  const base = { HOME: owner, PATH: "/bin", CLAUDE_CODE_OAUTH_TOKEN: "fixture-oauth-only" };
  const options = { base, root: join(root, "configs"), bin: "/fake/claude", authRoot: join(root, "auth") };
  const commands = [buildLendClaudeCommand(spec, options), buildLendClaudeCommand(spec, options)];
  expect(commands[0]).not.toBe(commands[1]);
  expect(commands.join("\n")).not.toContain(base.CLAUDE_CODE_OAUTH_TOKEN);
  expect(commands.every((c) => c.startsWith("env -i ") && c.includes("--no-env-file") && c.includes("--config=/dev/null"))).toBe(true);
  const parent = join(options.root, spec.agentName!);
  for (const run of readdirSync(parent)) {
    const dir = join(parent, run);
    const raw = readFileSync(join(dir, "launch.json"), "utf8");
    const p = JSON.parse(raw) as ClaudeWorkerPlan;
    expect(raw).not.toContain(base.CLAUDE_CODE_OAUTH_TOKEN);
    expect(lstatSync(join(dir, "launch.json")).mode & 0o777).toBe(0o600);
    expect(lstatSync(dir).mode & 0o777).toBe(0o700);
    expect(readdirSync(p.env.HOME)).toEqual([]);
    expect(readdirSync(p.env.CLAUDE_CONFIG_DIR)).toEqual([".claude.json"]);
    expect(readFileSync(join(p.env.CLAUDE_CONFIG_DIR, ".claude.json"), "utf8")).not.toContain("owner-private");
    expect(await receiveClaudeToken(p.authSocket)).toBe(base.CLAUDE_CODE_OAUTH_TOKEN);
    await expect(receiveClaudeToken(p.authSocket)).rejects.toThrow("凭据交接失败");
  }
  removeClaudeWorkerConfig(spec.agentName!, options.root);
  expect(existsSync(parent)).toBe(false);
  expect(readFileSync(join(owner, ".claude", "CLAUDE.md"), "utf8")).toBe("owner-private");
  expect(() => buildLendClaudeCommand(spec, { ...options, base: { HOME: owner } })).toThrow("CLAUDE_CODE_OAUTH_TOKEN");
});

test("socket 过期不可再领；清理拒绝指向 owner 的软链", async () => {
  const root = temp();
  const auth = serveClaudeToken("fake", root, 5);
  await Bun.sleep(20);
  await expect(receiveClaudeToken(auth.path)).rejects.toThrow("凭据交接失败");
  const owner = join(root, "owner"); mkdirSync(owner);
  symlinkSync(owner, join(root, spec.agentName!));
  expect(() => removeClaudeWorkerConfig(spec.agentName!, root)).toThrow("软链");
  expect(existsSync(owner)).toBe(true);
});

test("存活探测同时认 Claude 宿主和原 Codex 宿主，普通 shell 不算 worker", () => {
  expect(acpHostVerdict([100], "100 1 shell\n101 100 bun /repo/src/lib/lend-claude-worker-host.ts /launch")).toBe("running");
  expect(acpHostVerdict([100], "100 1 shell\n101 100 bun /repo/src/acp-host.ts")).toBe("running");
  expect(acpHostVerdict([100], "100 1 shell\n101 100 sleep")).toBe("no_host");
});

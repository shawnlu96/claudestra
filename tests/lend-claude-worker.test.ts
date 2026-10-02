import { afterEach, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildLendClaudeCommand, claudeWorkerPlan, removeClaudeWorkerConfig, type ClaudeWorkerPlan } from "../src/lib/lend-claude-worker.js";
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

test("本机登录口径：HOME / CLAUDE_CONFIG_DIR 照出借方原值，不带 OAuth token / API key / 代理；strict MCP、空 settings sources、沿用权限护栏", () => {
  const p = claudeWorkerPlan(spec, "/private/run", { PATH: "/bin", HOME: "/owner", GH_TOKEN: "gh-secret", CODEX_HOME: "/codex",
    CLAUDE_CONFIG_DIR: "/owner/.claude-alt", CLAUDE_CODE_OAUTH_TOKEN: "oauth-secret", ANTHROPIC_API_KEY: "api-secret", HTTP_PROXY: "proxy" }, "/bin/claude");
  expect(p.env).toMatchObject({ HOME: "/owner", CLAUDE_CONFIG_DIR: "/owner/.claude-alt", CLAUDESTRA_MCP_PROFILE: "lend", CLAUDESTRA_LEND_WORKER: "1",
    ENABLE_CLAUDEAI_MCP_SERVERS: "false" });
  for (const key of ["GH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "HTTP_PROXY", "CODEX_HOME"]) expect(p.env[key]).toBeUndefined();
  expect(JSON.stringify(p)).not.toMatch(/gh-secret|oauth-secret|api-secret|\/codex/);
  expect(p.argv).toContain("--strict-mcp-config");
  expect(p.argv).toContain("--dangerously-skip-permissions");
  expect(arg(p, "--setting-sources")).toBe("");
  expect(arg(p, "--disallowedTools")).toBe(DEFAULT_DISALLOWED.join(" "));
  expect(arg(p, "--append-system-prompt")).toContain("一次性出借 worker agent-lend-test");
  const settings = JSON.parse(arg(p, "--settings"));
  expect(settings).toMatchObject({ disableAllHooks: true, autoMemoryEnabled: false });
  // 祖先目录与用户级（默认配置目录、CLAUDE_CONFIG_DIR）的 CLAUDE.md / rules 都排除；clone 自己不在排除表里
  expect(settings.claudeMdExcludes).toEqual(expect.arrayContaining(["/work/CLAUDE.md", "/work/.claude/**", "/AGENTS.md",
    "/owner/.claude/CLAUDE.md", "/owner/.claude/rules/**", "/owner/.claude-alt/CLAUDE.md", "/owner/.claude-alt/rules/**"]));
  expect(settings.claudeMdExcludes).not.toContain("/work/clone/CLAUDE.md");
  const plain = claudeWorkerPlan(spec, "/run", { HOME: "/owner" }, "/claude");
  expect(plain.env.HOME).toBe("/owner");
  expect("CLAUDE_CONFIG_DIR" in plain.env).toBe(false);
  const strict = claudeWorkerPlan({ ...spec, permissionMode: "plan", extras: { disallowedPreset: "strict" } }, "/run", {}, "/claude");
  expect(arg(strict, "--permission-mode")).toBe("plan");
  expect(strict.argv).not.toContain("--dangerously-skip-permissions");
  expect(strict.argv).not.toContain("--allow-dangerously-skip-permissions");
  expect(arg(strict, "--disallowedTools")).toContain("Bash(sudo:*)");
});

test("MCP 只有 lend 服务，env -i 隔断凭据；列表和调用同样 fail closed", () => {
  const p = claudeWorkerPlan(spec, "/run", { CLAUDE_CODE_OAUTH_TOKEN: "oauth-secret" }, "/claude");
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

test("不配 setup-token 也能生成启动命令；代次目录只有启动计划和 cwd 记录，不建 HOME / 配置目录、不碰出借方文件", () => {
  const root = temp();
  const owner = join(root, "owner");
  mkdirSync(join(owner, ".claude"), { recursive: true });
  writeFileSync(join(owner, ".claude", "CLAUDE.md"), "owner-private");
  // 旧版留下的 token 文件 / 环境变量都不再读：命令和计划里都不出现
  const base = { HOME: owner, PATH: "/bin", CLAUDE_CODE_OAUTH_TOKEN: "legacy-oauth-ignored" };
  const options = { base, root: join(root, "configs"), bin: "/fake/claude" };
  const commands = [buildLendClaudeCommand(spec, options), buildLendClaudeCommand(spec, options)];
  expect(commands[0]).not.toBe(commands[1]);
  expect(commands.join("\n")).not.toContain(base.CLAUDE_CODE_OAUTH_TOKEN);
  expect(commands.every((c) => c.startsWith("env -i ") && c.includes("--no-env-file") && c.includes("--config=/dev/null"))).toBe(true);
  const parent = join(options.root, spec.agentName!);
  for (const run of readdirSync(parent)) {
    const dir = join(parent, run);
    expect(readdirSync(dir).sort()).toEqual(["launch.json", "run.json"]);
    const raw = readFileSync(join(dir, "launch.json"), "utf8");
    const p = JSON.parse(raw) as ClaudeWorkerPlan;
    expect(raw).not.toContain(base.CLAUDE_CODE_OAUTH_TOKEN);
    expect(p.env.HOME).toBe(owner);
    expect("authSocket" in p).toBe(false);
    expect(JSON.parse(readFileSync(join(dir, "run.json"), "utf8"))).toEqual({ cwd: spec.cwd, sessions: join(owner, ".claude", "projects", "-work-clone") });
    expect(lstatSync(join(dir, "launch.json")).mode & 0o777).toBe(0o600);
    expect(lstatSync(dir).mode & 0o777).toBe(0o700);
  }
  removeClaudeWorkerConfig(spec.agentName!, options.root);
  expect(existsSync(parent)).toBe(false);
  expect(readdirSync(join(owner, ".claude"))).toEqual(["CLAUDE.md"]);
  expect(readFileSync(join(owner, ".claude", "CLAUDE.md"), "utf8")).toBe("owner-private");
});

test("清理拒绝指向 owner 的软链", () => {
  const root = temp();
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

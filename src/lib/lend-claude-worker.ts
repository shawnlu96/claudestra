/**
 * 出借 Claude 的启动计划：独立 HOME / CLAUDE_CONFIG_DIR，不复制任何用户配置；仅通过官方 setup-token 环境变量认证。
 * https://code.claude.com/docs/en/authentication#generate-a-long-lived-token
 * MCP 子进程另走 env -i，既不继承 OAuth token，也不加载 clone 的 .env / bunfig；工具档仍由 lend-mcp-profile 和 bridge 双重核。
 * 干净启动是防意外继承的护栏，不是同一 OS 用户下的文件访问沙箱。
 */
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DEFAULT_PERMISSION_MODE, MCP_NAME, resolveDisallowed, shellEscape } from "./claude-launch.js";
import { resolveBunPath } from "./bun-path.js";
import { CALLER_CRED_FILE_ENV } from "./caller-cred.js";
import { resolveBridgeUrl } from "./bridge-url.js";
import { RUNTIME_DIR, STATE_DIR } from "./paths.js";
import { SRC_DIR } from "./repo-root.js";
import { MCP_PROFILE_ENV, LEND_PROFILE } from "./lend-mcp-profile.js";
import { BUN_NO_AUTOLOAD, envIPrefix, isLendWorkerName, LEND_WORKER_MARK, pickWorkerEnv } from "./runtimes/clean-env.js";
import type { LaunchSpec } from "./runtimes/types.js";
import { readClaudeLendToken } from "./lend-claude-token.js";
import { serveClaudeToken } from "./lend-claude-worker-auth.js";

import { CLAUDE_LEND_ROOT } from "./lend-claude-worker-session.js";
export const CLAUDE_LEND_HOST = "/lib/lend-claude-worker-host.ts";
export interface ClaudeWorkerPlan { agent: string; cwd: string; dir: string; argv: string[]; env: Record<string, string>; authSocket: string }

function workerDir(name: string, root: string): string {
  if (!/^agent-lend-[\w-]+$/.test(name)) throw new Error("无效的 Claude 出借 worker 名");
  return join(root, name);
}

/** 只删自己的配置代次；不随软链走到出借人的目录。失败向上传，不能假装已清理。 */
export function removeClaudeWorkerConfig(name: string, root = CLAUDE_LEND_ROOT): void {
  const dir = workerDir(name, root);
  if (!existsSync(dir)) return;
  if (lstatSync(root).isSymbolicLink() || lstatSync(dir).isSymbolicLink()) throw new Error("Claude 出借配置目录不能是软链");
  rmSync(dir, { recursive: true, force: true });
}

/** 生命周期与生产适配器共用；不调用普通 buildClaudeCommand，避免其中的 owner agent-settings / 项目花名册。 */
export function claudeWorkerPlan(spec: LaunchSpec, dir: string, authSocket: string, base: Record<string, string | undefined>, bin: string): ClaudeWorkerPlan {
  if (!spec.cwd || !isLendWorkerName(spec.agentName) || !spec.callerCredFile) throw new Error("Claude 出借启动缺工作副本、worker 名或 MCP 身份凭据");
  const env = { ...pickWorkerEnv(base), HOME: join(dir, "home"), CLAUDE_CONFIG_DIR: join(dir, "config"),
    CLAUDESTRA_STATE_DIR: base.CLAUDESTRA_STATE_DIR || STATE_DIR, CLAUDESTRA_RUNTIME_DIR: base.CLAUDESTRA_RUNTIME_DIR || RUNTIME_DIR,
    [LEND_WORKER_MARK]: "1", CLAUDESTRA_AGENT: spec.agentName!, [MCP_PROFILE_ENV]: LEND_PROFILE };
  delete (env as Record<string, string>).CODEX_HOME;
  const mcpEnv = { ...env, DISCORD_CHANNEL_ID: spec.channelId, BRIDGE_URL: spec.bridgeUrl || resolveBridgeUrl(), MCP_NAME,
    [CALLER_CRED_FILE_ENV]: spec.callerCredFile };
  const mcp = { mcpServers: { [MCP_NAME]: { command: "/usr/bin/env", args: ["-i", ...Object.entries(mcpEnv).map(([k, v]) => `${k}=${v}`),
    resolveBunPath(), ...BUN_NO_AUTOLOAD, join(SRC_DIR, "channel-server.ts")] } } };
  const mode = spec.permissionMode === "auto" ? DEFAULT_PERMISSION_MODE : spec.permissionMode || DEFAULT_PERMISSION_MODE;
  const x = spec.extras ?? {};
  const disallowed = resolveDisallowed({ preset: typeof x.disallowedPreset === "string" ? x.disallowedPreset : undefined,
    raw: typeof x.disallowedRaw === "string" ? x.disallowedRaw : undefined });
  // 不从 clone 的祖先目录加载 owner 指令；clone 本身的 CLAUDE.md 仍可正常读取。
  const excludes: string[] = [];
  for (let p = dirname(resolve(spec.cwd)); ; p = dirname(p)) {
    excludes.push(join(p, "CLAUDE.md"), join(p, "CLAUDE.local.md"), join(p, "AGENTS.md"), join(p, ".claude", "**"));
    if (dirname(p) === p) break;
  }
  const argv = [bin, "--dangerously-load-development-channels", `server:${MCP_NAME}`, "--strict-mcp-config", "--mcp-config", JSON.stringify(mcp),
    "--setting-sources", "", "--settings", JSON.stringify({ disableAllHooks: true, autoMemoryEnabled: false, claudeMdExcludes: excludes }),
    ...(mode === "bypassPermissions" ? ["--dangerously-skip-permissions"] : ["--permission-mode", mode]),
    "--disallowedTools", disallowed.join(" "), ...(spec.mode === "new" ? ["--session-id", spec.sessionId] : ["--resume", spec.sessionId]),
    ...(spec.mode === "fork" ? ["--fork-session"] : []),
    "--append-system-prompt", `你是一次性出借 worker ${spec.agentName}。只处理当前订单，使用 claudestra 派单工具或订单说明中的 lend submit 交付。`];
  return { agent: spec.agentName!, cwd: spec.cwd, dir, argv, env, authSocket };
}

export function buildLendClaudeCommand(spec: LaunchSpec, o: { base?: Record<string, string | undefined>; root?: string; bin?: string; authRoot?: string } = {}): string {
  const base = o.base ?? process.env;
  const root = o.root ?? CLAUDE_LEND_ROOT;
  const token = readClaudeLendToken(base);
  if (!token) throw new Error("Claude 出借未配置 CLAUDE_CODE_OAUTH_TOKEN：先 claude setup-token，再重授 --claude N");
  const bin = o.bin ?? Bun.which("claude");
  if (!bin) throw new Error("找不到 Claude Code CLI");
  const parent = workerDir(spec.agentName ?? "", root);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (lstatSync(root).isSymbolicLink() || lstatSync(parent).isSymbolicLink()) throw new Error("Claude 出借配置目录不能是软链");
  const dir = mkdtempSync(join(parent, "run-"));
  chmodSync(dir, 0o700);
  let auth: ReturnType<typeof serveClaudeToken> | undefined;
  try {
    auth = serveClaudeToken(token, o.authRoot);
    const plan = claudeWorkerPlan(spec, dir, auth.path, base, bin);
    for (const p of [plan.env.HOME, plan.env.CLAUDE_CONFIG_DIR]) mkdirSync(p, { mode: 0o700 });
    // 新目录的本地 onboarding 标记，不复制出借人的 .claude.json。
    writeFileSync(join(plan.env.CLAUDE_CONFIG_DIR, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true }), { mode: 0o600 });
    const file = join(dir, "launch.json");
    writeFileSync(file, JSON.stringify(plan), { mode: 0o600, flag: "wx" });
    return `${envIPrefix(base, shellEscape)} ${[resolveBunPath(), ...BUN_NO_AUTOLOAD, `${SRC_DIR}${CLAUDE_LEND_HOST}`, file].map(shellEscape).join(" ")}`;
  } catch (e) { auth?.close(); rmSync(dir, { recursive: true, force: true }); throw e; }
}

/**
 * 出借 Claude 的启动计划：和本机新开 worker 一样，用出借方默认 HOME / 配置目录和本机已有登录，不建独立 HOME、不碰 setup-token。
 * 隔离靠启动参数：只挂派单 MCP（strict）、不读 user / project / local 设置（技能、子代理、插件、hooks、用户级 CLAUDE.md 都随之不加载）、
 * 关 hooks 与自动记忆、排除祖先与用户级 CLAUDE.md、关 claude.ai 连接器；MCP 子进程另走 env -i。实测依据见 docs/architecture/lend-claude-workers.md。
 * 干净启动是防意外继承的护栏，不是同一 OS 用户下的文件访问沙箱。
 */
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DEFAULT_PERMISSION_MODE, MCP_NAME, resolveDisallowed, shellEscape } from "./claude-launch.js";
import { resolveBunPath } from "./bun-path.js";
import { CALLER_CRED_FILE_ENV } from "./caller-cred.js";
import { resolveBridgeUrl } from "./bridge-url.js";
import { RUNTIME_DIR, STATE_DIR } from "./paths.js";
import { SRC_DIR } from "./repo-root.js";
import { MCP_PROFILE_ENV, LEND_PROFILE } from "./lend-mcp-profile.js";
import { BUN_NO_AUTOLOAD, envIPrefix, isLendWorkerName, LEND_WORKER_MARK, pickWorkerEnv, workerPrivateDirs } from "./runtimes/clean-env.js";
import type { LaunchSpec } from "./runtimes/types.js";
import { projectSlug } from "./session-recall.js";

import { CLAUDE_LEND_ROOT, RUN_RECORD_FILE, type ClaudeRunRecord } from "./lend-claude-worker-session.js";
export const CLAUDE_LEND_HOST = "/lib/lend-claude-worker-host.ts";
export interface ClaudeWorkerPlan { agent: string; cwd: string; dir: string; argv: string[]; env: Record<string, string> }

function workerDir(name: string, root: string): string {
  if (!/^agent-lend-[\w-]+$/.test(name)) throw new Error("无效的 Claude 出借 worker 名");
  return join(root, name);
}

/** 只删自己的启动代次目录；不随软链走到出借人的目录。失败向上传，不能假装已清理。 */
export function removeClaudeWorkerConfig(name: string, root = CLAUDE_LEND_ROOT): void {
  const dir = workerDir(name, root);
  if (!existsSync(dir)) return;
  if (lstatSync(root).isSymbolicLink() || lstatSync(dir).isSymbolicLink()) throw new Error("Claude 出借配置目录不能是软链");
  rmSync(dir, { recursive: true, force: true });
}

/** 出借方的 CLAUDE.md 不进 worker：clone 的祖先目录逐级排除，再显式排除用户级（默认配置目录与 CLAUDE_CONFIG_DIR）。 */
function claudeMdExcludes(cwd: string, env: Record<string, string>): string[] {
  const out: string[] = [];
  for (let p = dirname(resolve(cwd)); ; p = dirname(p)) {
    out.push(join(p, "CLAUDE.md"), join(p, "CLAUDE.local.md"), join(p, "AGENTS.md"), join(p, ".claude", "**"));
    if (dirname(p) === p) break;
  }
  const configs = new Set([env.HOME && join(env.HOME, ".claude"), env.CLAUDE_CONFIG_DIR].filter((d): d is string => !!d));
  for (const c of configs) out.push(join(c, "CLAUDE.md"), join(c, "rules", "**"));
  return out;
}

/** worker 会话的落点：Claude Code 按 realpath 后的 cwd 起 slug，放在 CLAUDE_CONFIG_DIR（没有就 ~/.claude）的 projects 下 */
function sessionsDir(cwd: string, env: Record<string, string>): string {
  let real = cwd;
  try { real = realpathSync(cwd); } catch { real = cwd; /* clone 还没就绪就按原样算：正常路径两者一致，错了只影响摘要 / 归档找会话 */ }
  return join(env.CLAUDE_CONFIG_DIR || join(env.HOME ?? "", ".claude"), "projects", projectSlug(real));
}

/** 生命周期与生产适配器共用；不调用普通 buildClaudeCommand，避免其中的 owner agent-settings / 项目花名册。 */
export function claudeWorkerPlan(spec: LaunchSpec, dir: string, base: Record<string, string | undefined>, bin: string): ClaudeWorkerPlan {
  if (!spec.cwd || !isLendWorkerName(spec.agentName) || !spec.callerCredFile) throw new Error("Claude 出借启动缺工作副本、worker 名或 MCP 身份凭据");
  // HOME / CLAUDE_CONFIG_DIR 照出借方原值，Claude 才找得到本机登录；登录凭据变量不在白名单里，env -i 后不会带进来。
  // 状态 / 运行目录是代次目录下的专属目录（随代次目录清掉）：Claude 的 Bash 继承这份环境，不能指向生产（clean-env.ts workerPrivateDirs）。
  const env: Record<string, string> = { ...pickWorkerEnv(base), ...(base.CLAUDE_CONFIG_DIR ? { CLAUDE_CONFIG_DIR: base.CLAUDE_CONFIG_DIR } : {}),
    ENABLE_CLAUDEAI_MCP_SERVERS: "false", ...workerPrivateDirs(dir),
    [LEND_WORKER_MARK]: "1", CLAUDESTRA_AGENT: spec.agentName!, [MCP_PROFILE_ENV]: LEND_PROFILE };
  delete env.CODEX_HOME;
  // 只有 channel-server（和 bridge 对话）用生产目录
  const mcpEnv = { ...env, CLAUDESTRA_STATE_DIR: base.CLAUDESTRA_STATE_DIR || STATE_DIR, CLAUDESTRA_RUNTIME_DIR: base.CLAUDESTRA_RUNTIME_DIR || RUNTIME_DIR,
    DISCORD_CHANNEL_ID: spec.channelId, BRIDGE_URL: spec.bridgeUrl || resolveBridgeUrl(), MCP_NAME, [CALLER_CRED_FILE_ENV]: spec.callerCredFile };
  const mcp = { mcpServers: { [MCP_NAME]: { command: "/usr/bin/env", args: ["-i", ...Object.entries(mcpEnv).map(([k, v]) => `${k}=${v}`),
    resolveBunPath(), ...BUN_NO_AUTOLOAD, join(SRC_DIR, "channel-server.ts")] } } };
  const mode = spec.permissionMode === "auto" ? DEFAULT_PERMISSION_MODE : spec.permissionMode || DEFAULT_PERMISSION_MODE;
  const x = spec.extras ?? {};
  const disallowed = resolveDisallowed({ preset: typeof x.disallowedPreset === "string" ? x.disallowedPreset : undefined,
    raw: typeof x.disallowedRaw === "string" ? x.disallowedRaw : undefined });
  const settings = { disableAllHooks: true, autoMemoryEnabled: false, claudeMdExcludes: claudeMdExcludes(spec.cwd, env) };
  const argv = [bin, "--dangerously-load-development-channels", `server:${MCP_NAME}`, "--strict-mcp-config", "--mcp-config", JSON.stringify(mcp),
    "--setting-sources", "", "--settings", JSON.stringify(settings),
    ...(mode === "bypassPermissions" ? ["--dangerously-skip-permissions"] : ["--permission-mode", mode]),
    "--disallowedTools", disallowed.join(" "), ...(spec.mode === "new" ? ["--session-id", spec.sessionId] : ["--resume", spec.sessionId]),
    ...(spec.mode === "fork" ? ["--fork-session"] : []),
    "--append-system-prompt", `你是一次性出借 worker ${spec.agentName}。只处理当前订单，使用 claudestra 派单工具或订单说明中的 lend submit 交付。`];
  return { agent: spec.agentName!, cwd: spec.cwd, dir, argv, env };
}

export function buildLendClaudeCommand(spec: LaunchSpec, o: { base?: Record<string, string | undefined>; root?: string; bin?: string } = {}): string {
  const base = o.base ?? process.env;
  const root = o.root ?? CLAUDE_LEND_ROOT;
  const bin = o.bin ?? Bun.which("claude");
  if (!bin) throw new Error("找不到 Claude Code CLI");
  const parent = workerDir(spec.agentName ?? "", root);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (lstatSync(root).isSymbolicLink() || lstatSync(parent).isSymbolicLink()) throw new Error("Claude 出借配置目录不能是软链");
  const dir = mkdtempSync(join(parent, "run-"));
  chmodSync(dir, 0o700);
  try {
    const plan = claudeWorkerPlan(spec, dir, base, bin);
    // 会话落在出借方默认的 projects 目录：记下位置，归档和摘要按它找回本代会话（lend-claude-worker-session.ts）。
    const record: ClaudeRunRecord = { cwd: plan.cwd, sessions: sessionsDir(plan.cwd, plan.env) };
    writeFileSync(join(dir, RUN_RECORD_FILE), JSON.stringify(record), { mode: 0o600, flag: "wx" });
    const file = join(dir, "launch.json");
    writeFileSync(file, JSON.stringify(plan), { mode: 0o600, flag: "wx" });
    return `${envIPrefix(base, shellEscape)} ${[resolveBunPath(), ...BUN_NO_AUTOLOAD, `${SRC_DIR}${CLAUDE_LEND_HOST}`, file].map(shellEscape).join(" ")}`;
  } catch (e) { rmSync(dir, { recursive: true, force: true }); throw e; }
}

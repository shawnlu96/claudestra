/**
 * 会话开场记忆召回(v2.21.5+)——把「记得去搜 mem0」从自觉变成程序动作。
 *
 * 背景(agent-mem0 + Codex 2026-09-06 对记忆架构的评估):冷热分层方向对,但
 * 冷层(mem0,3400+ 条)的价值取决于 agent 记得去搜,「忘了搜从头研究」被 owner
 * 抓过两次。修法不是再写一遍「记得搜」,而是 Claude Code 的 SessionStart hook
 * (startup / resume / clear / compact)自动跑 ~/mem0-mcp/recall.py,把本项目
 * 最相关 + 最近写入的记忆注入开场 context;同一个 hook 顺带注入上次会话留下的
 * HANDOFF.md(进度交接,save-compact skill 写,每项目一份覆盖式)。
 *
 * 这个模块是纯逻辑(路径推导 + settings.json 合并),hook 本体在
 * src/hooks/recall-hook.ts;注册走 setup.ts / install-cli / `manager install-hooks`,
 * 三处共用这里的 ensureRecallHook,幂等。recall.py 不存在的机器一律跳过——
 * Claudestra 要发给别人用,mem0 是 owner 自己的设施,不能成为硬依赖。
 */
import { existsSync } from "fs";
import { homedir } from "os";

/** SessionStart 的 matcher:compact 后也重新注入——压缩摘要最容易把约束丢掉。 */
export const RECALL_MATCHER = "startup|resume|clear|compact";
/** hook 命令超时(秒)。recall.py 自己 8s 兜底,这里留余量;超时只是没有召回,不影响会话。 */
export const RECALL_HOOK_TIMEOUT_S = 15;
/** HANDOFF.md 超过这个天数就不再注入——太旧的交接比没有更误导。 */
export const HANDOFF_MAX_AGE_DAYS = 14;

export function recallScriptPath(home = homedir()): string {
  return process.env.MEM0_RECALL_SCRIPT || `${home}/mem0-mcp/recall.py`;
}

/** recall.py 用的解释器:mem0-mcp 自己的 venv(装了 psycopg / dotenv),没有就退回 python3。 */
export function recallPythonPath(home = homedir()): string {
  if (process.env.MEM0_RECALL_PYTHON) return process.env.MEM0_RECALL_PYTHON;
  const venv = `${home}/mem0-mcp/.venv/bin/python`;
  return existsSync(venv) ? venv : "python3";
}

/** 这台机器有没有装 mem0 召回 —— 没有就不注册 hook、doctor 也不报 warn。 */
export function recallAvailable(home = homedir()): boolean {
  return existsSync(recallScriptPath(home));
}

/**
 * Claude Code 的项目目录 slug:路径里所有非字母数字字符换成 `-`
 * (`/Users/x/.claude-orchestrator/master` → `-Users-x--claude-orchestrator-master`)。
 * 与 ~/.claude/projects/<slug>/ 的真实命名逐一核对过(含点号与斜杠)。
 */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/** 该工作目录的 auto-memory 目录(Claude Code 每会话注入其中 MEMORY.md 的那个)。 */
export function memoryDir(cwd: string, home = homedir()): string {
  return `${home}/.claude/projects/${projectSlug(cwd)}/memory`;
}

/** save-compact 写的进度交接文件:每项目一份,覆盖式,不进 mem0。 */
export function handoffPath(cwd: string, home = homedir()): string {
  return `${memoryDir(cwd, home)}/HANDOFF.md`;
}

export function isRecallHookCommand(cmd: unknown): boolean {
  return typeof cmd === "string" && /recall-hook\.ts\s*$/.test(cmd);
}

type HookCmd = { type: "command"; command: string; timeout?: number };
type HookEntry = { matcher?: string; hooks: HookCmd[] };
export type ClaudeSettings = { hooks?: Record<string, HookEntry[]> } & Record<string, unknown>;

/**
 * 把召回 hook 合并进 settings.json 的 SessionStart:
 * - 已有指向 recall-hook.ts 的命令 → 只校正命令字符串 / matcher / timeout(改路径、换 bun 绝对路径时用);
 * - 没有 → 追加一条独立 entry(不动别人的 SessionStart hook)。
 * 返回是否改动,调用方决定要不要写回。
 */
export function ensureRecallHook(settings: ClaudeSettings, command: string): boolean {
  if (!settings.hooks || typeof settings.hooks !== "object") settings.hooks = {};
  const list = Array.isArray(settings.hooks.SessionStart) ? settings.hooks.SessionStart : [];
  let changed = false;
  let found = false;
  for (const entry of list) {
    if (!entry || !Array.isArray(entry.hooks)) continue;
    for (const h of entry.hooks) {
      if (!isRecallHookCommand(h?.command)) continue;
      found = true;
      if (h.command !== command) { h.command = command; changed = true; }
      if (h.timeout !== RECALL_HOOK_TIMEOUT_S) { h.timeout = RECALL_HOOK_TIMEOUT_S; changed = true; }
      if (entry.matcher !== RECALL_MATCHER) { entry.matcher = RECALL_MATCHER; changed = true; }
    }
  }
  if (!found) {
    list.push({ matcher: RECALL_MATCHER, hooks: [{ type: "command", command, timeout: RECALL_HOOK_TIMEOUT_S }] });
    changed = true;
  }
  settings.hooks.SessionStart = list;
  return changed;
}

/** 撤掉召回 hook(owner 反悔 / 卸载用)。返回是否改动。 */
export function removeRecallHook(settings: ClaudeSettings): boolean {
  const list = settings.hooks?.SessionStart;
  if (!Array.isArray(list)) return false;
  let changed = false;
  const kept: HookEntry[] = [];
  for (const entry of list) {
    if (!entry || !Array.isArray(entry.hooks)) { kept.push(entry); continue; }
    const rest = entry.hooks.filter((h) => !isRecallHookCommand(h?.command));
    if (rest.length !== entry.hooks.length) changed = true;
    if (rest.length) kept.push({ ...entry, hooks: rest });
    else if (entry.hooks.length === 0) kept.push(entry);
  }
  if (!changed) return false;
  if (kept.length) settings.hooks!.SessionStart = kept;
  else delete settings.hooks!.SessionStart;
  return true;
}

/** settings.json 文本里有没有挂召回 hook(doctor 用,不解析也能答)。 */
export function hasRecallHook(settings: ClaudeSettings): boolean {
  const list = settings.hooks?.SessionStart;
  return Array.isArray(list) && list.some((e) => Array.isArray(e?.hooks) && e.hooks.some((h) => isRecallHookCommand(h?.command)));
}

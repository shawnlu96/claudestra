/**
 * 派发关系（registry 的 parent / task）：侧栏把执行者挂在派它的 agent 下面（web sidebar-entries.ts 构树）。
 * parent 存派发者的 registry 键（`agent-xxx`，大总管是 `master`——它不在 registry 里）。纯展示元数据，不参与授权。
 *
 * 写入都在 manager 的命令级写锁里（manager.ts「写锁」段 + write-commands.ts），这里不再另拿锁——
 * 同一把锁在同一进程里再 acquire 会自己等满 20s。纯函数单测见 tests/manager-team.test.ts。
 */
import { isMasterAgent } from "../lib/registry.js";
import { repoEnvVar } from "../lib/env-file.js";
import { loadRegistry, saveRegistry, normalizeName, output, type AgentInfo, type Registry } from "./core.js";

export const MASTER_PARENT = "master";
export const TASK_MAX = 40;
/** 与 label 同一条规矩：控制字符 / 方向控制符会让侧栏里的字看起来像别的东西 */
const UNSAFE_TEXT_RE = /[\u0000-\u001f\u007f‎‏‪-‮⁦-⁩]/;

/** 命令行上的派发字段：undefined = 没写（create 走自动反查）；parent "none" = 显式不挂；task "" = 清除 */
export interface TeamFlags {
  parent?: string;
  task?: string;
}
/** 最终写进 registry 的两字段（缺 = 不设） */
export type TeamFields = Pick<AgentInfo, "parent" | "task">;
type ParentMap = Record<string, { parent?: string; channelId?: string }>;

/** 抽出 `--parent <x>` / `--parent=x` / `--task <text>` / `--task=text`；空串的 --task 保留（= 清除） */
export function extractTeamFlags(args: string[]): { rest: string[]; flags: TeamFlags } {
  const rest: string[] = [];
  const flags: TeamFlags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const m = a.match(/^--(parent|task)(?:=(.*))?$/s);
    if (!m) {
      rest.push(a);
      continue;
    }
    const v = m[2] ?? args[++i] ?? "";
    flags[m[1] as keyof TeamFlags] = v;
  }
  return { rest, flags };
}

/** 用户写的派发者名 → registry 键（master 的各种写法归一成 `master`） */
export function parentKey(raw: string): string {
  const t = raw.trim();
  return isMasterAgent(t.toLowerCase()) ? MASTER_PARENT : normalizeName(t);
}

export function validateTask(task: string): string | null {
  if (task.length > TASK_MAX) return `--task 最多 ${TASK_MAX} 个字符`;
  if (UNSAFE_TEXT_RE.test(task)) return "--task 不能含控制字符或方向控制符";
  return null;
}

/**
 * parent 合法性：存在（大总管恒存在）/ 不是自己 / 不成环（沿派发者的 parent 链走，走到自己就是环）。
 * 链上悬空（祖先已被 remove）或已有别的环都在 seen 处停下，不死循环。
 */
export function validateParent(agents: ParentMap, child: string, parent: string): string | null {
  if (isMasterAgent(child)) return "大总管不能挂在别的 agent 下面";
  if (parent === MASTER_PARENT) return null;
  if (parent === child) return "--parent 不能是自己";
  if (!agents[parent]) return `--parent 指向的 ${parent} 不存在`;
  const seen = new Set<string>();
  for (let cur = agents[parent]?.parent; cur && !seen.has(cur); cur = agents[cur]?.parent) {
    if (cur === child) return `--parent ${parent} 会成环（${parent} 本身挂在 ${child} 下面）`;
    seen.add(cur);
  }
  return null;
}

/**
 * 自动 parent：agent 在自己的 Bash 里跑 create 时带着自己的 DISCORD_CHANNEL_ID（claude-launch.ts 注入，大总管的是
 * CONTROL_CHANNEL_ID，launcher.ts）。反查不到（终端手动跑、bridge / cron 调）→ 不设。
 */
export function autoParent(agents: ParentMap, channelId: string | undefined, controlChannelId: string, child: string): string | undefined {
  if (!channelId) return undefined;
  if (controlChannelId && channelId === controlChannelId) return MASTER_PARENT;
  const hit = Object.entries(agents).find(([k, v]) => k !== child && v.channelId === channelId);
  return hit?.[0];
}

/** create 前（拉起 agent 之前）定下 parent / task；不合法返回错误，调用方拒绝 create */
export function resolveTeamFields(agents: ParentMap, child: string, flags: TeamFlags, env: { channelId?: string; controlChannelId: string }): TeamFields | { error: string } {
  const task = flags.task?.trim() ?? "";
  const taskErr = validateTask(task);
  if (taskErr) return { error: taskErr };
  let parent: string | undefined;
  if (flags.parent === undefined) parent = autoParent(agents, env.channelId, env.controlChannelId, child);
  else if (flags.parent.trim() && flags.parent.trim() !== "none") {
    parent = parentKey(flags.parent);
    const err = validateParent(agents, child, parent);
    if (err) return { error: err };
  }
  return { ...(parent ? { parent } : {}), ...(task ? { task } : {}) };
}

/** cmdCreate 用：读 registry + 环境后定派发字段；出错直接 output 并返回 null（manager.ts 一行调用） */
export async function teamFieldsForCreate(child: string, flags: TeamFlags): Promise<TeamFields | null> {
  const env = { channelId: process.env.DISCORD_CHANNEL_ID, controlChannelId: repoEnvVar("CONTROL_CHANNEL_ID") };
  const r = resolveTeamFields((await loadRegistry()).agents, child, flags, env);
  if ("error" in r) output({ ok: false, error: r.error });
  return "error" in r ? null : r;
}

/** resume 整条重写条目时要带过去的字段（缺了就丢挂载关系、显示名、external 闸门） */
export function keepOnResume(prior: AgentInfo | undefined): Partial<AgentInfo> {
  if (!prior) return {};
  const { parent, task, label, external } = prior;
  return { ...(parent ? { parent } : {}), ...(task ? { task } : {}), ...(label ? { label } : {}), ...(external ? { external } : {}) };
}

/** rename：原来挂在旧名下面的子 agent 一起改指新名（在 saveRegistry 之前调） */
export function renameParentRefs(reg: Registry, oldKey: string, newKey: string): void {
  for (const info of Object.values(reg.agents)) if (info.parent === oldKey) info.parent = newKey;
}

/** `team-link <agent> [--parent <agent|master|none>] [--task "<text>"]`：给已存在的 agent 补挂 / 改挂 / 改任务名 */
export async function cmdTeamLink(args: string[]) {
  const { rest, flags } = extractTeamFlags(args);
  const [name] = rest;
  if (!name || rest.length > 1 || (flags.parent === undefined && flags.task === undefined)) {
    output({ ok: false, error: 'usage: team-link <agent> [--parent <agent|master|none>] [--task "<text>"]（--task "" 清除）' });
    return;
  }
  const reg = await loadRegistry();
  const key = normalizeName(name);
  const info = reg.agents[key];
  if (!info) {
    output({ ok: false, error: `registry 里没有 ${key}` });
    return;
  }
  const next = resolveTeamFields(reg.agents, key, { parent: flags.parent ?? "none", task: flags.task ?? "" }, { controlChannelId: "" });
  if ("error" in next) {
    output({ ok: false, error: next.error });
    return;
  }
  // 没写的那一项保持原值
  const parent = flags.parent === undefined ? info.parent : next.parent;
  const task = flags.task === undefined ? info.task : next.task;
  if (parent) info.parent = parent;
  else delete info.parent;
  if (task) info.task = task;
  else delete info.task;
  await saveRegistry(reg);
  output({ ok: true, agent: key.replace(/^agent-/, ""), parent: parent ? parent.replace(/^agent-/, "") : null, task: task ?? null });
}

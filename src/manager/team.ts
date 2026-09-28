/**
 * 派发关系（registry 的 parent / task）：侧栏把执行者挂在派它的 agent 下面（web sidebar-entries.ts 构树）。
 * parent 存派发者的 registry 键（`agent-xxx`，大总管是 `master`——它不在 registry 里）。纯展示元数据，不参与授权。
 *
 * 写入都在 manager 的命令级写锁里（manager.ts「写锁」段 + write-commands.ts），这里不再另拿锁——
 * 同一把锁在同一进程里再 acquire 会自己等满 20s。纯函数单测见 tests/manager-team.test.ts。
 */
import { isMasterAgent } from "../lib/registry.js";
import { hasUnsafeDisplayChars } from "../lib/display-text.js";
import { loadRegistry, saveRegistry, normalizeName, output, type AgentInfo, type Registry } from "./core.js";

export const MASTER_PARENT = "master";
export const TASK_MAX = 40;

/** 命令行上的派发字段：undefined = 没写（create 走自动反查）；parent "none" = 显式不挂；task "" = 清除 */
export interface TeamFlags {
  parent?: string;
  task?: string;
}
/** 最终写进 registry 的两字段（缺 = 不设） */
export type TeamFields = Pick<AgentInfo, "parent" | "task">;
type ParentMap = Record<string, { parent?: string; channelId?: string }>;

/**
 * 抽出 `--parent <x>` / `--parent=x` / `--task <text>` / `--task=text`；空串的 --task 保留（= 清除）。
 * 缺值（放在末尾）或 --parent 给空串 → error：否则会悄悄变成「不挂」，把自动反查的结果覆盖掉。
 */
export function extractTeamFlags(args: string[]): { rest: string[]; flags: TeamFlags; error?: string } {
  const rest: string[] = [];
  const flags: TeamFlags = {};
  let error: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const m = a.match(/^--(parent|task)(?:=(.*))?$/s);
    if (!m) {
      rest.push(a);
      continue;
    }
    const v = m[2] ?? args[++i];
    if (v === undefined || (m[1] === "parent" && !v.trim())) error ??= `--${m[1]} 缺少值（不挂派发者请写 --parent none）`;
    else flags[m[1] as keyof TeamFlags] = v;
  }
  return { rest, flags, error };
}

/** 用户写的派发者名 → registry 键（master 的各种写法归一成 `master`） */
export function parentKey(raw: string): string {
  const t = raw.trim();
  return isMasterAgent(t.toLowerCase()) ? MASTER_PARENT : normalizeName(t);
}

export function validateTask(task: string): string | null {
  if (task.length > TASK_MAX) return `--task 最多 ${TASK_MAX} 个字符`;
  if (hasUnsafeDisplayChars(task)) return "--task 不能含控制字符或方向控制符";
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
 * 自动 parent：agent 在自己的 Bash 里跑 create 时带着自己的 DISCORD_CHANNEL_ID（claude-launch.ts 注入）。
 * 反查不到（终端手动跑、bridge / cron 调）→ 不设。大总管的频道（CONTROL_CHANNEL_ID）不在 registry 里，天然反查不到——
 * 大总管建常驻 agent 是最常用的路径，自动挂 master 会让它们全从项目组里消失；要挂大总管只认显式 --parent master。
 */
export function autoParent(agents: ParentMap, channelId: string | undefined, child: string): string | undefined {
  if (!channelId) return undefined;
  return Object.entries(agents).find(([k, v]) => k !== child && v.channelId === channelId)?.[0];
}

/**
 * create 前（拉起 agent 之前）定下 parent / task；显式 --parent 不合法返回错误，调用方拒绝 create。
 * 自动反查只在带 --task 时生效（带任务名才算派活，普通建会话不挂）；反查结果同样过校验，不合法就不挂（不拒绝 create）。
 */
export function resolveTeamFields(agents: ParentMap, child: string, flags: TeamFlags, env: { channelId?: string }): TeamFields | { error: string } {
  const task = flags.task?.trim() ?? "";
  const taskErr = validateTask(task);
  if (taskErr) return { error: taskErr };
  let parent: string | undefined;
  if (flags.parent === undefined) {
    const auto = task ? autoParent(agents, env.channelId, child) : undefined;
    parent = auto && !validateParent(agents, child, auto) ? auto : undefined;
  } else if (flags.parent.trim() !== "none") {
    parent = parentKey(flags.parent);
    const err = validateParent(agents, child, parent);
    if (err) return { error: err };
  }
  return { ...(parent ? { parent } : {}), ...(task ? { task } : {}) };
}

/** cmdCreate 用：读 registry + 环境后定派发字段；出错直接 output 并返回 null（manager.ts 一行调用） */
export async function teamFieldsForCreate(child: string, flags: TeamFlags): Promise<TeamFields | null> {
  const r = resolveTeamFields((await loadRegistry()).agents, child, flags, { channelId: process.env.DISCORD_CHANNEL_ID });
  if ("error" in r) output({ ok: false, error: r.error });
  return "error" in r ? null : r;
}

/**
 * resume 整条重写条目时要带过去的字段（缺了就丢挂载关系、显示名）。external 是安全闸门，只在接的还是同一个会话时保留：
 * `resume <已停止的名字> <无关 sessionId>` 若沿用 external，peer token 的 scope 会直接覆盖到这个新会话。
 */
export function keepOnResume(prior: AgentInfo | undefined, sessionId: string): Partial<AgentInfo> {
  if (!prior) return {};
  const { parent, task, label } = prior;
  const external = prior.external === true && prior.sessionId === sessionId;
  return { ...(parent ? { parent } : {}), ...(task ? { task } : {}), ...(label ? { label } : {}), ...(external ? { external } : {}) };
}

/**
 * 指向 oldKey 的 parent 一起改：rename 改指新名；remove（newKey 省略）直接清掉——留着的话，
 * 以后建出同名 agent 会被这些旧孤儿认作父，校验还会误报成环。在 saveRegistry 之前调。
 */
export function repointParentRefs(reg: Registry, oldKey: string, newKey?: string): void {
  for (const info of Object.values(reg.agents)) {
    if (info.parent !== oldKey) continue;
    if (newKey) info.parent = newKey;
    else delete info.parent;
  }
}

/** `team-link <agent> [--parent <agent|master|none>] [--task "<text>"]`：给已存在的 agent 补挂 / 改挂 / 改任务名 */
export async function cmdTeamLink(args: string[]) {
  const { rest, flags, error } = extractTeamFlags(args);
  const [name] = rest;
  if (error || !name || rest.length > 1 || (flags.parent === undefined && flags.task === undefined)) {
    output({ ok: false, error: error ?? 'usage: team-link <agent> [--parent <agent|master|none>] [--task "<text>"]（--task "" 清除）' });
    return;
  }
  const reg = await loadRegistry();
  const key = normalizeName(name);
  const info = reg.agents[key];
  if (!info) {
    output({ ok: false, error: `registry 里没有 ${key}` });
    return;
  }
  const next = resolveTeamFields(reg.agents, key, { parent: flags.parent ?? "none", task: flags.task ?? "" }, {});
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

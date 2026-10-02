/**
 * 开卡中途失败的手动结清（i28-IMP1）：start_node 失败回滚后只留下 `dag-start:<卡>:<attempt>:task-new`、没有 `...:bind`，
 * 共享台账导入的 preflight（scripts/shared-ledger-import.ts）会一直当它还在跑。`ledger start-settle` 先核实三件事，
 * 都成立才写一条持久事件 `dag-start:<卡>:<attempt>:settled`，preflight 认它放行：
 * 1. 卡是 cancelled，或这次 attempt 已有 `...:undo-task` 回滚事件；
 * 2. 本机 registry 里这张卡的执行者会话不在运行（不存在，或 status=stopped）；
 * 3. 卡的 worktree 目录不存在，且项目每个 git 仓库的 `git worktree list` 都列得出来、里面都没有它（任何一个核实不了就不过）。
 *    会话与 worktree 的证据读不出来（registry 坏、仓库不可读）一律拒绝，不当成「不在」。
 * 不改 start_node 自身流程（dag-tools-steps.ts）；结清只追加事件，重跑命中 dedupKey 原样返回、不重复写。
 */
import type { Database } from "bun:sqlite";
import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { WriteCtx } from "./ledger-checks.js";
import { actorMayConfigure, textOneLine } from "./ledger-scheduler-settle.js";
import { getEventByDedup, getTask, LedgerError } from "./ledger-store.js";
import type { LedgerEvent } from "./ledger-stages.js";
import { appendEvent } from "./ledger-write.js";

export interface StartSettleEnv {
  /** start_node 放 worktree 的目录（缺省 statePath("worktrees")，与 dag-tools-start.ts 同源） */
  worktreeRoot: string;
  /** 本机 registry 里的会话（名字 + 状态 + 工作目录）；读不出来就抛，不能当成「都不在」 */
  agents(): Promise<{ name: string; status?: string; cwd?: string }[]>;
  exists(path: string): boolean;
  /** 卡所属项目的目录（projects.json dirs） */
  projectDirs(project: string): string[];
  /**
   * `git worktree list --porcelain` 的 worktree 路径。"not-git" = 目录在、没有 .git、git 也不认它（不可能持有 worktree 元数据）；
   * null = 核实不了（目录不在 / 有 .git 但命令失败）——任何一个候选仓库核实不了，整项就不过，不能拿别的仓库的结果顶
   */
  worktrees(dir: string): Promise<string[] | "not-git" | null>;
}

export interface StartSettleInput { taskId: string; attempt: string; reason: string }

export interface StartSettleChecks {
  rolledBack: { ok: boolean; detail: string };
  session: { ok: boolean; detail: string };
  worktree: { ok: boolean; detail: string };
}

const ATTEMPT = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const startDedup = (taskId: string, attempt: string, step: string): string => `dag-start:${taskId}:${attempt}:${step}`;
/** 与 dag-tools-start.ts 的 agentNameFor 同一规则（那边没导出，这里不改它） */
const agentNameFor = (taskId: string): string => `task-${taskId.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`.slice(0, 48);

/**
 * registry.json 的严格解析（结清专用）：通用读者 normalizeRegistryAgents 遇到脏条目整份返回空数组，
 * 那对结清就是「没有会话在跑」的假证明。这里结构不对一律抛，条目必须是对象、status / cwd / dir 有就得是字符串。
 */
export function parseRegistryForSettle(data: unknown): { name: string; status?: string; cwd?: string }[] {
  const bad = (why: string): never => { throw new LedgerError("conflict", `registry.json 结构不对，核实不了执行者会话：${why}`); };
  const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  if (!isObj(data)) return bad("顶层不是对象");
  if (data.agents === undefined) return [];
  if (!isObj(data.agents)) return bad("agents 不是对象");
  return Object.entries(data.agents).map(([name, v]) => {
    if (!isObj(v)) return bad(`条目 ${name} 不是对象`);
    for (const k of ["status", "cwd", "dir"]) if (v[k] !== undefined && typeof v[k] !== "string") bad(`条目 ${name} 的 ${k} 不是字符串`);
    const cwd = (v.cwd ?? v.dir) as string | undefined;
    return { name, ...(v.status !== undefined ? { status: v.status as string } : {}), ...(cwd !== undefined ? { cwd } : {}) };
  });
}

/** 路径比较：macOS 临时目录有 /var → /private/var 软链，git 列出来的是解析后的路径 */
function canonical(path: string): string {
  const abs = resolve(path);
  try { return realpathSync(abs); } catch { /* 目录不在：按父目录解析 */ }
  try { return join(realpathSync(dirname(abs)), basename(abs)); } catch { return abs; }
}

/** 三项核实；不写库。每项给出可读的说明，拒绝时原样报给操作者 */
async function checkStartSettle(db: Database, env: StartSettleEnv, input: StartSettleInput): Promise<StartSettleChecks> {
  const task = getTask(db, input.taskId);
  if (!task) throw new LedgerError("not_found", `没有卡 ${input.taskId}`);
  const undo = getEventByDedup(db, startDedup(input.taskId, input.attempt, "undo-task"));
  const rolledBack = task.stage === "cancelled" || !!undo
    ? { ok: true, detail: task.stage === "cancelled" ? "卡是 cancelled" : "这次 attempt 有 undo-task 回滚事件" }
    : { ok: false, detail: `卡还是 ${task.stage}，这次 attempt 也没有 undo-task 回滚事件` };

  const wantNames = new Set([task.agent, `agent-${agentNameFor(task.id)}`].filter((x): x is string => !!x));
  const extraWorktree = typeof task.extra.worktree === "string" && task.extra.worktree ? [task.extra.worktree] : [];
  const paths = [...new Set([join(env.worktreeRoot, task.id.toLowerCase()), ...extraWorktree].map(canonical))];
  let agents: { name: string; status?: string; cwd?: string }[] | null = null, agentsError = "";
  try { agents = await env.agents(); } catch (e) { agentsError = e instanceof Error ? e.message : String(e); }
  const running = (agents ?? []).filter((a) => a.status !== "stopped" && (wantNames.has(a.name) || (!!a.cwd && paths.includes(canonical(a.cwd)))));
  const session = !agents ? { ok: false, detail: `读不出本机 registry，核实不了执行者会话：${agentsError}` }
    : running.length
    ? { ok: false, detail: `执行者会话仍在运行：${running.map((a) => `${a.name}(${a.status ?? "无状态"})`).join(", ")}` }
    : { ok: true, detail: `registry 里没有在运行的执行者会话（查了 ${[...wantNames].join(", ")}）` };

  const present = paths.filter((p) => env.exists(p));
  let worktree: { ok: boolean; detail: string };
  if (present.length) worktree = { ok: false, detail: `worktree 目录还在：${present.join(", ")}` };
  else {
    const listed: string[] = [], unreadable: string[] = [];
    let readable = 0;
    for (const dir of env.projectDirs(task.project)) {
      const list = await env.worktrees(dir);
      if (list === "not-git") continue;
      if (!list) { unreadable.push(dir); continue; }
      readable++;
      listed.push(...list.map(canonical));
    }
    const registered = paths.filter((p) => listed.includes(p));
    worktree = registered.length ? { ok: false, detail: `git worktree list 里还有：${registered.join(", ")}` }
      : unreadable.length ? { ok: false, detail: `仓库目录列不出 git worktree，核实不了：${unreadable.join(", ")}` }
      : !readable ? { ok: false, detail: `项目 ${task.project} 没有能列出 git worktree 的仓库目录，核实不了` }
      : { ok: true, detail: `worktree 目录不在，git worktree list 里也没有（${paths.join(", ")}）` };
  }
  return { rolledBack, session, worktree };
}

/**
 * `ledger start-settle <卡> --attempt <id> --reason <原因>`：项目 PM / master / owner 才能结清。
 * 已结清直接返回原事件（duplicate），不再核实；核实有一项不过就拒，并且不写事件。
 */
export async function settleDagStart(db: Database, ctx: WriteCtx, env: StartSettleEnv, input: StartSettleInput)
  : Promise<{ event: LedgerEvent; duplicate: boolean; checks: StartSettleChecks | null }> {
  if (!ATTEMPT.test(input.attempt)) throw new LedgerError("invalid", "--attempt 只能是字母数字 _ . -（≤ 64 位）");
  const reason = textOneLine(input.reason, "--reason ", 600);
  const task = getTask(db, input.taskId);
  if (!task) throw new LedgerError("not_found", `没有卡 ${input.taskId}`);
  if (!actorMayConfigure(db, ctx.actor, task.project)) throw new LedgerError("forbidden", `只有项目 ${task.project} 的 PM / master / owner 能结清开卡`);
  const key = startDedup(task.id, input.attempt, "settled");
  const prior = getEventByDedup(db, key);
  if (prior) return { event: prior, duplicate: true, checks: null };
  const started = getEventByDedup(db, startDedup(task.id, input.attempt, "task-new"));
  if (!started || started.target !== task.id) throw new LedgerError("not_found", `卡 ${task.id} 没有 attempt ${input.attempt} 的开卡记录（task-new）`);
  if (getEventByDedup(db, startDedup(task.id, input.attempt, "bind"))) throw new LedgerError("conflict", `attempt ${input.attempt} 已绑节点，开卡是完成的，不用结清`);
  const checks = await checkStartSettle(db, env, { ...input, taskId: task.id });
  const failed = (Object.entries(checks) as [keyof StartSettleChecks, { ok: boolean; detail: string }][]).filter(([, c]) => !c.ok);
  if (failed.length) {
    const label = { rolledBack: "卡没回滚", session: "会话仍在运行", worktree: "worktree 还在" } as const;
    throw new LedgerError("conflict", `核实没过，不结清：${failed.map(([k, c]) => `${label[k]}（${c.detail}）`).join("；")}`);
  }
  const r = appendEvent(db, { ...ctx, dedupKey: key }, {
    project: task.project, target: task.id, kind: "decision", text: `开卡中途失败已结清（attempt ${input.attempt}）：${reason}`,
    data: { op: "dag_start_settle", taskId: task.id, attempt: input.attempt, reason, operator: ctx.actor, checks },
  });
  return { ...r, checks };
}

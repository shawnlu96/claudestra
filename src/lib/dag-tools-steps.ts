/**
 * start_node 的执行：按预检出的 StartPlan 一步步做（= PM 原来的 mk-auto.sh），任何一步失败就把已做的倒序撤掉，回报停在哪一步。
 * 顺序有讲究：绑节点（dag-bind）放最后——绑定只追加、撤不掉，而卡被取消会让节点算「已完成」、之后改不了图；开 auto（workflow-set）
 * 在它前面，是最可能被拒的一步（调度服务没开），预检也查过一次。卡号一旦建过就不能复用，所以回滚是把卡推到 cancelled，重试要换 taskId。
 * 每次调用一个随机 attempt 做 dedup 前缀：同一次里的重放安全，回滚后的重试不会被上一次的 dedup 回放成「成功」。
 * 失败不等于没写：manager 提交后被超时强杀、结果丢了，台账里照样有这一笔。所以台账步骤失败后先按本次 dedup 查库（landed），落了就当成功接着走；
 * 回滚只撤「本次确认建的」——每步动手前再查一次资源在不在，在就是别人的，失败也不碰。tests/dag-tools-bridge.test.ts。
 */
import type { Database } from "bun:sqlite";
import { dirname, join } from "node:path";
import type { StartPlan } from "./dag-tools-start.js";
import { getFeature } from "./ledger-feature.js";
import { getWorkflow } from "./ledger-scheduler.js";
import { getEventByDedup, getTask } from "./ledger-store.js";
import { ledgerArgs } from "./order-ledger-exit.js";

interface GitResult {
  ok: boolean;
  out: string;
}

/** 执行要用的副作用（bridge 注入真实的：以调用方频道跑 manager、runBounded 跑 git、node:fs） */
export interface StepIO {
  db: () => Database;
  /** 以调用方身份跑 `manager <args>`，返回它的 JSON 结果 */
  manager(args: string[], timeoutMs?: number): Promise<any>;
  git(cwd: string, args: string[], timeoutMs?: number): Promise<GitResult>;
  exists(path: string): boolean;
  read(path: string): string | null;
  write(path: string, text: string): void;
  remove(path: string): void;
  symlink(target: string, path: string): void;
  agentExists(agent: string): boolean;
  attempt: string;
}

const STEP_NAMES = ["task-new", "spec", "worktree", "prompt", "agent", "task-set", "workflow", "bind"] as const;
type StepName = (typeof STEP_NAMES)[number];

interface Step {
  name: StepName;
  run(): Promise<string | null>;
  /** run 报失败后查库：这一笔其实已经落了（结果丢了）→ 当成功接着走 */
  landed?(): boolean;
  /** 只撤本次确认建的东西；失败的那一步也会被调（可能做了一半），自己判断有没有要撤的 */
  undo?(): Promise<string | null>;
}

export type StartOutcome =
  | { ok: true; taskId: string; agent: string; branch: string; worktree: string; prompt: string; steps: StepName[]; reconciled: StepName[] }
  | { ok: false; code: "start_failed"; error: string; failedStep: StepName; rolledBack: StepName[]; leftovers: string[] };

const CREATE_TIMEOUT_MS = 240_000;
const FALLBACK = "PM 接管，按手动流程推进（派审 + 合并队列）";

/** manager 的 JSON 结果 → null（成功）或错误文字 */
const failed = (r: any): string | null => (r?.ok ? null : String(r?.error ?? r?.code ?? "manager 没有返回结果").slice(0, 500));

const dedup = (io: StepIO, p: StartPlan, step: string) => `dag-start:${p.taskId}:${io.attempt}:${step}`;

/** 以调用方身份跑一条 ledger 写命令；workflow-set 不收 --dedup（它自己按 workflow-rev 做 CAS），step 给 null */
function ledger(io: StepIO, p: StartPlan, sub: string, target: string, flags: Record<string, string | undefined>, step: string | null, extraPos: string[] = []) {
  const args = ledgerArgs(sub, target, flags, dedup(io, p, String(step)));
  return io.manager([...args.slice(0, 3), ...extraPos, ...args.slice(3, step === null ? -1 : undefined)]);
}

/** 这一步的 dedup 事件在库里 = 本次调用写的（attempt 随机，别人不会撞） */
const ours = (io: StepIO, p: StartPlan, step: string) => getEventByDedup(io.db(), dedup(io, p, step)) !== null;

const rev = (io: StepIO, id: string) => String(getTask(io.db(), id)?.rev ?? 0);

function taskSteps(io: StepIO, p: StartPlan): Step[] {
  return [
    {
      name: "task-new",
      run: async () => failed(await ledger(io, p, "task-new", p.taskId, {
        title: p.title, kind: "code", item: p.item ?? undefined, branch: p.branch, spec: p.specRel, pm: p.pm, project: p.project, extra: JSON.stringify({ fileGlobs: p.fileGlobs }),
      }, "task-new")),
      landed: () => ours(io, p, "task-new"),
      // 只取消本次建的卡：同名卡若是别人（并发 / 手工）建的，本次的 task-new 事件不在库里
      undo: async () => {
        const t = getTask(io.db(), p.taskId);
        if (!t || t.stage === "cancelled" || !ours(io, p, "task-new")) return null;
        return failed(await ledger(io, p, "stage", p.taskId, { from: t.stage, to: "cancelled", text: "start_node 中途失败，回滚" }, "undo-task"));
      },
    },
    fileStep("spec", io, p.specPath, () => (p.specText === null ? null : p.specText.endsWith("\n") ? p.specText : `${p.specText}\n`), false),
  ];
}

/**
 * 写一个文件（规格卡 / 执行者说明）。wrote 在写之前置上：写到一半抛错（已建 / 已截断）也要撤。
 * mayReplace=false 时动手前文件已在 = 不是本次写的（预检后被人写了），报错且不撤。
 */
function fileStep(name: "spec" | "prompt", io: StepIO, path: string, text: () => string | null, mayReplace: boolean): Step {
  let wrote = false;
  let before: string | null = null;
  return {
    name,
    run: async () => {
      const t = text();
      if (t === null) return null;
      before = io.read(path);
      if (before !== null && !mayReplace) return `${path} 已存在（不是这次写的），不覆盖`;
      wrote = true;
      io.write(path, t);
      return null;
    },
    undo: async () => {
      if (!wrote) return null;
      if (before === null) io.remove(path);
      else io.write(path, before);
      return null;
    },
  };
}

const hasBranch = async (io: StepIO, p: StartPlan) => (await io.git(p.repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${p.branch}`])).ok;

function worktreeStep(io: StepIO, p: StartPlan): Step {
  // 本次要建的：动手前确认不在才置上。已在的是别人的（预检之后才出现），失败回滚绝不删
  const mine = { worktree: false, branch: false };
  return {
    name: "worktree",
    run: async () => {
      if (p.base.startsWith("origin/")) {
        const f = await io.git(p.repo, ["fetch", "-q", "origin"], 60_000);
        if (!f.ok) return `git fetch origin 失败：${f.out}`;
      }
      if (io.exists(p.worktree)) return `worktree 目录 ${p.worktree} 已存在（预检之后才出现，不是这次建的）`;
      if (await hasBranch(io, p)) return `分支 ${p.branch} 已存在（预检之后才出现，不是这次建的）`;
      mine.worktree = mine.branch = true;
      const w = await io.git(p.repo, ["worktree", "add", "-b", p.branch, p.worktree, p.base]);
      if (!w.ok) return `git worktree add 失败：${w.out}`;
      // 软链依赖目录：执行者跑检查要用；仓库没有就跳过（不是每个项目都有）
      for (const sub of ["node_modules", join("web", "node_modules")]) {
        if (io.exists(join(p.repo, sub)) && io.exists(dirname(join(p.worktree, sub))) && !io.exists(join(p.worktree, sub))) io.symlink(join(p.repo, sub), join(p.worktree, sub));
      }
      return null;
    },
    undo: async () => {
      const out: string[] = [];
      if (mine.worktree && io.exists(p.worktree)) {
        const w = await io.git(p.repo, ["worktree", "remove", "--force", p.worktree]);
        if (!w.ok) out.push(`worktree ${p.worktree} 没删掉：${w.out}`);
      }
      if (mine.branch && (await hasBranch(io, p))) {
        const b = await io.git(p.repo, ["branch", "-D", p.branch]);
        if (!b.ok) out.push(`分支 ${p.branch} 没删掉：${b.out}`);
      }
      return out.join("；") || null;
    },
  };
}

function agentSteps(io: StepIO, p: StartPlan): Step[] {
  let mine = false;
  return [
    fileStep("prompt", io, p.promptPath, () => p.promptText, true),
    {
      name: "agent",
      run: async () => {
        if (io.agentExists(p.agent)) return `agent ${p.agent} 已存在（预检之后才出现，不是这次建的）`;
        mine = true;
        return failed(await io.manager(["create", p.agentName, p.worktree, "--purpose", p.purpose, "--task", p.taskId, "--effort", "high", "--project", p.project], CREATE_TIMEOUT_MS));
      },
      // create 超时可能已建好：registry 里有、且是本次 create 之前没有的，才 kill
      undo: async () => (mine && io.agentExists(p.agent) ? failed(await io.manager(["kill", p.agent])) : null),
    },
    {
      name: "task-set",
      run: async () => failed(await ledger(io, p, "task-set", p.taskId, { rev: rev(io, p.taskId), agent: p.agent }, "task-set")),
      landed: () => ours(io, p, "task-set"),
    },
    {
      name: "workflow",
      run: async () => failed(await ledger(io, p, "workflow-set", p.taskId, {
        rev: rev(io, p.taskId), "workflow-rev": "0", template: "code", version: "2", mode: "auto", "author-family": "claude", fallback: FALLBACK,
      }, null)),
      // workflow-set 没有 dedup：卡是本次建的（task-new 已确认归属），它的 workflow 是 auto 就是这一笔落了
      landed: () => getWorkflow(io.db(), p.taskId)?.mode === "auto",
      undo: async () => {
        const w = getWorkflow(io.db(), p.taskId);
        if (!w || w.mode !== "auto") return null;
        return failed(await ledger(io, p, "workflow-set", p.taskId, {
          rev: rev(io, p.taskId), "workflow-rev": String(w.rev), template: w.template, version: String(w.templateVersion), mode: "manual",
          "author-family": w.authorFamily, fallback: w.fallback, reason: "start_node 中途失败，回滚",
        }, null));
      },
    },
    {
      name: "bind",
      run: async () => failed(await ledger(io, p, "dag-bind", p.feature.id, { rev: String(getFeature(io.db(), p.feature.id)?.rev ?? 0) }, "bind", [p.key, p.taskId])),
      // 绑定只追加、撤不掉：落了却当失败回滚，节点会指向被取消的卡
      landed: () => ours(io, p, "bind"),
    },
  ];
}

export async function runStart(io: StepIO, p: StartPlan): Promise<StartOutcome> {
  const steps = [...taskSteps(io, p), worktreeStep(io, p), ...agentSteps(io, p)];
  const done: Step[] = [];
  const reconciled: StepName[] = [];
  for (const s of steps) {
    let err: string | null;
    try {
      err = await s.run();
    } catch (e) {
      err = (e as Error).message;
    }
    if (err && s.landed?.()) reconciled.push(s.name);
    else if (err) {
      // 失败的这一步也交给 undo（可能做了一半）；各步的 undo 只撤本次确认建的
      const { rolledBack, leftovers } = await rollback([s, ...done.reverse()]);
      return { ok: false, code: "start_failed", error: err, failedStep: s.name, rolledBack, leftovers };
    }
    done.push(s);
  }
  return { ok: true, taskId: p.taskId, agent: p.agent, branch: p.branch, worktree: p.worktree, prompt: p.promptPath, steps: done.map((s) => s.name), reconciled };
}

async function rollback(steps: Step[]): Promise<{ rolledBack: StepName[]; leftovers: string[] }> {
  const rolledBack: StepName[] = [];
  const leftovers: string[] = [];
  for (const s of steps) {
    if (!s.undo) continue;
    try {
      const err = await s.undo();
      if (err) leftovers.push(`${s.name}：${err}`);
      else rolledBack.push(s.name);
    } catch (e) {
      leftovers.push(`${s.name}：${(e as Error).message}`);
    }
  }
  return { rolledBack, leftovers };
}

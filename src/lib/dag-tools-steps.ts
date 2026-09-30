/**
 * start_node 的执行：按预检出的 StartPlan 一步步做（= PM 原来的 mk-auto.sh），任何一步失败就把已做的倒序撤掉，回报停在哪一步。
 * 顺序有讲究：绑节点（dag-bind）放最后——绑定只追加、撤不掉，而卡被取消会让节点算「已完成」、之后改不了图；开 auto（workflow-set）
 * 在它前面，是最可能被拒的一步（调度服务没开），预检也查过一次。卡号一旦建过就不能复用，所以回滚是把卡推到 cancelled，重试要换 taskId。
 * 每次调用一个随机 attempt 做 dedup 前缀：同一次里的重放安全，回滚后的重试不会被上一次的 dedup 回放成「成功」。tests/dag-tools-start.test.ts。
 */
import type { Database } from "bun:sqlite";
import { dirname, join } from "node:path";
import type { StartPlan } from "./dag-tools-start.js";
import { getFeature } from "./ledger-feature.js";
import { getWorkflow } from "./ledger-scheduler.js";
import { getTask } from "./ledger-store.js";
import { ledgerArgs } from "./order-ledger-exit.js";

export interface GitResult {
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

export const STEP_NAMES = ["task-new", "spec", "worktree", "prompt", "agent", "task-set", "workflow", "bind"] as const;
export type StepName = (typeof STEP_NAMES)[number];

interface Step {
  name: StepName;
  /** 失败时可能已做了一半（worktree 建了一半、create 超时）：失败的这一步也要撤。其余步骤是一条原子写，失败 = 没做 */
  partial?: boolean;
  run(): Promise<string | null>;
  undo?(): Promise<string | null>;
}

export type StartOutcome =
  | { ok: true; taskId: string; agent: string; branch: string; worktree: string; prompt: string; steps: StepName[] }
  | { ok: false; code: "start_failed"; error: string; failedStep: StepName; rolledBack: StepName[]; leftovers: string[] };

const CREATE_TIMEOUT_MS = 240_000;
const FALLBACK = "PM 接管，按手动流程推进（派审 + 合并队列）";

/** manager 的 JSON 结果 → null（成功）或错误文字 */
const failed = (r: any): string | null => (r?.ok ? null : String(r?.error ?? r?.code ?? "manager 没有返回结果").slice(0, 500));

/** 以调用方身份跑一条 ledger 写命令；workflow-set 不收 --dedup（它自己按 workflow-rev 做 CAS），step 给 null */
function ledger(io: StepIO, p: StartPlan, sub: string, target: string, flags: Record<string, string | undefined>, step: string | null, extraPos: string[] = []) {
  const args = ledgerArgs(sub, target, flags, `dag-start:${p.taskId}:${io.attempt}:${step}`);
  return io.manager([...args.slice(0, 3), ...extraPos, ...args.slice(3, step === null ? -1 : undefined)]);
}

const rev = (io: StepIO, id: string) => String(getTask(io.db(), id)?.rev ?? 0);

function taskSteps(io: StepIO, p: StartPlan): Step[] {
  return [
    {
      name: "task-new",
      run: async () => failed(await ledger(io, p, "task-new", p.taskId, {
        title: p.title, kind: "code", item: p.item ?? undefined, branch: p.branch, spec: p.specRel, pm: p.pm, project: p.project, extra: JSON.stringify({ fileGlobs: p.fileGlobs }),
      }, "task-new")),
      undo: async () => {
        const t = getTask(io.db(), p.taskId);
        if (!t || t.stage === "cancelled") return null;
        return failed(await ledger(io, p, "stage", p.taskId, { from: t.stage, to: "cancelled", text: "start_node 中途失败，回滚" }, "undo-task"));
      },
    },
    {
      name: "spec",
      run: async () => {
        if (p.specText === null) return null;
        io.write(p.specPath, p.specText.endsWith("\n") ? p.specText : `${p.specText}\n`);
        return null;
      },
      undo: async () => (p.specText === null ? null : (io.remove(p.specPath), null)),
    },
  ];
}

function worktreeStep(io: StepIO, p: StartPlan): Step {
  return {
    name: "worktree",
    partial: true,
    run: async () => {
      if (p.base.startsWith("origin/")) {
        const f = await io.git(p.repo, ["fetch", "-q", "origin"], 60_000);
        if (!f.ok) return `git fetch origin 失败：${f.out}`;
      }
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
      if (io.exists(p.worktree)) {
        const w = await io.git(p.repo, ["worktree", "remove", "--force", p.worktree]);
        if (!w.ok) out.push(`worktree ${p.worktree} 没删掉：${w.out}`);
      }
      // 预检确认过分支原本不存在：现在有就是这一步建的
      if ((await io.git(p.repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${p.branch}`])).ok) {
        const b = await io.git(p.repo, ["branch", "-D", p.branch]);
        if (!b.ok) out.push(`分支 ${p.branch} 没删掉：${b.out}`);
      }
      return out.join("；") || null;
    },
  };
}

function agentSteps(io: StepIO, p: StartPlan): Step[] {
  let before: string | null = null;
  return [
    {
      name: "prompt",
      run: async () => {
        before = io.read(p.promptPath);
        io.write(p.promptPath, p.promptText);
        return null;
      },
      undo: async () => (before === null ? io.remove(p.promptPath) : io.write(p.promptPath, before), null),
    },
    {
      name: "agent",
      partial: true,
      run: async () => failed(await io.manager(["create", p.agentName, p.worktree, "--purpose", p.purpose, "--task", p.taskId, "--effort", "high", "--project", p.project], CREATE_TIMEOUT_MS)),
      // create 失败时它自己清占位；这里只在 registry 真有这个 agent 时才 kill
      undo: async () => (io.agentExists(p.agent) ? failed(await io.manager(["kill", p.agent])) : null),
    },
    { name: "task-set", run: async () => failed(await ledger(io, p, "task-set", p.taskId, { rev: rev(io, p.taskId), agent: p.agent }, "task-set")) },
    {
      name: "workflow",
      run: async () => failed(await ledger(io, p, "workflow-set", p.taskId, {
        rev: rev(io, p.taskId), "workflow-rev": "0", template: "code", version: "2", mode: "auto", "author-family": "claude", fallback: FALLBACK,
      }, null)),
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
    },
  ];
}

export async function runStart(io: StepIO, p: StartPlan): Promise<StartOutcome> {
  const steps = [...taskSteps(io, p), worktreeStep(io, p), ...agentSteps(io, p)];
  const done: Step[] = [];
  for (const s of steps) {
    let err: string | null;
    try {
      err = await s.run();
    } catch (e) {
      err = (e as Error).message;
    }
    if (!err) {
      done.push(s);
      continue;
    }
    // 失败的这一步做了一半的（create 超时、worktree 建了一半）连它一起撤；原子步骤失败 = 没写，不撤（撤了会动到并发建的同名卡）
    const { rolledBack, leftovers } = await rollback([...(s.partial ? [s] : []), ...done.reverse()]);
    return { ok: false, code: "start_failed", error: err, failedStep: s.name, rolledBack, leftovers };
  }
  return { ok: true, taskId: p.taskId, agent: p.agent, branch: p.branch, worktree: p.worktree, prompt: p.promptPath, steps: done.map((s) => s.name) };
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

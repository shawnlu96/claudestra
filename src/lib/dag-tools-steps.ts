import { rollback } from "./shared-ledger-gate-rollback.js";
import { requireLocalSharedLedgerPlanning } from "./shared-ledger-gate.js";
import { runLocalStart, type QueuedStart } from "./scheduler-local-runtime-start.js";
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
import { LATEST_TEMPLATE_VERSION } from "./scheduler-template.js";
import { ledgerArgs } from "./order-ledger-exit.js";
import { peerRestateSkip } from "./scheduler-spec-resume-text.js";

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

const STEP_NAMES = ["task-new", "spec", "worktree", "prompt", "agent", "task-set", "restate", "workflow", "bind"] as const;
export type StepName = (typeof STEP_NAMES)[number];

export interface Step {
  name: StepName;
  run(): Promise<string | null>;
  /** run 报失败后查库：这一笔其实已经落了（结果丢了）→ 当成功接着走 */
  landed?(): boolean;
  /** 只撤本次确认建的东西；失败的那一步也会被调（可能做了一半），自己判断有没有要撤的 */
  undo?(): Promise<string | null>;
}

export type StartOutcome =
  | { ok: true; taskId: string; agent: string; branch: string; worktree: string; prompt: string; steps: StepName[]; reconciled: StepName[] }
  | { ok: true; taskId: string; placement: string; branch: string; steps: StepName[]; reconciled: StepName[] }
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
        title: p.title, kind: "code", item: p.item ?? undefined, branch: p.branch, spec: p.specPath, pm: p.pm, project: p.project,
        extra: JSON.stringify({ sharedFeatureId: p.feature.id, fileGlobs: p.fileGlobs,
          ...(p.peer ? { placement: `peer:${p.peer.name}`, repo: p.peer.repo,
            ...(p.peer.reservation ? { placementReservation: p.peer.reservation } : {}) } : p.localOnly ? { placement: "local" } : {}) }),
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

/** 分支的提交；没有这个分支为 null */
async function tip(io: StepIO, p: StartPlan, ref: string): Promise<string | null> {
  const r = await io.git(p.repo, ["rev-parse", "--verify", "--quiet", ref]);
  return r.ok && r.out ? r.out : null;
}

/** `git worktree list --porcelain` 里锁标记等于 tag 的那个 worktree 的路径 */
async function lockedBy(io: StepIO, p: StartPlan, tag: string): Promise<string | null> {
  const r = await io.git(p.repo, ["worktree", "list", "--porcelain"]);
  const block = r.ok ? r.out.split("\n\n").find((b) => b.split("\n").includes(`locked ${tag}`)) : undefined;
  return block?.match(/^worktree (.+)$/m)?.[1] ?? null;
}

/**
 * 归属靠「确实是本次建的」，不靠「检查时没看见」——检查和创建之间，别的进程（手工 git、另一个 bridge）照样能在同一路径建 worktree：
 * - add 带 `--lock --reason <本次 attempt>`，git 在 checkout 之前就把锁写进 worktree 元数据。add 失败时只清锁标记是本次的那个；
 *   路径被别人占了，git 拒 add、不会有本次的锁，外来的 worktree 一个文件都不碰。add 成功后解锁，之后这个路径才算本次的。
 *   （`git worktree move` 不能拿来落位：目标已是目录时它会挪进去而不是失败。）
 * - 分支：add 成功 = 本次建的。add 失败时归属不明（路径冲突时 git 已经建了分支），只在它还停在本次起点提交上时才删——那样的分支上
 *   没有任何人的工作，删了不丢东西；否则留下并报出来。
 */
function worktreeStep(io: StepIO, p: StartPlan): Step {
  const tag = `dag-start:${p.taskId}:${io.attempt}`;
  const mine = { placed: false, branch: false, base: null as string | null };
  return {
    name: "worktree",
    run: async () => {
      if (p.base.startsWith("origin/")) {
        const f = await io.git(p.repo, ["fetch", "-q", "origin"], 60_000);
        if (!f.ok) return `git fetch origin 失败：${f.out}`;
      }
      if (io.exists(p.worktree)) return `worktree 目录 ${p.worktree} 已存在（预检之后才出现，不是这次建的）`;
      if (await tip(io, p, `refs/heads/${p.branch}`)) return `分支 ${p.branch} 已存在（预检之后才出现，不是这次建的）`;
      mine.base = await tip(io, p, `${p.base}^{commit}`);
      if (!mine.base) return `起点 ${p.base} 找不到提交`;
      requireLocalSharedLedgerPlanning(p.feature.id);
      const w = await io.git(p.repo, ["worktree", "add", "--lock", "--reason", tag, "-b", p.branch, p.worktree, p.base]);
      if (!w.ok) return `git worktree add 失败：${w.out}`;
      mine.placed = mine.branch = true;
      const u = await io.git(p.repo, ["worktree", "unlock", p.worktree]);
      if (!u.ok) return `worktree 解锁失败：${u.out}`;
      // 软链依赖目录：执行者跑检查要用；仓库没有就跳过（不是每个项目都有）
      for (const sub of ["node_modules", join("web", "node_modules")]) {
        if (io.exists(join(p.repo, sub)) && io.exists(dirname(join(p.worktree, sub))) && !io.exists(join(p.worktree, sub))) io.symlink(join(p.repo, sub), join(p.worktree, sub));
      }
      return null;
    },
    undo: async () => {
      const out: string[] = [];
      // 两道 --force：本次的锁可能还在（add 成功后解锁前失败，或 add 做了一半）
      const dir = mine.placed ? p.worktree : mine.base ? await lockedBy(io, p, tag) : null;
      if (dir && (mine.placed ? io.exists(dir) : true)) {
        const w = await io.git(p.repo, ["worktree", "remove", "--force", "--force", dir]);
        if (!w.ok) out.push(`worktree ${dir} 没删掉：${w.out}`);
      }
      const now = mine.base ? await tip(io, p, `refs/heads/${p.branch}`) : null;
      if (now && (mine.branch || now === mine.base)) {
        const b = await io.git(p.repo, ["branch", "-D", p.branch]);
        if (!b.ok) out.push(`分支 ${p.branch} 没删掉：${b.out}`);
      } else if (now) out.push(`分支 ${p.branch} 已有别的提交（不在本次起点上），没删`);
      return out.join("；") || null;
    },
  };
}

function agentSteps(io: StepIO, p: StartPlan): Step[] {
  // owned：回执名 = 预检规范名、registry 里有、create 前没有，才算本次建的；只有它会被绑定 / kill。结果不明的留 unknown，不 kill
  let owned: string | null = null;
  let unknown: string | null = null;
  return [
    fileStep("prompt", io, p.promptPath, () => p.promptText, true),
    {
      name: "agent",
      run: async () => {
        if (io.agentExists(p.agent)) return `agent ${p.agent} 已存在（预检之后才出现，不是这次建的）`;
        // manager normalizeName 吃掉名字里第一个 agent- 片段：短名自带 agent-（AGL1 卡号）时传规范全名，它只去掉开头那层，落成的就是 p.agent
        const name = p.agentName.includes("agent-") ? p.agent : p.agentName;
        const r = await io.manager(["create", name, p.worktree, "--purpose", p.purpose, "--task", p.taskId, "--effort", "high", "--project", p.project], CREATE_TIMEOUT_MS);
        const got = typeof r?.agent === "string" ? r.agent : p.agent;
        if (r?.ok && got === p.agent) { owned = p.agent; return null; }
        // 回执名对不上（可能是 manager 复用的同名历史会话）或结果丢了却在 registry 里：归属不明，不绑也不 kill
        if (r?.ok || io.agentExists(got)) unknown = got;
        return r?.ok ? `manager create 回执的 agent ${got} 与预检规范名 ${p.agent} 不一致` : failed(r);
      },
      undo: async () => {
        if (owned && io.agentExists(owned)) return failed(await io.manager(["kill", owned]));
        return unknown ? `agent ${unknown} 归属不明（unknown），没 kill，等 PM 核对` : null;
      },
    },
    {
      name: "task-set",
      run: async () => failed(await ledger(io, p, "task-set", p.taskId, { rev: rev(io, p.taskId), agent: owned ?? p.agent }, "task-set")),
      landed: () => ours(io, p, "task-set"),
    },
  ];
}

/** 开 auto 与绑节点：本机卡、peer 卡都走，且总在最后（绑定撤不掉） */
function cardSteps(io: StepIO, p: StartPlan): Step[] {
  const { template, version } = p.workflow ?? { template: "code", version: LATEST_TEMPLATE_VERSION.code };
  return [
    {
      name: "workflow",
      run: async () => failed(await ledger(io, p, "workflow-set", p.taskId, {
        rev: rev(io, p.taskId), "workflow-rev": "0", template, version: String(version), mode: "auto", "author-family": "claude", fallback: FALLBACK,
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

/**
 * peer 卡（i28-W5）跳过复述：start_node 本身就是 PM 放行，先记一条写明放置理由的 decision，再以复述记录把卡推到 restate。
 * 排在开 auto 之后（workflow-set 只收 spec 卡）；两步之间调度器若推到这张卡，卡上的 extra.placement 让它只会等，不会派复述单
 * 或起本机 agent（scheduler-placement-plan.ts pinnedWork）。失败时 workflow / task-new 的 undo 把卡退成人工并取消。
 */
function restateStep(io: StepIO, p: StartPlan, peer: NonNullable<StartPlan["peer"]>): Step {
  const why = `start_node 放到 peer:${peer.name}（${peer.reason}）；复述环节跳过，start_node 即 PM 放行，开工单由放置结果派给它`;
  return {
    name: "restate",
    run: async () => failed(await ledger(io, p, "decision", p.taskId, {}, "placement", [peerRestateSkip(why).decision])) ??
      failed(await ledger(io, p, "stage", p.taskId, peerRestateSkip(why).stage, "restate")),
    landed: () => ours(io, p, "placement") && ours(io, p, "restate"),
  };
}

export async function runStart(io: StepIO, p: StartPlan): Promise<StartOutcome | QueuedStart> { return runLocalStart(io, p, async (io, p) => {
  const [workflow, bind] = cardSteps(io, p);
  const steps = p.peer ? [...taskSteps(io, p), workflow, restateStep(io, p, p.peer), bind]
    : [...taskSteps(io, p), worktreeStep(io, p), ...agentSteps(io, p), workflow, bind];
  const done: Step[] = [];
  const reconciled: StepName[] = [];
  for (const s of steps) {
    let err: string | null;
    try {
      requireLocalSharedLedgerPlanning(p.feature.id);
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
  const names = done.map((s) => s.name);
  if (p.peer) return { ok: true, taskId: p.taskId, placement: `peer:${p.peer.name}`, branch: p.branch, steps: names, reconciled };
  return { ok: true, taskId: p.taskId, agent: p.agent, branch: p.branch, worktree: p.worktree, prompt: p.promptPath, steps: names, reconciled };
  }, { ledgerPath: io.db().filename });
}

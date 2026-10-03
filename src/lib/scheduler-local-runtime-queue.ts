/** The bridge owns queued start callbacks so retries retain the original caller and all explicit opening parameters. */
import { currentLocalProjectDirs } from "./scheduler-local-runtime-projects.js";
import { dirname } from "node:path";
import { actorMayConfigure } from "./ledger-scheduler-settle.js";
import type { StartOutcome, StepIO } from "./dag-tools-steps.js";
import { preflightStart, type StartPlan } from "./dag-tools-start.js";
import { readSchedulerConfig } from "./scheduler-config.js";
import { readRegistryAgentsSync } from "./registry.js";
import { notifyProjectPm } from "./pm-notify.js";
import type { LocalStartOptions } from "./scheduler-local-runtime-start.js";
import type { SlotWait } from "./scheduler-local-runtime-slots.js";

export interface QueuedStart {
  ok: false; code: "queued"; queued: true; taskId: string; error: string;
  failedStep: "agent"; rolledBack: []; leftovers: [];
}
interface Pending {
  io: StepIO; plan: StartPlan; opts: LocalStartOptions;
  retry: (beforeStart?: () => Promise<void>) => Promise<StartOutcome | QueuedStart | SlotWait>; receipt: QueuedStart; queuedAt: number;
}
const pending = new Map<string, Pending>();
const entering = new Map<string, Promise<QueuedStart>>();
let timer: ReturnType<typeof setTimeout> | null = null;
let driving = false;
const keyOf = (io: StepIO, p: StartPlan) => `${io.db().filename}\0${p.feature.id}\0${p.key}`;

function schedule(): void {
  if (timer || !pending.size) return;
  timer = setTimeout(() => {
    timer = null;
    void retryQueuedLocalStarts().catch((e) => console.error(`[scheduler-local-runtime] 排队开卡重试失败：${(e as Error).message}`));
  }, 5000);
  timer.unref();
}

async function note(item: Pending, state: "queued" | "started" | "failed", detail = ""): Promise<void> {
  const p = item.plan, queued = new Date(item.queuedAt).toISOString();
  const text = `[Codex 排队 ${state}] 卡号 ${p.taskId}；节点 ${p.feature.id}/${p.key}；原调用 PM ${p.pm}；排队时间 ${queued}${detail ? `；${detail}` : ""}`;
  const r = await item.io.manager(["ledger", "note", "-", text, `--project=${p.project}`,
    `--dedup=local-codex-queue:${item.io.attempt}:${p.feature.id}:${p.key}:${state}`]);
  if (r?.ok !== true) throw new Error(`排队 ${state} 留痕失败：${String(r?.error ?? r?.code ?? "manager 没有返回结果")}`);
}

export async function queueLocalStart(io: StepIO, plan: StartPlan, opts: LocalStartOptions, reason: string,
  retry: Pending["retry"]): Promise<QueuedStart> {
  const key = keyOf(io, plan), existing = pending.get(key);
  if (existing) return existing.receipt;
  const inProgress = entering.get(key);
  if (inProgress) return inProgress;
  const create = async (): Promise<QueuedStart> => {
    const receipt: QueuedStart = { ok: false, code: "queued", queued: true, taskId: plan.taskId,
      error: `排队等槽：${reason}；空出槽后自动开工，无需再调用 start_node；bridge 重启会清空排队，届时重新 start_node`,
      failedStep: "agent", rolledBack: [], leftovers: [] };
    const item: Pending = { io, plan, opts, retry, receipt, queuedAt: Date.now() };
    await note(item, "queued");
    pending.set(key, item);
    schedule();
    return receipt;
  };
  const work = create();
  entering.set(key, work);
  try { return await work; } finally { entering.delete(key); }
}

/** Re-run all preflight gates: the DAG, PM authority, resource conflicts and service policy may change while waiting. */
async function stillReady({ io, plan: p, opts }: Pending): Promise<string | null> {
  if (opts.queuedReady) return opts.queuedReady(p);
  if (!actorMayConfigure(io.db(), p.pm, p.project)) return "原调用者已不再有项目开卡权限，排队取消";
  const config = readSchedulerConfig(opts.configPath);
  const result = await preflightStart({
    db: io.db(), caller: p.pm, ledgerDir: dirname(dirname(dirname(p.specPath))),
    worktreeRoot: dirname(p.worktree),
    projectDirs: (project) => currentLocalProjectDirs(project, opts.projectsPath), agentNames: () => readRegistryAgentsSync(opts.registryPath).map((r) => r.name), exists: io.exists,
    branchExists: async (repo, branch) => (await io.git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])).ok,
    autoReady: (project) => config.enabled && config.autoDispatch && config.projects[project] ? null : "调度服务已关闭，排队开卡取消",
    template: () => null,
  }, { featureId: p.feature.id, key: p.key, taskId: p.taskId, branch: p.branch, base: p.base, repo: p.repo, title: p.title,
    ...(p.item ? { item: p.item } : {}), ...(p.specText !== null ? { spec: p.specText } : {}), placement: "local", template: p.workflow?.template });
  if (!result.ok) return result.error;
  if ("already" in result) return "节点已经由别处开工，取消排队";
  return JSON.stringify(result.plan.fileGlobs) === JSON.stringify(p.fileGlobs) ? null : "节点文件范围已改变，原排队开卡取消";
}

async function notify(item: Pending, text: string): Promise<void> {
  try {
    if (item.opts.queuedNotice) await item.opts.queuedNotice(text);
    else await notifyProjectPm(item.io.db(), item.plan.project, text, { fromName: "scheduler" });
  } catch (e) { console.error(`[scheduler-local-runtime] 排队开卡结果通知失败：${(e as Error).message}`); }
}

async function failed(item: Pending, reason: string): Promise<void> {
  try { await note(item, "failed", reason); }
  catch (e) {
    // A revoked PM cannot write a project note; report the refusal and notify the current PM instead of bypassing that permission.
    console.error(`[scheduler-local-runtime] ${(e as Error).message}`);
  }
  await notify(item, `${item.plan.taskId} ${reason}`);
}

/** One retry pass; each callback takes the same global slot lock as authors and reviewers. */
export async function retryQueuedLocalStarts(): Promise<void> {
  if (driving) return;
  driving = true;
  try {
    for (const [key, item] of pending) {
      try {
        const blocked = await stillReady(item);
        if (blocked) { pending.delete(key); await failed(item, `排队开卡取消：${blocked}`); continue; }
        const result = await item.retry(() => note(item, "started"));
        if ("kind" in result) continue;
        pending.delete(key);
        if (result.ok) await notify(item, `${item.plan.taskId} 已获得 Codex 空槽并自动开工`);
        else await failed(item, `排队开卡失败：${result.error}`);
      } catch (e) {
        pending.delete(key);
        await failed(item, `排队开卡失败：${(e as Error).message}`);
      }
    }
  } finally { driving = false; schedule(); }
}

/** Explicit teardown for a closing bridge/test host; callbacks cannot outlive their caller's DB and manager connection. */
export function clearQueuedLocalStarts(): void {
  pending.clear();
  if (timer) clearTimeout(timer);
  timer = null;
}

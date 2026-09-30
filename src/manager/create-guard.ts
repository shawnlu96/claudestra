/**
 * create 的「creating」占位：动手前写进 registry，建频道 / 建窗口后立刻写回 channelId / windowId，
 * 成功时被正式条目整条覆盖。进程中途被杀，占位就是残留的全部线索——再跑同名 create / kill /
 * `manager repair --apply` 据它关窗口（只按记下的 id）、删频道、清 bridge 欠账，再把同名旧条目（prev）
 * 原样放回。频道没删成（bridge 不在）就不动占位：放回 prev 会让那个频道从此无人认领。
 */
import { assertSchedulerLease } from "../lib/scheduler-lease-env.js";
import { releaseNameForFreshAgent } from "../lib/agent-settings.js";
import { isPendingLive, newPending, type PendingOp } from "../lib/pending-ops.js";
import { channelFailureText } from "./ops-deps.js";
import type { AgentInfo, Registry } from "./core.js";
import type { OpsDeps } from "./ops-deps.js";
import { repointParentRefs } from "./team.js";

type CreatePending = Extract<PendingOp, { op: "create" }>;

function createPendingOf(a: AgentInfo | undefined): CreatePending | null {
  return a?.pending?.op === "create" ? a.pending : null;
}

/** 同一个标记（同一次 create 写的），而不只是「都是 create」——并发时别把别人刚写的占位当成自己要清的 */
function sameMarker(a: { pid: number; startedAt: string } | null, b: { pid: number; startedAt: string }): boolean {
  return !!a && a.pid === b.pid && a.startedAt === b.startedAt;
}

export interface ClearResult { ok: boolean; steps: string[]; error?: string }

export interface ClearOptions {
  /** 频道删不掉（bridge 不在 / Discord 没权限）时放弃这一步照样收尾，别让它永远挡住同名 create */
  force?: boolean;
  /** 放回的旧条目若是 active 就改成 stopped：kill 一个做到一半的 create 时，别让 launcher 把旧会话拉活 */
  restoreStopped?: boolean;
  /** 只清这一个标记（调用方判定时看到的那个）：两次读之间别的 create 接手了，就停手，别清到它头上 */
  expect: { pid: number; startedAt: string };
}

/** 关掉这次 create 建的窗口：记了 id 只关那一个；没记到 id（砍在建窗口与写回之间）时同名窗口只有裸 shell 才关 */
async function closeCreateWindow(name: string, p: CreatePending, deps: OpsDeps, steps: string[]): Promise<void> {
  const ids = await deps.windowIds(name);
  if (p.windowId) {
    if (ids.includes(p.windowId)) {
      await deps.killWindowId(p.windowId);
      steps.push("窗口已关");
    }
    return;
  }
  for (const id of ids) {
    if (await deps.windowIsBareShell(id)) {
      await deps.killWindowId(id);
      steps.push(`窗口 ${id}（没记到 id，只剩 shell）已关`);
    } else {
      steps.push(`同名窗口 ${id} 不是这次 create 记下的、里面还有进程，没关`);
    }
  }
}

/** 清掉一个 create 残留（不看持有者死活——调用方先判）。可重复调用：每一步都先看还在不在 */
export async function clearCreateResidue(name: string, deps: OpsDeps, opts: ClearOptions): Promise<ClearResult> {
  const p = createPendingOf((await deps.loadRegistry()).agents[name]);
  if (!p) return { ok: true, steps: [] };
  if (!sameMarker(p, opts.expect)) return { ok: false, steps: [], error: `${name} 的占位已换成另一次 create（pid ${p.pid}），没动` };
  const steps: string[] = [];
  await closeCreateWindow(name, p, deps, steps);
  if (p.channelId) {
    const r = await deps.deleteChannel(p.channelId);
    if (typeof r === "object" && !opts.force) return { ok: false, steps, error: `${channelFailureText(p.channelId, r)}；占位保留` };
    steps.push(typeof r === "object" ? `频道 ${p.channelId} 删不掉，按 --force 放弃（去 Discord 手动删）` : r === "gone" ? "频道早已不在" : "频道已删");
    await deps.agentCleanup(p.channelId, name);
  } else {
    steps.push(`没记到频道 id：名为 #${p.channelName} 的频道（若有）要人工核对`);
  }
  const reg = await deps.loadRegistry();
  if (!sameMarker(createPendingOf(reg.agents[name]), p)) {
    steps.push("占位已被别的进程接手，registry 没动");
  } else {
    const prev = p.prev as unknown as AgentInfo | undefined;
    if (prev) reg.agents[name] = opts.restoreStopped && prev.status === "active" ? { ...prev, status: "stopped" } : prev;
    else delete reg.agents[name];
    await deps.saveRegistry(reg);
    steps.push(p.prev ? "同名旧条目已恢复" : "占位已删");
  }
  return { ok: true, steps };
}

export type BeginResult = { ok: true; recovered?: ClearResult } | { ok: false; error: string };

/** 窗口 / 占位检查 + 写占位。create 残留（持有者已死或超时）先清再建；别的操作的残留拒绝，免得被 prev 带走后丢线索 */
export async function beginCreate(name: string, channelName: string, base: Partial<AgentInfo>, deps: OpsDeps, run: CreateRun = newCreateRun()): Promise<BeginResult> {
  const cur = (await deps.loadRegistry()).agents[name];
  let recovered: ClearResult | undefined;
  if (cur?.pending) {
    if (isPendingLive(cur.pending, deps.now(), deps.alive)) {
      return { ok: false, error: `${name} 正在 ${cur.pending.op}（pid ${cur.pending.pid}），等它结束再试` };
    }
    if (cur.pending.op !== "create") {
      return { ok: false, error: `${name} 有做到一半的 ${cur.pending.op}，先跑 manager repair --apply（或再跑一次那条命令）收尾` };
    }
    recovered = await clearCreateResidue(name, deps, { expect: cur.pending });
    if (!recovered.ok) return { ok: false, error: `上次 create 的残留清不掉：${recovered.error}` };
  }
  if ((await deps.listWindows()).includes(name)) return { ok: false, error: `${name} 已存在` };
  const reg = await deps.loadRegistry();
  const prev = reg.agents[name];
  // 两次读之间别人写了标记（写锁降级后的并发 create 等）：不能把它的占位当成 prev 收进来
  if (prev?.pending) return { ok: false, error: `${name} 另有一个 ${prev.pending.op} 同时在做，这边让开` };
  const mine = newPending("create", { channelName, ...(prev ? { prev: prev as unknown as Record<string, unknown> } : {}) }, deps.now());
  reg.agents[name] = { ...base, status: "creating", channelId: "", created: new Date(deps.now()).toISOString(), pending: mine } as AgentInfo;
  await deps.saveRegistry(reg);
  run.marker = mine;
  // 写锁 20 秒后会降级放行：两个同名 create 可能同时走到这里，后写的赢，先写的必须认输（它还什么都没建）
  if (!sameMarker(createPendingOf((await deps.loadRegistry()).agents[name]), mine)) {
    return { ok: false, error: `${name} 另有一个 create 同时在建，这边让开` };
  }
  return { ok: true, ...(recovered ? { recovered } : {}) };
}

/**
 * 一次 create 的在途状态（每次 create 一个，单测可自建）。signalled = 收到信号，不再开始提交；aborting = 信号清理
 * 已接手（主流程任何 tmux 动作都要停）；committed = 正式条目已落盘（信号到了也不清）。
 */
export interface CreateRun {
  marker?: CreatePending;
  signalled: boolean;
  aborting: boolean;
  committed: boolean;
  committing: Promise<void> | null;
}

export function newCreateRun(): CreateRun {
  return { signalled: false, aborting: false, committed: false, committing: null };
}

/** 占位还是本次 create 写的那个吗（被信号清理 / 别的进程接手后就不是了） */
function ownsPlaceholder(reg: Registry, name: string, run: CreateRun): boolean {
  return !!run.marker && sameMarker(createPendingOf(reg.agents[name]), run.marker);
}

export class CreateAborted extends Error {
  constructor() { super("create 已被信号打断，清理接手"); }
}

/** 把窗口操作包一层：清理接手后任何一步都抛 CreateAborted，不再往 tmux 发东西（tests/resumable-ops.test.ts） */
export function gateOps<T extends object>(ops: T, run: CreateRun): T {
  return new Proxy(ops, {
    get(target, key, recv) {
      const v = Reflect.get(target, key, recv);
      if (typeof v !== "function") return v;
      return (...args: unknown[]) => {
        if (run.aborting) throw new CreateAborted();
        assertSchedulerLease(); // 调度服务建的审查 session：父服务失租 / 已停后不再往窗口发任何键
        return (v as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

/** 建频道 / 建窗口后立刻调：之后任何一刻被杀，残留清理都知道删哪个频道、关哪个窗口 */
export async function recordCreate(name: string, patch: { channelId?: string; windowId?: string }, deps: OpsDeps, run: CreateRun): Promise<void> {
  // 信号清理已接手：把主流程冻在这里等它 process.exit，别再往下建窗口（清理按接手时的占位删，后建的它看不见）。
  // 刚建好还没来得及记下的窗口，清理看不到它的 id：这里按 id 自己关掉
  if (run.aborting) {
    if (patch.windowId) await deps.killWindowId(patch.windowId).catch((e) => console.error(`[create] 关中止时刚建的窗口失败: ${(e as Error).message}`));
    await new Promise<never>(() => {});
  }
  const reg = await deps.loadRegistry();
  const a = reg.agents[name];
  if (!ownsPlaceholder(reg, name, run) || !a) return;
  Object.assign(a.pending as CreatePending, patch);
  Object.assign(run.marker!, patch);
  if (patch.channelId) a.channelId = patch.channelId;
  await deps.saveRegistry(reg);
}

/** 正式条目覆盖占位。aborted = 已收到信号（清理负责输出）；lost = 占位被别的进程当残留清掉 / 接手了 */
export async function commitCreate(name: string, entry: AgentInfo, deps: OpsDeps, run: CreateRun): Promise<"ok" | "aborted" | "lost"> {
  if (run.signalled) return "aborted";
  let done!: () => void;
  run.committing = new Promise<void>((r) => (done = r));
  try {
    const reg = await deps.loadRegistry();
    if (!ownsPlaceholder(reg, name, run)) return "lost";
    if (createPendingOf(reg.agents[name])!.prev) repointParentRefs(reg, name); // kill 后同名重建：旧子 agent 不认新 agent 作父
    reg.agents[name] = entry;
    await deps.saveRegistry(reg);
    releaseNameForFreshAgent(name, reg.agents); // 全新 agent：registry 落盘后才清同名旧文件（早清的话 create 失败会丢掉停止的同名 agent 的档位）；rename 没补跑完的替它挪走
    run.committed = true;
    return "ok";
  } finally {
    done();
    run.committing = null;
  }
}

/**
 * create 失败（或占位被接手）时收尾：占位还是自己的 → 走残留清理（会放回 prev）；已不是自己的 → registry 不碰，
 * 只按本次自己记下的 id 关窗口（还得同名）、删频道——id 唯一，不会误伤接手方。
 */
export async function abandonCreate(name: string, own: { channelId?: string; windowId?: string }, deps: OpsDeps, run: CreateRun): Promise<ClearResult> {
  if (ownsPlaceholder(await deps.loadRegistry(), name, run)) return clearCreateResidue(name, deps, { expect: run.marker! });
  const steps = ["占位已被别的进程接手，registry 没动，只按本次的 id 收拾"];
  if (own.windowId && (await deps.windowIds(name)).includes(own.windowId)) {
    await deps.killWindowId(own.windowId);
    steps.push("本次的窗口已关");
  }
  if (own.channelId) {
    const r = await deps.deleteChannel(own.channelId);
    if (typeof r === "object") return { ok: false, steps, error: channelFailureText(own.channelId, r) };
    steps.push("本次的频道已删");
  }
  return { ok: true, steps };
}

/** 信号处理本体（guardCreateSignals 挂它；单测直接调，exit 换成假的） */
export async function abortCreate(sig: NodeJS.Signals, name: string, deps: OpsDeps, run: CreateRun, report: (msg: string) => void, exit: (code: number) => void): Promise<void> {
  if (run.signalled) return;
  run.signalled = true;
  if (run.committing) await run.committing;
  // 已落盘 / 占位已不是自己的：让主流程照常收尾（输出 ok 或走 lost 分支），这里什么都不做
  if (run.committed || !ownsPlaceholder(await deps.loadRegistry(), name, run)) return;
  run.aborting = true;
  const code = sig === "SIGINT" ? 130 : 143;
  setTimeout(() => exit(code), 10_000).unref();
  try {
    const r = await clearCreateResidue(name, deps, { expect: run.marker! });
    report(r.ok ? `create 被 ${sig} 打断，已清理：${r.steps.join("；")}` : `create 被 ${sig} 打断，${r.error}`);
  } catch (e) {
    report(`create 被 ${sig} 打断，清理出错：${(e as Error).message}——跑 manager repair 补`);
  }
  exit(code);
}

/** create 在途时挂上 SIGINT / SIGTERM / SIGHUP；kill -9 拦不住，靠再跑 / repair。返回解除函数，create 结束时调用 */
export function guardCreateSignals(name: string, deps: OpsDeps, run: CreateRun, report: (msg: string) => void): () => void {
  const handler = (sig: NodeJS.Signals) => void abortCreate(sig, name, deps, run, report, (c) => process.exit(c));
  const sigs: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const s of sigs) process.on(s, handler);
  return () => { for (const s of sigs) process.off(s, handler); };
}

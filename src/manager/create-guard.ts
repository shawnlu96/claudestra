/**
 * create 的「creating」占位：动手前写进 registry，建频道 / 建窗口后立刻写回 channelId / windowId，
 * 成功时被正式条目整条覆盖。进程中途被杀，占位就是残留的全部线索——再跑同名 create / kill /
 * `manager repair --apply` 据它关窗口（只按记下的 id）、删频道、清 bridge 欠账，再把同名旧条目（prev）
 * 原样放回。频道没删成（bridge 不在）就不动占位：放回 prev 会让那个频道从此无人认领。
 */
import { isPendingLive, newPending, type PendingOp } from "../lib/pending-ops.js";
import type { AgentInfo, Registry } from "./core.js";
import type { OpsDeps } from "./ops-deps.js";
import { repointParentRefs } from "./team.js";

type CreatePending = Extract<PendingOp, { op: "create" }>;

function createPendingOf(a: AgentInfo | undefined): CreatePending | null {
  return a?.pending?.op === "create" ? a.pending : null;
}

/** 同一个标记（同一次 create 写的），而不只是「都是 create」——并发时别把别人刚写的占位当成自己要清的 */
function sameMarker(a: CreatePending | null, b: CreatePending): boolean {
  return !!a && a.pid === b.pid && a.startedAt === b.startedAt;
}

export interface ClearResult { ok: boolean; steps: string[]; error?: string }

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
export async function clearCreateResidue(name: string, deps: OpsDeps): Promise<ClearResult> {
  const p = createPendingOf((await deps.loadRegistry()).agents[name]);
  if (!p) return { ok: true, steps: [] };
  const steps: string[] = [];
  await closeCreateWindow(name, p, deps, steps);
  if (p.channelId) {
    const r = await deps.deleteChannel(p.channelId);
    if (typeof r === "object") return { ok: false, steps, error: `删频道 ${p.channelId} 失败（${r.error}），占位保留，bridge 恢复后再跑` };
    steps.push(r === "gone" ? "频道早已不在" : "频道已删");
    await deps.agentCleanup(p.channelId, name);
  } else {
    steps.push(`没记到频道 id：名为 #${p.channelName} 的频道（若有）要人工核对`);
  }
  const reg = await deps.loadRegistry();
  if (!sameMarker(createPendingOf(reg.agents[name]), p)) {
    steps.push("占位已被别的进程接手，registry 没动");
  } else {
    if (p.prev) reg.agents[name] = p.prev as unknown as AgentInfo;
    else delete reg.agents[name];
    await deps.saveRegistry(reg);
    steps.push(p.prev ? "同名旧条目已恢复" : "占位已删");
  }
  return { ok: true, steps };
}

export type BeginResult = { ok: true; recovered?: ClearResult } | { ok: false; error: string };

/** 窗口 / 占位检查 + 写占位。create 残留（持有者已死或超时）先清再建；别的操作的残留拒绝，免得被 prev 带走后丢线索 */
export async function beginCreate(name: string, channelName: string, base: Partial<AgentInfo>, deps: OpsDeps): Promise<BeginResult> {
  const cur = (await deps.loadRegistry()).agents[name];
  let recovered: ClearResult | undefined;
  if (cur?.pending) {
    if (isPendingLive(cur.pending, deps.now(), deps.alive)) {
      return { ok: false, error: `${name} 正在 ${cur.pending.op}（pid ${cur.pending.pid}），等它结束再试` };
    }
    if (cur.pending.op !== "create") {
      return { ok: false, error: `${name} 有做到一半的 ${cur.pending.op}，先跑 manager repair --apply（或再跑一次那条命令）收尾` };
    }
    recovered = await clearCreateResidue(name, deps);
    if (!recovered.ok) return { ok: false, error: `上次 create 的残留清不掉：${recovered.error}` };
  }
  if ((await deps.listWindows()).includes(name)) return { ok: false, error: `${name} 已存在` };
  const reg = await deps.loadRegistry();
  const prev = reg.agents[name];
  const mine = newPending("create", { channelName, ...(prev ? { prev: prev as unknown as Record<string, unknown> } : {}) }, deps.now());
  reg.agents[name] = { ...base, status: "creating", channelId: "", created: new Date(deps.now()).toISOString(), pending: mine } as AgentInfo;
  await deps.saveRegistry(reg);
  // 写锁 20 秒后会降级放行：两个同名 create 可能同时走到这里，后写的赢，先写的必须认输（它还什么都没建）
  if (!sameMarker(createPendingOf((await deps.loadRegistry()).agents[name]), mine)) {
    return { ok: false, error: `${name} 另有一个 create 同时在建，这边让开` };
  }
  return { ok: true, ...(recovered ? { recovered } : {}) };
}

/** 占位还是本进程的吗（被信号清理 / 别的进程接手后就不是了） */
function ownsPlaceholder(reg: Registry, name: string): boolean {
  const p = createPendingOf(reg.agents[name]);
  return !!p && p.pid === process.pid;
}

let aborting = false;
let committing: Promise<void> | null = null;

/** 信号清理已接手：create 主流程别再输出 / 清理（输出只能有一行） */
export function createAborting(): boolean {
  return aborting;
}

/** 建频道 / 建窗口后立刻调：之后任何一刻被杀，残留清理都知道删哪个频道、关哪个窗口 */
export async function recordCreate(name: string, patch: { channelId?: string; windowId?: string }, deps: OpsDeps): Promise<void> {
  if (aborting) return;
  const reg = await deps.loadRegistry();
  const a = reg.agents[name];
  if (!ownsPlaceholder(reg, name) || !a) return;
  Object.assign(a.pending as CreatePending, patch);
  if (patch.channelId) a.channelId = patch.channelId;
  await deps.saveRegistry(reg);
}

/** 正式条目覆盖占位。aborted = 信号清理已接手（它负责输出）；lost = 占位被别的进程当残留清掉 / 接手了 */
export async function commitCreate(name: string, entry: AgentInfo, deps: OpsDeps): Promise<"ok" | "aborted" | "lost"> {
  if (aborting) return "aborted";
  let done!: () => void;
  committing = new Promise<void>((r) => (done = r));
  try {
    const reg = await deps.loadRegistry();
    if (aborting) return "aborted";
    if (!ownsPlaceholder(reg, name)) return "lost";
    if (createPendingOf(reg.agents[name])!.prev) repointParentRefs(reg, name); // kill 后同名重建：旧子 agent 不认新 agent 作父
    reg.agents[name] = entry;
    await deps.saveRegistry(reg);
    return "ok";
  } finally {
    done();
    committing = null;
  }
}

/**
 * create 在途时收到 SIGINT / SIGTERM / SIGHUP：跑同一套残留清理（最多 10 秒）再退出。正在 commit 就等它写完——
 * 写完了说明 create 已成功，不再清理。kill -9 拦不住，靠再跑 / repair。返回解除函数，create 结束时调用。
 */
export function guardCreateSignals(name: string, deps: OpsDeps, report: (msg: string) => void): () => void {
  const handler = async (sig: NodeJS.Signals) => {
    if (aborting) return;
    aborting = true;
    const code = sig === "SIGINT" ? 130 : 143;
    setTimeout(() => process.exit(code), 10_000).unref();
    try {
      if (committing) await committing;
      if (!ownsPlaceholder(await deps.loadRegistry(), name)) {
        report(`create 被 ${sig} 打断时已经落盘完成，没有清理（${name} 已创建）`);
      } else {
        const r = await clearCreateResidue(name, deps);
        report(r.ok ? `create 被 ${sig} 打断，已清理：${r.steps.join("；")}` : `create 被 ${sig} 打断，${r.error}`);
      }
    } catch (e) {
      report(`create 被 ${sig} 打断，清理出错：${(e as Error).message}——跑 manager repair 补`);
    }
    process.exit(code);
  };
  const sigs: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const s of sigs) process.on(s, handler);
  return () => { for (const s of sigs) process.off(s, handler); };
}

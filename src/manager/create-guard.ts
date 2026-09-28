/**
 * create 的「creating」占位：动手前写进 registry，建频道后立刻写回 channelId，成功时被正式条目整条覆盖。
 * 进程中途被杀，占位就是残留的全部线索——再跑同名 create / kill / `manager repair --apply` 据它清掉
 * 频道、窗口、bridge 欠账，再把同名旧条目（prev）原样放回。频道没删成（bridge 不在）就不动占位：
 * 放回 prev 会让那个频道从此无人认领。
 */
import { isPendingLive, newPending, type PendingOp } from "../lib/pending-ops.js";
import type { AgentInfo, Registry } from "./core.js";
import type { OpsDeps } from "./ops-deps.js";
import { repointParentRefs } from "./team.js";

type CreatePending = Extract<PendingOp, { op: "create" }>;

function createPendingOf(a: AgentInfo | undefined): CreatePending | null {
  return a?.pending?.op === "create" ? a.pending : null;
}

export interface ClearResult { ok: boolean; steps: string[]; error?: string }

/** 清掉一个 create 残留（不看持有者死活——调用方先判）。可重复调用：每一步都先看还在不在 */
export async function clearCreateResidue(name: string, deps: OpsDeps): Promise<ClearResult> {
  const p = createPendingOf((await deps.loadRegistry()).agents[name]);
  if (!p) return { ok: true, steps: [] };
  const steps: string[] = [];
  if ((await deps.listWindows()).includes(name)) {
    await deps.killWindow(name);
    steps.push("窗口已关");
  }
  if (p.channelId) {
    const r = await deps.deleteChannel(p.channelId);
    if (typeof r === "object") return { ok: false, steps, error: `删频道 ${p.channelId} 失败（${r.error}），占位保留，bridge 恢复后再跑` };
    steps.push(r === "gone" ? "频道早已不在" : "频道已删");
    await deps.agentCleanup(p.channelId, name);
  } else {
    steps.push(`没记到频道 id：名为 #${p.channelName} 的频道（若有）要人工核对`);
  }
  const reg = await deps.loadRegistry();
  if (createPendingOf(reg.agents[name])) {
    if (p.prev) reg.agents[name] = p.prev as unknown as AgentInfo;
    else delete reg.agents[name];
    await deps.saveRegistry(reg);
    steps.push(p.prev ? "同名旧条目已恢复" : "占位已删");
  }
  return { ok: true, steps };
}

export type BeginResult = { ok: true; recovered?: ClearResult } | { ok: false; error: string };

/** 窗口 / 占位检查 + 写占位。残留占位（持有者已死或超时）先清再建 */
export async function beginCreate(name: string, channelName: string, base: Partial<AgentInfo>, deps: OpsDeps): Promise<BeginResult> {
  const cur = (await deps.loadRegistry()).agents[name];
  let recovered: ClearResult | undefined;
  if (cur?.pending) {
    if (isPendingLive(cur.pending, deps.now(), deps.alive)) {
      return { ok: false, error: `${name} 正在 ${cur.pending.op}（pid ${cur.pending.pid}），等它结束再试` };
    }
    if (cur.pending.op === "create") {
      recovered = await clearCreateResidue(name, deps);
      if (!recovered.ok) return { ok: false, error: `上次 create 的残留清不掉：${recovered.error}` };
    }
  }
  if ((await deps.listWindows()).includes(name)) return { ok: false, error: `${name} 已存在` };
  const reg = await deps.loadRegistry();
  const prev = reg.agents[name];
  reg.agents[name] = {
    ...base,
    status: "creating",
    channelId: "",
    created: new Date(deps.now()).toISOString(),
    pending: newPending("create", { channelName, ...(prev ? { prev: prev as unknown as Record<string, unknown> } : {}) }, deps.now()),
  } as AgentInfo;
  await deps.saveRegistry(reg);
  return { ok: true, ...(recovered ? { recovered } : {}) };
}

/** 占位还是本进程的吗（被信号清理 / 别的进程接管后就不是了） */
function ownsPlaceholder(reg: Registry, name: string): boolean {
  const p = createPendingOf(reg.agents[name]);
  return !!p && p.pid === process.pid;
}

/** 建频道后立刻调：之后任何一刻被杀，残留清理都知道删哪个频道 */
export async function recordCreateChannel(name: string, channelId: string, deps: OpsDeps): Promise<void> {
  const reg = await deps.loadRegistry();
  const a = reg.agents[name];
  if (!ownsPlaceholder(reg, name) || !a) return;
  (a.pending as CreatePending).channelId = channelId;
  a.channelId = channelId;
  await deps.saveRegistry(reg);
}

/** 正式条目覆盖占位。返回 false = 占位已不属于本进程（信号清理抢先），调用方按失败处理 */
export async function commitCreate(name: string, entry: AgentInfo, deps: OpsDeps): Promise<boolean> {
  if (aborting) return false;
  const reg = await deps.loadRegistry();
  if (!ownsPlaceholder(reg, name)) return false;
  if (createPendingOf(reg.agents[name])!.prev) repointParentRefs(reg, name); // kill 后同名重建：旧子 agent 不认新 agent 作父
  reg.agents[name] = entry;
  await deps.saveRegistry(reg);
  return true;
}

let aborting = false;

/**
 * create 在途时收到 SIGINT / SIGTERM / SIGHUP：跑同一套残留清理（最多 10 秒）再退出。
 * kill -9 拦不住，靠再跑 / repair。返回解除函数，create 结束（成功或自己清理完）时调用。
 */
export function guardCreateSignals(name: string, deps: OpsDeps, report: (msg: string) => void): () => void {
  const handler = (sig: NodeJS.Signals) => {
    if (aborting) return;
    aborting = true;
    const code = sig === "SIGINT" ? 130 : 143;
    setTimeout(() => process.exit(code), 10_000).unref();
    clearCreateResidue(name, deps)
      .then((r) => report(r.ok ? `create 被 ${sig} 打断，已清理：${r.steps.join("；")}` : `create 被 ${sig} 打断，${r.error}`))
      .catch((e) => report(`create 被 ${sig} 打断，清理出错：${(e as Error).message}——跑 manager repair 补`))
      .finally(() => process.exit(code));
  };
  const sigs: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const s of sigs) process.on(s, handler);
  return () => { for (const s of sigs) process.off(s, handler); };
}

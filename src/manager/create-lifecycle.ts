/**
 * `manager create --card <taskId> [--card-role author|reviewer|other]`: register a card worker at create time (LIFE1,
 * lib/agent-lifecycle-store.ts) and tag it kind=worker (lib/worker-kind.ts setWorkerKind), so the lifecycle can collect it
 * when its card finishes. The registration is the one label every reader uses; names decide nothing. An executor (--role executor)
 * without --card is refused before anything is created; ordinary user agents are unaffected. tests/agent-lifecycle-create.test.ts.
 * Only the session this create started is registered: the create's own result must say ok with this agent and a session id the
 * registry now holds and did not hold before. A registration that fails undoes the create (manager remove), so no window is left
 * that nothing would ever collect; the caller gets ok:false either way. The undo only removes the session this create started: when
 * the registry no longer holds it under that name (replaced since, or never was) or holds a protected agent, nothing is removed.
 */
import { isWorkerRole, checkCard, registerWorker, type WorkerRole } from "../lib/agent-lifecycle-store.js";
import { LEDGER_PATH, openLedger } from "../lib/ledger-store.js";
import { SCHEDULER_LEASE_ENV } from "../lib/scheduler-lease-env.js";
import { setWorkerKind } from "../lib/worker-kind.js";
import { extractStringFlag, loadRegistry, normalizeName, output, type Registry, saveRegistry } from "./core.js";

export interface CardFlags { taskId: string; role: WorkerRole }

export function extractCardFlags(args: string[]): { rest: string[]; card?: CardFlags; error?: string } {
  const { rest: a, value: taskId } = extractStringFlag(args, "--card");
  const { rest, value: role } = extractStringFlag(a, "--card-role");
  if (taskId === undefined) return role === undefined ? { rest } : { rest, error: "--card-role 要和 --card <卡号> 一起给" };
  if (!/^[\w.-]{1,80}$/.test(taskId)) return { rest, error: `--card 要写台账卡号（收到 ${JSON.stringify(taskId)}）` };
  const r = role ?? "other";
  if (!isWorkerRole(r)) return { rest, error: `--card-role 只能是 author / reviewer / other（收到 ${r}）` };
  return { rest, card: { taskId, role: r } };
}

/** null = may create. `role` is the --role team flag (an executor is a card worker too). */
export function cardGate(name: string, card: CardFlags | undefined, role: string | undefined, ledgerPath = LEDGER_PATH): string | null {
  const key = normalizeName(name);
  if (!card) {
    if (role !== "executor") return null;
    return `${key} 是给卡建的执行者（--role executor），要带 --card <卡号> --card-role author|reviewer|other（卡结束时按它收回）`;
  }
  try { return checkCard(openLedger(ledgerPath), card.taskId); }
  catch (e) { return `台账打不开，登记不了 --card：${(e as Error).message}`; }
}

export interface RegisterDeps {
  ledgerPath: string;
  loadRegistry(): Promise<Registry>;
  saveRegistry(reg: Registry): Promise<void>;
  /** undo a create whose registration failed (production: manager remove) */
  remove(agent: string): Promise<Record<string, unknown>>;
  createdBy(): Promise<string>;
}

async function createdBy(): Promise<string> {
  if (process.env[SCHEDULER_LEASE_ENV]) return "scheduler";
  const channel = process.env.DISCORD_CHANNEL_ID;
  const caller = channel ? Object.entries((await loadRegistry()).agents).find(([, a]) => a.channelId === channel)?.[0] : undefined;
  return caller ?? "cli";
}

const realDeps: RegisterDeps = {
  ledgerPath: LEDGER_PATH, loadRegistry, saveRegistry, createdBy,
  remove: async (agent) => {
    const { runRemove } = await import("./agent-kill.js"), { realOpsDeps } = await import("./ops-deps.js");
    return runRemove(agent, realOpsDeps);
  },
};

/** The registry holds this create's session under `key` (not pending): the only state a registration or an undo may act on. */
const holdsSession = (reg: Registry, key: string, sessionId: string): boolean => {
  const info = reg.agents[key];
  return !!info && !info.pending && info.sessionId === sessionId;
};

/**
 * kind=worker in the registry, then the ledger row; null = registered. `undo` says whether the failure may be undone by removing
 * the agent: never when the name no longer runs this session (a replacement is someone else's) or is a protected agent.
 */
async function register(key: string, sessionId: string, card: CardFlags, deps: RegisterDeps): Promise<{ why: string; undo: boolean } | null> {
  try {
    const reg = await deps.loadRegistry();
    if (!holdsSession(reg, key, sessionId)) return { why: `registry 里 ${key} 现在不是本次建的会话 ${sessionId}（已被替换或没落地），没登记也没动它`, undo: false };
    const info = reg.agents[key];
    if (!setWorkerKind(reg.agents, key, "worker") || info.kind !== "worker") return { why: `${key} 是受保护的 agent（master / PM / kind=main），不能登记成卡 worker`, undo: false };
    await deps.saveRegistry(reg);
    registerWorker(openLedger(deps.ledgerPath), { agent: key, sessionId, taskId: card.taskId, role: card.role, createdBy: await deps.createdBy() });
    return null;
  } catch (e) {
    return { why: (e as Error).message, undo: true };
  }
}

/** Removes the agent only while the registry still holds the session this create started; otherwise says why it was left. */
async function undoCreate(key: string, sessionId: string, deps: RegisterDeps): Promise<{ ok: boolean; error?: string }> {
  try {
    if (!holdsSession(await deps.loadRegistry(), key, sessionId)) return { ok: false, error: `registry 里 ${key} 已不是本次建的会话 ${sessionId}，不删` };
    const r = await deps.remove(key);
    return r.ok === true ? { ok: true } : { ok: false, error: String(r.error) };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/**
 * After the create ran: `result` is its one output object. Registers only when it reports this agent created with a new session;
 * anything else is passed back as it was (a failed create never touches the agent that already had the name).
 */
export async function registerCreated(name: string, card: CardFlags, result: Record<string, unknown> | null, before: string | null,
  deps: RegisterDeps = realDeps): Promise<Record<string, unknown>> {
  const key = normalizeName(name);
  if (!result) return { ok: false, error: `${key} 的 create 没有输出结果，没登记` };
  if (result.ok !== true) return result;
  const sessionId = typeof result.sessionId === "string" ? result.sessionId : "";
  if (result.agent !== key || !sessionId || sessionId === before) {
    return { ...result, ok: false, error: `create 报成功，但没拿到 ${key} 本次新建的会话 id，没登记也没动它；请核对后 manager remove 或重建` };
  }
  const failed = await register(key, sessionId, card, deps);
  if (!failed) return { ...result, card: { taskId: card.taskId, role: card.role, registered: true } };
  if (!failed.undo) return { ok: false, agent: key, sessionId, rolledBack: false, error: `${key} 卡 worker 没登记：${failed.why}；没撤回（不是本次建的会话或受保护），请核对` };
  const undo = await undoCreate(key, sessionId, deps);
  return { ok: false, agent: key, sessionId, rolledBack: undo.ok,
    error: `${key} 建好了但卡 worker 登记失败：${failed.why}；${undo.ok ? "已撤回本次创建（manager remove），可重试 create" : `撤回没做成（${undo.error}），请核对后手动 manager remove ${key}`}` };
}

/** Runs `create` with stdout's result line held back, so the caller gets one object: the create's, or the registration's verdict. */
async function captureResult(create: () => Promise<void>): Promise<Record<string, unknown> | null> {
  const log = console.log;
  let result: Record<string, unknown> | null = null;
  console.log = (...args: unknown[]) => {
    if (args.length === 1 && typeof args[0] === "string") {
      try {
        const v = JSON.parse(args[0]) as unknown;
        if (v && typeof v === "object" && !Array.isArray(v) && "ok" in v) { result = v as Record<string, unknown>; return; }
      } catch { /* not a result line: printed as is below */ }
    }
    log(...args);
  };
  try { await create(); } finally { console.log = log; }
  return result;
}

/** manager.ts create: gate, create, register. */
export async function withCardRegistration(name: string, card: CardFlags | undefined, role: string | undefined, create: () => Promise<void>): Promise<void> {
  const refused = cardGate(name, card, role);
  if (refused) return output({ ok: false, error: refused });
  if (!card) return create();
  const before = (await loadRegistry()).agents[normalizeName(name)]?.sessionId ?? null;
  output(await registerCreated(name, card, await captureResult(create), before));
}

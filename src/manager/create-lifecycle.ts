/**
 * `manager create --card <taskId> [--card-role author|reviewer|other]`: register a card worker at create time (LIFE1,
 * lib/agent-lifecycle-store.ts) and tag it kind=worker (lib/worker-kind.ts setWorkerKind), so the lifecycle can collect it
 * when its card finishes. The registration is the one label every reader uses; names decide nothing. An executor (--role executor)
 * without --card is refused before anything is created; ordinary user agents are unaffected. tests/manager-create-lifecycle.test.ts.
 */
import { isWorkerRole, checkCard, registerWorker, type WorkerRole } from "../lib/agent-lifecycle-store.js";
import { LEDGER_PATH, openLedger } from "../lib/ledger-store.js";
import { SCHEDULER_LEASE_ENV } from "../lib/scheduler-lease-env.js";
import { setWorkerKind } from "../lib/worker-kind.js";
import { extractStringFlag, loadRegistry, normalizeName, output, saveRegistry } from "./core.js";

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

async function createdBy(): Promise<string> {
  if (process.env[SCHEDULER_LEASE_ENV]) return "scheduler";
  const channel = process.env.DISCORD_CHANNEL_ID;
  const caller = channel ? Object.entries((await loadRegistry()).agents).find(([, a]) => a.channelId === channel)?.[0] : undefined;
  return caller ?? "cli";
}

/** After a successful create: ledger row + kind=worker. A failure here is logged, the created agent stays (stock backfill finds it). */
export async function registerCreated(name: string, card: CardFlags, ledgerPath = LEDGER_PATH): Promise<void> {
  const key = normalizeName(name);
  const reg = await loadRegistry();
  const info = reg.agents[key];
  if (!info || info.pending) return; // create failed or is unfinished: nothing to register
  try {
    registerWorker(openLedger(ledgerPath), { agent: key, sessionId: info.sessionId ?? "", taskId: card.taskId, role: card.role, createdBy: await createdBy() });
    if (setWorkerKind(reg.agents, key, "worker") && info.kind === "worker") await saveRegistry(reg);
  } catch (e) {
    console.error(`⚠️ ${key} 已建好，但生命周期登记失败（卡结束时靠存量兜底收）：${(e as Error).message}`);
  }
}

/** manager.ts create: gate, create, register. */
export async function withCardRegistration(name: string, card: CardFlags | undefined, role: string | undefined, create: () => Promise<void>): Promise<void> {
  const refused = cardGate(name, card, role);
  if (refused) return output({ ok: false, error: refused });
  await create();
  if (card) await registerCreated(name, card);
}

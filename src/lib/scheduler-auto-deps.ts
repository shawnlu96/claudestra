/**
 * Production wiring of the auto tick: ledger writes through the scheduler-identity CLI, adapters chosen from the
 * registry, the author taken from the card (PM names it; the engine never invents an executor), and the per-card
 * cross-family reviewer created through `manager create` in the author's working directory. Anything the engine
 * cannot prove (no session id yet, create timed out) is "unknown" and stops for PM rather than being created twice.
 */
import type { Database } from "bun:sqlite";
import { bridgeSend } from "./bridge-client.js";
import { resolveBunPath } from "./bun-path.js";
import type { AuthorFamily } from "./ledger-scheduler.js";
import type { LedgerTask } from "./ledger-stages.js";
import { getMeta } from "./ledger-store.js";
import { readRegistryAgentsSync, type RegistryAgent } from "./registry.js";
import { SRC_DIR } from "./repo-root.js";
import { runManagerProcess } from "./run-manager.js";
import { boundRef, type AutoTickDeps } from "./scheduler-auto-tick.js";
import { acpPort, messagePort, type RegistryRow } from "./scheduler-auto-ports.js";
import type { SessionRole } from "./scheduler-sessions.js";
import { ledgerResult } from "./scheduler-work-order.js";
import { createAcpWorker } from "./worker-acp.js";
import { createChannelWorker, createTmuxFallbackWorker } from "./worker-message.js";
import type { AdapterDeps } from "./worker-ports.js";
import { selectWorkerRoute, type EnsureResult, type SessionRef, type WorkerSession } from "./worker-session.js";

type Manager = (...args: string[]) => Promise<Record<string, unknown>>;

const run = (env: Record<string, string | undefined>, timeoutMs: number): Manager => (...args) =>
  runManagerProcess(args, { bunPath: resolveBunPath(), managerPath: `${SRC_DIR}/manager.ts`, env: { ...process.env, DISCORD_CHANNEL_ID: "", ...env }, timeoutMs });

const schedulerLedger: Manager = run({ CLAUDESTRA_SCHEDULER_SERVICE: "1" }, 120_000);
const plainManager: Manager = run({}, 180_000);

const familyOf = (a: RegistryAgent): AuthorFamily | null =>
  a.runtime === "codex" ? "codex" : a.runtime === undefined || a.runtime === "claude-code" ? "claude" : null;
export const reviewerName = (taskId: string): string => `agent-rv-${taskId.toLowerCase()}`;

function refOf(task: LedgerTask, role: SessionRole, row: RegistryAgent, family: AuthorFamily): EnsureResult {
  if (familyOf(row) !== family) return { kind: "manual", reason: `${row.name} 的 runtime（${row.runtime ?? "claude-code"}）不是要求的 ${family} 家族` };
  if (!row.sessionId) return { kind: "unknown", reason: `${row.name} 还没有 session id` };
  const ref: SessionRef = { taskId: task.id, role, agent: row.name, sessionId: row.sessionId, family, transport: row.transport === "acp" ? "acp" : "tmux" };
  return { kind: "ready", ref, created: false };
}

async function createReviewer(db: Database, registryRow: RegistryRow, task: LedgerTask, family: AuthorFamily): Promise<EnsureResult> {
  const author = boundRef(db, task.id, "author");
  const dir = author && registryRow(author.agent)?.cwd;
  if (!dir) return { kind: "manual", reason: "找不到执行者的工作目录，建不了审查 session" };
  const name = reviewerName(task.id);
  const runtime = family === "codex" ? ["--runtime", "codex", "--transport", "acp"] : [];
  const r = await plainManager("create", name, dir, "--purpose", `${task.id} 跨模型对抗式审查（调度引擎建）`, "--project", task.project,
    "--task", `${task.id} 审查`, ...runtime);
  if (r.ok !== true) return { kind: "unknown", reason: `建 ${name} 失败或结果不明：${String(r.error ?? "")}`.slice(0, 400) };
  for (let i = 0; i < 30; i++) {
    const row = registryRow(name);
    if (row?.sessionId) {
      const got = refOf(task, "reviewer", row, family);
      return got.kind === "ready" ? { ...got, created: true } : got;
    }
    await Bun.sleep(3000);
  }
  return { kind: "unknown", reason: `${name} 已建，90 秒内没等到 session id` };
}

async function ensure(db: Database, registryRow: RegistryRow, task: LedgerTask, role: SessionRole, family: AuthorFamily): Promise<EnsureResult> {
  if (role === "author") {
    if (!task.agent) return { kind: "manual", reason: "自动卡要先由 PM 指定执行者（task.agent）并建好它的 session" };
    const row = registryRow(task.agent);
    return row ? refOf(task, role, row, family) : { kind: "manual", reason: `执行者 ${task.agent} 不在本机 registry` };
  }
  const existing = registryRow(reviewerName(task.id));
  return existing ? refOf(task, role, existing, family) : createReviewer(db, registryRow, task, family);
}

function worker(db: Database, registryRow: RegistryRow, ref: SessionRef): WorkerSession | { manual: string } {
  const row = registryRow(ref.agent);
  if (!row) return { manual: `${ref.agent} 不在本机 registry` };
  if (row.sessionId !== ref.sessionId) return { manual: `${ref.agent} 的当前 session 已不是台账绑定的那个` };
  const route = selectWorkerRoute({ agent: row.name, runtime: row.runtime, transport: row.transport, acpPending: row.acpPending });
  if (route.kind === "manual") return { manual: route.reason };
  const deps: AdapterDeps = {
    sessions: {
      bound: (taskId, role) => boundRef(db, taskId, role),
      create: async () => ({ ok: false, unknown: false, reason: "建 session 走调度器的 ensure" }),
      archive: async () => ({ ok: false, unknown: false, reason: "本段不自动归档 session" }),
    },
    ledger: { result: (r, probe) => ledgerResult(db, r, probe) },
  };
  if (route.route === "acp") return createAcpWorker({ ...deps, port: acpPort(db, registryRow) });
  const port = messagePort(registryRow);
  if (route.route === "tmux") return createTmuxFallbackWorker({ ...deps, port, reason: route.fallbackReason ?? "tmux 兼容回退" });
  return createChannelWorker({ ...deps, port });
}

async function notifyPm(db: Database, task: LedgerTask, text: string): Promise<void> {
  const meta = getMeta(db, task.project);
  const pm = meta.pms.find((p) => p !== meta.team?.dispatcher) ?? "master";
  const r = await bridgeSend({ type: "route_to_agent", targetName: pm, text, fromName: "scheduler", oneShot: true }, { timeoutMs: 30_000 });
  if (!r.ok) throw new Error(`发给 ${pm} 失败：${r.error}`);
}

/** registryPath is for tests; production reads the canonical registry fresh on every lookup. */
export function autoTickDeps(db: Database, registryPath?: string): AutoTickDeps {
  const registryRow: RegistryRow = (agent) => readRegistryAgentsSync(registryPath).find((a) => a.name === agent);
  return {
    manager: schedulerLedger,
    worker: (ref) => worker(db, registryRow, ref),
    ensure: (task, role, family) => ensure(db, registryRow, task, role, family),
    notifyPm: (task, text) => notifyPm(db, task, text),
    now: () => Date.now(),
  };
}

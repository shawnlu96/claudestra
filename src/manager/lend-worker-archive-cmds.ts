/**
 * Manager-owned B-terminal registry retirement: facts from agent-lifecycle-lend.ts, execution through LIFE1's one collect
 * (runLendTerminal: canonical archive → runRemove's archive-only branch). This file adds the B-side backup / plan / CAS around it;
 * no worker or process is stopped and nothing on disk is moved or deleted here.
 */
import { Database } from "bun:sqlite";
import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { getMeta, getOrder, guardJournalWrites, LEND_JOURNAL_PATH, setMeta, type LendRow } from "../lib/lend-journal.js";
import { archiveHash, workerArchiveIdentity, workerArchiveKey, workerArchiveProblem, type WorkerArchiveIdentity } from "../lib/lend-worker-registry-archive.js";
import { archivePlainPath, archiveReceiptHolds, prepareWorkerArchiveBackup, readWorkerArchiveBackup, writeArchiveReceipt } from "../lib/lend-worker-registry-archive-files.js";
import { archiveAgentSession, ARCHIVE_ROOT, type ArchiveResult } from "../lib/session-archive.js";
import { output, REGISTRY_PATH, saveRegistry, type AgentInfo, type Registry } from "./core.js";
import { acquireLock } from "../lib/file-lock.js";
import { statePath } from "../lib/paths.js";
import { assertSchedulerLease, leasedRun } from "../lib/scheduler-lease-env.js";
import { probeAcpWorker, type WorkerLiveness } from "../lib/worker-liveness.js";
import { readActivity, type ActivityRecord } from "../lib/agent-supervisor-activity.js";
import { cardWorkerIndex, type CardWorker } from "../lib/agent-lifecycle-store.js";
import { lendTerminalAction, probePid, type LendTerminalVerdict, type PidProbe } from "../lib/agent-lifecycle-lend.js";
import { runLendTerminal } from "../lib/agent-lifecycle-run.js";
import { runRemove, type ArchiveOnlyRemove } from "./agent-kill.js";
import { realOpsDeps, type OpsDeps } from "./ops-deps.js";
import { machineUuid, ownerVerdict, readOwnerMarker } from "../lib/owner-guard.js";
import { hostname } from "node:os";
import { LedgerReader } from "../lib/ledger-read.js";
import { getAsk, hasAsksTable } from "../lib/ledger-asks.js";
import { checkWorkerArchiveApproval, workerArchiveBind } from "../lib/lend-worker-registry-archive-auth.js";
import { resolveActor } from "./ledger-identity.js";

/** No "history already kept" flag here: only the backup's archive receipt (writeArchiveReceipt) proves a completed terminal archive. */
interface Plan { identity: WorkerArchiveIdentity; backup: string; record: AgentInfo; done: boolean; historical: boolean }
export interface WorkerArchiveDeps {
  db: Database;
  registryPath: string;
  archiveRoot: string;
  backupRoot: string;
  receiptsPath: string;
  /** worker-liveness probe: only no_window may proceed, and it alone never proves the exit */
  window(name: string): Promise<WorkerLiveness>;
  /** tmux windows for runRemove's archive-only branch (throws when unreadable) */
  listWindows(): Promise<string[]>;
  /** canonical acp-activity record and its hostPid probe: the exit proof */
  activity(name: string): ActivityRecord | null;
  probe(pid: number): PidProbe;
  /** cardWorkerIndex link of a same-name local card worker; throws when the ledger cannot be read */
  card(name: string): CardWorker | undefined;
  archive(name: string, info: AgentInfo): Promise<ArchiveResult>;
  /** The sole registry writer must compare expected bytes and run check synchronously before rename. */
  save(reg: Registry, expected: string, check: () => void): Promise<void>;
  check(): void;
  authorizeHistorical?(): void;
}

function readRegistry(path: string): { raw: string; reg: Registry } {
  archivePlainPath(path);
  const raw = readFileSync(path, "utf8");
  const reg = JSON.parse(raw) as Registry;
  if (!reg || !reg.agents || Array.isArray(reg.agents) || typeof reg.agents !== "object" || typeof reg.socket !== "string") throw new Error("registry 格式损坏");
  return { raw, reg };
}

function receiptsFor(row: LendRow, path: string): string {
  archivePlainPath(path);
  const raw = readFileSync(path, "utf8");
  const rows = raw.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  if (!rows.some((r) => r.orderId === row.orderId && r.sessionId === row.sessionId && r.agent === row.agent && r.outcome === row.state
    && JSON.stringify(r.ackSig) === JSON.stringify(row.receipt))) throw new Error("本地收据未保全 / 关联不匹配");
  return raw;
}

const planKey = (id: WorkerArchiveIdentity) => `workerRegistryArchive:${workerArchiveKey(id)}`;

function loadPlan(d: WorkerArchiveDeps, id: WorkerArchiveIdentity): Plan | null {
  const raw = getMeta(d.db, planKey(id));
  if (!raw) return null;
  const plan = JSON.parse(raw) as Plan;
  if (JSON.stringify(plan.identity) !== JSON.stringify(id)) throw new Error("持久归档计划身份已变");
  const backup = readWorkerArchiveBackup(plan.backup);
  const original = JSON.parse(readFileSync(join(plan.backup, "registry-before.json"), "utf8")) as Registry;
  const savedRow = JSON.parse(readFileSync(join(plan.backup, "order.json"), "utf8")) as LendRow;
  const current = getOrder(d.db, id.orderId);
  const resultEvidence = (row: LendRow | null) => JSON.stringify([row?.state, row?.payload, row?.payloadSha, row?.work, row?.receipt]);
  if (JSON.stringify(backup.identity) !== JSON.stringify(id)
    || resolve(plan.backup) !== resolve(d.backupRoot, workerArchiveKey(id), backup.registryHash)
    || JSON.stringify(original.agents[id.agent]) !== JSON.stringify(plan.record)) throw new Error("持久归档计划备份不匹配");
  if (resultEvidence(savedRow) !== resultEvidence(current)) throw new Error("备份后订单结果 / 产物已变（可恢复）");
  return plan;
}

function verifyHistory(d: WorkerArchiveDeps, id: WorkerArchiveIdentity): void {
  const path = join(d.archiveRoot, id.agent, `${id.sessionId}.jsonl`);
  archivePlainPath(path);
  const lines = readFileSync(path, "utf8").split("\n").filter((line) => line.trim());
  if (!lines.length) throw new Error("会话历史未保全");
  for (const line of lines) {
    const item = JSON.parse(line);
    if (!item || typeof item !== "object") throw new Error("会话历史格式损坏");
    const session = item.type === "session_meta" ? item.payload?.id : item.sessionId;
    if (session && session !== id.sessionId) throw new Error("会话历史身份不匹配");
  }
}

/** Metadata only. Caller must supply an exact list; there is no name-prefix bulk selection. */
export function previewWorkerRegistryArchive(ids: WorkerArchiveIdentity[], d: WorkerArchiveDeps) {
  const { raw, reg } = readRegistry(d.registryPath);
  const entries = ids.map((id) => ({ ...id, reason: reg.agents[id.agent]
    ? workerArchiveProblem(id, getOrder(d.db, id.orderId), reg.agents[id.agent]) : "registry 无原记录" }));
  return { entries, registryHash: archiveHash(raw), listHash: archiveHash(JSON.stringify(entries)), backupTarget: d.backupRoot };
}

/** This plan's own canonical archive finished (receipt still byte-identical); a pre-existing copy alone is never trusted. */
const historyKept = (d: WorkerArchiveDeps, id: WorkerArchiveIdentity, plan: Plan | null) =>
  !!plan && archiveReceiptHolds(plan.backup, id, join(d.archiveRoot, id.agent));

/** The synchronous B facts (journal row, registry record, card link, exit proof) against a window observation already made. */
function factsVerdict(d: WorkerArchiveDeps, id: WorkerArchiveIdentity, info: AgentInfo | undefined, kept: boolean, window: WorkerLiveness): LendTerminalVerdict {
  const activity = d.activity(id.agent);
  return lendTerminalAction({ id, row: getOrder(d.db, id.orderId), record: info, card: d.card(id.agent), window,
    activity, probe: activity && Number.isInteger(activity.hostPid) && activity.hostPid > 1 ? d.probe(activity.hostPid) : null, historyKept: kept });
}

/** Re-reads every B fact including the window and asks agent-lifecycle-lend.ts. */
async function terminalVerdict(d: WorkerArchiveDeps, id: WorkerArchiveIdentity, info: AgentInfo | undefined, kept: boolean): Promise<LendTerminalVerdict> {
  const window = await d.window(id.agent);
  return factsVerdict(d, id, info, kept, window);
}

/** Future settle hook only: a settled historical row needs the separate owner-authorized entry. */
export async function archiveWorkerRegistry(id: WorkerArchiveIdentity, d: WorkerArchiveDeps): Promise<{ archived: boolean; reason?: string; blocked?: true }> {
  d.check();
  const row = getOrder(d.db, id.orderId);
  const snapshot = readRegistry(d.registryPath);
  let plan = loadPlan(d, id);
  const info = snapshot.reg.agents[id.agent];
  if (plan && info && JSON.stringify(info) !== JSON.stringify(plan.record)) throw new Error("备份后 registry 目标记录已变（可恢复）");
  const verdict = await terminalVerdict(d, id, info ?? plan?.record, historyKept(d, id, plan));
  if ("refuse" in verdict) return { archived: false, reason: verdict.refuse, ...(verdict.blocked ? { blocked: true as const } : {}) };
  if ((!row!.settle && !plan) || plan?.historical) {
    if (!d.authorizeHistorical) return { archived: false, reason: "历史记录仅允许 dry-run；执行须 B owner 精确授权" };
    d.authorizeHistorical();
  }
  const receipts = receiptsFor(row!, d.receiptsPath);
  if (!info) {
    if (!plan) return { archived: false, reason: "registry 无原记录" };
    if (!historyKept(d, id, plan)) throw new Error("registry 记录已不在但本计划的终态归档收据缺失 / 已变（可恢复）");
    verifyHistory(d, id);
    d.check();
    if (JSON.stringify(getOrder(d.db, id.orderId)) !== JSON.stringify(row) || readRegistry(d.registryPath).raw !== snapshot.raw) {
      throw new Error("恢复归档期间身份已变（可恢复）");
    }
    return { archived: true };
  }
  if (!plan) {
    const backup = prepareWorkerArchiveBackup(d.backupRoot, id, snapshot.raw, join(d.archiveRoot, id.agent), { journal: JSON.stringify(row), receipts });
    plan = { identity: id, backup, record: info, done: false, historical: !row!.settle };
    d.check();
    setMeta(d.db, planKey(id), JSON.stringify(plan));
  }
  return executePlan(id, row!, snapshot, plan, d);
}

/** Only what runRemove's archive-only branch may call; every stop / channel / disk step throws instead of running. */
export function archiveOnlyOps(registryPath: string, listWindows: () => Promise<string[]>): OpsDeps {
  const no = async (): Promise<never> => { throw new Error("archive-only 退役不 kill / 删频道 / 清理"); };
  return { loadRegistry: async () => readRegistry(registryPath).reg, saveRegistry: no, listWindows, windowIds: no, killWindow: no, killWindowId: no,
    renameWindow: no, restartInProgress: realOpsDeps.restartInProgress, windowIsBareShell: no, deleteChannel: no, renameChannel: no, listChannels: no,
    agentCleanup: no, archive: no, rescan: no, renameLedger: no, now: Date.now, alive: realOpsDeps.alive };
}

async function executePlan(id: WorkerArchiveIdentity, row: LendRow, snapshot: { raw: string; reg: Registry }, plan: Plan,
  d: WorkerArchiveDeps): Promise<{ archived: boolean }> {
  d.db.exec("BEGIN IMMEDIATE");
  try {
    let window = await d.window(id.agent);
    // Also the synchronous publish check (saveRegistry runs it right before rename): card link / ownership and exit proof are re-read
    // there, not only before the last await, so a card link that appears in that window keeps the record.
    const check = () => {
      d.check();
      if (plan.historical) d.authorizeHistorical!();
      if (JSON.stringify(getOrder(d.db, id.orderId)) !== JSON.stringify(row)) throw new Error("归档期间 journal 已变（可恢复）");
      if (readRegistry(d.registryPath).raw !== snapshot.raw) throw new Error("归档期间 registry 已变（可恢复）");
      const facts = factsVerdict(d, id, snapshot.reg.agents[id.agent], false, window);
      if ("refuse" in facts) throw new Error(`B 终态 / 归属事实已变（可恢复）：${facts.refuse}`);
    };
    check();
    const verdict = factsVerdict(d, id, snapshot.reg.agents[id.agent], historyKept(d, id, plan), window);
    if ("refuse" in verdict) throw new Error(`B 终态事实已变（可恢复）：${verdict.refuse}`);
    const guard: ArchiveOnlyRemove = {
      sessionId: id.sessionId,
      verify: (info) => {
        check();
        const problem = workerArchiveProblem(id, getOrder(d.db, id.orderId), info);
        if (problem) throw new Error(problem);
        readWorkerArchiveBackup(plan.backup);
      },
      save: (reg) => d.save(reg, snapshot.raw, check),
    };
    const out = await runLendTerminal(verdict.action, {
      now: Date.now,
      agents: async () => Object.entries(readRegistry(d.registryPath).reg.agents).filter(([name]) => name === id.agent)
        .map(([name, a]) => ({ name, status: a.status, sessionId: a.sessionId, cwd: a.cwd, pending: !!a.pending, window: false })),
      // Only this plan's receipted canonical archive lets collect skip the archive (verdict.action.archiveOnly.historyKept).
      manager: async (cmd, name) => {
        if (name !== id.agent) return { ok: false, error: `archive-only 只处理 ${id.agent}` };
        if (cmd === "archive") {
          const result = await d.archive(name, snapshot.reg.agents[name]);
          if (result.ok) { verifyHistory(d, id); writeArchiveReceipt(plan.backup, id, join(d.archiveRoot, id.agent)); }
          return { ...result };
        }
        if (cmd !== "remove") return { ok: false, error: `archive-only 不支持 ${cmd}` };
        check();
        if (!historyKept(d, id, plan)) return { ok: false, error: "本计划的终态归档收据缺失 / 已变，不退役" };
        verifyHistory(d, id);
        window = await d.window(id.agent);
        const again = factsVerdict(d, id, snapshot.reg.agents[id.agent], true, window);
        if ("refuse" in again) return { ok: false, error: `归档期间 B 终态事实已变：${again.refuse}` };
        return runRemove(name, archiveOnlyOps(d.registryPath, d.listWindows), { archiveOnly: guard });
      },
      record: async () => { setMeta(d.db, planKey(id), JSON.stringify({ ...plan, done: true })); },
    });
    if ("error" in out) throw new Error(`${out.error}（可恢复）`);
    d.db.exec("COMMIT");
    return { archived: true };
  } catch (e) {
    d.db.exec("ROLLBACK");
    throw e; // Prepared bundle persists; a retry also recognizes a committed registry removal after a crash.
  }
}

/** Restore just the original record; unrelated current registry changes and canonical history are preserved. */
export async function rollbackWorkerRegistryArchive(backupDir: string, d: WorkerArchiveDeps): Promise<void> {
  const backup = readWorkerArchiveBackup(backupDir);
  const original = JSON.parse(readFileSync(join(backupDir, "registry-before.json"), "utf8")) as Registry;
  const { raw, reg } = readRegistry(d.registryPath);
  const id = backup.identity;
  const savedId = workerArchiveIdentity(JSON.parse(readFileSync(join(backupDir, "order.json"), "utf8")));
  if (!original.agents[id.agent] || !savedId || workerArchiveKey(savedId) !== workerArchiveKey(id)) {
    throw new Error("回滚身份不匹配");
  }
  if (reg.agents[id.agent]) throw new Error("回滚目标已有记录，保留当前会话");
  if ((await d.window(id.agent)) !== "no_window") throw new Error("回滚目标存活 / 未知，保留当前记录");
  const check = () => {
    d.check();
    const problem = workerArchiveProblem(id, getOrder(d.db, id.orderId), original.agents[id.agent]);
    if (problem) throw new Error(`回滚身份已变：${problem}`);
  };
  check();
  reg.agents[id.agent] = original.agents[id.agent];
  await d.save(reg, raw, check);
}

/** The existing advisory manager lock is acquired here with mandatory ownership; no lock means no writes. */
export async function withWorkerArchiveLock<T>(run: (check: () => void) => Promise<T>,
  path = statePath(".manager-write.lock"), waitMs = 20_000): Promise<T> {
  assertSchedulerLease();
  const lock = await acquireLock(path, waitMs);
  if (!lock) throw new Error("归档写锁超时，保留原记录（可恢复）");
  const check = () => {
    assertSchedulerLease();
    if (!lock.held()) throw new Error("归档写锁已失，保留原记录（可恢复）");
  };
  try { check(); return await run(check); } finally { lock.release(); }
}

/**
 * cardWorkerIndex link through the bridge's LedgerReader. Its get() also returns null for an unreadable path (EACCES etc.), so null
 * counts as "no card" only when the ledger file is positively absent (ENOENT); any other miss throws and the record is kept.
 */
export function ledgerCardWorker(reader: LedgerReader, name: string): CardWorker | undefined {
  const db = reader.get();
  if (db) return cardWorkerIndex(db).get(name);
  try { statSync(reader.path); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`台账读不到（${(e as NodeJS.ErrnoException).code ?? (e as Error).message}），不当作没有本机卡（可恢复）`);
  }
  throw new Error("台账存在但还不可读（建表中 / 未就绪），不当作没有本机卡（可恢复）");
}

function productionArchiveDeps(db: Database, check: () => void, ledger: LedgerReader): WorkerArchiveDeps {
  return {
    db, check, registryPath: REGISTRY_PATH, archiveRoot: ARCHIVE_ROOT,
    backupRoot: statePath("backups", "lend-worker-registry"), receiptsPath: statePath("lend", "receipts.jsonl"),
    window: (name) => probeAcpWorker(name), listWindows: () => realOpsDeps.listWindows(),
    activity: (name) => readActivity(name), probe: (pid) => probePid(pid),
    card: (name) => ledgerCardWorker(ledger, name),
    archive: (name, info) => archiveAgentSession(name, info),
    save: (reg, expected, verify) => saveRegistry(reg, { expected, check: verify }),
  };
}

function parsedIdentity(raw: string | undefined): WorkerArchiveIdentity {
  const value = raw && JSON.parse(raw);
  const identity = value && workerArchiveIdentity(value);
  if (!identity || Object.keys(value).sort().join() !== ["agent", "leaseGen", "orderId", "sessionId"].join()) {
    throw new Error("必须提供精确 {orderId,agent,sessionId,leaseGen}，不接受名称前缀");
  }
  return identity;
}

function assertArchiveOwner(): void {
  const verdict = ownerVerdict(readOwnerMarker(), { uuid: machineUuid(), host: hostname() }, process.env.CLAUDESTRA_TAKEOVER === "1");
  if (!verdict.ok) throw new Error("本机不是 B owner 主机，拒绝归档");
}

/** Re-read the existing local ask on every publication check; peer/PM answers never count as owner approval. */
function historicalGate(id: WorkerArchiveIdentity, askId: string, d: WorkerArchiveDeps, reader: LedgerReader): () => void {
  const preview = previewWorkerRegistryArchive([id], d);
  const params = workerArchiveBind({ listHash: preview.listHash, registryHash: preview.registryHash, backupTarget: preview.backupTarget }).params;
  const agents = readRegistry(d.registryPath).reg.agents;
  const plan = loadPlan(d, id);
  // A completed removal has a different preview. Recovery verifies the original approved bundle, without another write.
  if (plan?.historical && !agents[id.agent]) {
    params.registryHash = readWorkerArchiveBackup(plan.backup).registryHash;
    params.listHash = archiveHash(JSON.stringify([{ ...id, reason: workerArchiveProblem(id, getOrder(d.db, id.orderId), plan.record) }]));
  }
  const actor = resolveActor({ channelId: process.env.DISCORD_CHANNEL_ID, controlChannelId: process.env.CONTROL_CHANNEL_ID }, agents);
  if (!actor.ok) throw new Error(actor.error);
  return () => {
    const ledger = reader.get();
    const ask = ledger && hasAsksTable(ledger) ? getAsk(ledger, askId) : null;
    checkWorkerArchiveApproval(ask, actor.actor, params);
  };
}

/** Only the archive-workflows leaf calls this entry; the no-argument workflow backfill remains unchanged. */
export async function cmdLendWorkerArchive(args: string[]): Promise<void> {
  let db: Database | undefined;
  const reader = new LedgerReader();
  try {
    if (args.length === 1) args = ["dry-run", ...args];
    const [op = "dry-run", raw, flag, askId] = args;
    if (!["dry-run", "settle", "apply"].includes(op) || (op === "apply" ? flag !== "--ask" || !askId || args.length !== 4 : args.length !== 2)) {
      throw new Error("usage: archive-workflows --lend-worker dry-run|settle <identity-json> | apply <identity-json> --ask <local-owner-ask>");
    }
    const id = parsedIdentity(raw);
    if (op === "settle" && !leasedRun()) throw new Error("自动归档必须经现有调度租约，历史记录请 dry-run");
    if (op === "dry-run") {
      db = new Database(LEND_JOURNAL_PATH, { readonly: true });
      const { entries, ...params } = previewWorkerRegistryArchive([id], productionArchiveDeps(db, assertSchedulerLease, reader));
      return output({ ok: true, dryRun: true, entries, ...params, bind: workerArchiveBind(params) });
    }
    await withWorkerArchiveLock(async (lockCheck) => {
      const check = () => { lockCheck(); assertArchiveOwner(); };
      check();
      if (op === "settle") {
        const who = resolveActor({ channelId: process.env.DISCORD_CHANNEL_ID, controlChannelId: process.env.CONTROL_CHANNEL_ID }, readRegistry(REGISTRY_PATH).reg.agents);
        if (!who.ok || who.actor !== "owner") throw new Error("自动归档只接受现有 plainManager 调度闭包，worker / agent 不能代调");
      }
      db = new Database(LEND_JOURNAL_PATH, { readwrite: true, create: false });
      db.exec("PRAGMA busy_timeout = 5000");
      guardJournalWrites(db, check);
      const d = productionArchiveDeps(db, check, reader);
      if (op === "apply") {
        d.authorizeHistorical = historicalGate(id, askId!, d, reader);
        d.authorizeHistorical();
      }
      const result = await archiveWorkerRegistry(id, d);
      output({ ok: result.archived, ...result, recoverable: !result.archived });
    });
  } catch (e) {
    output({ ok: false, recoverable: true, error: (e as Error).message });
  } finally { db?.close(); reader.close(); }
}

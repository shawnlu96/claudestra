/** Read-only B worker plans. Retirement belongs to LIFE1; no alternate registry writer is permitted here. */
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getOrder, LEND_JOURNAL_PATH } from "../lib/lend-journal.js";
import { archiveHash, workerArchiveFactsProblem, workerArchiveIdentity, workerArchiveKey, workerArchiveProblem,
  type WorkerArchiveFacts, type WorkerArchiveIdentity } from "../lib/lend-worker-registry-archive.js";
import { archivePlainPath, readWorkerArchiveBackup } from "../lib/lend-worker-registry-archive-files.js";
import { workerArchiveBind } from "../lib/lend-worker-registry-archive-auth.js";
import { ARCHIVE_ROOT } from "../lib/session-archive.js";
import { statePath } from "../lib/paths.js";
import { output, REGISTRY_PATH, type Registry } from "./core.js";

export const WORKER_ARCHIVE_CAPABILITY = "blocked-capability";
const MISSING_PORT = "LIFE1 尚无 B order/session/gen 终态、保全/CAS、只退 registry 禁删目录入口";
export interface WorkerArchivePlanDeps { db: Database; registryPath: string; backupRoot: string; archiveRoot: string }
export interface WorkerArchivePlan { identity: WorkerArchiveIdentity; registryHash: string; orderHash: string; backupTarget: string }

function readRegistry(path: string): { raw: string; reg: Registry } {
  archivePlainPath(path);
  const raw = readFileSync(path, "utf8");
  const reg = JSON.parse(raw) as Registry;
  if (!reg || !reg.agents || Array.isArray(reg.agents) || typeof reg.agents !== "object" || typeof reg.socket !== "string") throw new Error("registry 格式损坏");
  return { raw, reg };
}

/** Structural eligibility is metadata, not authenticated retirement authority; the LIFE1 port must supply the remaining facts. */
export function previewWorkerRegistryArchive(ids: WorkerArchiveIdentity[], d: WorkerArchivePlanDeps) {
  const { raw, reg } = readRegistry(d.registryPath);
  const entries = ids.map((id) => ({ ...id, reason: reg.agents[id.agent]
    ? workerArchiveProblem(id, getOrder(d.db, id.orderId), reg.agents[id.agent]) : "registry 无原记录" }));
  return { entries, registryHash: archiveHash(raw), listHash: archiveHash(JSON.stringify(entries)), backupTarget: d.backupRoot,
    capability: WORKER_ARCHIVE_CAPABILITY, required: MISSING_PORT };
}

/** Records only a snapshot for isolated verification. It does not prepare files, alter the journal or grant execution authority. */
export function planWorkerRegistryArchive(id: WorkerArchiveIdentity, d: WorkerArchivePlanDeps): WorkerArchivePlan {
  const { raw, reg } = readRegistry(d.registryPath);
  const row = getOrder(d.db, id.orderId);
  const problem = workerArchiveProblem(id, row, reg.agents[id.agent] ?? {});
  if (problem) throw new Error(problem);
  return { identity: { ...id }, registryHash: archiveHash(raw), orderHash: archiveHash(JSON.stringify(row)), backupTarget: d.backupRoot };
}

function verifyHistory(path: string, id: WorkerArchiveIdentity): void {
  archivePlainPath(path);
  const lines = readFileSync(path, "utf8").split("\n").filter((line) => line.trim());
  if (!lines.length) throw new Error("会话历史未保全");
  for (const line of lines) {
    const item = JSON.parse(line);
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("会话历史格式损坏");
    const session = item.type === "session_meta" ? item.payload?.id : item.sessionId;
    if (session && session !== id.sessionId) throw new Error("会话历史身份不匹配");
  }
}

/** Isolated read-only verification, including stale-plan rejection. A successful check still cannot retire a worker. */
export function verifyWorkerRegistryArchivePlan(plan: WorkerArchivePlan, d: WorkerArchivePlanDeps, facts: WorkerArchiveFacts,
  backupDir: string): { verified: true; capability: string } {
  const { raw, reg } = readRegistry(d.registryPath);
  const row = getOrder(d.db, plan.identity.orderId);
  if (archiveHash(raw) !== plan.registryHash || archiveHash(JSON.stringify(row)) !== plan.orderHash) throw new Error("计划后 registry / journal 已变（可恢复）");
  const problem = workerArchiveFactsProblem(plan.identity, row, reg.agents[plan.identity.agent] ?? {}, facts);
  if (problem) throw new Error(problem);
  if (resolve(plan.backupTarget) !== resolve(d.backupRoot)) throw new Error("备份目标已变");
  const backup = readWorkerArchiveBackup(backupDir);
  if (workerArchiveKey(backup.identity) !== workerArchiveKey(plan.identity) || backup.registryHash !== plan.registryHash
    || resolve(backupDir) !== resolve(d.backupRoot, workerArchiveKey(plan.identity), plan.registryHash)) throw new Error("备份身份不匹配");
  if (readFileSync(join(backupDir, "order.json"), "utf8") !== JSON.stringify(row)) throw new Error("备份订单事实已变");
  const receipts = readFileSync(join(backupDir, "receipts.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  if (!receipts.some((r) => r.orderId === row!.orderId && r.sessionId === row!.sessionId && r.agent === row!.agent
    && r.outcome === row!.state && JSON.stringify(r.ackSig) === JSON.stringify(row!.receipt))) throw new Error("收据保全关联不匹配");
  verifyHistory(join(d.archiveRoot, plan.identity.agent, `${plan.identity.sessionId}.jsonl`), plan.identity);
  return { verified: true, capability: WORKER_ARCHIVE_CAPABILITY };
}

function parsedIdentity(raw: string | undefined): WorkerArchiveIdentity {
  const value = raw && JSON.parse(raw);
  const identity = value && workerArchiveIdentity(value);
  if (!identity || Object.keys(value).sort().join() !== ["agent", "leaseGen", "orderId", "sessionId"].join()) {
    throw new Error("必须提供精确 {orderId,agent,sessionId,leaseGen}，不接受名称前缀");
  }
  return identity;
}

/** The existing workflow leaf keeps its default behavior; this optional entry never attempts a production retirement. */
export async function cmdLendWorkerArchive(args: string[]): Promise<void> {
  let db: Database | undefined;
  try {
    if (args.length === 1) args = ["dry-run", ...args];
    const [op = "dry-run", raw, flag, askId] = args;
    if (!["dry-run", "settle", "apply"].includes(op) || (op === "apply" ? flag !== "--ask" || !askId || args.length !== 4 : args.length !== 2)) {
      throw new Error("usage: archive-workflows --lend-worker dry-run|settle <identity-json> | apply <identity-json> --ask <local-owner-ask>");
    }
    const id = parsedIdentity(raw);
    // Neither scheduler leases nor owner approval can supply the missing LIFE1 implementation.
    if (op !== "dry-run") return output({ ok: false, recoverable: true, code: WORKER_ARCHIVE_CAPABILITY, error: MISSING_PORT });
    archivePlainPath(LEND_JOURNAL_PATH);
    db = new Database(LEND_JOURNAL_PATH, { readonly: true });
    const preview = previewWorkerRegistryArchive([id], { db, registryPath: REGISTRY_PATH, archiveRoot: ARCHIVE_ROOT,
      backupRoot: statePath("backups", "lend-worker-registry") });
    output({ ok: true, dryRun: true, ...preview, bind: workerArchiveBind({ listHash: preview.listHash, registryHash: preview.registryHash, backupTarget: preview.backupTarget }) });
  } catch (e) {
    output({ ok: false, recoverable: true, error: (e as Error).message });
  } finally { db?.close(); }
}

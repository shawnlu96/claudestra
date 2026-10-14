/** Durable, exclusive batches keep every byte outside both checkouts; incomplete batches always need inspection. */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { acquireLock } from "./file-lock.js";
import { statePath } from "./paths.js";
import { recordObserved, recoveryPolicy, type RecoveryMode } from "./recovery-policy.js";
import { writeTextAtomicSync } from "./state-file.js";
import { retryWorktreeDirty, retryWorktreeDirtySync } from "./scheduler-create-retry-worktree.js";
import type { Git } from "./scheduler-review-worktree.js";
import { CONV_BUILD_PATHS, buildArtifactOwner, convBuildCandidates, convBuildCandidatesSync, noLinkedAncestors, readBuildArtifact,
  type ArtifactProof, type BuildArtifact, type ConvArtifactContext } from "./conv-ignored-build-artifacts.js";

type Result = Awaited<ReturnType<Git>>;
type Overrides = Pick<ConvArtifactContext, "repository" | "quarantineRoot" | "policy">;
export function convArtifactContext(db: Database, task: { id: string; project: string; branch?: string | null; headSHA?: string | null }, intentId: string, now: number,
  gate: () => string | null, overrides: Overrides = {}): ConvArtifactContext {
  return { ...overrides, taskId: task.id, project: task.project, intentId, gate,
    expected: task.branch !== undefined && task.headSHA !== undefined ? { branch: task.branch, head: task.headSHA } : undefined,
    // The shared ledger formatter supplies its own conditional prefix; keep it once in the stored observation.
    observe: (a) => { recordObserved(db, { ...a, action: a.action.replace(/^本会/, "") }, now); } };
}
const key = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 24);
const within = (root: string, path: string) => { const r = relative(resolve(root), resolve(path)); return r === "" || (r !== ".." && !r.startsWith("../") && !isAbsolute(r)); };
export const convArtifactIsolationPath = (c: ConvArtifactContext) => join(c.quarantineRoot ?? statePath("quarantine", "conv-build-artifacts"), key(c.taskId), key(c.intentId));

/** Validate existing ancestors even when the new private isolation path has not been created yet. */
function safeLocation(path: string, worktree: string, repo: string): void {
  noLinkedAncestors(path, true);
  if (within(realpathSync(worktree), path) || within(realpathSync(repo), path)) throw new Error("隔离目录必须在仓库根与目标 worktree 根之外");
}

/** Missing final receipts are a crash signal, not permission to finish by guessing what moved. */
function priorBatchRefusal(path: string, context: ConvArtifactContext): string | null {
  if (!existsSync(path)) return null;
  noLinkedAncestors(path);
  for (const name of readdirSync(path).filter((n) => n.startsWith("batch-"))) {
    const dir = join(path, name);
    noLinkedAncestors(dir);
    if (!lstatSync(dir).isDirectory()) return "隔离批次类型错误，保留等待核对";
    noLinkedAncestors(join(dir, "receipt.json"));
    const receipt = JSON.parse(readFileSync(join(dir, "receipt.json"), "utf8"));
    if (receipt.version !== 1 || receipt.taskId !== context.taskId || receipt.intentId !== context.intentId
      || !Array.isArray(receipt.candidates) || !Array.isArray(receipt.moved)) return "隔离回执身份或结构错误，保留等待核对";
    if (receipt.status !== "complete") return `隔离批次未完成（${name}），保留产物与回执等待核对`;
    if (receipt.candidates.length !== receipt.moved.length) return "隔离回执搬移项不完整，保留等待核对";
    for (const artifact of receipt.candidates) {
      const item = CONV_BUILD_PATHS.find((p) => p.path === artifact.path);
      if (!item || !receipt.moved.includes(item.path)
        || readBuildArtifact(join(dir, "artifacts"), item.path, item.directory)?.digest !== artifact.digest) return "隔离内容与回执不符，保留等待核对";
    }
  }
  return null;
}

interface Receipt { version: 1; taskId: string; intentId: string; worktree: string; status: "prepared" | "complete" | "failed";
  candidates: BuildArtifact[]; moved: string[]; error?: string }
export interface QuarantineIO { beforeMove?(path: string, dest: string): void; rename?(from: string, to: string): void }

/** Caller has proved the entire checkout and permission; every leaf identity and permission is checked again before moving. */
export function moveArtifactBatch(worktree: string, path: string, candidates: BuildArtifact[], context: ConvArtifactContext, io: QuarantineIO = {}): string {
  const batch = mkdtempSync(join(path, "batch-")), receiptPath = join(batch, "receipt.json");
  const receipt: Receipt = { version: 1, taskId: context.taskId, intentId: context.intentId, worktree, status: "prepared", candidates, moved: [] };
  const save = () => writeTextAtomicSync(receiptPath, JSON.stringify(receipt, null, 2));
  save();
  try {
    for (const artifact of candidates) {
      const dest = join(batch, "artifacts", artifact.path);
      io.beforeMove?.(artifact.path, dest);
      const why = context.gate();
      if (why || (context.policy ?? recoveryPolicy)(context.project, "convIgnoredBuildArtifacts").mode !== "on") throw new Error(why ?? "产物恢复策略已不是 on");
      const item = CONV_BUILD_PATHS.find((p) => p.path === artifact.path)!;
      const current = readBuildArtifact(worktree, item.path, item.directory);
      if (current?.fingerprint !== artifact.fingerprint) throw new Error(`搬移前产物已变化：${artifact.path}`);
      noLinkedAncestors(dirname(dest), true);
      mkdirSync(dirname(dest), { recursive: true }); noLinkedAncestors(dirname(dest));
      try { lstatSync(dest); throw new Error(`隔离目标已存在：${artifact.path}`); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
      const from = join(worktree, artifact.path);
      if (io.rename) io.rename(from, dest); else renameSync(from, dest);
      receipt.moved.push(artifact.path); save();
      const moved = readBuildArtifact(join(batch, "artifacts"), artifact.path, item.directory);
      if (moved?.digest !== artifact.digest) throw new Error(`隔离后产物字节不符：${artifact.path}`);
    }
    receipt.status = "complete"; save();
    return batch;
  } catch (e) {
    receipt.status = "failed"; receipt.error = String(e);
    try { save(); } catch (writeError) { console.warn(`隔离失败回执未能更新，prepared 回执仍拒绝重试：${String(writeError)}`); }
    throw e;
  }
}

const syncGit = (args: string[]) => {
  const r = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  const out = (r.exitCode === 0 ? r.stdout : r.stderr).toString();
  return { code: r.exitCode, out: out.endsWith("\0") ? out : out.trim() };
};

/** No await between the final complete proof, the stopped-session gate and moving a batch. No move occurs at sync effect edges. */
export async function quarantineConvArtifacts(git: Git, worktree: string, repo: string, context: ConvArtifactContext,
  identity: { branch: string; head: string }, verify: () => Promise<string | null>): Promise<string | null> {
  const proof = await convArtifactProof(git, worktree, repo, context);
  if (proof.reason || proof.mode !== "on") return proof.reason;
  const path = convArtifactIsolationPath(context);
  try {
    safeLocation(path, worktree, repo);
    const previous = priorBatchRefusal(path, context);
    if (previous) return previous;
    if (!proof.candidates.length) return retryWorktreeDirty(git, worktree, repo);
    const early = context.gate();
    if (early) return early;
    mkdirSync(path, { recursive: true }); noLinkedAncestors(path);
    const lock = await acquireLock(join(path, "move.lock"), 0);
    if (!lock) return "隔离批次正在处理，不并发搬移";
    try {
      const refused = priorBatchRefusal(path, context) ?? await verify();
      if (refused) return refused;
      const fresh = await convArtifactProof(git, worktree, repo, context);
      if (fresh.reason || fresh.mode !== "on") return fresh.reason ?? "产物恢复策略已不是 on";
      if (!lock.held()) return "隔离批次锁已失效，不搬移";
      const branch = syncGit(["-C", worktree, "symbolic-ref", "--quiet", "--short", "HEAD"]);
      const head = syncGit(["-C", worktree, "rev-parse", "--verify", "HEAD"]);
      if (branch.code || head.code || branch.out !== identity.branch || head.out !== identity.head) return "搬移前工作树分支 / head 已变化";
      const dirty = convArtifactProofSync(syncGit, worktree, repo, context);
      if (dirty) return dirty;
      const late = context.gate();
      if (late || (context.policy ?? recoveryPolicy)(context.project, "convIgnoredBuildArtifacts").mode !== "on") return late ?? "产物恢复策略已不是 on";
      moveArtifactBatch(worktree, path, fresh.candidates, { ...context, gate: () => lock.held() ? context.gate() : "隔离批次锁已失效" });
      return await retryWorktreeDirty(git, worktree, repo);
    } finally { lock.release(); }
  } catch (e) { return `隔离构建产物失败，保留产物与回执：${String(e)}`; }
}

/** Slot acquisition may await after opening a tree; the create edge therefore repeats the strict proof synchronously. */
export function convTreeCreateEdge(dir: string, branch: string | null, head: string | null): string | null {
  if (!existsSync(dir)) return null; // In-memory lifecycle facades have no disk tree to prove.
  try { noLinkedAncestors(dir); } catch (e) { return `创建边界工作树路径不安全：${String(e)}`; }
  const owner = buildArtifactOwner(dir, syncGit(["-C", dir, "worktree", "list", "--porcelain"]));
  const at = syncGit(["-C", dir, "symbolic-ref", "--quiet", "--short", "HEAD"]), sha = syncGit(["-C", dir, "rev-parse", "--verify", "HEAD"]);
  if (at.code || sha.code || at.out !== branch || sha.out !== head) return "创建边界工作树分支 / head 已变化";
  return retryWorktreeDirtySync(syncGit, dir, owner);
}

export function convArtifactMode(context: ConvArtifactContext): RecoveryMode {
  return (context.policy ?? recoveryPolicy)(context.project, "convIgnoredBuildArtifacts").mode;
}
function observed(context: ConvArtifactContext, candidates: BuildArtifact[]): void {
  if (!candidates.length) return;
  const batch = createHash("sha256").update(JSON.stringify(candidates)).digest("hex").slice(0, 24);
  const intent = createHash("sha256").update(context.intentId).digest("hex").slice(0, 24);
  context.observe({ project: context.project, mechanism: "convIgnoredBuildArtifacts", target: context.taskId,
    actionKey: `artifacts:${intent}:${batch}`, action: `本会挪走 ${candidates.length} 项`, data: { intentId: context.intentId, paths: candidates.map((c) => c.path), count: candidates.length } });
}

/** Read-only preflight. Only on can provisionally exempt proven candidates; all other dirty semantics stay canonical. */
export async function convArtifactProof(git: Git, worktree: string, repo: string | undefined, context?: ConvArtifactContext, identityOnly = false): Promise<ArtifactProof> {
  const mode = context ? convArtifactMode(context) : "off";
  if (!context || mode === "off") return { mode, candidates: [], reason: await retryWorktreeDirty(git, worktree, repo) };
  let candidates: BuildArtifact[];
  try { candidates = await convBuildCandidates(git, worktree, context); }
  catch (e) { return { mode, candidates: [], reason: await retryWorktreeDirty(git, worktree, repo) ?? `构建产物证明失败：${String(e)}` }; }
  const clean = await retryWorktreeDirty(git, worktree, repo, candidates.map((c) => c.path));
  if (clean) return { mode, candidates, reason: clean };
  if (candidates.length) {
    const gate = context.gate();
    if (gate) return { mode, candidates, reason: gate };
    try {
      const path = convArtifactIsolationPath(context);
      safeLocation(path, worktree, repo ?? context.repository ?? worktree);
      const previous = priorBatchRefusal(path, context);
      if (previous) return { mode, candidates, reason: previous };
    } catch (e) { return { mode, candidates, reason: `隔离目录或回执不可用：${String(e)}` }; }
    const current = convArtifactMode(context);
    if (current !== mode) return { mode: current, candidates, reason: "产物恢复策略已变化，不隔离、不记录候选动作" };
  }
  if (mode === "observe" && !identityOnly) observed(context, candidates);
  return { mode, candidates, reason: mode === "on" || identityOnly ? null : await retryWorktreeDirty(git, worktree, repo) };
}

/** The same candidate and dirty proof at synchronous reclaim boundaries; it never moves files or creates directories. */
export function convArtifactProofSync(git: (args: string[]) => Result, worktree: string, repo: string | undefined, context: ConvArtifactContext): string | null {
  if (convArtifactMode(context) !== "on") return retryWorktreeDirtySync(git, worktree, repo);
  try {
    const candidates = convBuildCandidatesSync(git, worktree, context);
    const dirty = retryWorktreeDirtySync(git, worktree, repo, candidates.map((c) => c.path));
    if (dirty) return dirty;
    if (candidates.length) {
      const path = convArtifactIsolationPath(context);
      safeLocation(path, worktree, repo ?? context.repository ?? worktree);
      const previous = priorBatchRefusal(path, context);
      if (previous) return previous;
    }
    return context.gate();
  } catch (e) { return retryWorktreeDirtySync(git, worktree, repo) ?? `构建产物证明失败：${String(e)}`; }
}

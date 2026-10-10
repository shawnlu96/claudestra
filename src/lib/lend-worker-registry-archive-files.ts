/** Private, hash-verified recovery bundles. Publication of the manifest is the durable prepared marker. */
import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { writeJsonAtomicSync } from "./state-file.js";
import { archiveHash, workerArchiveKey, type WorkerArchiveIdentity } from "./lend-worker-registry-archive.js";

interface FileHash { path: string; sha256: string }
export interface WorkerArchiveBackup {
  v: 1; identity: WorkerArchiveIdentity; registryHash: string; files: FileHash[];
}

/** Reject symlinks in every existing ancestor; recovery bundles must never read/write through a replaced directory. */
export function archivePlainPath(path: string): void {
  for (let p = resolve(path);;) {
    const stat = lstatSync(p, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) throw new Error(`归档路径不能是软链：${p}`);
    const parent = dirname(p);
    if (parent === p) return;
    p = parent;
  }
}

function privateDir(path: string): void {
  archivePlainPath(path);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function saveFile(root: string, name: string, data: Buffer | string, files: FileHash[]): void {
  const dest = join(root, name);
  privateDir(dirname(dest));
  archivePlainPath(dest);
  const bytes = typeof data === "string" ? Buffer.from(data) : data;
  writeFileSync(dest, bytes, { mode: 0o600 });
  chmodSync(dest, 0o600);
  files.push({ path: name, sha256: archiveHash(bytes.toString("base64")) });
}

function copyTree(source: string, root: string, dest: string, files: FileHash[]): void {
  archivePlainPath(source);
  const stat = lstatSync(source, { throwIfNoEntry: false });
  if (!stat) return;
  if (stat.isFile()) return saveFile(root, dest, readFileSync(source), files);
  if (!stat.isDirectory()) throw new Error(`不是普通归档文件：${source}`);
  privateDir(join(root, dest));
  for (const entry of readdirSync(source).sort()) copyTree(join(source, entry), root, join(dest, entry), files);
}

/** Reuse only a fully verified bundle; a crash before manifest publication can be safely retried. */
export function prepareWorkerArchiveBackup(root: string, id: WorkerArchiveIdentity, registry: string, archiveDir: string,
  evidence: { journal: string; receipts: string }): string {
  const dir = join(root, workerArchiveKey(id), archiveHash(registry));
  archivePlainPath(dir);
  const manifest = join(dir, "manifest.json");
  if (lstatSync(manifest, { throwIfNoEntry: false })) {
    const old = readWorkerArchiveBackup(dir);
    if (JSON.stringify(old.identity) !== JSON.stringify(id) || old.registryHash !== archiveHash(registry)) throw new Error("备份身份不匹配");
    return dir;
  }
  privateDir(dir);
  const files: FileHash[] = [];
  saveFile(dir, "registry-before.json", registry, files);
  saveFile(dir, "order.json", evidence.journal, files);
  saveFile(dir, "receipts.jsonl", evidence.receipts, files);
  copyTree(archiveDir, dir, "archive", files);
  const data: WorkerArchiveBackup = { v: 1, identity: id, registryHash: archiveHash(registry), files };
  writeJsonAtomicSync(manifest, data, { mode: 0o600 });
  readWorkerArchiveBackup(dir);
  return dir;
}

export function readWorkerArchiveBackup(dir: string): WorkerArchiveBackup {
  archivePlainPath(join(dir, "manifest.json"));
  if ((lstatSync(dir).mode & 0o077) || (lstatSync(join(dir, "manifest.json")).mode & 0o077)) throw new Error("备份清单权限不合格");
  const data = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as WorkerArchiveBackup;
  if (data.v !== 1 || !data.identity || !Array.isArray(data.files)) throw new Error("归档备份格式损坏");
  for (const f of data.files) {
    const path = resolve(dir, f.path);
    if (!f.path || relative(resolve(dir), path).startsWith("..") || !path.startsWith(resolve(dir) + sep)) throw new Error("备份文件越界");
    archivePlainPath(path);
    const stat = lstatSync(path);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error(`备份权限 / 类型不合格：${f.path}`);
    if (archiveHash(readFileSync(path).toString("base64")) !== f.sha256) throw new Error(`备份 hash 不匹配：${f.path}`);
  }
  if (!["registry-before.json", "order.json", "receipts.jsonl"].every((name) => data.files.some((f) => f.path === name))
    || archiveHash(readFileSync(join(dir, "registry-before.json"), "utf8")) !== data.registryHash) throw new Error("registry 备份不完整");
  return data;
}

const RECEIPT = "archive-receipt.json";

/** The session's canonical archive files: the main history plus everything under its <sessionId>/ (subagents, workflow). */
function sessionArchiveFiles(archiveDir: string, sessionId: string): FileHash[] {
  const files: FileHash[] = [];
  const walk = (rel: string) => {
    const path = join(archiveDir, rel);
    archivePlainPath(path);
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat) return;
    if (stat.isFile()) return void files.push({ path: rel, sha256: archiveHash(readFileSync(path).toString("base64")) });
    if (!stat.isDirectory()) throw new Error(`不是普通归档文件：${path}`);
    for (const entry of readdirSync(path).sort()) walk(join(rel, entry));
  };
  walk(`${sessionId}.jsonl`);
  if (!files.length) throw new Error("会话历史未保全");
  walk(sessionId);
  return files;
}

/**
 * Written only after this plan's own canonical archive returned ok (the exit was already proven), so it is the evidence that the
 * terminal history is complete. A copy that merely exists (an early archive-sweeper snapshot, a kill-time copy) never counts.
 */
export function writeArchiveReceipt(backupDir: string, id: WorkerArchiveIdentity, archiveDir: string): void {
  readWorkerArchiveBackup(backupDir);
  const dest = join(backupDir, RECEIPT);
  archivePlainPath(dest);
  writeJsonAtomicSync(dest, { v: 1, identity: id, files: sessionArchiveFiles(archiveDir, id.sessionId) }, { mode: 0o600 });
}

/** True only when the receipt is this identity's and every receipted file is still byte-identical; anything else re-archives. */
export function archiveReceiptHolds(backupDir: string, id: WorkerArchiveIdentity, archiveDir: string): boolean {
  const path = join(backupDir, RECEIPT);
  archivePlainPath(path);
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return false;
  if (!stat.isFile() || (stat.mode & 0o077)) throw new Error("归档收据权限 / 类型不合格");
  const data = JSON.parse(readFileSync(path, "utf8")) as { v: number; identity: WorkerArchiveIdentity; files: FileHash[] };
  if (data.v !== 1 || JSON.stringify(data.identity) !== JSON.stringify(id) || !Array.isArray(data.files)) return false;
  if (!lstatSync(join(archiveDir, `${id.sessionId}.jsonl`), { throwIfNoEntry: false })) return false;
  return JSON.stringify(data.files) === JSON.stringify(sessionArchiveFiles(archiveDir, id.sessionId));
}

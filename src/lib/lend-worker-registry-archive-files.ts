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

/** One source file this receipt proves contained: the archive's first `size` bytes hash to the source's final bytes. */
interface SourceProof { archive: string; size: number; sha256: string }
interface ArchiveReceipt { v: 3; identity: WorkerArchiveIdentity; files: FileHash[]; sources: SourceProof[] }

const prefixHash = (bytes: Buffer, size: number) => archiveHash(bytes.subarray(0, size).toString("base64"));

/** The recursive workflow trees canonical archiveSession mirrors through workflow-archive (same relative layout under <sid>/). */
const WORKFLOW_DIRS = ["workflows", join("subagents", "workflows")];

/**
 * Every source file canonical archiveSession preserves — the main history, subagents/*.jsonl and every file under the recursive
 * workflows/** and subagents/workflows/** trees — each checked against its archive copy. Append-only *.jsonl must start with the
 * source's bytes (copyIfLarger keeps an existing target that is as large or larger, so its ok alone never proves the final source is
 * there); other workflow files are mirrored by copyIfChanged and must equal the source. A larger stale or foreign snapshot fails here.
 */
function sourceProofs(source: string, archiveDir: string, sessionId: string): SourceProof[] {
  const pairs: Array<[string, string]> = [[source, `${sessionId}.jsonl`]];
  const stem = source.replace(/\.jsonl$/, "");
  const sub = join(stem, "subagents");
  archivePlainPath(source);
  const subStat = lstatSync(sub, { throwIfNoEntry: false });
  if (subStat) {
    if (!subStat.isDirectory()) throw new Error(`源 subagents 不是目录：${sub}`);
    for (const f of readdirSync(sub).sort()) if (f.endsWith(".jsonl")) pairs.push([join(sub, f), join(sessionId, "subagents", f)]);
  }
  const walk = (rel: string) => {
    const from = join(stem, rel);
    archivePlainPath(from);
    const stat = lstatSync(from, { throwIfNoEntry: false });
    if (!stat) return;
    if (stat.isDirectory()) {
      for (const entry of readdirSync(from).sort()) walk(join(rel, entry));
      return;
    }
    if (!stat.isFile()) throw new Error(`源 workflow 不是普通文件：${from}`);
    if (!rel.split(sep).pop()!.includes(".tmp-")) pairs.push([from, join(sessionId, rel)]); // 与 workflow-archive 同口径跳过临时文件
  };
  for (const rel of WORKFLOW_DIRS) walk(rel);
  return pairs.map(([from, rel]) => {
    archivePlainPath(from);
    const src = readFileSync(from);
    const dest = join(archiveDir, rel);
    archivePlainPath(dest);
    const kept = lstatSync(dest, { throwIfNoEntry: false })?.isFile() ? readFileSync(dest) : null;
    const exact = !rel.endsWith(".jsonl");
    if (!kept || kept.length < src.length || (exact && kept.length !== src.length) || !kept.subarray(0, src.length).equals(src)) {
      throw new Error(`归档 ${rel} 不含源的最终内容（旧快照 / 他人副本 / 未拷上），不签终态收据`);
    }
    return { archive: rel, size: src.length, sha256: prefixHash(src, src.length) };
  });
}

/**
 * Written only after this plan's own canonical archive returned ok (the exit was already proven) and the archive is proven to contain
 * the final source bytes, so it is the evidence that the terminal history is complete. A copy that merely exists never counts.
 */
export function writeArchiveReceipt(backupDir: string, id: WorkerArchiveIdentity, archiveDir: string, source: string): void {
  readWorkerArchiveBackup(backupDir);
  const sources = sourceProofs(source, archiveDir, id.sessionId);
  const dest = join(backupDir, RECEIPT);
  archivePlainPath(dest);
  const data: ArchiveReceipt = { v: 3, identity: id, files: sessionArchiveFiles(archiveDir, id.sessionId), sources };
  writeJsonAtomicSync(dest, data, { mode: 0o600 });
}

/**
 * True only when the receipt is this identity's, every receipted file is still byte-identical and still starts with the receipted
 * final source bytes. Only v3 proves recursive workflow coverage; v2 may omit final workflow sources and must re-archive.
 * The source itself is not needed when the complete receipt holds.
 */
export function archiveReceiptHolds(backupDir: string, id: WorkerArchiveIdentity, archiveDir: string): boolean {
  const path = join(backupDir, RECEIPT);
  archivePlainPath(path);
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return false;
  if (!stat.isFile() || (stat.mode & 0o077)) throw new Error("归档收据权限 / 类型不合格");
  const data = JSON.parse(readFileSync(path, "utf8")) as ArchiveReceipt;
  if (data.v !== 3 || JSON.stringify(data.identity) !== JSON.stringify(id) || !Array.isArray(data.files) || !Array.isArray(data.sources)
    || !data.sources.some((p) => p.archive === `${id.sessionId}.jsonl`)) return false;
  if (!lstatSync(join(archiveDir, `${id.sessionId}.jsonl`), { throwIfNoEntry: false })) return false;
  if (JSON.stringify(data.files) !== JSON.stringify(sessionArchiveFiles(archiveDir, id.sessionId))) return false;
  return data.sources.every((p) => {
    if (!data.files.some((f) => f.path === p.archive)) return false;
    const dest = join(archiveDir, p.archive);
    archivePlainPath(dest);
    const kept = readFileSync(dest);
    return kept.length >= p.size && prefixHash(kept, p.size) === p.sha256;
  });
}

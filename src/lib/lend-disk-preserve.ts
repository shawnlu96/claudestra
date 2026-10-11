/**
 * Byte backup of an ended lend order's checkouts, taken before anything reclaims them: an order cancelled or stopped while its
 * result is unknown or undelivered still has the only copy of the worker's unpushed commits and WIP on disk.
 * Copies work/ and push/ byte for byte (.git included, so commits come back with plain git; no git is run here because the
 * checkout's .git/config belongs to the worker), plus caller-named records (transcript, receipts) and the journal report.
 * Success is a durable proof.json naming the manifest hash; nothing here deletes or moves a source, and a crashed or failed
 * attempt is resumed in place, never wiped. Only node_modules is left out, and listed. tests/lend-work-retention-cancel.test.ts.
 */
import { createHash } from "node:crypto";
import {
  chmodSync, closeSync, copyFileSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, readSync,
  realpathSync, renameSync, symlinkSync, utimesSync, writeSync,
} from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { orderDir, orderDirName } from "./lend-clone.js";

const AREAS = ["work", "push"] as const;
type TreeArea = typeof AREAS[number];
const SKIP_DIRS = new Set(["node_modules"]);
const present = (path: string): boolean => lstatSync(path, { throwIfNoEntry: false }) !== undefined;

interface Entry {
  area: TreeArea | "record";
  path: string;
  type: "file" | "dir" | "link";
  mode: number;
  size?: number;
  sha256?: string;
  target?: string;
  /** record only: where the original lives; it is copied, never touched */
  from?: string;
}

/** What the proof is bound to: a row that changed generation, worker or session since is a different order life. */
export interface PreserveIdentity { orderId: string; state: string; leaseGen: number | null; agent: string | null; sessionId: string | null; createdAt: number }
export interface PreserveRecord { label: string; path: string }
interface Manifest { v: 1; identity: PreserveIdentity; treeSha256: string; entries: Entry[]; skipped: string[]; report: unknown }
export interface PreserveProof {
  v: 1; identity: PreserveIdentity; treeSha256: string; manifestSha256: string; files: number; bytes: number; dir: string; at: number;
}
export interface PreserveInput {
  root: string;
  identity: PreserveIdentity;
  /** journal facts worth keeping next to the bytes (summary, self-check, receipt, reason) */
  report?: unknown;
  records?: readonly PreserveRecord[];
  now: number;
}

const sha = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");

function hashFile(path: string): string {
  const h = createHash("sha256"), buf = Buffer.allocUnsafe(1 << 20), fd = openSync(path, "r");
  try {
    for (let n = readSync(fd, buf, 0, buf.length, null); n > 0; n = readSync(fd, buf, 0, buf.length, null)) h.update(buf.subarray(0, n));
  } finally { closeSync(fd); }
  return h.digest("hex");
}

/** Symlinked roots/areas/leaves are refused before anything resolves through them (same rule the reclaim applies). */
export function assertOrderPaths(id: string, root: string): void {
  if (!present(root)) return;
  if (lstatSync(root).isSymbolicLink()) throw new Error("出借根目录不能是软链");
  const realRoot = realpathSync(root);
  for (const area of AREAS) {
    const parent = join(root, area);
    if (!present(parent)) continue;
    if (lstatSync(parent).isSymbolicLink() || relative(realRoot, realpathSync(parent)) !== area) throw new Error(`拒绝删除：${area} 越出出借根目录`);
    const dir = orderDir(id, root, area);
    if (!present(dir)) continue;
    if (lstatSync(dir).isSymbolicLink() || relative(realRoot, realpathSync(dir)) !== join(area, orderDirName(id))) {
      throw new Error(`拒绝删除：${id} 的 ${area} 不是订单目录`);
    }
  }
}

/** Links are recorded by target and never followed; anything that is not a file, directory or link cannot be backed up and refuses. */
function scanArea(dir: string, area: TreeArea, entries: Entry[], skipped: string[]): void {
  if (!present(dir)) return;
  entries.push({ area, path: "", type: "dir", mode: lstatSync(dir).mode & 0o777 });
  for (const stack = [dir]; stack.length;) {
    const cur = stack.pop()!;
    for (const name of readdirSync(cur).sort()) {
      const p = join(cur, name), st = lstatSync(p), path = relative(dir, p), mode = st.mode & 0o777;
      if (st.isDirectory() && SKIP_DIRS.has(name)) skipped.push(`${area}/${path}`);
      else if (st.isDirectory()) { entries.push({ area, path, type: "dir", mode }); stack.push(p); }
      else if (st.isSymbolicLink()) entries.push({ area, path, type: "link", mode, target: readlinkSync(p) });
      else if (st.isFile()) entries.push({ area, path, type: "file", mode, size: st.size, sha256: hashFile(p) });
      else throw new Error(`${area}/${path} 不是普通文件 / 目录 / 软链，无法保全`);
    }
  }
}

interface Tree { entries: Entry[]; skipped: string[]; sha256: string }
function scanTree(id: string, root: string): Tree {
  assertOrderPaths(id, root);
  const entries: Entry[] = [], skipped: string[] = [];
  for (const area of AREAS) scanArea(orderDir(id, root, area), area, entries, skipped);
  const key = (e: Entry) => `${e.area}/${e.path}`;
  entries.sort((a, b) => (key(a) < key(b) ? -1 : 1));
  return { entries, skipped: skipped.sort(), sha256: sha(JSON.stringify(entries)) };
}

/** Private backup root under the lend root; every level must be a real directory exactly where its name says. */
function backupHome(id: string, root: string): string {
  const realRoot = realpathSync(root);
  let dir = root;
  for (const part of ["preserved", orderDirName(id)]) {
    dir = join(dir, part);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (lstatSync(dir).isSymbolicLink() || realpathSync(dir) !== join(realRoot, relative(root, dir))) throw new Error(`保全目录 ${dir} 是软链或越出出借根目录`);
  }
  return dir;
}

let seq = 0;
/** tmp + fsync + rename + directory fsync: a reader sees the old bytes or the whole new file, and a rename survives power loss. */
function durable(path: string, write: (tmp: string) => void): void {
  const tmp = `${path}.tmp-${process.pid}-${seq++}`;
  write(tmp);
  const fd = openSync(tmp, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, path);
  const dfd = openSync(dirname(path), "r");
  try { fsyncSync(dfd); } finally { closeSync(dfd); }
}
const durableJson = (path: string, text: string): void => durable(path, (tmp) => {
  const fd = openSync(tmp, "w", 0o600);
  try { writeSync(fd, text); } finally { closeSync(fd); }
});

const destOf = (dir: string, e: Entry): string => join(dir, e.area === "record" ? "records" : e.area, e.path);

function copyEntry(src: string, dst: string, e: Entry): void {
  mkdirSync(dirname(dst), { recursive: true, mode: 0o700 });
  const have = lstatSync(dst, { throwIfNoEntry: false });
  if (e.type === "dir") return void mkdirSync(dst, { recursive: true, mode: 0o700 });
  if (e.type === "link") {
    if (!have) return symlinkSync(e.target!, dst);
    if (!have.isSymbolicLink() || readlinkSync(dst) !== e.target) throw new Error(`备份里的 ${e.area}/${e.path} 与源软链不一致`);
    return;
  }
  if (have?.isFile() && hashFile(dst) === e.sha256) return; // resumed attempt: these bytes are already safe
  const st = lstatSync(src);
  if (!st.isFile()) throw new Error(`${e.area}/${e.path} 保全期间不再是普通文件`);
  durable(dst, (tmp) => { copyFileSync(src, tmp); chmodSync(tmp, (e.mode & 0o700) | 0o400); });
  utimesSync(dst, st.atime, st.mtime); // git's index compares mtimes: keeps the restored checkout from looking fully modified
  if (hashFile(dst) !== e.sha256) throw new Error(`${e.area}/${e.path} 备份字节与源 hash 不符（保全期间被改动？）`);
}

function recordEntries(records: readonly PreserveRecord[]): Entry[] {
  return records.map((r, i) => {
    const st = lstatSync(r.path);
    if (!st.isFile()) throw new Error(`记录 ${r.label}（${r.path}）不是普通文件`);
    return { area: "record" as const, path: `${i}-${basename(r.path)}`, type: "file" as const, mode: st.mode & 0o777, size: st.size, sha256: hashFile(r.path), from: r.path };
  });
}

const sameIdentity = (a: PreserveIdentity, b: PreserveIdentity): boolean =>
  a.orderId === b.orderId && a.state === b.state && a.leaseGen === b.leaseGen && a.agent === b.agent && a.sessionId === b.sessionId && a.createdAt === b.createdAt;

/**
 * The backup at `dir` against its own proof and manifest: every byte re-hashed. Throws on anything unreadable or inconsistent.
 * Needs no source, so a late reader can check a backup long after the checkout was reclaimed.
 */
export function checkBackup(dir: string): PreserveProof {
  const proof = JSON.parse(readFileSync(join(dir, "proof.json"), "utf8")) as PreserveProof;
  const raw = readFileSync(join(dir, "manifest.json"));
  if (proof?.v !== 1 || typeof proof.manifestSha256 !== "string" || sha(raw) !== proof.manifestSha256) throw new Error(`${dir} 的 manifest 与成功证明对不上`);
  const m = JSON.parse(raw.toString("utf8")) as Manifest;
  if (m?.v !== 1 || !Array.isArray(m.entries) || !m.identity || !sameIdentity(m.identity, proof.identity) || m.treeSha256 !== proof.treeSha256) {
    throw new Error(`${dir} 的 manifest 读不懂或与证明不是同一单`);
  }
  if (sha(JSON.stringify(m.entries.filter((e) => e.area !== "record"))) !== m.treeSha256) throw new Error(`${dir} 的 manifest 条目与目录树 hash 不符`);
  for (const e of m.entries) {
    const p = destOf(dir, e), st = lstatSync(p);
    const ok = e.type === "dir" ? st.isDirectory() : e.type === "link" ? st.isSymbolicLink() && readlinkSync(p) === e.target : st.isFile() && hashFile(p) === e.sha256;
    if (!ok) throw new Error(`备份 ${e.area}/${e.path} 缺失或与 manifest 不符`);
  }
  return proof;
}

/** The proof for the checkout as it is on disk right now; throws unless a verified backup of exactly these bytes and this identity exists. */
export function verifyPreserved(root: string, identity: PreserveIdentity): PreserveProof {
  const tree = scanTree(identity.orderId, root);
  const proof = checkBackup(backupDir(identity, root, tree));
  if (!sameIdentity(proof.identity, identity)) throw new Error(`保全证明属于另一代 / 另一会话（gen ${proof.identity.leaseGen}），不是当前订单`);
  if (proof.treeSha256 !== tree.sha256) throw new Error("保全证明对应的不是当前工作副本");
  return proof;
}

/** Content-addressed: the same bytes of the same generation always land in the same directory, so a repeat or a concurrent call converges. */
const backupDir = (id: PreserveIdentity, root: string, tree: Tree): string =>
  join(backupHome(id.orderId, root), `g${id.leaseGen ?? "x"}-${tree.sha256.slice(0, 20)}`);

/** Verified backups of this order, newest first; unreadable or unverifiable ones are skipped (they prove nothing). */
export function preservedBackups(root: string, orderId: string): PreserveProof[] {
  const home = join(root, "preserved", orderDirName(orderId));
  if (!present(home)) return [];
  const out: PreserveProof[] = [];
  for (const name of readdirSync(backupHome(orderId, root))) {
    try { out.push(checkBackup(join(home, name))); } catch { /* an incomplete or damaged attempt is not a backup; callers only want proven ones */ }
  }
  return out.sort((a, b) => b.at - a.at);
}

/**
 * Back up the order's checkouts and return the durable proof. Idempotent: an existing verified backup of the same bytes is
 * returned untouched. Throws when there is nothing to back up, when anything cannot be read, or when the source changed while
 * it was being copied (a process is still writing); the caller must then keep the checkout.
 */
export function preserveOrderWork(input: PreserveInput): PreserveProof {
  const { root, identity } = input;
  const tree = scanTree(identity.orderId, root);
  if (!tree.entries.length) throw new Error("没有可保全的工作副本");
  const dir = backupDir(identity, root, tree);
  if (present(join(dir, "proof.json"))) return verifyPreserved(root, identity);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const records = recordEntries(input.records ?? []);
  for (const e of tree.entries) copyEntry(join(orderDir(identity.orderId, root, e.area as TreeArea), e.path), destOf(dir, e), e);
  for (const e of records) copyEntry(e.from!, destOf(dir, e), e);
  const manifest: Manifest = { v: 1, identity, treeSha256: tree.sha256, entries: [...tree.entries, ...records], skipped: tree.skipped, report: input.report ?? null };
  const text = JSON.stringify(manifest, null, 1);
  durableJson(join(dir, "manifest.json"), text);
  if (scanTree(identity.orderId, root).sha256 !== tree.sha256) throw new Error("保全期间工作副本被改动，本次不出成功证明");
  const files = manifest.entries.filter((e) => e.type === "file");
  const proof: PreserveProof = {
    v: 1, identity, treeSha256: tree.sha256, manifestSha256: sha(text), files: files.length, bytes: files.reduce((n, e) => n + (e.size ?? 0), 0), dir, at: input.now,
  };
  durableJson(join(dir, "proof.json"), JSON.stringify(proof, null, 1));
  return verifyPreserved(root, identity);
}

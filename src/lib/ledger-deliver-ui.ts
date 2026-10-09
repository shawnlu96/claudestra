/**
 * UISDEL1: the before / after screenshot evidence check of a UI card's delivery, run by ledger-write.ts deliver inside its own
 * transaction before anything is written (MCP → CLI, CLI, peer writeLendDeliver all reach it with the same rules). It only records
 * evidence: never an approval, never an owner / PM answer; PM / owner still look at the actual files (scheduler-ui-gate.ts).
 * Policy: recovery-policy key uiDelivery through an injected port. off (or no port: callers not wired) = the old path, nothing read;
 * observe = check, record one deduplicated note per problem, never block, never write screenshots; on = refuse a missing / wrong
 * manifest, else register extra.screenshots (real paths) + screenshotsDigest and the manifest on the deliver event, same tx.
 * Bytes are hashed from files under this machine's artifact root only: `local` = <root>/<taskId>/<ref>; `imported` = files a peer
 * order already had imported to <imported>/<peer>/<order>/<ref> with a provenance.json naming that peer / worker / order / head and
 * each file's sha256. Opened by fd with O_NOFOLLOW and realpath-in-root (attachment-lookup.ts openAttachment). A peer's own paths are
 * never opened; nothing here fetches, transfers or imports. tests/order-deliver-ui.test.ts、tests/ledger-lend-write-ui.test.ts.
 * UISPATH1: only the artifact root itself is resolved and trusted; every layer below it (imported / <peer> / <order>, <taskId>, a
 * ref's subdirectories) must be a real directory whose realpath is exactly <parent's realpath>/<name>, so a layer rewritten by a
 * symlink is refused instead of becoming the trusted root at its own realpath. Layers are re-checked (dev / ino / realpath) after
 * the open. Nothing is created or swept. tests/ledger-deliver-ui-path.test.ts.
 */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { closeSync, fstatSync, lstatSync, readSync, realpathSync, statSync, type Stats } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { openAttachment } from "./attachment-lookup.js";
import { getWorkflow } from "./ledger-scheduler.js";
import type { LedgerEvent, LedgerTask, Stage } from "./ledger-stages.js";
import { LedgerError } from "./ledger-store.js";
import { isUiEvidenceError, readUiEvidence, type UiEvidence } from "./order-deliver-ui.js";

type UiDeliveryMode = "on" | "observe" | "off";
export interface UiDeliverPeer { peer: string; worker: string; orderId: string }
export interface UiDeliverPort {
  /** recovery-policy uiDelivery, read at the write boundary (inside the deliver transaction) */
  mode(project: string): { mode: UiDeliveryMode; diagnostic?: string };
  /** observe: one deduplicated note per problem (recovery-policy recordObserved) */
  observe(db: Database, a: { project: string; target: string; actionKey: string; action: string; data: Record<string, unknown> }): void;
  roots: { local: string; imported: string };
  /** set = a peer's write order (writeLendDeliver): only `imported` artifacts of exactly this peer / worker / order count */
  peer?: UiDeliverPeer;
}
export interface UiDeliverPlan {
  extra?: { screenshots: string[]; screenshotsDigest: string };
  data?: { uiEvidence: Record<string, unknown> };
  observed?: { code: string; why: string };
}

const FILE_MAX = 10 * 1024 * 1024;
const PROVENANCE_MAX = 64 * 1024;
const NAME = /^(?!\.\.?$)[\w.-]{1,64}$/;
const HEX64 = /^[0-9a-f]{64}$/;

class Problem extends Error { constructor(readonly code: string, why: string) { super(why); } }
const no = (code: string, why: string): never => { throw new Problem(code, why); };

function readFd(fd: number, size: number, max: number): Buffer {
  if (size > max) no("too_large", `工件超过 ${max} 字节`);
  const buf = Buffer.alloc(size);
  for (let off = 0; off < size;) {
    let n: number;
    try { n = readSync(fd, buf, off, size - off, off); } catch { return no("unreadable", "读工件失败"); }
    if (n <= 0) return no("unreadable", "读工件时文件变了");
    off += n;
  }
  return buf;
}

/** One verified directory on the way down from the artifact root: where it is, where it really is, and which inode it was. */
interface Layer { path: string; real: string; dev: number; ino: number }

const untrusted = (what: string): never => no("path_untrusted", `工件路径不可信（软链 / 不是真目录 / 读不了 / 核对中被换）：${what}`);
const missing = (err: unknown): boolean => (err as NodeJS.ErrnoException).code === "ENOENT";

/** The artifact root itself: this machine's own state dir, resolved once (its ancestors may be symlinks, e.g. /var → /private/var). */
function anchor(root: string): Layer {
  const path = resolve(root);
  let real: string, st: Stats;
  try { real = realpathSync(path); st = statSync(real); } catch (err) { return missing(err) ? no("artifact_missing", "工件根不存在") : untrusted("工件根"); }
  if (!st.isDirectory()) untrusted("工件根");
  return { path, real, dev: st.dev, ino: st.ino };
}

/** parent/name must be a real directory (lstat: never a symlink) whose realpath is exactly <parent's realpath>/<name>. */
function layer(parent: Layer, name: string, shown: string): Layer {
  const path = join(parent.path, name);
  let st: Stats, real: string, same: Stats;
  try { st = lstatSync(path); } catch (err) { return missing(err) ? no("artifact_missing", `工件根下没有这个目录：${shown}`) : untrusted(shown); }
  if (!st.isDirectory()) untrusted(shown);
  try { real = realpathSync(path); same = statSync(real); } catch { return untrusted(shown); }
  // whole-segment comparison: a realpath elsewhere or in a same-prefix neighbour (imported-x) never equals the parent
  if (dirname(real) !== parent.real || same.dev !== st.dev || same.ino !== st.ino) untrusted(shown);
  return { path, real, dev: st.dev, ino: st.ino };
}

/** root, then each name as a verified layer below it */
function descend(root: string, names: string[], shown: string): Layer[] {
  const chain = [anchor(root)];
  for (const n of names) chain.push(layer(chain[chain.length - 1], n, shown));
  return chain;
}

/** After the open: every layer is still the same inode at the same realpath; a swap / replacement in between is refused. */
function recheck(chain: Layer[], shown: string): void {
  chain.forEach((l, i) => {
    let st: Stats, real: string;
    try { st = i === 0 ? statSync(l.path) : lstatSync(l.path); real = realpathSync(l.path); } catch { return untrusted(shown); }
    if (!st.isDirectory() || st.dev !== l.dev || st.ino !== l.ino || real !== l.real) untrusted(shown);
  });
}

/**
 * Bytes of one file strictly inside the verified chain (no symlink at any layer or leaf, no escape, regular file), or a problem;
 * never a path outside the root. The leaf is opened by openAttachment (O_NOFOLLOW + fd), then pinned to the chain's realpath.
 */
function readInside(base: Layer[], ref: string, max: number): { path: string; bytes: Buffer } {
  const parts = ref.split("/"), leaf = parts.pop() as string, chain = [...base];
  for (const n of parts) chain.push(layer(chain[chain.length - 1], n, ref));
  const dir = chain[chain.length - 1], path = join(dir.path, leaf);
  const hit = openAttachment(path, { uploadDir: dir.path, inboxDirs: [] });
  if (!hit) return no("artifact_missing", `工件根下没有这个文件，或是软链 / 逃出根：${ref}`);
  try {
    let real: string, same: Stats, st: Stats;
    try { real = realpathSync(path); same = statSync(real); st = fstatSync(hit.fd); } catch { return untrusted(ref); }
    if (dirname(real) !== dir.real || same.dev !== st.dev || same.ino !== st.ino) untrusted(ref);
    recheck(chain, ref);
    return { path, bytes: readFd(hit.fd, hit.size, max) };
  } finally { closeSync(hit.fd); }
}

const ORDER_DIR = /^(?!\.\.?$)[\w.-]{1,200}$/;
const orderDir = (orderId: string): string => orderId.replaceAll(":", "_");

/** provenance.json of an imported set: who it came from and each file's sha256; anything else = not an import we can stand on. */
function provenance(base: Layer[], peer: UiDeliverPeer, head: string): Record<string, string> {
  const { bytes } = readInside(base, "provenance.json", PROVENANCE_MAX);
  let p: Record<string, unknown>;
  try { p = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>; } catch { return no("provenance_invalid", "provenance.json 不是 JSON"); }
  if (!p || typeof p !== "object" || p.v !== 1 || !p.files || typeof p.files !== "object" || Array.isArray(p.files)) return no("provenance_invalid", "provenance.json 格式不对");
  if (p.peer !== peer.peer || p.worker !== peer.worker || p.orderId !== peer.orderId || p.head !== head) {
    return no("provenance_mismatch", "导入工件的来源（peer / worker / 单号 / head）对不上这一单");
  }
  const files: Record<string, string> = {};
  for (const [ref, f] of Object.entries(p.files as Record<string, unknown>)) {
    const sha = (f as { sha256?: unknown } | null)?.sha256;
    if (typeof sha === "string" && HEX64.test(sha)) files[ref] = sha;
  }
  return files;
}

type Checked = UiEvidence & { files: { ref: string; path: string; bytes: number }[] };
function check(task: LedgerTask, input: { headSHA?: string; uiEvidence?: unknown }, port: UiDeliverPort, ui: boolean): Checked {
  let e: UiEvidence | null;
  try { e = readUiEvidence(input.uiEvidence); } catch (err) { return isUiEvidenceError(err) ? no("invalid", err.message) : (() => { throw err; })(); }
  if (!ui) return no("not_ui", "这张卡不是 ui 模板，不收截图证据");
  if (!e) return no("missing", "ui 卡交付要带前后截图清单（uiEvidence）");
  if (e.taskId !== task.id) no("wrong_task", `截图清单是 ${e.taskId} 的，不是 ${task.id} 的`);
  if (!input.headSHA || e.head !== input.headSHA) no("wrong_head", "截图清单的 head 不是这次交付的 head");
  if (e.specRev !== task.specRev) no("wrong_spec", `截图清单是规格第 ${e.specRev} 版，卡上是第 ${task.specRev} 版`);
  const target = task.stage === "review" ? task.round : task.round + 1;
  if (e.round !== target) no("wrong_round", `截图清单的目标审查轮次是 ${e.round}，这次交付进的是第 ${target} 轮`);
  const want = port.peer ? "imported" : "local";
  if (e.source !== want) no("wrong_source", port.peer ? "远端交付只认已导入本机的工件（对方路径不在本机读）" : "本机交付只认本机工件根下本卡的文件");
  if (!NAME.test(task.id)) no("bad_task_id", "卡号不能当工件目录名");
  let base: Layer[], claimed: Record<string, string> | null = null;
  if (port.peer) {
    if (!NAME.test(port.peer.peer) || !ORDER_DIR.test(orderDir(port.peer.orderId))) no("bad_peer", "peer 名 / 单号不能当工件目录名");
    // the imported layer is itself checked under the artifact root, like peer / order: never trusted at its own realpath
    const imported = resolve(port.roots.imported), order = orderDir(port.peer.orderId);
    base = descend(dirname(imported), [basename(imported), port.peer.peer, order], `${basename(imported)}/${port.peer.peer}/${order}`);
    claimed = provenance(base, port.peer, e.head);
  } else base = descend(port.roots.local, [task.id], task.id);
  const files = e.shots.map((s) => {
    const { path, bytes } = readInside(base, s.ref, FILE_MAX);
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== s.sha256) no("hash_mismatch", `${s.ref} 的实际 sha256 与清单声明的不一致`);
    if (claimed && claimed[s.ref] !== actual) no("not_imported", `${s.ref} 不在这一单的导入记录里，或导入时的 sha256 不同`);
    return { ref: s.ref, path, bytes: bytes.length };
  });
  return { ...e, files };
}

/**
 * Decides what this delivery does about screenshots. Throws (on) before any write; the caller applies `extra` / `data` in its
 * own write and calls port.observe for `observed`. Non-UI cards without uiEvidence get {} whatever the mode.
 */
export function planUiDelivery(db: Database, task: LedgerTask, input: { headSHA?: string; moveFrom?: Stage; uiEvidence?: unknown }, port?: UiDeliverPort): UiDeliverPlan {
  if (!port) return {};
  const { mode } = port.mode(task.project);
  if (mode === "off") return {};
  const ui = getWorkflow(db, task.id)?.template === "ui";
  if (!ui && input.uiEvidence === undefined) return {};
  try {
    const e = check(task, input, port, ui);
    if (mode !== "on") return {};
    const shots = e.shots.map((s, i) => ({ ...s, path: e.files[i].path, bytes: e.files[i].bytes }));
    const { files: _f, shots: _s, ...rest } = e;
    return { extra: { screenshots: shots.map((s) => s.path), screenshotsDigest: e.digest },
      data: { uiEvidence: { ...rest, shots, bytesVerified: true, ...(port.peer ? { peer: port.peer } : {}) } } };
  } catch (err) {
    if (!(err instanceof Problem)) throw err;
    if (mode === "on") throw new LedgerError("invalid", `ui 卡交付的截图证据不合格（${err.code}）：${err.message}`, { ui: err.code, ...(port.peer ? { lend: "invalid" } : {}) });
    return { observed: { code: err.code, why: err.message } };
  }
}

/** Observe note for one problem; dedup per card + target round + code, so the same gap is one note. */
export function observeUiDelivery(db: Database, task: LedgerTask, plan: UiDeliverPlan, port: UiDeliverPort | undefined, head: string | undefined): void {
  if (!plan.observed || !port) return;
  const round = task.stage === "review" ? task.round : task.round + 1;
  const why = plan.observed.why.replace(/[\p{Cc}\u2028\u2029]/gu, " ").slice(0, 300);
  // observe never blocks the delivery: a note that cannot be written is logged and dropped (its savepoint rolls back alone)
  try {
    port.observe(db, { project: task.project, target: task.id, actionKey: `ui-delivery:r${round}:${plan.observed.code}:${(head ?? "nohead").slice(0, 12)}`,
      action: `拒收 ui 卡交付（截图证据 ${plan.observed.code}：${why}）`, data: { code: plan.observed.code, head: head ?? null } });
  } catch (e) { console.error(`⚠️ ${task.id} ui 交付观察没记上：${(e as Error).message}`); }
}

/**
 * Replay of a delivery key: once a delivery registered a manifest, the same key counts as the same delivery only with the same
 * manifest digest (a different or missing manifest is refused, never overwrites). Deliveries without a stored manifest replay as before.
 */
export function uiReplaySame(prev: Pick<LedgerEvent, "data">, raw: unknown): boolean {
  const stored = (prev.data.uiEvidence as { digest?: unknown } | undefined)?.digest;
  if (typeof stored !== "string") return true;
  try { return readUiEvidence(raw)?.digest === stored; } catch { return false; }
}

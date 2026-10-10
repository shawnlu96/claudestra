/**
 * LENDUI1: A's side of one screenshot upload — who may store (the peer holding this write / fix order of a ui card and the card's
 * write lease, card not moved, a head that is not the order's starting point) and the store itself: stripped PNG bytes as
 * s01.png … s16.png (named here in arrival order, nothing from the sender is a path) plus provenance.json, both atomic, 0600.
 * A refusal creates no directory and writes nothing. The bridge process is the only writer (local-api/lend-shot.ts); the ledger
 * is only read. Nothing here registers evidence: that is the delivery (lend-ui-deliver.ts). tests/lend-ui-store.test.ts.
 */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, type Stats } from "node:fs";
import { dirname, join } from "node:path";
import { cardMoved, getLendOrder } from "./ledger-lend.js";
import { heldLease } from "./ledger-lend-lease.js";
import { remoteCaller } from "./ledger-lend-peers.js";
import { getWorkflow } from "./ledger-scheduler.js";
import { getTask } from "./ledger-store.js";
import { isWriteStep } from "./lend-git.js";
import { LEND_UI_PROVENANCE, lendUiDirParts, readLendUiProvenance, type LendUiFile, type LendUiProvenance } from "./lend-ui-provenance.js";
import { LEND_SHOT_LIMITS, shotRefusal, type LendShot, type LendShotRefusal } from "./lend-ui-wire.js";
import type { RecoveryMode } from "./recovery-policy.js";
import { writeTextAtomicSync } from "./state-file.js";

export interface LendShotStoreDeps {
  /** uiDeliverPort().roots.imported: the root the delivery check reads imported artifacts from */
  importedRoot: string;
  /** recovery-policy lendUiShots of the order's project, read per upload */
  mode(project: string): RecoveryMode;
  now(): number;
}
/** mode / stored are for the caller's log line, not for the peer */
export interface LendShotStored { ok: true; v: 1; ref: string; sha256: string; bytes: number; width: number; height: number; mode: RecoveryMode; stored: boolean }
type Holder = { worker: string; orderId: string; project: string };

/** Every rule of who may upload, read from the ledger; the peer is the authenticated principal, never a field of the request. */
function holderOf(db: Database, peer: string, s: Pick<LendShot, "orderId" | "gen" | "head">, now: number): Holder | LendShotRefusal {
  const who = remoteCaller(db, peer, s, now);
  if ("refused" in who) return shotRefusal("not_held", who.refused);
  const o = getLendOrder(db, who.orderId);
  if (!o) return shotRefusal("not_held", "你没有持有这一单");
  if (!isWriteStep(o.step)) return shotRefusal("invalid", "只有开工 / 修复单收截图");
  const task = getTask(db, o.taskId);
  if (!task || cardMoved(task, o)) return shotRefusal("not_held", "卡已不在这一单的阶段 / 轮次");
  if (getWorkflow(db, task.id)?.template !== "ui") return shotRefusal("invalid", "这张卡不是 ui 模板，不收截图");
  if (heldLease(db, task)?.peer !== peer) return shotRefusal("not_held", "这张卡的写租约不在你名下");
  if (s.head === o.head) return shotRefusal("invalid", "head 是这一单的起点，没有新提交");
  return { worker: who.worker, orderId: o.orderId, project: o.project };
}

const lstat = (p: string): Stats | null => {
  try { return lstatSync(p); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
};
const realDir = (st: Stats): boolean => st.isDirectory() && !st.isSymbolicLink();

const layersOf = (importedRoot: string, parts: [string, string]): [string, string, string] =>
  [importedRoot, join(importedRoot, parts[0]), join(importedRoot, ...parts)];
/**
 * <imported>/<peer>/<order>: no existing layer may be a symlink or a non-directory. Creates nothing — asked before the order's
 * provenance is read, so a replay of a stored shot is refused on a linked directory like a new one and nothing is read through the link.
 */
const layersReal = (layers: string[]): boolean => layers.every((p) => { const st = lstat(p); return st === null || realDir(st); });

/** Missing layers are made one by one, 0700, each checked again once made. Above the imported root is this machine's own state dir. */
function ensureDir(layers: [string, string, string]): string | null {
  if (!layersReal(layers)) return null;
  mkdirSync(dirname(layers[0]), { recursive: true });
  for (const p of layers) {
    if (!lstat(p)) mkdirSync(p, { mode: 0o700 });
    if (!realDir(lstatSync(p))) return null;
  }
  return layers[2];
}

const refOf = (n: number): string => `s${String(n).padStart(2, "0")}.png`;
const answer = (ref: string, f: LendUiFile, mode: RecoveryMode, stored: boolean): LendShotStored =>
  ({ ok: true, v: 1, ref, sha256: f.sha256, bytes: f.bytes, width: f.width, height: f.height, mode, stored });

/** The slot rules against what this order already holds; a string = the conflict, an entry = the same bytes were stored before. */
function slotOf(prov: LendUiProvenance, peer: string, h: Holder, s: LendShot, sha256: string): [string, LendUiFile] | string | null {
  if (prov.peer !== peer || prov.worker !== h.worker || prov.orderId !== h.orderId) return "这一单已有的截图来源对不上";
  if (prov.head !== s.head) return "这一单的截图已按另一个 head 收下";
  const same = Object.entries(prov.files).find(([, f]) => f.view === s.view && f.size === s.size && f.phase === s.phase);
  if (same) return same[1].sha256 === sha256 ? same : `${s.view} @ ${s.size} 的 ${s.phase} 已收过另一张图`;
  return Object.keys(prov.files).length >= LEND_SHOT_LIMITS.slots ? `一单最多 ${LEND_SHOT_LIMITS.slots} 张截图` : null;
}

/** Synchronous from the ledger read to the last rename, so two uploads of one process never interleave; errors carry no local path. */
export function receiveLendShot(db: Database, peer: string, s: LendShot, deps: LendShotStoreDeps): LendShotStored | LendShotRefusal {
  const holder = holderOf(db, peer, s, deps.now());
  if ("ok" in holder) return holder;
  const mode = deps.mode(holder.project);
  if (mode === "off") return shotRefusal("shots_off", "这台机器没开收截图（lendUiShots = off）");
  const parts = lendUiDirParts(peer, holder.orderId);
  if (!parts) return shotRefusal("invalid", "peer 名 / 单号不能当目录名");
  const sha256 = createHash("sha256").update(s.png).digest("hex");
  const layers = layersOf(deps.importedRoot, parts);
  const linked = shotRefusal("unavailable", "截图目录不可用（有一层不是真目录），没写");
  try {
    if (!layersReal(layers)) return linked;
    const before = readLendUiProvenance(layers[2]);
    if (before.status === "corrupt") return shotRefusal("unavailable", "这一单的截图记录读不了，没写");
    const prov: LendUiProvenance = before.status === "ok" ? before.data : { v: 1, peer, worker: holder.worker, orderId: holder.orderId, head: s.head, files: {} };
    const slot = slotOf(prov, peer, holder, s, sha256);
    if (typeof slot === "string") return shotRefusal("conflict", slot);
    if (slot) return answer(slot[0], slot[1], mode, false);
    const dir = ensureDir(layers);
    if (!dir) return linked;
    const ref = refOf(Object.keys(prov.files).length + 1);
    const file: LendUiFile = { sha256, bytes: s.png.length, width: s.width, height: s.height, view: s.view, size: s.size, phase: s.phase, receivedAt: deps.now() };
    // image first: a crash in between leaves an unlisted file that the next upload of this order overwrites under the same name
    writeTextAtomicSync(join(dir, ref), s.png, { mode: 0o600, noFollow: true });
    writeTextAtomicSync(join(dir, LEND_UI_PROVENANCE), `${JSON.stringify({ ...prov, files: { ...prov.files, [ref]: file } }, null, 2)}\n`, { mode: 0o600, noFollow: true });
    return answer(ref, file, mode, true);
  } catch (e) {
    return shotRefusal("unavailable", `截图没存上（${(e as NodeJS.ErrnoException).code ?? "io"}），稍后重传`);
  }
}

const tails = new Map<string, Promise<void>>();
/** One order's uploads run one after another in this process, in arrival order, whatever the caller awaits around them. */
export function inOrderOf<T>(orderId: string, fn: () => T | Promise<T>): Promise<T> {
  const run = (tails.get(orderId) ?? Promise.resolve()).then(fn);
  const tail = run.then(() => {}, () => {});
  tails.set(orderId, tail);
  void tail.then(() => { if (tails.get(orderId) === tail) tails.delete(orderId); });
  return run;
}

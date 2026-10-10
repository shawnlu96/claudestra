/**
 * LENDUI1: provenance.json of one lend order's imported screenshots — who uploaded them (authenticated peer), for which order /
 * worker / head, and per stored file its sha256 (hashed here from the stored bytes), IHDR size and the slot it was uploaded for.
 * Read-only half: the delivery side (lend-ui-deliver.ts) imports only this file; the writer is lend-ui-store.ts.
 * The directory rule is the one ledger-deliver-ui.ts reads by: <imported>/<peer>/<orderId with ":" → "_">/.
 * tests/lend-ui-store.test.ts、tests/lend-ui-deliver.test.ts.
 */
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { SIZE, VIEW, type UiPhase } from "./order-deliver-ui.js";

export interface LendUiFile { sha256: string; bytes: number; width: number; height: number; view: string; size: string; phase: UiPhase; receivedAt: number }
export interface LendUiProvenance { v: 1; peer: string; worker: string; orderId: string; head: string; files: Record<string, LendUiFile> }
export type LendUiProvenanceRead = { status: "missing" } | { status: "ok"; data: LendUiProvenance } | { status: "corrupt"; error: string };

export const LEND_UI_PROVENANCE = "provenance.json";
const PROVENANCE_MAX = 64 * 1024;
const NAME = /^(?!\.\.?$)[\w.-]{1,64}$/;
const ORDER_DIR = /^(?!\.\.?$)[\w.-]{1,200}$/;
const REF = /^s(?:0[1-9]|1[0-6])\.png$/;
const HEX64 = /^[0-9a-f]{64}$/;
const SHA40 = /^[0-9a-f]{40}$/;

/** <peer>, <order dir> under the imported root; null = the peer name or order id cannot be a directory name here. */
export function lendUiDirParts(peer: string, orderId: string): [string, string] | null {
  const order = orderId.replaceAll(":", "_");
  return NAME.test(peer) && ORDER_DIR.test(order) ? [peer, order] : null;
}
export function lendUiDir(importedRoot: string, peer: string, orderId: string): string | null {
  const parts = lendUiDirParts(peer, orderId);
  return parts ? join(importedRoot, ...parts) : null;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const whole = (v: unknown, min: number): v is number => Number.isSafeInteger(v) && (v as number) >= min;
const exactKeys = (o: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(o).length === keys.length && keys.every((k) => k in o);

function fileOf(v: unknown): LendUiFile | null {
  if (!isObj(v) || !exactKeys(v, ["sha256", "bytes", "width", "height", "view", "size", "phase", "receivedAt"])) return null;
  const ok = typeof v.sha256 === "string" && HEX64.test(v.sha256) && whole(v.bytes, 1) && whole(v.width, 1) && whole(v.height, 1) && whole(v.receivedAt, 0)
    && typeof v.view === "string" && VIEW.test(v.view) && typeof v.size === "string" && SIZE.test(v.size) && (v.phase === "before" || v.phase === "after");
  return ok ? v as unknown as LendUiFile : null;
}

/** Strict: a file this module's writer did not produce (other keys, other refs, a bad entry) is corrupt, never half-read. */
function parseProvenance(raw: string): LendUiProvenance {
  const p: unknown = JSON.parse(raw);
  if (!isObj(p) || !exactKeys(p, ["v", "peer", "worker", "orderId", "head", "files"]) || p.v !== 1) throw new Error("格式不对");
  if (typeof p.peer !== "string" || typeof p.worker !== "string" || typeof p.orderId !== "string" || typeof p.head !== "string" || !SHA40.test(p.head)) throw new Error("来源字段不对");
  if (!isObj(p.files) || Object.entries(p.files).some(([ref, f]) => !REF.test(ref) || !fileOf(f))) throw new Error("文件记录不对");
  return p as unknown as LendUiProvenance;
}

/** Opened with O_NOFOLLOW and read from that fd: a symlinked provenance.json is corrupt, not followed. No directory = missing. */
export function readLendUiProvenance(dir: string): LendUiProvenanceRead {
  let fd: number;
  try {
    fd = openSync(join(dir, LEND_UI_PROVENANCE), constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? { status: "missing" } : { status: "corrupt", error: "打不开" };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > PROVENANCE_MAX) return { status: "corrupt", error: "不是普通文件或过大" };
    const buf = Buffer.alloc(st.size);
    for (let off = 0; off < st.size;) {
      const n = readSync(fd, buf, off, st.size - off, off);
      if (n <= 0) return { status: "corrupt", error: "读的时候文件变了" };
      off += n;
    }
    return { status: "ok", data: parseProvenance(buf.toString("utf8")) };
  } catch (e) {
    return { status: "corrupt", error: (e as Error).message };
  } finally {
    closeSync(fd);
  }
}

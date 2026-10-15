/**
 * The hand-off between the bridge and the scheduler for the repository owner's review pushes (RRL-1). The bridge writes one file
 * per accepted push (tmp + rename, 0600); the scheduler pass books each through `ledger scheduler-remote-review`, which reads the
 * file again here and re-runs every check on its own — the file names a card, it does not vouch for anything. Only plain files
 * directly in the inbox, never a link, at most the push cap plus the envelope. tests/remote-review-intake-ledger.test.ts.
 */
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { statePath } from "./paths.js";
import { PUSH_MAX_BYTES } from "./peer-pr-message.js";
import { writeTextAtomicSync } from "./state-file.js";

export const REMOTE_INBOX_DIR = statePath("ledger", "remote-review-inbox");
/** <receivedAt>-<card>~<report id>~<head12>.json: oldest first by name, and a push still waiting is found by its key. */
const NAME = /^\d{13}-[\w.-]{1,80}~PR\d{1,9}-r\d{1,4}~[0-9a-f]{12}\.json$/;
const FILE_MAX = PUSH_MAX_BYTES + 4096;

export interface InboxEntry { v: 1; peer: string; agent: string; taskId: string; receivedAt: number; text: string }

export interface InboxKey { taskId: string; reportId: string; head12: string }
const keyOf = (k: InboxKey): string => `${k.taskId}~${k.reportId}~${k.head12}`;

export function writeInbox(entry: Omit<InboxEntry, "v">, key: InboxKey, dir = REMOTE_INBOX_DIR): string {
  const name = `${entry.receivedAt}-${keyOf(key)}.json`;
  if (key.taskId !== entry.taskId || !NAME.test(name)) throw new Error(`收件名不合规：${name}`);
  const path = resolve(dir, name);
  writeTextAtomicSync(path, JSON.stringify({ v: 1, ...entry }), { mode: 0o600 });
  return path;
}

/** A push with this key is already waiting in the inbox (not yet booked by the scheduler). */
export const inInbox = (key: InboxKey, dir = REMOTE_INBOX_DIR): boolean => listInbox(dir).some((p) => p.endsWith(`-${keyOf(key)}.json`));

/** Inbox files oldest first; a tmp file of a write in progress has another name and is skipped. */
export function listInbox(dir = REMOTE_INBOX_DIR): string[] {
  try {
    return readdirSync(dir).filter((n) => NAME.test(n)).sort().map((n) => resolve(dir, n));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}

export function readInbox(path: string, dir = REMOTE_INBOX_DIR): InboxEntry {
  const full = resolve(path);
  if (dirname(full) !== resolve(dir) || !NAME.test(basename(full))) throw new Error("不是远端审查收件目录里的文件");
  const st = lstatSync(full);
  if (!st.isFile() || st.size > FILE_MAX) throw new Error("收件不是普通文件或太大");
  const raw = JSON.parse(readFileSync(full, "utf8")) as Partial<InboxEntry>;
  const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;
  if (raw.v !== 1 || !str(raw.peer) || !str(raw.agent) || !str(raw.taskId) || !Number.isInteger(raw.receivedAt) || !str(raw.text)) {
    throw new Error("收件字段不全");
  }
  return raw as InboxEntry;
}

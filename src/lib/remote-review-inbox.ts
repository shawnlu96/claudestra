/**
 * The hand-off between the bridge and the scheduler for the repository owner's review pushes (RRL-1). The bridge writes one file
 * per accepted push (tmp + rename, 0600); the scheduler pass books each through `ledger scheduler-remote-review`, which reads the
 * file again here and re-runs every check on its own — the file names a card, it does not vouch for anything. Only plain files
 * directly in the inbox, never a link, at most the push cap plus the envelope. tests/remote-review-intake-ledger.test.ts.
 */
import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { statePath } from "./paths.js";
import { PUSH_MAX_BYTES } from "./peer-pr-message.js";
import { writeTextAtomicSync } from "./state-file.js";

export const REMOTE_INBOX_DIR = statePath("ledger", "remote-review-inbox");
const NAME = /^\d{13}-[0-9a-f-]{36}\.json$/;
const FILE_MAX = PUSH_MAX_BYTES + 4096;

export interface InboxEntry { v: 1; peer: string; agent: string; taskId: string; receivedAt: number; text: string }

export function writeInbox(entry: Omit<InboxEntry, "v">, dir = REMOTE_INBOX_DIR): string {
  const path = resolve(dir, `${entry.receivedAt}-${randomUUID()}.json`);
  writeTextAtomicSync(path, JSON.stringify({ v: 1, ...entry }), { mode: 0o600 });
  return path;
}

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

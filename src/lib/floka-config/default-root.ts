/** Startup only resolves paths. It never migrates, creates directories, or generates identity.
 * Keep this entire import graph node-only: Pi loads state-dir through Node/Jiti.
 */
import { createHash, createPrivateKey } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { object, renameMode } from "./values.ts";

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
function stat(path: string) {
  try { return lstatSync(path); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}
function json(path: string): Record<string, any> {
  try { return object(JSON.parse(readFileSync(path, "utf8"))); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT" || e instanceof SyntaxError) return {};
    throw e;
  }
}
function names(path: string): string[] {
  try { return readdirSync(path); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}

/** Same byte-level anchor as STATE1, without importing its asynchronous migration graph. */
function identity(root: string): string | null {
  const files = ["instance-id", "instance-key.pem"].map(n => join(root, n));
  if (!files.every(p => stat(p)?.isFile())) return null;
  const [id, key] = files.map(p => readFileSync(p));
  if (!/^[\w-]{1,64}$/.test(id!.toString().trim())) return null;
  try {
    if (createPrivateKey(key!).asymmetricKeyType !== "ed25519") return null;
  } catch { return null; } // Invalid keys cannot prove an existing identity; never print their contents.
  return hash(Buffer.concat([id!, key!].map(b => Buffer.from(hash(b), "hex")))).slice(0, 24);
}

/** Only checksum-valid, complete STATE1 journals can authorize the new default. */
function committedJournal(path: string, oldRoot: string, newRoot: string, anchor: string): boolean {
  const { checksum, ...j } = json(path);
  if (checksum !== hash(JSON.stringify(j)) || j.version !== 2 || basename(path) !== `${j.txId}.journal.json`) return false;
  if (j.status !== "committed" || j.commitPoint !== 1 || JSON.stringify(j.plan) !== '["state-move","state-alias"]') return false;
  if (!Array.isArray(j.steps) || j.steps.length !== 2) return false;
  if (!j.steps.every((s: any, i: number) => s.id === j.plan[i] && s.item === "rename.state" && s.state === "applied"
    && s.beforeSum === hash(JSON.stringify(s.before)))) return false;
  const move = object(j.steps[0].before), alias = object(j.steps[1].before);
  return move.from === resolve(oldRoot) && move.to === resolve(newRoot) && move.identity === anchor
    && alias.link === resolve(oldRoot) && alias.target === resolve(newRoot);
}

function hasCommit(home: string, oldRoot: string, newRoot: string, anchor: string): boolean {
  const journals = join(home, ".claudestra-maintenance", "state", "journals");
  let latest = -Infinity, committed = false;
  for (const run of names(journals)) {
    const dir = join(journals, run);
    if (!stat(dir)?.isDirectory()) continue;
    for (const name of names(dir)) {
      const path = join(dir, name), file = stat(path);
      if (!name.endsWith(".journal.json") || !file?.isFile()) continue;
      const j = json(path);
      if (!Array.isArray(j.plan)) return false; // A damaged later journal cannot revive an older proof.
      if (!j.plan.some((s: unknown) => typeof s === "string" && s.startsWith("state-"))) continue;
      // A subsequent interrupted/rolled-back state transaction supersedes an older successful proof.
      // Tied timestamps are conservative: every tied journal must prove a committed forward move.
      if (file.mtimeMs < latest) continue;
      const valid = committedJournal(path, oldRoot, newRoot, anchor);
      committed = file.mtimeMs === latest ? committed && valid : valid;
      latest = file.mtimeMs;
    }
  }
  return committed;
}

/** stateDirIn remains the stable legacy location used by migration planning and isolation guards. */
export function defaultStateRoot(home: string, oldRoot: string): string {
  const next = join(home, ".floka");
  const oldStat = stat(oldRoot), newStat = stat(next);
  if (!newStat) return oldRoot;
  if (!newStat.isDirectory()) throw new Error("floka state root is not a plain directory; refusing default resolution");
  const oldId = oldStat ? identity(oldRoot) : null;
  const newId = identity(next);
  if (oldId && newId && oldId !== newId) throw new Error("legacy and floka state identities conflict; refusing default resolution");
  const alias = oldStat?.isSymbolicLink() && realpathSync(oldRoot) === realpathSync(next);
  if (oldStat && !oldStat.isDirectory() && !alias) throw new Error("unknown legacy state alias; refusing default resolution");
  if (!oldStat) throw new Error("legacy state root missing without its committed alias; recover the interrupted migration first");
  if (!alias && !oldId) throw new Error("legacy state root has no valid identity while a new root exists; refusing identity generation");
  if (!alias) return oldRoot; // Includes an empty new root. Existing identity always stays on the legacy root.
  if (!newId) throw new Error("floka state alias has no valid identity; refusing identity generation");
  const mode = renameMode(object(json(join(oldRoot, "config.json")).rename).state);
  if (mode !== "on") return oldRoot;
  return hasCommit(home, oldRoot, next, newId) ? next : oldRoot;
}

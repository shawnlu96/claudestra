/**
 * dispatch-recovery-POOLRV1 r1: the lend result request A actually received, kept byte for byte on A only. The bridge decodes the
 * verified body as strict UTF-8 (no replacement, BOM kept), so the text the writer gets re-encodes to exactly those bytes. Files live
 * under an A-chosen directory, named by their own sha256 (dir 0700, file 0600, linked into place: never overwritten). A file
 * no ledger event names is an orphan, not a proof. tests/pool-review-proof-raw.test.ts.
 */
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { basename, join } from "node:path";

/** Lossless text of the received body, or null: invalid UTF-8 is refused instead of decoded with U+FFFD. */
export function strictUtf8(bytes: ArrayBuffer | Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

const sha256 = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

export interface RawRef { sha256: string; path: string; bytes: number }

/** Store `text` as `<dir>/<sha256>.json`; an existing file must hold the same bytes (a content-addressed name), anything else throws. */
export function saveRawResult(dir: string, text: string): RawRef {
  const bytes = Buffer.from(text, "utf8");
  const sha = sha256(bytes);
  const path = join(dir, `${sha}.json`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const tmp = join(dir, `.${sha}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, bytes);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  try {
    linkSync(tmp, path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    if (rawProblem({ sha256: sha, path, bytes: bytes.length })) throw new Error(`原件 ${basename(path)} 已存在但内容不同，不覆盖`);
  } finally { unlinkSync(tmp); }
  return { sha256: sha, path, bytes: bytes.length };
}

/** null = the file is there, a regular 0600 file, and its bytes still hash to the name and the recorded digest. */
export function rawProblem(ref: RawRef): string | null {
  if (!/^[0-9a-f]{64}$/.test(ref.sha256) || basename(ref.path) !== `${ref.sha256}.json`) return "原件路径不是按内容哈希命名的";
  let b: Buffer;
  try {
    const st = statSync(ref.path);
    if (!st.isFile() || (st.mode & 0o077) !== 0) return "原件不是只属本机用户的普通文件";
    b = readFileSync(ref.path);
  } catch {
    return "原件缺失或读不到";
  }
  return b.length === ref.bytes && sha256(b) === ref.sha256 ? null : "原件内容和记下的哈希对不上";
}

/** The archived text back (for locating the parsed report / findings), or null when rawProblem says it is not intact. */
export function readRawResult(ref: RawRef): string | null {
  return rawProblem(ref) ? null : readFileSync(ref.path, "utf8");
}

/** Shared report writer: refuse SQLite databases and ledger sidecars, then replace the directory entry atomically. */
import { closeSync, existsSync, lstatSync, openSync, readSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, type Stats } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { LedgerError } from "./ledger-store.js";

const lstatOrNull = (p: string): Stats | null => {
  try {
    return lstatSync(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
};

function isSqlite(p: string): boolean {
  const fd = openSync(p, "r");
  try {
    const head = Buffer.alloc(16);
    return readSync(fd, head, 0, 16, 0) === 16 && head.toString("latin1") === "SQLite format 3\0";
  } finally {
    closeSync(fd);
  }
}

/**
 * dry-run 报告落盘：目标（按真实目录解析，软链目录也算）不能是台账库或它的 -wal / -shm / -journal，已有文件必须是普通文件、
 * 不是库的硬链、也不是 SQLite 库（备份等）。写法是同目录临时文件再 rename：rename 只换目录项，检查之后目标被换成软链或硬链也写不进库。
 * 少了这道闸，`--out ledger.sqlite` 会把库整个覆写成 markdown（tests/ledger-feature-l3.test.ts「--out 落到库」）。
 */
export function writeMemoryImportReport(out: string, dbPath: string, md: string): void {
  const refuse = (why: string): never => {
    throw new LedgerError("invalid", `--out ${out} ${why}，报告没写`);
  };
  let target: string;
  try {
    target = join(realpathSync(dirname(resolve(out))), basename(out));
  } catch (e) {
    return refuse(`所在目录读不了（${(e as Error).message}）`);
  }
  const dbReal = dbPath && dbPath !== ":memory:" && existsSync(dbPath) ? realpathSync(dbPath) : null;
  const guarded = dbReal ? ["", "-wal", "-shm", "-journal"].map((s) => dbReal + s) : [];
  if (guarded.includes(target)) refuse("是台账库或它的 -wal / -shm / -journal");
  const st = lstatOrNull(target);
  if (st) {
    if (!st.isFile()) refuse("已存在且不是普通文件（软链、目录等）");
    if (guarded.some((g) => existsSync(g) && statSync(g).ino === st.ino && statSync(g).dev === st.dev)) refuse("是台账库或旁路文件的硬链");
    if (isSqlite(target)) refuse("已存在且是 SQLite 库");
  }
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, md, { flag: "wx" });
    renameSync(tmp, target);
  } finally {
    if (existsSync(tmp)) rmSync(tmp);
  }
}

/**
 * 台账迁移前的整库备份：库文件旁的 backups/ledger.sqlite.pre-v<目标版本>.bak，回滚 = 停服务后拿它换回 ledger.sqlite。
 * VACUUM INTO 是一致读（WAL 里已提交的都在），先写临时文件再 link 成正式名：link 不覆盖，并发首开时只有一个进程的留下，
 * 进程中途挂掉也不会留一个半截文件冒充备份。同名备份已在 = 这次升级之前已经备过，跳过（重开幂等）。
 * 备份失败就抛：调用方不迁移（fail-closed），库保持原版本，老代码照常能用。
 */
import type { Database } from "bun:sqlite";
import { existsSync, linkSync, mkdirSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export function ledgerBackupPath(path: string, target: number): string {
  return join(dirname(path), "backups", `${basename(path)}.pre-v${target}.bak`);
}

/** 需要时备份，返回备份文件路径；新库（v0）、内存库、已是目标版本都不备份，返回 null */
export function backupBeforeMigrate(db: Database, path: string, from: number, target: number): string | null {
  if (path === ":memory:" || from === 0 || from >= target) return null;
  const dest = ledgerBackupPath(path, target);
  if (existsSync(dest)) return dest;
  const tmp = `${dest}.${process.pid}.${Date.now()}.tmp`;
  try {
    mkdirSync(dirname(dest), { recursive: true });
    db.prepare("VACUUM INTO ?").run(tmp);
    linkSync(tmp, dest);
  } catch (e) {
    // 只有 link 撞 EEXIST 算正常（别的进程先备好了）；mkdir 撞同名文件也是 EEXIST，所以再看一眼备份在不在
    if ((e as NodeJS.ErrnoException).code !== "EEXIST" || !existsSync(dest)) {
      throw new Error(`台账迁移前备份失败（${(e as Error).message}），未迁移，库仍是 v${from}`, { cause: e });
    }
  } finally {
    // 先看在不在：backups 不是目录时 rm 自己也会抛，盖掉上面那句「备份失败」
    if (existsSync(tmp)) rmSync(tmp);
  }
  return dest;
}

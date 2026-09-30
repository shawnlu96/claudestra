/**
 * 台账迁移前的整库备份：库文件旁的 backups/，回滚 = 停服务后拿它换回 ledger.sqlite。判「要不要备」与 runMigrations 同口径：
 * 版本落后（升级，备成 pre-v<目标版本>.bak），或版本已到而表 / 列 / 索引缺（并行分支撞了迁移编号，runMigrations 会重跑补齐；
 * 备成 pre-v<目标版本>.repair-<缺什么的摘要>.bak——不能因为版本号已到就跳过，也不能拿升级那份旧备份顶替）。
 * VACUUM INTO 是一致读，先写临时文件再 link 成正式名：link 不覆盖，并发首开只留一份，进程中途挂掉也不会留半截文件冒充备份。
 * 同名备份已在 = 这次改库之前已经备过，跳过（重开 / 补迁移失败后重试都幂等）。备份失败就抛：调用方不迁移，库保持原样。
 */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, linkSync, mkdirSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export function ledgerBackupPath(path: string, target: number, repair = ""): string {
  return join(dirname(path), "backups", `${basename(path)}.pre-v${target}${repair && `.repair-${repair}`}.bak`);
}

/** 需要时备份，返回备份文件路径；新库（v0）、内存库、版本已到且 schema 完整（这次打开不改库）都不备份，返回 null */
export function backupBeforeMigrate(db: Database, path: string, from: number, target: number, missing: readonly string[]): string | null {
  if (path === ":memory:" || from === 0 || (from >= target && missing.length === 0)) return null;
  const repair = from >= target ? createHash("sha256").update(missing.join("\n")).digest("hex").slice(0, 8) : "";
  return vacuumBackup(db, ledgerBackupPath(path, target, repair), `台账迁移前备份失败`, `未迁移，库仍是 v${from}`);
}

/**
 * VACUUM INTO 临时文件再 link 成 dest；失败抛「<what>（原因），<after>」，调用方据此不改库。
 * reuse = 同名已在就当已备过（schema 升级：名字由目标版本决定，同名 = 同一次改库前的快照）；
 * 传 false 时同名已在也算失败——名字不能证明内容是这次改库前的样子（feature 迁移失败后库被改过再重试）。
 */
export function vacuumBackup(db: Database, dest: string, what: string, after: string, reuse = true): string {
  if (reuse && existsSync(dest)) return dest;
  const tmp = `${dest}.${process.pid}.${Date.now()}.tmp`;
  try {
    mkdirSync(dirname(dest), { recursive: true });
    db.prepare("VACUUM INTO ?").run(tmp);
    linkSync(tmp, dest);
  } catch (e) {
    // 只有 link 撞 EEXIST 算正常（别的进程先备好了）；mkdir 撞同名文件也是 EEXIST，所以再看一眼备份在不在
    if (!reuse || (e as NodeJS.ErrnoException).code !== "EEXIST" || !existsSync(dest)) {
      throw new Error(`${what}（${(e as Error).message}），${after}`, { cause: e });
    }
  } finally {
    // 先看在不在：backups 不是目录时 rm 自己也会抛，盖掉上面那句「备份失败」
    if (existsSync(tmp)) rmSync(tmp);
  }
  return dest;
}

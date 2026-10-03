#!/usr/bin/env bun
/**
 * 共享台账中心的每日一致性备份（claudestra-shared-ledger-backup.service 调用，服务账号运行）。
 * VACUUM INTO 在一个读事务里写出完整、无 WAL 依赖的新库，服务照常写入不受影响；先写 .partial、校验通过再改名，
 * 半截文件不会被当成备份。备份文件 0600；只按名字清理本脚本写的 shared-ledger-*.sqlite，超过保留天数的删除。
 * 用法：bun backup.ts <库路径> <备份目录> [保留天数，默认 7]
 */
import { Database } from "bun:sqlite";
import { chmodSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

const NAME = /^shared-ledger-\d{8}T\d{6}Z\.sqlite$/;

export function backupLedger(dbPath: string, dir: string, keepDays = 7, now = new Date()): { file: string; pruned: string[] } {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const file = join(dir, `shared-ledger-${stamp}.sqlite`);
  const partial = `${file}.partial`;
  rmSync(partial, { force: true });
  const source = new Database(dbPath, { readonly: true, strict: true });
  try { source.run("VACUUM INTO ?", [partial]); }
  finally { source.close(); }
  chmodSync(partial, 0o600);
  const copy = new Database(partial, { readonly: true });
  try {
    const row = copy.query("PRAGMA quick_check").get() as Record<string, string> | null;
    if (Object.values(row ?? {})[0] !== "ok") throw new Error(`备份校验失败：${partial}`);
  } finally { copy.close(); }
  renameSync(partial, file);
  const cutoff = now.getTime() - keepDays * 86_400_000;
  const pruned = readdirSync(dir).filter((n) => NAME.test(n) && join(dir, n) !== file && statSync(join(dir, n)).mtimeMs < cutoff);
  for (const n of pruned) rmSync(join(dir, n));
  return { file, pruned };
}

if (import.meta.main) {
  const [dbPath, dir, keep] = Bun.argv.slice(2);
  const keepDays = keep === undefined ? 7 : Number(keep);
  if (!dbPath || !dir || !Number.isInteger(keepDays) || keepDays < 1) {
    console.error("用法: bun backup.ts <库路径> <备份目录> [保留天数]");
    process.exit(2);
  }
  const { file, pruned } = backupLedger(dbPath, dir, keepDays);
  console.log(`备份 ${file}${pruned.length ? `；清理 ${pruned.length} 份过期备份` : ""}`);
}

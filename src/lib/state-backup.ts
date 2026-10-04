/**
 * 关键状态文件的快照与恢复（bridge 每小时一份，`manager state-backup list|now|restore`），外加「文件消失就报警」的检查。
 * 这些文件丢了没有别处可以重建（登录 / API 令牌、peer 联系方式与钉住的公钥、出借授权），所以单独快照到 backups/state/<时间戳>/。
 * 里面有明文密钥：目录 0700、文件 0600。tests/state-backup.test.ts。
 */
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { acquireLock } from "./file-lock.js";
import { STATE_DIR } from "./paths.js";
import { principalsLockPath } from "./principals.js";
import { REGISTRY_PATH } from "./registry.js";
import { writeTextAtomicSync } from "./state-file.js";

/** 只快照 / 恢复这些（restore 的文件名白名单，也挡住路径穿越） */
export const BACKUP_FILES: readonly string[] = [
  "principals.json", "peers.json", "peer-keys.json", "lend.json", basename(REGISTRY_PATH), "cron.json", "projects.json", "config.json",
  "shared-ledger-bindings.json", "shared-ledger-credentials.json",
];
/** 每分钟查一次在不在：丢了就踢掉所有设备 / 断掉所有 peer 的两个 */
const WATCHED_FILES = ["principals.json", "peers.json"];
export const KEEP_SNAPSHOTS = 48;

const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;
const backupRoot = (dir: string) => join(dir, "backups", "state");
const stamp = (now: Date) => now.toISOString().replace(/[:.]/g, "-");

export interface Snapshot { ts: string; files: string[] }

/** 从旧到新；只认时间戳名的目录（写到一半的 .partial 不算） */
export function listSnapshots(dir = STATE_DIR): Snapshot[] {
  const root = backupRoot(dir);
  if (!existsSync(root)) return [];
  return readdirSync(root).filter((n) => TS_RE.test(n)).sort()
    .map((ts) => ({ ts, files: readdirSync(join(root, ts)).filter((f) => BACKUP_FILES.includes(f)).sort() }));
}

/** 最近一份含 name 的快照（报警时给恢复命令用；文件丢了之后的快照里没有它） */
export function latestSnapshotWith(name: string, dir = STATE_DIR): string | null {
  return listSnapshots(dir).reverse().find((s) => s.files.includes(name))?.ts ?? null;
}

function readCurrent(dir: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  for (const f of BACKUP_FILES) if (existsSync(join(dir, f))) out.set(f, readFileSync(join(dir, f)));
  return out;
}

function sameAs(cur: Map<string, Buffer>, snap: Snapshot | undefined, dir: string): boolean {
  if (!snap || snap.files.length !== cur.size) return false;
  return snap.files.every((f) => cur.get(f)?.equals(readFileSync(join(backupRoot(dir), snap.ts, f))) ?? false);
}

/** 留最新 keep 份；另外每个文件最新的那份也留着——文件丢了没人管，48 小时后不至于连最后一份都轮转掉 */
function rotate(dir: string, keep: number): void {
  const all = listSnapshots(dir);
  const kept = new Set(all.slice(-keep).map((s) => s.ts));
  for (const f of BACKUP_FILES) { const ts = latestSnapshotWith(f, dir); if (ts) kept.add(ts); }
  for (const s of all) if (!kept.has(s.ts)) rmSync(join(backupRoot(dir), s.ts), { recursive: true, force: true });
}

/** 快照一份；和上一份逐字节一样（或一个文件都没有）就不建，返回 created:false 和上一份的时间戳 */
export function takeSnapshot(dir = STATE_DIR, now = new Date(), keep = KEEP_SNAPSHOTS): { created: boolean; ts: string | null; files: string[] } {
  const cur = readCurrent(dir);
  const last = listSnapshots(dir).at(-1);
  if (!cur.size || sameAs(cur, last, dir)) return { created: false, ts: last?.ts ?? null, files: last?.files ?? [] };
  const root = backupRoot(dir);
  // 逐级建、逐级核：backups 或 backups/state 是软链就会把密钥写到状态目录外，连空目录也不在外面建
  for (const rel of ["backups", join("backups", "state")]) {
    if (!existsSync(join(dir, rel))) mkdirSync(join(dir, rel), { mode: 0o700 });
    if (!noSymlinkUnder(dir, rel)) throw new Error(`备份目录 ${join(dir, rel)} 经软链指到了别处，不快照`);
  }
  chmodSync(root, 0o700);
  const ts = stamp(now);
  // 先写进隐藏目录再改名：写到一半挂掉不会留下一份残缺快照给 restore 用
  const tmp = join(root, `.${ts}.${process.pid}.partial`);
  mkdirSync(tmp, { mode: 0o700 });
  for (const [f, buf] of cur) writeFileSync(join(tmp, f), buf, { mode: 0o600 });
  renameSync(tmp, join(root, ts));
  rotate(dir, keep);
  return { created: true, ts, files: [...cur.keys()].sort() };
}

export type RestoreResult = { ok: true; restored: string[]; safetyTs: string | null } | { ok: false; error: string };

/** dir 下的 rel 解析软链后还在 dir 下同一个位置（中间哪一段是软链都不行）。解析不了（不存在 / 读不了）就当不安全，调用方拒掉 */
function noSymlinkUnder(dir: string, rel: string): boolean {
  try { return realpathSync(join(dir, rel)) === join(realpathSync(dir), rel); } catch { return false; }
}

/** 恢复的目标要么不存在、要么是普通文件：软链 / 目录一律拒，不跟着软链写到状态目录外 */
function targetProblem(dir: string, name: string): string | null {
  let st: ReturnType<typeof lstatSync>;
  try { st = lstatSync(join(dir, name)); } catch { return null; /* 不存在：正是要恢复的情形 */ }
  return st.isFile() ? null : `${join(dir, name)} 不是普通文件（软链 / 目录），不恢复；先手动挪走它`;
}

/**
 * 恢复 ts 那份里的 names（缺省 = 那份里全部）；先把当前文件快照一份，恢复错了还能回去。
 * holds：写之前最后核一次 principals 锁还在手里（restoreLocked 给）；从这里到写完都是同步的，中间不会被别的写者插进来。
 */
export function restoreSnapshot(ts: string, names: string[], dir = STATE_DIR, now = new Date(), holds: () => boolean = () => true): RestoreResult {
  if (!TS_RE.test(ts)) return { ok: false, error: `时间戳格式不对：${ts}（用 state-backup list 里的）` };
  const snap = listSnapshots(dir).find((s) => s.ts === ts);
  if (!snap) return { ok: false, error: `没有这份快照：${ts}` };
  const bad = names.filter((n) => !BACKUP_FILES.includes(n));
  if (bad.length) return { ok: false, error: `只能恢复这些文件：${BACKUP_FILES.join(" ")}；不认：${bad.join(" ")}` };
  const want = names.length ? names : snap.files;
  const missing = want.filter((n) => !snap.files.includes(n));
  if (missing.length) return { ok: false, error: `${ts} 这份里没有：${missing.join(" ")}` };
  const rel = (n: string) => join("backups", "state", ts, n);
  const escaped = want.filter((n) => !noSymlinkUnder(dir, rel(n)) || !lstatSync(join(dir, rel(n))).isFile());
  if (escaped.length) return { ok: false, error: `快照里的 ${escaped.join(" ")} 不是备份目录里的普通文件（经软链指到了别处），不恢复` };
  const blocked = want.map((n) => targetProblem(dir, n)).filter((p): p is string => !!p);
  if (blocked.length) return { ok: false, error: blocked.join("；") };
  // 先读进内存：下面的安全快照会轮转，可能正好删掉最旧的这一份
  const data = want.map((n) => [n, readFileSync(join(dir, rel(n)), "utf8")] as const);
  if (!holds()) return { ok: false, error: "principals 锁已经不在手里，什么都没写；稍后重试" };
  const safety = takeSnapshot(dir, now);
  // noFollow：目标在上面核完之后被换成软链，替换的也是软链本身，不会写到它指的文件
  for (const [n, text] of data) writeTextAtomicSync(join(dir, n), text, { mode: 0o600, noFollow: true });
  return { ok: true, restored: want, safetyTs: safety.ts };
}

/**
 * CLI 的恢复入口：先拿 principals 锁（和 bridge 的设备凭据写 updatePrincipals 互斥，不然它拿旧副本写回会把恢复吃掉）。
 * 拿不到就拒，不像命令级写锁那样降级继续：恢复正是要和那些写者错开。等 5 秒和 updatePrincipals 一样，那些写都很短，等不到就让人重试。
 * tests/state-backup-lock.test.ts
 */
export async function restoreLocked(ts: string, names: string[], o: { dir?: string; waitMs?: number } = {}): Promise<RestoreResult> {
  const dir = o.dir ?? STATE_DIR;
  const lock = await acquireLock(principalsLockPath(join(dir, "principals.json")), o.waitMs ?? 5_000);
  if (!lock) return { ok: false, error: "principals 锁被占着（bridge 在写设备凭据，或有别的写命令在跑），什么都没写；稍后重试" };
  try { return restoreSnapshot(ts, names, dir, new Date(), lock.held); } finally { lock.release(); }
}

/**
 * 守护的一拍（bridge 每分钟调一次）：上一拍在、这一拍不见了的 WATCHED_FILES 各报一次；还没回来就不再报，回来之后再丢会再报。
 * 每 backupEvery 拍（第一拍也算）快照一份。启动时就已经不在的文件不报：没有「原本存在」的依据。
 */
export function stateGuard(o: { notify: (title: string, body: string) => void; log: (line: string) => void; dir?: string; backupEvery?: number }): () => void {
  const dir = o.dir ?? STATE_DIR;
  let prev: Set<string> | null = null;
  let ticks = 0;
  return () => {
    const present = new Set<string>(WATCHED_FILES.filter((f) => existsSync(join(dir, f))));
    for (const f of WATCHED_FILES) {
      if (!prev?.has(f) || present.has(f)) continue;
      let ts: string | null = null;
      try { ts = latestSnapshotWith(f, dir); } catch (e) { o.log(`⚠️ 读备份目录失败：${(e as Error).message}`); /* 报警照发，只是不带恢复命令 */ }
      const how = ts ? `最近一份备份 ${ts}，恢复：bun src/manager.ts state-backup restore ${ts} ${f}` : "没有找到含这个文件的备份";
      o.log(`🚨 关键状态文件 ${join(dir, f)} 不见了；${how}`);
      o.notify(`${f} 不见了`, `关键状态文件 ${f} 刚被删掉（设备登录 / peer 连接会断）。${how}`);
    }
    prev = present;
    if (ticks++ % (o.backupEvery ?? 60) !== 0) return;
    try {
      takeSnapshot(dir);
    } catch (e) {
      o.log(`⚠️ 状态文件快照失败：${(e as Error).message}`);
    }
  };
}

/**
 * 全量测试闸的进程树记录 trees/<id>.json（docs/architecture/full-test-gate.md）。持有者（runFullTestGate 的 track）和观察者（observeTree，
 * 别的申请者经 permit 采样时调）都会「读 → 剪 / 并 → 写回」；两边经 mergeTreeRecord 这一个写入口：在同一把文件锁里重读最新记录，
 * 按三方合并（读到时的 base、自己算出的 next、此刻的 latest）——别人在 base 之后并进来的成员 / 键保留，自己剪掉的不复活。
 * 坏记录按 unknown 保槽，不覆盖。tests/full-test-gate-record.test.ts。
 *
 * 锁（tree-locks/<id>.lock）与 src/lib/file-lock.ts 同一套落盘协议（mkdir 抢占 + owner token，lockOwnedBy 核对后才删），但这里要同步：observeTree 是
 * lend-check-permit 同步依赖里调的，等不了 acquireLock 的 Promise。持有时间只有一次读 + 写，拿不到就不写（调用方按 unknown / 下轮再写）。
 */
import { mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { lockOwnedBy } from "./file-lock.js";
import { normalizeKeys, type Key, type TreeRoot } from "./full-test-gate-tree.js";
import { readJsonStateSync, writeJsonAtomicSync } from "./state-file.js";

const LOCK_WAIT_MS = 2_000;
const LOCK_STALE_MS = 10_000;

const memberSchema = z.object({ pid: z.number().int().positive(), start: z.string().nullable(), uniq: z.string().nullable(),
  ver: z.number().int().nullable() }).strict();
const keySchema = z.union([z.number().int().positive(), z.object({ id: z.number().int().positive(), leaderStart: z.string().nullable() }).strict()]);
const treeSchema = z.union([
  z.object({ state: z.literal("spawning") }).strict(),
  z.object({ state: z.literal("running"), pgid: z.number().int().positive(), start: z.string().nullable(), uniq: z.string().nullable(),
    ver: z.number().int().nullable(), uid: z.number().int().nullable(), members: z.array(memberSchema),
    boot: z.string().nullable().optional(), pgids: z.array(keySchema).optional(), sids: z.array(keySchema).optional(),
    quietAt: z.number().optional() }).strict(),
]);
export type TreeRecord = z.infer<typeof treeSchema>;

export function treePath(dir: string, id: string): string {
  return join(dir, "trees", `${id}.json`);
}

/** 读记录：没有 = "missing"；读不出 / 格式不对 = null（调用方按 unknown） */
export function readTreeRecord(dir: string, id: string): TreeRecord | "missing" | null {
  const read = readJsonStateSync(treePath(dir, id));
  if (read.status === "missing") return "missing";
  if (read.status === "corrupt") return null;
  const tree = treeSchema.safeParse(read.data);
  return tree.success ? tree.data : null;
}

/** 锁目录放在 trees/ 外：trees/ 里只有记录本身，逐个读的人不会读到目录 */
export function treeLockPath(dir: string, id: string): string {
  return join(dir, "tree-locks", `${id}.lock`);
}

/** 持有 tree-locks/<id>.lock 时同步执行 fn；等不到锁返回 "locked" */
function withRecordLock<T>(dir: string, id: string, fn: () => T): T | "locked" {
  const lock = treeLockPath(dir, id);
  const token = `${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 10)}`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  mkdirSync(join(dir, "tree-locks"), { recursive: true, mode: 0o700 });
  for (;;) {
    try {
      mkdirSync(lock);
      writeFileSync(join(lock, "owner"), token);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") rmSync(lock, { recursive: true, force: true }); // 建了锁、token 没写进去
      // 持有者只做一次读写；锁老过 LOCK_STALE_MS = 持有者死在临界区里，挪走再抢（挪名是原子的，两个回收者只有一个成功）
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) {
          const tmp = `${lock}.stale-${token}`;
          renameSync(lock, tmp);
          rmSync(tmp, { recursive: true, force: true });
          continue;
        }
      } catch { /* 刚被释放 / 别人先回收了：下一轮再抢 */ }
      if (Date.now() >= deadline) return "locked";
      Bun.sleepSync(5);
    }
  }
  try { return fn(); } finally { if (lockOwnedBy(lock, token)) rmSync(lock, { recursive: true, force: true }); }
}

export type WriteResult = { status: "written"; tree: TreeRoot } | { status: "missing" | "corrupt" | "locked" } | { status: "failed"; error: string };

/** 整份写（spawning、刚认出根的 running）：只有持有者在这时写，同样经锁，免得与观察者的合并交错 */
export function writeTreeRecord(dir: string, id: string, record: TreeRecord): void {
  const r = withRecordLock(dir, id, () => writeJsonAtomicSync(treePath(dir, id), record));
  if (r === "locked") throw new Error(`进程树记录 ${id} 的锁等不到`);
}

/** 三方合并：保留 next 里 latest 也有的、或 base 之后才出现的；再补上 latest 在 base 之后新增的。同一 key 以 next 为准 */
function merge3<T>(base: T[], next: T[], latest: T[], key: (x: T) => string): T[] {
  const b = new Set(base.map(key));
  const l = new Set(latest.map(key));
  const out = new Map<string, T>();
  for (const x of next) if (l.has(key(x)) || !b.has(key(x))) out.set(key(x), x);
  for (const x of latest) if (!b.has(key(x)) && !out.has(key(x))) out.set(key(x), x);
  return [...out.values()];
}

function mergeKeys(root: TreeRoot, base: TreeRoot, next: TreeRoot, latest: TreeRoot, kind: "pgid" | "sid"): Key[] {
  const field = kind === "pgid" ? "pgids" : "sids";
  const keys = merge3(normalizeKeys(root, base[field], kind), normalizeKeys(root, next[field], kind), normalizeKeys(root, latest[field], kind),
    (k) => `${k.id}@${k.leaderStart}`);
  // 同一个号只留一把（next 的在前：它是按更新的进程表剪过、补过组长时刻的）
  return keys.filter((k, i) => keys.findIndex((x) => x.id === k.id) === i);
}

/**
 * 读 → 剪 / 并之后的唯一写入口。base = 调用方当初读到（或上次写成）的记录，next = 它按自己的进程表算出的新记录。
 * 锁内重读：没有了（已释放删掉）/ 不是 running → missing，不重建；坏记录 → corrupt，不覆盖。返回实际落盘的合并结果
 */
export function mergeTreeRecord(dir: string, id: string, base: TreeRoot, next: TreeRoot): WriteResult {
  try {
    const r = withRecordLock(dir, id, (): WriteResult => {
      const read = readTreeRecord(dir, id);
      if (read === null) return { status: "corrupt" };
      if (read === "missing" || read.state !== "running") return { status: "missing" };
      const { state: _, ...latest } = read;
      const memberKey = (m: { pid: number; start: string | null }) => `${m.pid}@${m.start}`;
      const members = merge3(base.members, next.members, latest.members, memberKey);
      const baseMembers = new Set(base.members.map(memberKey));
      const othersAdded = latest.members.some((m) => !baseMembers.has(memberKey(m)));
      const quietAt = othersAdded ? latest.quietAt : next.quietAt === undefined ? undefined : Math.min(next.quietAt, latest.quietAt ?? Infinity);
      const tree: TreeRoot = { ...latest, members, pgids: mergeKeys(latest, base, next, latest, "pgid"), sids: mergeKeys(latest, base, next, latest, "sid") };
      if (quietAt === undefined) delete tree.quietAt;
      else tree.quietAt = quietAt;
      writeJsonAtomicSync(treePath(dir, id), { state: "running", ...tree });
      return { status: "written", tree };
    });
    return r === "locked" ? { status: "locked" } : r;
  } catch (e) {
    return { status: "failed", error: String(e) };
  }
}

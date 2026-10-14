/**
 * 只读判定:两个根的形态、身份文件、以及迁移 / 回滚前必须拒绝的情形。这里没有任何写操作,
 * observe 和事务的冲突检查都走它。身份只读不生成——缺了就拒绝,空根永远不会被当成可用的根。
 */

import { createHash, createPrivateKey } from "crypto";
import { basename, dirname, isAbsolute, join, resolve, sep } from "path";
import { stateDirIn } from "../../state-dir.ts";
import type { Layout, NodeStat, StateFs, StateMigrationOptions } from "./types.ts";

/** 实例身份文件(lib/instance-id.ts、lib/instance-key.ts 的文件名);迁移前后必须逐字节相同 */
const IDENTITY_FILES = ["instance-id", "instance-key.pem"] as const;
/** 新根的默认目录名(home 下) */
const NEW_ROOT_NAME = ".floka";
/** 与 lib/instance-id.ts 的 isInstanceId 同一形状;不 import 它,因为那个模块带着身份生成器和生产路径 */
const INSTANCE_ID = /^[\w-]{1,64}$/;

export type Identity = { ok: true; sum: string } | { ok: false; problem: string };

/**
 * 读根里的身份并给出短摘要(24 位 hex,够做一致性比对,又短到不会被日志脱敏当成凭据)。
 * 只读文件、只解析私钥,不调用任何生成函数。
 */
export async function readIdentity(fs: StateFs, root: string): Promise<Identity> {
  const parts: Uint8Array[] = [];
  for (const name of IDENTITY_FILES) {
    const path = join(root, name);
    const st = await fs.lstat(path);
    if (!st) return { ok: false, problem: `缺失身份文件 ${name}` };
    if (st.kind !== "file") return { ok: false, problem: `身份文件 ${name} 不是普通文件` };
    const bytes = await fs.readFile(path);
    if (!bytes) return { ok: false, problem: `缺失身份文件 ${name}` };
    parts.push(bytes);
  }
  if (!INSTANCE_ID.test(Buffer.from(parts[0]!).toString("utf8").trim())) return { ok: false, problem: "instance-id 内容无效" };
  try {
    if (createPrivateKey(Buffer.from(parts[1]!)).asymmetricKeyType !== "ed25519") return { ok: false, problem: "instance-key.pem 不是 ed25519 私钥" };
  } catch (e) {
    return { ok: false, problem: `instance-key.pem 解析失败:${(e as Error).message}` };
  }
  const h = createHash("sha256");
  for (const p of parts) h.update(createHash("sha256").update(p).digest());
  return { ok: true, sum: h.digest("hex").slice(0, 24) };
}

/** 路径的规范形:最近的已存在祖先取 realpath,再接上剩余部分(macOS 的 /var → /private/var 这类别名比对才可靠) */
async function canonical(fs: StateFs, p: string): Promise<string> {
  const abs = resolve(p);
  const rest: string[] = [];
  let cur = abs;
  for (;;) {
    const real = await fs.realpath(cur);
    if (real) return join(real, ...rest.reverse());
    const up = dirname(cur);
    if (up === cur) return abs;
    rest.push(basename(cur));
    cur = up;
  }
}

/** 根自身不跟随(迁移后旧根就是指向新根的 symlink),只规范它的父目录 */
const rootPath = async (fs: StateFs, p: string): Promise<string> => join(await canonical(fs, dirname(resolve(p))), basename(resolve(p)));

const inside = (child: string, root: string): boolean => child === root || child.startsWith(root.endsWith(sep) ? root : root + sep);

/** 两个根此刻的形态。旧根是 symlink 只认指向新根的那一种(本迁移建的别名),其余一律算未知 symlink */
export async function inspectLayout(fs: StateFs, oldRoot: string, newRoot: string): Promise<Layout> {
  const o = await fs.lstat(oldRoot);
  const n = await fs.lstat(newRoot);
  const reasons: string[] = [];
  if (n?.kind === "symlink") reasons.push("新根是 symlink,不认");
  else if (n && n.kind !== "dir") reasons.push("新根存在但不是目录");
  if (o?.kind === "symlink") {
    const target = await fs.realpath(oldRoot);
    if (!reasons.length && n?.kind === "dir" && target === (await fs.realpath(newRoot))) return { kind: "migrated" };
    reasons.push("旧根是未知 symlink(不指向新根)");
  } else if (o && o.kind !== "dir") reasons.push("旧根存在但不是目录");
  if (reasons.length) return { kind: "conflict", reasons };
  if (o && n) {
    if ((await fs.readdir(newRoot)).length === 0) return { kind: "legacy", newEmptyDir: true };
    return { kind: "conflict", reasons: ["旧根和新根都有数据,拒绝自动合并"] };
  }
  if (o) return { kind: "legacy", newEmptyDir: false };
  return n ? { kind: "moved" } : { kind: "missing" };
}

/** 数据此刻所在的根:迁移前在旧根,搬完(不论别名建没建)在新根 */
export const dataRoot = (layout: Layout, oldRoot: string, newRoot: string): string | null =>
  layout.kind === "legacy" ? oldRoot : layout.kind === "moved" || layout.kind === "migrated" ? newRoot : null;

/** 根路径本身的问题:非绝对、相同、自定义根未批准、事务日志落在根里 */
export async function rootProblems(o: StateMigrationOptions): Promise<string[]> {
  const out: string[] = [];
  if (![o.oldRoot, o.newRoot, o.journalDir, o.home].every(isAbsolute)) return ["旧根 / 新根 / 日志目录 / home 必须是绝对路径"];
  const [oldC, newC] = await Promise.all([o.oldRoot, o.newRoot].map((p) => rootPath(o.fs, p)));
  const journalC = await canonical(o.fs, o.journalDir);
  if (oldC === newC || inside(oldC!, newC!) || inside(newC!, oldC!)) out.push("旧根和新根相同或互相包含");
  if (inside(journalC, oldC!) || inside(journalC, newC!)) out.push("事务日志目录不能在旧根或新根里面(搬根会把锁和日志一起搬走)");
  const defOld = await rootPath(o.fs, stateDirIn(o.home));
  const defNew = await rootPath(o.fs, join(o.home, NEW_ROOT_NAME));
  if (oldC !== defOld || newC !== defNew) {
    const a = o.approvedCustom;
    if (!a || a.oldRoot !== o.oldRoot || a.newRoot !== o.newRoot) out.push("自定义根未明确批准,不自动搬");
  }
  return out;
}

/** 数据根和对面根的父目录必须在同一文件系统;跨设备的改名不是原子的,本卡拒绝 */
export async function deviceProblem(fs: StateFs, from: string, to: string): Promise<string | null> {
  const a = await fs.lstat(from);
  const b = await fs.lstat(dirname(to));
  if (!a) return "数据根不存在";
  if (!b || b.kind !== "dir") return "目标的父目录不存在";
  return a.dev === b.dev ? null : "旧根和新根不在同一文件系统,拒绝自动迁移";
}

/** 停写证明:两个根都要问,有任何写者就拒绝 */
export async function writerProblem(o: StateMigrationOptions): Promise<string | null> {
  const active = [...(await o.writers.activeWriters(o.oldRoot)), ...(await o.writers.activeWriters(o.newRoot))];
  return active.length ? `仍有写者未停:${[...new Set(active)].join("、")}` : null;
}

type OwnerLike = Pick<NodeStat, "mode" | "uid" | "gid">;

export const sameOwner = (a: OwnerLike | null, b: OwnerLike | null): boolean =>
  !!a && !!b && a.mode === b.mode && a.uid === b.uid && a.gid === b.gid;

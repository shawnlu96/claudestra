// POST /api/v1/sessions/archived/:id/restore 的 agent 分支第一步：把用户归档目录里的文件
// 挪到自动快照区 archive/<agent>/（移出归档区它就回到工作列表）。
// 规矩（A08-01）：搬运失败不删源；目标已有同名文件不覆盖、换名落下（落盘本身不覆盖，见 publishNoClobber）；全搬完才删源目录。
import * as nodeFsp from "node:fs/promises";
import { apiJson } from "./api-respond.js";

type FsOps = Pick<typeof nodeFsp, "mkdir" | "readdir" | "rename" | "rm" | "lstat" | "link" | "unlink" | "readlink" | "symlink">;

export type ArchiveMoveResult =
  | { ok: true; moved: string[]; renamed: Record<string, string> }
  | { ok: false; error: string; moved: string[]; notMoved: string[] };

const code = (e: unknown) => (e as NodeJS.ErrnoException).code;

/** `session.jsonl` → `session.restored-1.jsonl`、`-2`…；无扩展名/点开头的名字直接在尾部加 `.restored-N` */
export function conflictName(name: string, n: number): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return `${name}.restored-${n}`;
  return `${name.slice(0, dot)}.restored-${n}${name.slice(dot)}`;
}

/**
 * 不覆盖地把 from 落到 to：已被占返回 false（调用方换名重试），落下返回 true。
 * 「查空位再 rename」有 TOCTOU（自动归档可能在中间写进同名快照，rename 会把它盖掉），所以占位检查交给落盘这一步本身：
 *   文件   link()——目标存在必 EEXIST，原子、不覆盖；落下后才 unlink 源
 *   软链   按原指向 symlink()，同样 EEXIST；落下后才 unlink 源
 *   目录   rename()——只会替换**空**目录（不丢任何东西），非空 ENOTEMPTY/EEXIST、是文件 ENOTDIR
 * 占位的东西与源类型不同（如目标 session.jsonl 是个目录）视为环境异常：抛错，让调用方停下、不删源。
 */
async function publishNoClobber(fsp: FsOps, from: string, to: string, kind: "file" | "dir" | "symlink"): Promise<boolean> {
  try {
    if (kind === "dir") await fsp.rename(from, to);
    else if (kind === "symlink") await fsp.symlink(await fsp.readlink(from), to);
    else await fsp.link(from, to);
  } catch (e) {
    if (!["EEXIST", "ENOTEMPTY", "ENOTDIR", "EISDIR"].includes(code(e) ?? "")) throw e;
    const st = await fsp.lstat(to);
    if (kind === "dir" ? !st.isDirectory() : st.isDirectory()) throw new Error(`目标 ${to} 已存在且类型不同`);
    return false;
  }
  if (kind !== "dir") await fsp.unlink(from); // 删不掉：目标已落下、源还在，只多一份副本，不丢数据
  return true;
}

/** 把 srcDir/name 落进 destDir：原名被占就按 conflictName 依次试，返回最终落脚名 */
async function moveOne(fsp: FsOps, srcDir: string, destDir: string, name: string): Promise<string> {
  const st = await fsp.lstat(`${srcDir}/${name}`);
  const kind = st.isDirectory() ? "dir" : st.isSymbolicLink() ? "symlink" : "file";
  for (let n = 0; n < 10_000; n++) {
    const target = n === 0 ? name : conflictName(name, n);
    if (await publishNoClobber(fsp, `${srcDir}/${name}`, `${destDir}/${target}`, kind)) return target;
  }
  throw new Error(`目标 ${name} 找不到不冲突的名字`);
}

/** 搬 srcDir 里除 .meta.json 外的全部文件到 destDir；任何一步失败即停，源目录原样保留。全部搬完才删 srcDir。 */
export async function moveArchiveToSnapshots(srcDir: string, destDir: string, fsp: FsOps = nodeFsp): Promise<ArchiveMoveResult> {
  let names: string[];
  try {
    names = (await fsp.readdir(srcDir)).filter((f) => f !== ".meta.json");
  } catch (e) {
    return { ok: false, error: `读取归档目录失败: ${(e as Error).message}`, moved: [], notMoved: [] };
  }
  const moved: string[] = [];
  const renamed: Record<string, string> = {};
  try {
    await fsp.mkdir(destDir, { recursive: true });
    for (const f of names) {
      const target = await moveOne(fsp, srcDir, destDir, f);
      moved.push(f);
      if (target !== f) renamed[f] = target;
    }
  } catch (e) {
    const notMoved = names.filter((f) => !moved.includes(f));
    return { ok: false, error: `移出归档区失败: ${(e as Error).message}`, moved, notMoved };
  }
  try {
    await fsp.rm(srcDir, { recursive: true, force: true });
  } catch (e) {
    return { ok: false, error: `文件已搬走，删除归档目录失败: ${(e as Error).message}`, moved, notMoved: [] };
  }
  return { ok: true, moved, renamed };
}

/** 路由用：成功返回 null（调用方继续走原成功回包），失败返回 500 回包（含已搬 / 未搬文件名）。 */
export async function restoreAgentArchiveFiles(srcDir: string, destDir: string, fsp: FsOps = nodeFsp): Promise<Response | null> {
  const r = await moveArchiveToSnapshots(srcDir, destDir, fsp);
  if (r.ok) return null;
  return apiJson(500, { ok: false, error: r.error, moved: r.moved, notMoved: r.notMoved });
}

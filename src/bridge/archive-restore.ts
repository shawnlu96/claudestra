// POST /api/v1/sessions/archived/:id/restore 的 agent 分支第一步：把用户归档目录里的文件
// 挪到自动快照区 archive/<agent>/（移出归档区它就回到工作列表）。
// 规矩（A08-01）：搬运失败不删源；目标已有同名文件不覆盖、换名落下；全搬完才删源目录。
import * as nodeFsp from "node:fs/promises";
import { apiJson } from "./api-respond.js";

type FsOps = Pick<typeof nodeFsp, "mkdir" | "readdir" | "rename" | "rm" | "lstat">;

export type ArchiveMoveResult =
  | { ok: true; moved: string[]; renamed: Record<string, string> }
  | { ok: false; error: string; moved: string[]; notMoved: string[] };

async function exists(fsp: FsOps, p: string): Promise<boolean> {
  try {
    await fsp.lstat(p);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}

/** `session.jsonl` → `session.restored-1.jsonl`、`-2`…；无扩展名/点开头的名字直接在尾部加 `.restored-N` */
export function conflictName(name: string, n: number): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return `${name}.restored-${n}`;
  return `${name.slice(0, dot)}.restored-${n}${name.slice(dot)}`;
}

/**
 * 给 `name` 在 destDir 里挑落脚名：不存在就用原名；已有**普通文件**就按 conflictName 找第一个空位；
 * 被目录 / 其他非文件占着视为环境异常，抛错（让调用方停下、不删源）。
 */
async function pickDestName(fsp: FsOps, destDir: string, name: string): Promise<string> {
  let st;
  try {
    st = await fsp.lstat(`${destDir}/${name}`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return name;
    throw e;
  }
  if (!st.isFile()) throw new Error(`目标 ${name} 已存在且不是普通文件`);
  for (let n = 1; n < 10_000; n++) {
    const alt = conflictName(name, n);
    if (!(await exists(fsp, `${destDir}/${alt}`))) return alt;
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
      const target = await pickDestName(fsp, destDir, f);
      await fsp.rename(`${srcDir}/${f}`, `${destDir}/${target}`);
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

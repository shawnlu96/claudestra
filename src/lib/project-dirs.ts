/**
 * project 目录写入前的校验（project-add / project-edit --dirs / project-merge）：只收绝对路径，一个目录只归一个项目。
 * 为什么要严：台账 verify 按「本仓库主树命中哪个项目」判任务归属（manager/ledger-verify.ts），相对路径随调用方 cwd 变、
 * `$HOME` 字面不展开、两个项目登记同一目录时谁排前面归谁，都会让归属判错（T8G r4 P2-1 / P2-2）。
 * 已存在的目录按真实路径比（大小写、symlink 都规范掉）：Node 的 JS 版 realpath 不规范大小写，Bun 下两者一致，用 .native 保险。
 * 报错带 tpl + params，网页按模板翻译（web/lib/i18n-dict.ts）。
 */
import { realpathSync } from "node:fs";
import { normalize, resolve } from "node:path";
import { normalizeDir, type ProjectDef } from "./projects.js";

const HOME = process.env.HOME || "";

/** 比较用的键：存在 → 真实路径（大小写、symlink 都规范掉）；不存在 → 规范化后的绝对路径 */
export function dirKey(dir: string): string {
  const d = normalize(normalizeDir(dir));
  try {
    return realpathSync.native(d);
  } catch {
    return d; // 还没 clone 的目录：按规范化后的字面比
  }
}

export type DirsError = { ok: false; error: string; tpl: string; params: Record<string, string> };

const fail = (tpl: string, params: Record<string, string>): DirsError => ({
  ok: false,
  error: tpl.replace(/\{(\w+)\}/g, (m, k: string) => params[k] ?? m),
  tpl,
  params,
});

/** 不是绝对路径时给出应该怎么写；是绝对路径返回 null */
function notAbsolute(dir: string, cwd: string): DirsError | null {
  if (dir === "~" || dir.startsWith("~/")) return fail("项目目录要写绝对路径：「{dir}」里的 ~ 不会被展开，请写成「{fix}」", { dir, fix: HOME + dir.slice(1) });
  const home = dir.match(/^\$(?:HOME\b|\{HOME\})/);
  if (home) return fail("项目目录要写绝对路径：「{dir}」里的 $HOME 不会被展开，请写成「{fix}」", { dir, fix: HOME + dir.slice(home[0].length) });
  if (dir.startsWith("~") || dir.includes("$")) return fail("项目目录要写绝对路径：「{dir}」里的 ~用户名 或环境变量不会被展开，请写成展开后的绝对路径", { dir });
  if (!dir.startsWith("/")) return fail("项目目录要写绝对路径：「{dir}」是相对路径，请写成绝对路径，例如「{fix}」", { dir, fix: resolve(cwd, dir) });
  return null;
}

/**
 * 校验并规范化要写进项目 selfId 的目录：绝对路径、去尾斜杠与 `/./`、同一项目内按真实路径去重、不和别的项目撞目录。
 * 写入时不要求目录已存在（可以先登记再 clone）。
 */
export function validateProjectDirs(
  raw: readonly string[],
  projects: readonly ProjectDef[],
  selfId: string,
  cwd: string = process.cwd(),
): { ok: true; dirs: string[] } | DirsError {
  const dirs: string[] = [];
  const seen = new Set<string>();
  for (const r of raw.map((x) => x.trim()).filter(Boolean)) {
    const bad = notAbsolute(r, cwd);
    if (bad) return bad;
    const d = normalize(r).replace(/(.)\/+$/, "$1");
    const key = dirKey(d);
    if (seen.has(key)) continue;
    const other = projects.find((p) => p.id !== selfId && p.dirs.some((x) => dirKey(x) === key));
    if (other) return fail("目录「{dir}」已登记在项目 {project} 下：一个目录只能属于一个项目（要合并两个项目用 project-merge <src> <dst>）", { dir: d, project: other.id });
    seen.add(key);
    dirs.push(d);
  }
  return { ok: true, dirs };
}

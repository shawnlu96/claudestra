/**
 * 仓库带子模块时（如私仓 vendor/claudestra），检出之后要 `git submodule update --init --recursive`，否则测试 import 子模块就挂。
 * 出借副本（lend-clone.ts，上锁前）、本机执行者 worktree（scheduler-local-author.ts）、审查 worktree（scheduler-review-worktree.ts）共用。
 * 没有 .gitmodules 只看一眼磁盘，不发任何 git 调用：公共仓的调用序列与以前一致。git 的调用方式（在哪个目录、带哪些 -c、超时）由调用方注入。
 * tests/repo-submodules.test.ts。
 */
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

/** 在仓库目录里跑一条 git（args 不含 `git` 与 -C）；out = 给人看的输出 */
export type SubmoduleGit = (args: string[]) => Promise<{ code: number | null; out: string }>;
/** paths = .gitmodules 里登记的子模块路径（只收仓库内的相对路径）；没有子模块 = [] */
export type SubmoduleResult = { ok: true; paths: string[] } | { ok: false; reason: string };

const SUBMODULE_UPDATE = ["submodule", "update", "--init", "--recursive"] as const;

/** git 配置值的解码：去首尾空白，引号成对去掉，\\ \" \n \t \b 转义，引号外的 # ; 起注释（git-config(1) Syntax） */
function configValue(raw: string): string {
  let out = "", quoted = false, pending = "";
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (!quoted && (c === "#" || c === ";")) break;
    if (!quoted && /\s/.test(c)) { if (out) pending += c; continue; }
    out += pending; pending = "";
    if (c === '"') quoted = !quoted;
    else if (c === "\\") { const n = raw[++i] ?? ""; out += ({ n: "\n", t: "\t", b: "\b" } as Record<string, string>)[n] ?? n; }
    else out += c;
  }
  return out;
}

/** .gitmodules 里各 [submodule "…"] 小节的 path（按 git 配置语法解码）；绝对路径或带 .. 的不收（git 自己也不认） */
export function submodulePaths(dir: string): string[] {
  const file = join(dir, ".gitmodules");
  if (!existsSync(file)) return [];
  const paths: string[] = [];
  let inSubmodule = false;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const section = /^\s*\[\s*([^\s\]"]+)/.exec(line);
    if (section) { inSubmodule = section[1]!.toLowerCase() === "submodule"; continue; }
    const kv = /^\s*path\s*=(.*)$/i.exec(line);
    if (inSubmodule && kv) paths.push(configValue(kv[1]!));
  }
  return paths.filter((p) => p && !isAbsolute(p) && !p.split(/[\\/]/).includes(".."));
}

/** 有 .gitmodules 就拉子模块（含嵌套）；失败带原因，不抛 */
export async function updateSubmodules(dir: string, git: SubmoduleGit): Promise<SubmoduleResult> {
  if (!existsSync(join(dir, ".gitmodules"))) return { ok: true, paths: [] };
  try {
    const r = await git([...SUBMODULE_UPDATE]);
    if (r.code !== 0) return { ok: false, reason: `拉子模块失败：${r.out.trim().slice(0, 300) || `exit ${r.code}`}` };
    return { ok: true, paths: submodulePaths(dir) };
  } catch (e) {
    return { ok: false, reason: `拉子模块失败：${(e as Error).message}`.slice(0, 300) };
  }
}

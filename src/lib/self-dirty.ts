/**
 * 自动更新自己弄脏的工作区：更新流程里装 web 依赖时 npm 会改写受 git 管理的 web/package-lock.json（peer/optional 标记、
 * 删几条可选依赖），之后每次自动更新都因「工作区脏」被拦——2026-09-28 He 的机器就这样停在一个中间版本，旧网页服务
 * 引用的 JS 全 404，App 白屏。
 * 只有这些「我们自己的安装会改写」的文件是唯一的改动时，才还原它们再继续；别的改动一律照旧当成用户改动、阻塞并上报。
 */
import { spawnSync } from "node:child_process";

/** 更新流程会改写、但仓库里有提交版本的锁文件（相对仓库根） */
const SELF_MANAGED_FILES = ["web/package-lock.json"];

/** porcelain 每行 → { 状态码, 路径 }（「XY 路径」；第一行可能被 trim 掉前导空格，按正则剥状态段，别数下标） */
function parsePorcelain(porcelain: string): { code: string; path: string }[] {
  return porcelain.split("\n").filter((l) => l.trim()).map((l) => {
    const m = /^\s*([MADRCU?!]{1,2})\s+(.+)$/.exec(l);
    return m ? { code: m[1], path: m[2].trim() } : { code: "?", path: l.trim() };
  });
}

/** 改动只剩自管锁文件、且只是修改（不是新增 / 删除 / 未跟踪）→ 返回这些文件；否则 null */
export function selfInflictedOnly(porcelain: string): string[] | null {
  const rows = parsePorcelain(porcelain);
  if (!rows.length) return null;
  const ok = rows.every((r) => /^M+$/.test(r.code) && SELF_MANAGED_FILES.includes(r.path));
  return ok ? rows.map((r) => r.path) : null;
}

/**
 * 自动更新前调：改动只是自管锁文件就 git checkout 还原并返回空串（= 干净，可以继续）；否则原样返回 porcelain。
 * 还原失败也原样返回——宁可照旧阻塞上报，不能带着脏树往下走。
 */
export function healSelfDirty(repoRoot: string, porcelain: string): string {
  const files = selfInflictedOnly(porcelain);
  if (!files) return porcelain;
  const r = spawnSync("git", ["-C", repoRoot, "checkout", "HEAD", "--", ...files], { encoding: "utf8" });
  if (r.status !== 0) {
    console.error(`自管锁文件还原失败，自动更新照旧阻塞: ${(r.stderr || "").trim()}`);
    return porcelain;
  }
  console.log(`🧹 自动更新前还原了自己改写的锁文件: ${files.join(", ")}`);
  return "";
}

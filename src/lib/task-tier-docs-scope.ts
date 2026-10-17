/**
 * docs 卡（TIER3e）的文件范围：只许 docs/**、任意目录的 *.md、逐项写明具体路径的发版说明。纯函数，不读盘、不跑 git。
 * - 派单前（docsDispatchCheck）：只看 fileGlobs 声明——每一条都要证明落在上面三类里，宽泛授权（src/**、**、*、目录、带 {} / ! / ..）一律拒。
 * - 交付时（docsDeliveryCheck）：再看实际 diff（新增 / 修改 / 删除，重命名两头都算——调用方按 --no-renames 给全）与规格版本绑定：
 *   每个路径既要落在 fileGlobs 里，也要属于上面三类；规格版本变了、卡首声明与开卡时的流程不一致、证据缺失 = 无法证明，一律拒。
 * 钩子由 task-tier-docs-template.ts 注册进 task-tier-spec.ts registerTierChecks，门控在 task-tier-models.ts tierCheckGate。
 * tests/task-tier-docs-scope.test.ts。
 */
import { tierAtLaunch, type TierCheckCtx } from "./task-tier-spec.js";

/** 发版说明认得的文件名 / 目录名；只在逐项写明的具体路径上认（不认通配） */
const RELEASE_NAME = /^(changelog|changes|history|news|releases?|release[-_]?notes?)(\.[a-z0-9]+)?$/i;
const RELEASE_DIR = /^(release[-_]?notes?|releases|changelogs?)$/i;
const GLOB_CHARS = /[*?[\]{}!]/;

/** 路径本身合法：相对、无 .. / . 段、无空段、不带 repo: 前缀 */
function plainPath(p: string): boolean {
  if (!p || p.startsWith("/") || p.startsWith("repo:") || p.includes("\\")) return false;
  return p.split("/").every((s) => s !== "" && s !== "." && s !== "..");
}

const isReleaseNotes = (p: string): boolean => {
  const segs = p.split("/");
  return RELEASE_NAME.test(segs.at(-1)!) || segs.slice(0, -1).some((s) => RELEASE_DIR.test(s));
};

/** 一条 fileGlobs 声明能不能证明只放行 docs 范围；不能 = 返回原因 */
export function docsGlobProblem(glob: string): string | null {
  const g = glob.trim();
  if (!plainPath(g)) return `「${g.slice(0, 80)}」不是仓库内的相对路径（不许 /、..、repo: 前缀、空段）`;
  if (/[{}!]/.test(g)) return `「${g.slice(0, 80)}」带 {} 或 !，证明不了只放行文档`;
  if (g.startsWith("docs/")) return null;
  // 末段以字面 .md 结尾：* / ? / [] 都不跨目录，任何匹配都以 .md 结尾
  if (g.split("/").at(-1)!.endsWith(".md") && g.split("/").at(-1)!.length > 3) return null;
  if (!GLOB_CHARS.test(g) && isReleaseNotes(g)) return null;
  if (isReleaseNotes(g.replace(/[*?[\]]/g, ""))) return `发版说明「${g.slice(0, 80)}」要逐项写具体文件路径，不能用通配`;
  return `「${g.slice(0, 80)}」超出 docs 范围（只许 docs/**、*.md、逐项写明的发版说明）`;
}

/** 实际改到的一个路径是否属于 docs 三类（发版说明只认 fileGlobs 里逐项写明的那几条） */
export function docsPathProblem(path: string, globs: readonly string[]): string | null {
  if (!plainPath(path)) return `路径「${path.slice(0, 80)}」不合法`;
  if (!globs.some((g) => new Bun.Glob(g.trim()).match(path))) return `${path.slice(0, 120)} 不在本卡 fileGlobs 里`;
  if (path.startsWith("docs/") || path.endsWith(".md")) return null;
  if (globs.some((g) => g.trim() === path) && isReleaseNotes(path)) return null;
  return `${path.slice(0, 120)} 不是文档（只许 docs/**、*.md、逐项写明的发版说明）`;
}

/** 派单前：fileGlobs 每条都要过；空 = 无法证明 */
function docsGlobsProblem(globs: readonly string[]): string | null {
  if (!globs.length) return "docs 卡没有 fileGlobs，证明不了范围";
  for (const g of globs) { const why = docsGlobProblem(g); if (why) return why; }
  return null;
}

/** 交付时的证据（task-tier-deliver-wiring.ts 在真实交付入口拼好，随 TierCheckCtx 一起传进钩子） */
export interface DocsDeliveryProof {
  /** 交付 head 相对基线的变更路径（--no-renames：重命名两头都在）；读不到就给 filesError */
  files?: readonly string[];
  filesError?: string;
  /** 开卡时存下的流程模板与规格版本 */
  stored: { template: string; specRev: number } | null;
  /** 卡现在的规格版本与规格正文（读不到 = null） */
  specRev: number;
  specText: string | null;
}
export type DocsCheckCtx = TierCheckCtx & { docs?: DocsDeliveryProof };

/** 规格版本绑定：开卡后规格改版、卡首声明换成别的类型、没存流程，都停止按 docs 交付 */
function docsSpecProblem(p: DocsDeliveryProof): string | null {
  if (!p.stored) return "卡上没有存开卡时的流程，核对不了规格版本";
  if (p.stored.template !== "docs") return `卡上流程是 ${p.stored.template.slice(0, 40)}，不是 docs`;
  if (p.specRev !== p.stored.specRev) return `规格从第 ${p.stored.specRev} 版改到第 ${p.specRev} 版，docs 范围要按新版重新校验：先纠正规格或重新开卡`;
  const at = tierAtLaunch(p.stored, p.specText);
  return at.ok ? null : `规格卡首声明核对不过：${at.error}`;
}

/** 派单前钩子：只管 docs */
export function docsDispatchCheck(ctx: TierCheckCtx): string | null {
  if (ctx.tier !== "docs") return null;
  const why = docsGlobsProblem(ctx.fileGlobs);
  return why ? `docs 文件范围不合规：${why}；纠正规格的 fileGlobs` : null;
}

/** 交付时钩子：只管 docs；声明、规格版本、实际 diff 三样都要过，证据缺一样就拒（不静默放行、不转 code） */
export function docsDeliveryCheck(ctx: DocsCheckCtx): string | null {
  if (ctx.tier !== "docs") return null;
  const globs = docsGlobsProblem(ctx.fileGlobs);
  if (globs) return `docs 文件范围不合规：${globs}；纠正规格的 fileGlobs`;
  const p = ctx.docs;
  if (!p) return "交付没带 docs 范围证据（实际 diff 与规格版本），证明不了合规";
  const spec = docsSpecProblem(p);
  if (spec) return spec;
  if (p.filesError || !p.files) return `读不到交付的实际 diff（${(p.filesError ?? "没有文件清单").slice(0, 160)}），证明不了合规`;
  const bad = p.files.map((f) => docsPathProblem(f, ctx.fileGlobs)).filter((x): x is string => x !== null);
  if (bad.length) return `实际 diff 越界 ${bad.length} 处：${bad.slice(0, 3).join("；")}${bad.length > 3 ? "……" : ""}`;
  return null;
}

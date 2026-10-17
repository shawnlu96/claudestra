import { ASK_SCOPE_REGISTRY, scopeProtected, scopeRegistryVariant, scopeWireProtected, type ScopeGrant } from "./ask-scope-registry.js";

export interface ScopeContext {
  globs: string[];
  security: boolean;
  exists(path: string): boolean;
  locked(path: string): boolean;
}
export interface ScopeQuestion { class?: string; default?: string; risk?: string; files?: string[] }
const scopePath = (path: string): boolean => /^src\/[\w./-]+\.ts$/.test(path) && !path.split("/").some((p) => !p || p === "." || p === "..");
export const scopeMatches = (path: string, globs: readonly string[]): boolean => globs.some((g) => new Bun.Glob(g).match(path));

/** Deliberately bounded vocabulary: an unrecognized or mixed declaration falls back to the existing ask path. */
function registryShape(kind: ScopeGrant["kind"], text: string): boolean {
  if (!/(?:本卡|this card|own)/i.test(text) || /(?:别的卡|其他卡|别卡|其他条目|other card|gate|分组|组名|新组|分类|注释|权限|缺省|默认值|default value)/i.test(text)) return false;
  if (kind === "effects") return /(?:新增|添加|加|删除|删|计数|字母序|alphabet|count|add|delete)/i.test(text)
    && !/(?:逻辑|重写|函数|function|replace|rewrite)/i.test(text);
  if (kind === "keys") return /(?:字母序|alphabet)/i.test(text) && /(?:新增|添加|加|删除|删|add|delete)/i.test(text)
    && !/(?:改名|重命名|计数|rename)/i.test(text);
  if (kind === "manager") return /import\s*(?:一|1)\s*行/i.test(text) && /(?:展开|spread)/i.test(text)
    && /(?:命令表|command table)/i.test(text);
  return /(?:只加|只新增|只添加|only add)/i.test(text) && /(?:新命令|new command)/i.test(text)
    && !/(?:删除|删|改名|重写|delete|rename|rewrite)/i.test(text);
}

export function planScope(q: ScopeQuestion, ctx: ScopeContext): ScopeGrant[] | null {
  if (q.class !== "scope" || !q.default?.trim() || q.risk || ctx.security || !q.files?.length) return null;
  const text = q.default;
  if (/(?:开关缺省|默认开关|开关默认|权限表|安全分类|guard\s*基线)/i.test(text)) return null;
  const sources = [...new Set(text.match(/src\/[\w./-]+\.ts\b/g) ?? [])].filter((p) => scopePath(p) && scopeMatches(p, ctx.globs));
  const grants: ScopeGrant[] = [];
  for (const path of q.files) {
    if (!scopePath(path) || scopeProtected(path) || scopeRegistryVariant(path)) return null;
    const entry = ASK_SCOPE_REGISTRY.find((r) => r.path === path);
    if (entry) {
      if (!registryShape(entry.kind, text)) return null;
      grants.push({ path, kind: entry.kind, check: entry.check });
      continue;
    }
    if (scopeWireProtected(path) || !ctx.exists(path) || ctx.locked(path) || sources.length !== 1 || sources[0] === path) return null;
    if (!/import\s*(?:一|1)\s*行/i.test(text) || !/(?:调用\s*(?:≤|<=|不超过)\s*3\s*行|calls?\s*<=\s*3\s*lines?)/i.test(text)) return null;
    if (!/(?:判定逻辑|logic)/i.test(text) || !/(?:本卡新文件|new file)/i.test(text)) return null;
    grants.push({ path, kind: "wire", source: sources[0], check: "已有 src 文件；import 一行 + 调用 ≤3 行；判定逻辑在本卡新文件；card 锁核对" });
  }
  return grants;
}

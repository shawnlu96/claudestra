// 重复有效行（全仓总量棘轮）：去注释/空白/纯标点/import 行，连续 N 条有效行的窗口出现 ≥2 次，
// 被这些窗口覆盖的行算重复行。按总量而不是按文件计，这样把重复块原样搬进新模块不会被拦。
// tests 不计（fixture 重复是常态），twin 的第二份不计（twins 规则保证它与第一份一致）。
import { DUP_WINDOW, TWINS } from "../config.ts";
import type { Files, RuleResult } from "../types.ts";

function normalizeLine(raw: string, state: { inBlock: boolean }): string | null {
  let t = raw.trim();
  if (state.inBlock) {
    const e = t.indexOf("*/");
    if (e < 0) return null;
    state.inBlock = false;
    t = t.slice(e + 2).trim();
  }
  if (t.startsWith("/*") || t.startsWith("{/*")) {
    if (!t.includes("*/")) {
      state.inBlock = true;
      return null;
    }
    t = t.replace(/\{?\/\*.*?\*\/\}?/g, "").trim();
  }
  if (t.startsWith("//") || t.startsWith("*")) return null;
  t = t.replace(/\s+\/\/.*$/, "").replace(/\s+/g, " ");
  if (!/[A-Za-z0-9_$一-鿿]{2}/.test(t)) return null;
  if (/^(import|export \{[^}]*\} from|export \* from)\b/.test(t)) return null;
  return t;
}

function meaningfulLines(src: string): string[] {
  const state = { inBlock: false };
  const out: string[] = [];
  for (const raw of src.split("\n")) {
    const t = normalizeLine(raw, state);
    if (t !== null) out.push(t);
  }
  return out;
}

function dupScope(f: string): boolean {
  if (!/\.(ts|tsx)$/.test(f) || f.startsWith("tests/")) return false;
  return !TWINS.some(([, second]) => second === f);
}

export function measureDup(files: Files, win = DUP_WINDOW): RuleResult {
  const byHash = new Map<string, [string, number][]>();
  for (const [f, text] of files) {
    if (!dupScope(f)) continue;
    const lines = meaningfulLines(text);
    for (let i = 0; i + win <= lines.length; i++) {
      const k = Bun.hash(lines.slice(i, i + win).join("\n")).toString(36);
      const arr = byHash.get(k);
      if (arr) arr.push([f, i]);
      else byHash.set(k, [[f, i]]);
    }
  }
  const marked = new Map<string, Set<number>>();
  for (const occ of byHash.values()) {
    if (occ.length < 2) continue;
    for (const [f, i] of occ) {
      let s = marked.get(f);
      if (!s) marked.set(f, (s = new Set()));
      for (let k = 0; k < win; k++) s.add(i + k);
    }
  }
  const per = [...marked].map(([f, s]) => [f, s.size] as const).sort((a, b) => b[1] - a[1]);
  const total = per.reduce((a, [, n]) => a + n, 0);
  return { counts: { "dup:total": total }, detail: per.slice(0, 8).map(([f, n]) => `dup ${f}: ${n}`) };
}

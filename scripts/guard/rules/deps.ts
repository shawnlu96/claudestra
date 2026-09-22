// 分层依赖 + 运行时 import 环。已知违规边进 baseline（每条一个 key），出现新边就失败。
// 扫静态 import / export-from / 动态 import() / require()；type-only 边不参与分层与环。
import { dirname, join, normalize } from "path";
import { BRIDGE_HUBS, WATCHERS } from "../config.ts";
import type { Counts, Files, RuleResult } from "../types.ts";
import { stripComments } from "./strip.ts";

export interface Edge {
  from: string;
  to: string;
  typeOnly: boolean;
}

const IMPORT_RE =
  /(?:^|[^.\w])(?:import|export)\s+(type\s+)?(?:[^'"`;]*?\s+from\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|require\(\s*["']([^"']+)["']\s*\)/g;

function resolveSpec(files: Files, from: string, spec: string): string | null {
  let b: string | null = null;
  if (spec.startsWith(".")) b = normalize(join(dirname(from), spec));
  else if (spec.startsWith("@/") && (from.startsWith("web/") || from.startsWith("tests/"))) b = join("web", spec.slice(2));
  if (!b) return null;
  const cands = [b, b.replace(/\.js$/, ".ts"), b.replace(/\.js$/, ".tsx"), `${b}.ts`, `${b}.tsx`, join(b, "index.ts")];
  return cands.find((c) => files.has(c)) ?? null;
}

export function collectEdges(files: Files): Edge[] {
  const edges: Edge[] = [];
  for (const [f, src] of files) {
    if (!/\.(ts|tsx|mjs)$/.test(f)) continue;
    for (const m of stripComments(src).matchAll(IMPORT_RE)) {
      const to = resolveSpec(files, f, m[2] ?? m[3] ?? m[4]);
      if (to) edges.push({ from: f, to, typeOnly: Boolean(m[1]) });
    }
  }
  return edges;
}

type Layer = "lib" | "bridge" | "entry" | "src-other" | "tests" | "web" | "scripts";
function layerOf(f: string): Layer {
  if (f.startsWith("src/lib/")) return "lib";
  if (f.startsWith("src/bridge/")) return "bridge";
  if (/^src\/[^/]+\.ts$/.test(f)) return "entry";
  if (f.startsWith("src/")) return "src-other";
  if (f.startsWith("tests/")) return "tests";
  if (f.startsWith("web/")) return "web";
  return "scripts";
}

const base = (f: string) => f.replace(/^.*\//, "").replace(/\.tsx?$/, "");

/** 单条边违反了哪些分层规则（type-only 边只查跨 web/src 与 lib 纯度）。 */
function edgeViolations(e: Edge): string[] {
  const la = layerOf(e.from);
  const lb = layerOf(e.to);
  const s = `${e.from} -> ${e.to}`;
  const out: string[] = [];
  if (la === "lib" && lb !== "lib" && !e.typeOnly) out.push(`lib-only-lib: ${s}`);
  if (la === "bridge" && lb === "entry") out.push(`bridge-no-entry: ${s}`);
  if (la === "entry" && lb === "entry") out.push(`entry-no-entry: ${s}`);
  if (la !== "tests" && la !== "scripts" && (la === "web") !== (lb === "web")) out.push(`web-src-split: ${s}`);
  if (la === "tests" && lb === "entry") out.push(`tests-no-entry: ${s}`);
  if (la === "bridge" && lb === "bridge" && !e.typeOnly) {
    if (BRIDGE_HUBS.has(base(e.to))) out.push(`bridge-hub-leaf: ${s}`);
    if (WATCHERS.has(base(e.from)) && WATCHERS.has(base(e.to))) out.push(`watcher-no-watcher: ${s}`);
  }
  return out;
}

const UI_PKG = /from\s+["'](react|react-dom|next(\/[^"']*)?)["']/;

/** tests 只能 import web 里的纯模块：传递闭包里不能出现 react / next。 */
function webPure(files: Files, edges: Edge[], f: string, seen: Set<string>): boolean {
  if (seen.has(f)) return true;
  seen.add(f);
  if (UI_PKG.test(files.get(f) ?? "")) return false;
  return edges.filter((e) => e.from === f).every((e) => webPure(files, edges, e.to, seen));
}

/** Tarjan 强连通分量：src/ 内运行时边构成的环（>1 个节点）。 */
export function findCycles(edges: Edge[]): string[][] {
  const g = new Map<string, string[]>();
  for (const e of edges) {
    if (e.typeOnly || !e.from.startsWith("src/") || !e.to.startsWith("src/")) continue;
    (g.get(e.from) ?? g.set(e.from, []).get(e.from)!).push(e.to);
  }
  let idx = 0;
  const stack: string[] = [];
  const on = new Set<string>();
  const ix = new Map<string, number>();
  const low = new Map<string, number>();
  const out: string[][] = [];
  const visit = (v: string) => {
    ix.set(v, idx);
    low.set(v, idx++);
    stack.push(v);
    on.add(v);
    for (const w of g.get(v) ?? []) {
      if (!ix.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (on.has(w)) low.set(v, Math.min(low.get(v)!, ix.get(w)!));
    }
    if (low.get(v) !== ix.get(v)) return;
    const comp: string[] = [];
    let w: string;
    do {
      w = stack.pop()!;
      on.delete(w);
      comp.push(w);
    } while (w !== v);
    if (comp.length > 1) out.push(comp.sort());
  };
  for (const v of g.keys()) if (!ix.has(v)) visit(v);
  return out;
}

export function measureDeps(files: Files): RuleResult {
  const edges = collectEdges(files);
  const found = new Set<string>();
  for (const e of edges) for (const v of edgeViolations(e)) found.add(v);
  for (const e of edges) {
    if (layerOf(e.from) === "tests" && layerOf(e.to) === "web" && !webPure(files, edges, e.to, new Set())) {
      found.add(`tests-web-pure: ${e.from} -> ${e.to}`);
    }
  }
  for (const c of findCycles(edges)) found.add(`no-cycle: ${c.join(" | ")}`);
  const counts: Counts = {};
  for (const v of found) counts[`deps:${v}`] = 1;
  return { counts };
}

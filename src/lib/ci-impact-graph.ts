/**
 * Import graph for affected-test selection (merge-arch-IMPACT1). Pure: the repo arrives as a path list plus a reader, the parser
 * arrives as oxc's parseSync (src/lib may not import packages; callers and tests pass it in). Edges are static import / export-from,
 * literal dynamic import / require / `new URL(lit, import.meta.url)` / TS `import("x")` types; type-only edges count too, since a
 * dropped edge can only shrink the selection. What the graph cannot see (a non-literal load, a relative spec that resolves to
 * nothing, a module that locates the repo and then reads / walks / spawns) is recorded, never guessed, and
 * ci-impact-select.ts decides what that costs. tests/ci-impact-graph.test.ts.
 */
import { dirname, join, normalize } from "node:path";

/** oxc-parser's parseSync shape, only as far as this file reads it. */
export type OxcParseSync = (filename: string, source: string) => { program: unknown; errors: readonly { message?: string }[] };
type SpecKind = "static" | "dynamic" | "require" | "type" | "url";
/** How a module touches the repo outside imports: locate = finds its own place on disk; the rest are what it then does. */
type IoUse = "locate" | "read" | "walk" | "spawn";
interface ModuleScan { specs: { spec: string; kind: SpecKind }[]; dynamic: string[]; io: IoUse[]; error?: string }
export type ModuleScanner = (path: string, source: string) => ModuleScan;
export interface Alias { prefix: string; target: string }
export interface RepoSnapshot { paths: readonly string[]; read: (path: string) => string }
export interface ImpactGraph {
  /** module → repo files it depends on (resolved), sorted */
  deps: Map<string, string[]>;
  reverse: Map<string, Set<string>>;
  unresolved: { from: string; spec: string }[];
  dynamic: { from: string; what: string }[];
  io: Map<string, IoUse[]>;
  errors: { from: string; error: string }[];
}

export const MODULE_FILE = /\.(?:[cm]?[jt]sx?)$/;
/** bun test's discovery rule, the one scripts/ci-test-shard.ts uses on `git ls-files`. */
const TEST_FILE = /(\.|_)(test|spec)\.(c|m)?[jt]sx?$/;
export const isTestFile = (p: string) => TEST_FILE.test(p) && !p.split("/").includes("node_modules");

type Node = { type?: string; [k: string]: unknown };
const isNode = (v: unknown): v is Node => !!v && typeof v === "object" && typeof (v as Node).type === "string";
const READ_CALLS = new Set(["readFileSync", "readFile", "createReadStream", "existsSync", "statSync", "lstatSync", "realpathSync", "file"]);
const WALK_CALLS = new Set(["readdirSync", "readdir", "opendirSync", "opendir", "globSync", "glob", "Glob"]);
const SPAWN_CALLS = new Set(["spawn", "spawnSync", "execSync", "execFile", "execFileSync", "fork", "$"]);
const LOCATE_META = new Set(["dir", "dirname", "url", "filename", "path", "resolve"]);
const LOCATE_NAMES = new Set(["__dirname", "__filename", "REPO_ROOT", "SRC_DIR"]);

/** A string literal or an expression-free template; anything else is not literal. */
function literalString(n: unknown): string | null {
  if (!isNode(n)) return null;
  if (n.type === "Literal" && typeof n.value === "string") return n.value;
  if (n.type === "TemplateLiteral" && Array.isArray(n.expressions) && n.expressions.length === 0) {
    const q = (n.quasis as { value?: { cooked?: string } }[])[0];
    return typeof q?.value?.cooked === "string" ? q.value.cooked : null;
  }
  return null;
}
const calleeName = (c: unknown): string | null => {
  if (!isNode(c)) return null;
  if (c.type === "Identifier") return c.name as string;
  if (c.type === "MemberExpression" && isNode(c.property) && c.property.type === "Identifier") return c.property.name as string;
  return null;
};
const ioKind = (name: string | null): IoUse | null =>
  !name ? null : READ_CALLS.has(name) ? "read" : WALK_CALLS.has(name) ? "walk" : SPAWN_CALLS.has(name) ? "spawn" : null;
/** Modules whose bindings touch the disk or start processes; a binding imported from them is io under whatever local name. */
const IO_MODULES: Record<string, IoUse | null> = { "fs": null, "node:fs": null, "fs/promises": null, "node:fs/promises": null, "bun": null,
  "child_process": "spawn", "node:child_process": "spawn" };
/** Local names bound to an io function (`import { readdirSync as list }`, `const { spawn: run } = cp`, `const r = fs.readFileSync`). */
function collectAliases(n: Node, aliases: Map<string, IoUse>): void {
  const bind = (local: unknown, kind: IoUse | null) => { if (kind && isNode(local) && local.type === "Identifier") aliases.set(local.name as string, kind); };
  if (n.type === "ImportDeclaration") {
    const mod = literalString(n.source);
    if (mod === null || !(mod in IO_MODULES)) return;
    for (const sp of (n.specifiers as Node[] | undefined) ?? []) {
      const imported = isNode(sp.imported) ? ((sp.imported.name ?? sp.imported.value) as string) : null;
      bind(sp.local, ioKind(imported) ?? IO_MODULES[mod]!);
    }
  } else if (n.type === "VariableDeclarator" && isNode(n.id)) {
    if (n.id.type === "Identifier") bind(n.id, ioKind(calleeName(n.init)));
    else if (n.id.type === "ObjectPattern") {
      for (const pr of (n.id.properties as Node[] | undefined) ?? []) bind(pr.value, ioKind(isNode(pr.key) ? (pr.key.name ?? pr.key.value) as string : null));
    }
  }
}
const PATH_JOIN = new Set(["join", "resolve"]);
/** A path argument that resolves against cwd, i.e. into the checkout: `"src/x.ts"`, `` `tests/${n}` ``, `join("src", f)`, `"web/" + p`. */
function cwdRelative(a: unknown): boolean {
  if (!isNode(a)) return false;
  const lit = literalString(a);
  if (lit !== null) return lit !== "" && !lit.startsWith("/") && !lit.startsWith("~") && !/^[a-z]+:/i.test(lit) && !/\s/.test(lit);
  if (a.type === "TemplateLiteral") return cwdRelative({ type: "Literal", value: (a.quasis as { value?: { cooked?: string } }[])[0]?.value?.cooked ?? "" });
  if (a.type === "BinaryExpression" && a.operator === "+") return cwdRelative(a.left);
  if (a.type === "CallExpression" && PATH_JOIN.has(calleeName(a.callee) ?? "")) return cwdRelative((a.arguments as unknown[])[0]);
  return false;
}
/** A source file named relative to cwd anywhere in a spawn's argv (`spawnSync(["bun", "src/manager.ts"])`). */
const relSource = (a: unknown): boolean => isNode(a) && (a.type === "ArrayExpression"
  ? (a.elements as unknown[]).some(relSource) : cwdRelative(a) && MODULE_FILE.test(literalString(a) ?? ""));
const isRequire = (c: unknown) => isNode(c) && ((c.type === "Identifier" && c.name === "require")
  || (c.type === "MemberExpression" && isNode(c.object) && c.object.type === "Identifier" && c.object.name === "require"));
const isMetaUrl = (n: unknown) => isNode(n) && n.type === "MemberExpression" && isNode(n.object) && n.object.type === "MetaProperty"
  && isNode(n.property) && n.property.name === "url";
const at = (src: string, n: Node) => `${src.slice(0, Number(n.start ?? 0)).split("\n").length}:${src.slice(Number(n.start), Number(n.end)).slice(0, 80)}`;

/** One node's contribution; split from the walk so each stays small. */
function visit(n: Node, src: string, out: ModuleScan, io: Set<IoUse>, aliases: ReadonlyMap<string, IoUse>): void {
  const spec = (s: string | null, kind: SpecKind) => { if (s !== null) out.specs.push({ spec: s, kind }); };
  switch (n.type) {
    case "ImportDeclaration": case "ExportAllDeclaration": case "ExportNamedDeclaration":
      spec(literalString(n.source), n.importKind === "type" || n.exportKind === "type" ? "type" : "static"); break;
    case "ImportExpression": {
      const s = literalString(n.source);
      if (s === null) out.dynamic.push(at(src, n)); else spec(s, "dynamic"); break;
    }
    case "CallExpression": {
      const name = calleeName(n.callee), args = n.arguments as unknown[];
      const kind = (isNode(n.callee) && n.callee.type === "Identifier" ? aliases.get(name!) : undefined) ?? ioKind(name);
      if (isRequire(n.callee)) { const s = literalString(args[0]); if (s === null) out.dynamic.push(at(src, n)); else spec(s, "require"); }
      else if (kind) {
        io.add(kind);
        if (kind === "spawn" ? args.some(relSource) : cwdRelative(args[0])) io.add("locate");
      }
      else if (name === "cwd") io.add("locate");
      break;
    }
    case "NewExpression": {
      const name = calleeName(n.callee), args = n.arguments as unknown[];
      if (name === "URL" && args.length >= 2 && isMetaUrl(args[1])) {
        const s = literalString(args[0]); // a directory URL only locates; what is read under it is the module's io
        if (s === null) out.dynamic.push(at(src, n)); else if (s.endsWith("/") || s === "." || s === "..") io.add("locate"); else spec(s, "url");
      }
      else if (name === "Worker") { const s = literalString(args[0]); if (s !== null) spec(s, "dynamic"); else if (!isNode(args[0]) || args[0].type !== "NewExpression") out.dynamic.push(at(src, n)); }
      else if (name === "Glob") io.add("walk");
      break;
    }
    case "TaggedTemplateExpression": if (calleeName(n.tag) === "$") io.add("spawn"); break;
    case "MemberExpression":
      if (isNode(n.object) && n.object.type === "MetaProperty" && isNode(n.property) && LOCATE_META.has(n.property.name as string)) io.add("locate");
      break;
    case "Identifier": if (LOCATE_NAMES.has(n.name as string)) io.add("locate"); break;
    case "TSImportType": {
      const a = n.argument as Node | undefined;
      spec(literalString(n.source) ?? literalString(a?.literal) ?? literalString(a), "type"); break;
    }
    case "TSExternalModuleReference": spec(literalString(n.expression), "require"); break;
  }
}

/** The scanner built on oxc; a parse error is reported, not thrown, and the select side treats it as unknown. */
export function oxcScanner(parseSync: OxcParseSync): ModuleScanner {
  return (path, source) => {
    const out: ModuleScan = { specs: [], dynamic: [], io: [] };
    let program: unknown;
    try {
      const r = parseSync(path, source);
      if (r.errors.length) return { ...out, error: r.errors[0]?.message ?? "parse error" };
      program = r.program;
    } catch (e) { return { ...out, error: (e as Error).message }; }
    const io = new Set<IoUse>(), aliases = new Map<string, IoUse>(), nodes: Node[] = [], stack: unknown[] = [program];
    while (stack.length) {
      const v = stack.pop();
      if (Array.isArray(v)) { for (const x of v) stack.push(x); continue; }
      if (!v || typeof v !== "object") continue;
      if (isNode(v)) nodes.push(v);
      for (const [k, x] of Object.entries(v)) if (k !== "parent" && x && typeof x === "object") stack.push(x);
    }
    // aliases first: a binding may be declared after (in walk order) the call that uses it
    for (const n of nodes) collectAliases(n, aliases);
    for (const a of new Set(aliases.values())) io.add(a);
    for (const n of nodes) visit(n, source, out, io, aliases);
    out.io = [...io].sort();
    return out;
  };
}

/** tsconfig `paths` (`{"@/*": ["./web/*"]}`) → prefix aliases; only the `x/*` → `y/*` form, the only one the repo uses. */
export function tsconfigAliases(tsconfigText: string, baseDir = ""): Alias[] {
  const cfg = Bun.JSONC.parse(tsconfigText) as { compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } };
  const base = join(baseDir, cfg.compilerOptions?.baseUrl ?? ".");
  return Object.entries(cfg.compilerOptions?.paths ?? {}).flatMap(([k, v]) => v.filter((t) => k.endsWith("/*") && t.endsWith("/*"))
    .map((t) => ({ prefix: k.slice(0, -1), target: `${normalize(join(base, t.slice(0, -1))).replace(/\/$/, "")}/` })));
}

const EXT_SWAP: [RegExp, string[]][] = [[/\.js$/, [".ts", ".tsx"]], [/\.jsx$/, [".tsx"]], [/\.mjs$/, [".mts"]], [/\.cjs$/, [".cts"]]];
const EXT_ADD = [".ts", ".tsx", ".js", ".mjs", ".json", "/index.ts", "/index.tsx", "/index.js"];
export type Resolved = { kind: "file"; path: string } | { kind: "external" } | { kind: "unresolved" };

/** Relative and alias specs resolve inside the repo (.js → .ts, extensionless, index); bare and node: specs are external. */
export function resolveSpec(from: string, spec: string, has: (p: string) => boolean, aliases: readonly Alias[]): Resolved {
  const clean = spec.replace(/[?#].*$/, "");
  const alias = aliases.find((a) => clean.startsWith(a.prefix));
  let base: string;
  if (alias) base = alias.target + clean.slice(alias.prefix.length);
  else if (clean.startsWith("./") || clean.startsWith("../") || clean === "." || clean === "..") base = join(dirname(from), clean);
  else if (clean.startsWith("/")) return { kind: "unresolved" };
  else return { kind: "external" };
  base = normalize(base);
  if (base.startsWith("../") || base === "..") return { kind: "unresolved" };
  if (base.split("/").includes("node_modules")) return { kind: "external" };
  const cands = [base, ...EXT_SWAP.flatMap(([re, exts]) => (re.test(base) ? exts.map((e) => base.replace(re, e)) : [])), ...EXT_ADD.map((e) => base + e)];
  const hit = cands.find(has);
  return hit ? { kind: "file", path: hit } : { kind: "unresolved" };
}

/** Parses every module file of the snapshot once and resolves its specs. */
export function buildGraph(snap: RepoSnapshot, scan: ModuleScanner, aliases: readonly Alias[]): ImpactGraph {
  const all = new Set(snap.paths);
  const g: ImpactGraph = { deps: new Map(), reverse: new Map(), unresolved: [], dynamic: [], io: new Map(), errors: [] };
  for (const p of [...all].filter((x) => MODULE_FILE.test(x) && !x.split("/").includes("node_modules")).sort()) {
    const s = scan(p, snap.read(p));
    if (s.error) g.errors.push({ from: p, error: s.error });
    for (const what of s.dynamic) g.dynamic.push({ from: p, what });
    if (s.io.length) g.io.set(p, s.io);
    const deps = new Set<string>();
    for (const { spec } of s.specs) {
      const r = resolveSpec(p, spec, (x) => all.has(x), aliases);
      if (r.kind === "file" && r.path !== p) deps.add(r.path);
      else if (r.kind === "unresolved") g.unresolved.push({ from: p, spec });
    }
    g.deps.set(p, [...deps].sort());
    for (const d of deps) (g.reverse.get(d) ?? g.reverse.set(d, new Set()).get(d)!).add(p);
  }
  return g;
}

/** Adds edges the parser cannot see (from → each existing to); returns a new graph, the input stays as it was. */
export function withEdges(g: ImpactGraph, extra: readonly { from: string; to: readonly string[] }[]): ImpactGraph {
  const deps = new Map(g.deps), reverse = new Map([...g.reverse].map(([k, v]) => [k, new Set(v)]));
  for (const { from, to } of extra) {
    if (!deps.has(from)) continue;
    const add = to.filter((t) => t !== from && !deps.get(from)!.includes(t));
    if (!add.length) continue;
    deps.set(from, [...deps.get(from)!, ...add].sort());
    for (const t of add) (reverse.get(t) ?? reverse.set(t, new Set()).get(t)!).add(from);
  }
  return { ...g, deps, reverse };
}

function closure(adj: (f: string) => Iterable<string>, start: Iterable<string>): Set<string> {
  const seen = new Set<string>(), stack = [...start];
  while (stack.length) {
    const f = stack.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    for (const n of adj(f)) if (!seen.has(n)) stack.push(n);
  }
  return seen;
}

/** Everything that reaches any seed through deps (seeds included); cycles are fine, each node is visited once. */
export const reverseClosure = (g: ImpactGraph, seeds: Iterable<string>): Set<string> => closure((f) => g.reverse.get(f) ?? [], seeds);

/** Forward closure: what the roots (tests) depend on, roots included. */
export const forwardClosure = (g: ImpactGraph, roots: Iterable<string>): Set<string> => closure((f) => g.deps.get(f) ?? [], roots);

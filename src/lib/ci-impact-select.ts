/**
 * Conservative affected-test selection (merge-arch-IMPACT1): a pure selector, nothing here runs a test or is wired to a gate yet.
 * Changed files are seeds; a test is selected when it reaches a seed through the head graph (new paths) or the base graph (old
 * paths of deletions and renames), plus ALWAYS_RUN, tests whose own tests/ code reads / walks / spawns at all, and INPUT_MAP
 * readers. Any change or graph fact the selector cannot bound (full triggers, unregistered external inputs, unknown local specs, a
 * changed path missing from its side, unregistered non-literal loads anywhere reachable from a test — tests/ included — or any
 * unregistered read / scan / subprocess outside tests/, parse errors, an empty proposal) makes the proposal the full suite with reasons.
 * ciRelatedChecks: absent = observe; off = full only; observe = full runs, proposal computed beside it; on = the proposal runs;
 * an unknown value = full. tests/ci-impact-select.test.ts.
 * With a measured read map (merge-arch-SELECT3, ci-impact-io-map.ts) the two blanket io rules give way to what main's full run saw:
 * each entry is an edge set beside the registry's, io the map never saw reading the repo is no reason, and tests/ io is no longer
 * always-run. Full triggers, non-literal loads, unknown specs and unregistered inputs nobody read keep their cost.
 */
import { createHash } from "node:crypto";
import { forwardClosure, type ImpactGraph, isTestFile, MODULE_FILE, reverseClosure, withEdges } from "./ci-impact-graph.js";
import { DEFAULT_IMPACT_INPUTS, globMatch, type ImpactInputs } from "./ci-impact-inputs.js";
import { type IoMapEntry, ioMapEdges } from "./ci-impact-io-map.js";

export type CiRelatedMode = "off" | "observe" | "on";
export function ciRelatedChecksMode(raw: unknown): CiRelatedMode | null {
  if (raw === undefined || raw === null) return "observe";
  return raw === "off" || raw === "observe" || raw === "on" ? raw : null;
}

export interface ChangedFile {
  status: "A" | "M" | "D" | "R" | "C" | "T";
  path: string;
  from?: string;
  /** only in diff(read-map sha, head): main changed it after the map; its old path may be gone from base already */
  sinceMap?: true;
}
const C_ESC: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };
/** Git's C-quoted path (core.quotePath: `"tests/\303\251.json"`) → the real path; null when the quoting is malformed. */
export function unquoteGitPath(p: string): string | null {
  if (!p.startsWith('"')) return p;
  if (p.length < 2 || !p.endsWith('"')) return null;
  const bytes: number[] = [], body = p.slice(1, -1);
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch === '"') return null;
    if (ch !== "\\") { bytes.push(...new TextEncoder().encode(ch)); continue; }
    const oct = /^[0-7]{3}/.exec(body.slice(i + 1));
    if (oct) { bytes.push(parseInt(oct[0], 8)); i += 3; continue; }
    const e = C_ESC[body[i + 1] ?? ""];
    if (e === undefined) return null;
    bytes.push(e); i++;
  }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes)); } catch { return null; }
}

/**
 * `git diff --name-status -M` output → changes. Both forms: `-z` (NUL-separated, paths raw — the one callers should use) and the
 * text form, whose C-quoted paths are decoded. A record it cannot read is returned in bad (the select side goes full on it).
 */
export function parseNameStatus(text: string): { changes: ChangedFile[]; bad: string[] } {
  const changes: ChangedFile[] = [], bad: string[] = [];
  const records = text.includes("\0") ? nulRecords(text) : text.split("\n").filter((l) => l.trim()).map((l) => l.split("\t"));
  for (const rec of records) {
    const [code = "", ...raw] = rec, s = code[0], paths = raw.map(text.includes("\0") ? (x: string) => x : unquoteGitPath);
    const [a, b] = paths;
    if (paths.some((x) => !x)) bad.push(rec.join("\t"));
    else if ((s === "R" || s === "C") && a && b && paths.length === 2) changes.push({ status: s, from: a, path: b });
    else if ((s === "A" || s === "M" || s === "D" || s === "T") && a && paths.length === 1) changes.push({ status: s, path: a });
    else bad.push(rec.join("\t"));
  }
  return { changes, bad };
}
/** `-z` records: status, then one path (two for R / C). */
function nulRecords(text: string): string[][] {
  const tok = text.split("\0"), out: string[][] = [];
  if (tok.at(-1) === "") tok.pop();
  for (let i = 0; i < tok.length;) {
    const code = tok[i++]!, n = code[0] === "R" || code[0] === "C" ? 2 : 1;
    out.push([code, ...tok.slice(i, i + n)]);
    i += n;
  }
  return out;
}

export interface ImpactSide { graph: ImpactGraph; paths: readonly string[] }
export interface SelectInput {
  mode: unknown;
  changes: readonly ChangedFile[];
  /** diff lines that did not parse; any makes the proposal full */
  badChanges?: readonly string[];
  headPaths: readonly string[];
  /** called only when a proposal is needed, so off and an unknown mode never parse the repo */
  load: () => { base: ImpactSide; head: ImpactSide };
  inputs?: ImpactInputs;
  /** the measured read map's entries; absent = the registry-only rules */
  ioMap?: readonly IoMapEntry[];
}
type LinkVia = "always" | "reads-repo" | "import" | "input-map" | "io-map";
interface ImpactLink { test: string; via: LinkVia; cause: string }
export interface ImpactSelection {
  mode: CiRelatedMode | "unknown";
  run: "full" | "selected";
  /** what actually runs */
  tests: string[];
  /** observe / on: the would-be selection (the full list when it fell back); off / unknown: null */
  proposed: string[] | null;
  fullReasons: string[];
  links: ImpactLink[];
  /** guard runs whatever the selection; the selector never narrows it */
  guard: true;
  digest: string;
}

interface Proposal { tests: string[]; reasons: string[]; links: ImpactLink[] }
const REASON_CAP = 30;

/** INPUT_MAP rows and implicit deps → graph edges over one side's paths. */
function implicitEdges(paths: readonly string[], inputs: ImpactInputs) {
  return inputs.implicit.map((e) => ({ from: e.module, to: paths.filter((p) => e.deps.some((d) => globMatch(d, p))) }))
    .concat(inputs.inputMap.flatMap((m) => m.consumers.map((c) => ({ from: c, to: paths.filter((p) => globMatch(m.inputs, p)) }))));
}

/**
 * Graph facts that make any selection unsafe, over modules reachable from a test. A non-literal load is full wherever it is; any
 * read / walk / spawn outside tests/ is full unless IMPLICIT_INPUTS names its deps — whether the path is a literal, a variable or
 * a caller's argument cannot be told apart, so how the module locates the repo is no proof either way. tests/ code doing any io at
 * all is always-run instead (alwaysRun), so a test never needs its reads named to stay safe. With a read map (measured) the io
 * rule is off: the map's edges name what each module read, and a module absent from it read nothing in the repo.
 */
function graphReasons(g: ImpactGraph, tests: readonly string[], inputs: ImpactInputs, measured: boolean): string[] {
  const reach = forwardClosure(g, tests), out: string[] = [];
  const known = new Set(inputs.knownUnresolved.map((u) => u.spec)), registered = new Set(inputs.implicit.map((i) => i.module));
  for (const u of g.unresolved) if (reach.has(u.from) && !known.has(u.spec)) out.push(`未知本地依赖：${u.from} → ${u.spec}`);
  for (const e of g.errors) if (reach.has(e.from)) out.push(`解析失败：${e.from}（${e.error}）`);
  const dyn = new Set(g.dynamic.map((d) => d.from));
  for (const m of [...reach].sort()) {
    if ((!dyn.has(m) && m.startsWith("tests/")) || registered.has(m)) continue;
    const io = g.io.get(m) ?? [];
    if (dyn.has(m)) out.push(`未登记的非字面量动态加载：${m}`);
    else if (!measured && io.some((x) => x !== "locate")) out.push(`未登记的仓库读取 / 扫描 / 子进程：${m}`);
  }
  return out;
}

/**
 * Tests that run whatever changed: ALWAYS_RUN, and — without a read map — tests reaching tests/ code that reads, walks or spawns
 * anything (located or not).
 */
function alwaysRun(g: ImpactGraph, tests: ReadonlySet<string>, inputs: ImpactInputs, measured: boolean): ImpactLink[] {
  const links = inputs.alwaysRun.filter((a) => tests.has(a.test)).map((a): ImpactLink => ({ test: a.test, via: "always", cause: a.why }));
  if (measured) return links;
  const readers = [...g.deps.keys()].filter((m) => m.startsWith("tests/") && (g.io.get(m) ?? []).some((x) => x !== "locate")).sort();
  for (const r of readers) for (const t of reverseClosure(g, [r])) if (tests.has(t)) links.push({ test: t, via: "reads-repo", cause: r });
  return links;
}

type Seed = { path: string; side: "base" | "head" };
/** One changed path on one side: a full reason, a seed, or nothing (docs). */
function classify(p: string, side: ImpactSide, inputs: ImpactInputs): { reason?: string; seed?: boolean } {
  const full = inputs.fullTriggers.find((f) => globMatch(f.glob, p));
  if (full) return { reason: `全量触发：${p}（${full.why}）` };
  if (MODULE_FILE.test(p) || side.graph.reverse.has(p)) return { seed: true };
  if (inputs.docs.some((d) => globMatch(d, p))) return {};
  return { reason: `未登记外部输入：${p}` };
}

function seedsOf(changes: readonly ChangedFile[], base: ImpactSide, head: ImpactSide, inputs: ImpactInputs) {
  const seeds: Seed[] = [], reasons: string[] = [];
  const inBase = new Set(base.paths), inHead = new Set(head.paths);
  for (const c of changes) {
    const old = c.status === "R" || c.status === "C" ? c.from : c.status === "A" ? undefined : c.path;
    const sides: [string | undefined, ImpactSide, "base" | "head", Set<string>][] = [[old, base, "base", inBase],
      [c.status === "D" ? undefined : c.path, head, "head", inHead]];
    for (const [p, side, name, has] of sides) {
      if (!p) continue;
      // a deleted / renamed-away path the base cannot place has consumers nobody can name any more
      // (a path main itself dropped after the read map is not this PR's change: base and head agree on it)
      if (!has.has(p)) { if (name === "base" && c.status !== "M" && c.status !== "T" && !c.sinceMap) reasons.push(`改动旧路径不在 base：${p}`); continue; }
      const r = classify(p, side, inputs);
      if (r.reason) reasons.push(r.reason);
      if (r.seed) seeds.push({ path: p, side: name });
    }
    if (c.status !== "D" && !inHead.has(c.path)) reasons.push(`改动文件不在 head：${c.path}`);
  }
  return { seeds, reasons };
}

/** The proposal itself; reasons non-empty = it is the full suite. ioMap = the measured read map's entries (see the file header). */
export function proposeTests(changes: readonly ChangedFile[], base: ImpactSide, head: ImpactSide, inputs = DEFAULT_IMPACT_INPUTS,
  ioMap?: readonly IoMapEntry[]): Proposal {
  const all = head.paths.filter(isTestFile).sort(), tests = new Set(all), measured = ioMap !== undefined;
  const edges = (side: ImpactSide, other: ImpactSide) => withEdges(side.graph,
    [...implicitEdges(side.paths, inputs), ...(ioMap ? ioMapEdges(ioMap, side.paths, other.paths) : [])]);
  const b: ImpactSide = { ...base, graph: edges(base, head) }, h: ImpactSide = { ...head, graph: edges(head, base) };
  const { seeds, reasons } = seedsOf(changes, b, h, inputs);
  if (!changes.length) reasons.push("没有改动文件");
  reasons.push(...graphReasons(h.graph, all, inputs, measured));
  const links = alwaysRun(h.graph, tests, inputs, measured);
  for (const s of [...seeds].sort((x, y) => x.path.localeCompare(y.path) || x.side.localeCompare(y.side))) {
    const mapped = inputs.inputMap.find((m) => globMatch(m.inputs, s.path));
    for (const t of reverseClosure((s.side === "head" ? h : b).graph, [s.path])) {
      if (tests.has(t)) links.push({ test: t, via: mapped ? "input-map" : measured && !MODULE_FILE.test(s.path) ? "io-map" : "import", cause: s.side === "base" ? `${s.path}（base）` : s.path });
    }
  }
  const picked = [...new Set(links.map((l) => l.test))].sort();
  if (!reasons.length && !picked.length) reasons.push("拟选集为空（不能拿空清单判绿）");
  const firstLinks = [...new Map(links.map((l) => [l.test, l] as const)).values()].sort((x, y) => x.test.localeCompare(y.test));
  const uniq = [...new Set(reasons)].sort();
  const capped = uniq.length > REASON_CAP ? [...uniq.slice(0, REASON_CAP), `…另 ${uniq.length - REASON_CAP} 条`] : uniq;
  return reasons.length ? { tests: all, reasons: capped, links: firstLinks } : { tests: picked, reasons: [], links: firstLinks };
}

const digestOf = (s: Omit<ImpactSelection, "digest">) => createHash("sha256")
  .update(JSON.stringify([s.mode, s.run, s.tests, s.proposed, s.fullReasons])).digest("hex");
const done = (s: Omit<ImpactSelection, "digest" | "guard">): ImpactSelection => ({ ...s, guard: true, digest: digestOf({ ...s, guard: true }) });

/** The one entry every caller uses; it never throws (a failing load is a full fallback with its reason). */
export function selectImpactedTests(input: SelectInput): ImpactSelection {
  const all = input.headPaths.filter(isTestFile).sort(), mode = ciRelatedChecksMode(input.mode);
  if (mode === null) return done({ mode: "unknown", run: "full", tests: all, proposed: null, fullReasons: [`ciRelatedChecks 配置未知：${JSON.stringify(input.mode)}`], links: [] });
  if (mode === "off") return done({ mode, run: "full", tests: all, proposed: null, fullReasons: ["ciRelatedChecks=off"], links: [] });
  let p: Proposal;
  try {
    const { base, head } = input.load();
    p = proposeTests(input.changes, base, head, input.inputs, input.ioMap);
  } catch (e) { p = { tests: all, reasons: [`图构建失败：${(e as Error).message}`], links: [] }; }
  if (input.badChanges?.length) p = { tests: all, reasons: [...input.badChanges.map((l) => `改动行读不懂：${l}`), ...p.reasons], links: p.links };
  const run = mode === "on" && !p.reasons.length ? "selected" : "full";
  return done({ mode, run, tests: run === "full" ? all : p.tests, proposed: p.tests, fullReasons: p.reasons, links: p.links });
}

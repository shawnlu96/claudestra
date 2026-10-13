/**
 * The measured read map as a selection input (merge-arch-SELECT3). main's full push run records which repo files each module really
 * read / walked / spawned (src/lib/ci-io-trace.ts → scripts/ci-io-map.ts → artifact ci-io-map); here that file is parsed, checked and
 * turned into graph edges for ci-impact-select.ts, which then drops its two blanket io rules. Pure: the run list, the ancestry check
 * and the download arrive as functions (scripts/ci-related-plan.ts passes gh / git), so every way of not having a usable map is a
 * returned reason and the caller stays on the registry-only rules.
 * CI_IO_MAP: absent / empty = observe (the plan runs by the old rules and records what the map would pick); on = the map's
 * selection runs; off = not computed; an unknown value = not computed, with the reason recorded.
 * The map only covers what main's push run executes: slow-list tests (nightly) are not in it and never run on a PR anyway.
 * tests/ci-impact-io-map.test.ts.
 */
export type CiIoMapMode = "off" | "observe" | "on";
export function ciIoMapMode(raw: unknown): CiIoMapMode | null {
  if (raw === undefined || raw === null || raw === "") return "observe";
  return raw === "off" || raw === "observe" || raw === "on" ? raw : null;
}

export interface IoMapEntry { module: string; reads: readonly string[]; walks: readonly string[]; spawns: readonly string[] }
export interface IoMap { version: 1; sha: string; generatedAt: string; entries: IoMapEntry[] }

const IO_MAP_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const SHA = /^[0-9a-f]{40}$/;
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string" && x !== "");

/** io-map.json text → the map; throws with what is wrong (the caller turns it into a fallback reason). */
export function parseIoMap(text: string): IoMap {
  const m = JSON.parse(text) as Partial<IoMap> | null;
  if (!m || typeof m !== "object" || Array.isArray(m)) throw new Error("不是对象");
  if (m.version !== 1) throw new Error(`version ${JSON.stringify(m.version)} 不认识`);
  if (typeof m.sha !== "string" || !SHA.test(m.sha)) throw new Error("sha 不是 40 位提交号");
  if (typeof m.generatedAt !== "string" || Number.isNaN(Date.parse(m.generatedAt))) throw new Error("generatedAt 不是时间");
  if (!Array.isArray(m.entries)) throw new Error("entries 不是数组");
  for (const e of m.entries as Partial<IoMapEntry>[]) {
    const ok = !!e && typeof e.module === "string" && e.module !== "" && strings(e.reads) && strings(e.walks) && strings(e.spawns);
    if (!ok) throw new Error(`entry 读不懂：${JSON.stringify(e)?.slice(0, 80)}`);
  }
  return { version: 1, sha: m.sha, generatedAt: m.generatedAt, entries: m.entries };
}

/** Every directory that holds a path ("." included). */
function dirsOf(paths: readonly string[]): Set<string> {
  const out = new Set(["."]);
  for (const p of paths) for (let i = p.lastIndexOf("/"); i > 0; i = p.lastIndexOf("/", i - 1)) { const d = p.slice(0, i); if (out.has(d)) break; out.add(d); }
  return out;
}

/**
 * Entries → edges over one side's paths (module → what it depends on there):
 * - a file it read or spawned;
 * - everything under a directory it walked (any add / delete / change / rename below is that module's change);
 * - a directory it only looked at (exists / stat / realpath): its files on the side where it exists while the other side has no
 *   such directory — that it appears or disappears is the only thing such a call can see.
 * A path missing on this side adds nothing; a file the PR adds where the map saw a miss is in head's paths and gets its edge.
 */
export function ioMapEdges(entries: readonly IoMapEntry[], paths: readonly string[], other: readonly string[]): { from: string; to: string[] }[] {
  const files = new Set(paths), dirs = dirsOf(paths), otherDirs = dirsOf(other), memo = new Map<string, string[]>();
  const under = (d: string): string[] => {
    let hit = memo.get(d);
    if (!hit) memo.set(d, (hit = d === "." ? [...paths] : paths.filter((p) => p.startsWith(`${d}/`))));
    return hit;
  };
  const by = new Map<string, Set<string>>();
  for (const e of entries) {
    const to = by.get(e.module) ?? by.set(e.module, new Set()).get(e.module)!;
    for (const p of [...e.reads, ...e.spawns]) {
      if (files.has(p)) to.add(p);
      else if (dirs.has(p) && !otherDirs.has(p)) for (const x of under(p)) to.add(x);
    }
    for (const d of e.walks) {
      if (files.has(d)) to.add(d);
      else for (const x of under(d)) to.add(x);
    }
  }
  return [...by].map(([from, to]) => ({ from, to: [...to] }));
}

interface MainRun { id: number; sha: string; at: string }
/** GitHub's workflow-runs listing → successful push runs of main, newest first; throws when the text is not that listing. */
export function mainPushRuns(text: string): MainRun[] {
  const body = JSON.parse(text) as { workflow_runs?: unknown } | null;
  if (!body || !Array.isArray(body.workflow_runs)) throw new Error("没有 workflow_runs");
  const out: MainRun[] = [];
  for (const r of body.workflow_runs as Record<string, unknown>[]) {
    if (!r || r.event !== "push" || r.head_branch !== "main" || r.status !== "completed" || r.conclusion !== "success") continue;
    if (typeof r.id !== "number" || typeof r.head_sha !== "string" || !SHA.test(r.head_sha)) continue;
    out.push({ id: r.id, sha: r.head_sha, at: typeof r.created_at === "string" ? r.created_at : "" });
  }
  return out.sort((a, b) => b.at.localeCompare(a.at) || b.id - a.id);
}

export interface IoMapSource {
  /** the workflow-runs listing (JSON text) of ci.yml on main */
  runs: () => string;
  /** is this commit an ancestor of the PR head */
  isAncestor: (sha: string) => boolean;
  /** the io-map.json text of that run's ci-io-map artifact */
  download: (runId: number) => string;
  now: Date;
}
export type IoMapResult = { map: IoMap; runId: number } | { reason: string };
const msg = (e: unknown) => (e as Error).message.split("\n")[0]!.slice(0, 160);

/**
 * The map to select with: the newest successful main push run whose commit is an ancestor of the PR head, its artifact downloaded,
 * parsed, bound to that commit and at most 7 days old. Anything else is a reason, never a throw.
 */
export function resolveIoMap(src: IoMapSource): IoMapResult {
  let runs: MainRun[];
  try { runs = mainPushRuns(src.runs()); } catch (e) { return { reason: `读取图：列 main 运行失败（${msg(e)}）` }; }
  if (!runs.length) return { reason: "读取图：找不到成功的 main push 运行" };
  let run: MainRun | undefined;
  try { run = runs.find((r) => src.isAncestor(r.sha)); } catch (e) { return { reason: `读取图：祖先判断失败（${msg(e)}）` }; }
  if (!run) return { reason: `读取图：最近 ${runs.length} 次成功 main 运行的 sha 都不是 PR head 的祖先` };
  let text: string;
  try { text = src.download(run.id); } catch (e) { return { reason: `读取图：运行 ${run.id} 的 ci-io-map 工件找不到或下载失败（${msg(e)}）` }; }
  let map: IoMap;
  try { map = parseIoMap(text); } catch (e) { return { reason: `读取图：解析失败（${msg(e)}）` }; }
  if (map.sha !== run.sha) return { reason: `读取图：图里的 sha ${map.sha.slice(0, 12)} 不是运行 ${run.id} 的 ${run.sha.slice(0, 12)}` };
  const age = src.now.getTime() - Date.parse(map.generatedAt);
  if (age > IO_MAP_MAX_AGE_MS) return { reason: `读取图：生成于 ${map.generatedAt}，超过 7 天` };
  return { map, runId: run.id };
}

type Change = { status: string; path: string; from?: string };
/**
 * diff(base, head) ∪ diff(map sha, head): the PR's own changes first, then what main changed after the map was drawn (marked
 * sinceMap) — a module main touched since may read things the map has not seen, so it counts as changed too.
 */
export function unionChanges<T extends Change>(pr: readonly T[], sinceMap: readonly T[]): (T & { sinceMap?: true })[] {
  const key = (c: Change) => `${c.status}\0${c.from ?? ""}\0${c.path}`, seen = new Set(pr.map(key));
  return [...pr, ...sinceMap.filter((c) => !seen.has(key(c))).map((c) => ({ ...c, sinceMap: true as const }))];
}

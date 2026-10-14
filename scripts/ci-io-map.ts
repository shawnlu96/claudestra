// 实测读取图汇总（merge-arch-SELECT2，ci.yml check 作业里只在 push main 时跑）。用法：
//   bun scripts/ci-io-map.ts <分片工件目录> <输出 io-map.json> <sha> [片数]
// 各片测试步骤带 CI_IO_TRACE 跑（src/lib/ci-io-trace.ts），工件 ci-io-trace-shard-<k> 里是一份 JSONL；这里把它们合成
// {version:1, sha, generatedAt, entries:[{module, reads[], walks[], spawns[]}], untracked}，模块与路径都排序去重。给了片数时缺任何一片就不出图
// （缺一片的图会漏读取，SELECT3 拿它选测试不安全）。读不懂的行跳过并在日志里记条数。失败只写原因、退出码非 0，
// ci.yml 那一步 continue-on-error，不影响 main 判绿。只用系统库（ci-impact-graph.ts 也只用 node:path）：check 作业不 bun install。tests/ci-io-map.test.ts。
// untracked（SELECT5）：起过的仓库模块自己一条记录都没有——子进程没装记录器（最小 env、--config=/dev/null）或真的不碰文件，
// 图里它的依赖是盲区而不是「没有」。只如实列出、不算失败；SELECT3 不读这个字段（parseIoMap 忽略多余字段）。
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { MODULE_FILE } from "../src/lib/ci-impact-graph.ts";

const KINDS = { read: "reads", walk: "walks", spawn: "spawns" } as const;
type Kind = keyof typeof KINDS;
export interface IoMapEntry { module: string; reads: string[]; walks: string[]; spawns: string[] }
export interface UntrackedSpawn { module: string; spawnedBy: string[] }
export interface IoMap { version: 1; sha: string; generatedAt: string; entries: IoMapEntry[]; untracked: UntrackedSpawn[] }

/** 透传给最小 env 子进程的 `--preload` 记录器本身（argv 里的仓库文件都记成 spawn）：它不读仓库，列进来只是噪音 */
const RECORDER_PRELOAD = "src/lib/sync-fs-trace.ts";

/**
 * Repo modules some entry spawned that have no entry of their own (the child left no record at all). A module that spawns itself
 * (a worker mode) already has an entry from the parent, so an untraced self-spawn cannot show up here.
 */
export function untrackedSpawns(entries: readonly IoMapEntry[]): UntrackedSpawn[] {
  const seen = new Set([...entries.map((e) => e.module), RECORDER_PRELOAD]), by = new Map<string, Set<string>>();
  for (const e of entries) {
    for (const p of e.spawns.filter((x) => MODULE_FILE.test(x) && !seen.has(x))) {
      let s = by.get(p);
      if (!s) by.set(p, (s = new Set()));
      s.add(e.module);
    }
  }
  return [...by.keys()].sort().map((module) => ({ module, spawnedBy: [...by.get(module)!].sort() }));
}

/** JSONL texts → the map; bad counts the lines that are not a {module, kind, path} record. */
export function buildIoMap(texts: readonly string[], sha: string, now: Date): { map: IoMap; bad: number; lines: number } {
  const by = new Map<string, Record<Kind, Set<string>>>();
  let bad = 0, lines = 0;
  for (const text of texts) {
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      lines++;
      let r: { module?: unknown; kind?: unknown; path?: unknown };
      try { r = JSON.parse(line); } catch { bad++; continue; }
      if (typeof r?.module !== "string" || !r.module || typeof r.path !== "string" || !r.path || !Object.hasOwn(KINDS, String(r.kind))) { bad++; continue; }
      let e = by.get(r.module);
      if (!e) by.set(r.module, (e = { read: new Set(), walk: new Set(), spawn: new Set() }));
      e[r.kind as Kind].add(r.path);
    }
  }
  const sorted = (s: Set<string>) => [...s].sort();
  const entries = [...by.keys()].sort().map((module): IoMapEntry => {
    const e = by.get(module)!;
    return { module, reads: sorted(e.read), walks: sorted(e.walk), spawns: sorted(e.spawn) };
  });
  return { map: { version: 1, sha, generatedAt: now.toISOString(), entries, untracked: untrackedSpawns(entries) }, bad, lines };
}

/** Every *.jsonl under dir (download-artifact puts each artifact in its own subdirectory). */
export function traceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...traceFiles(p));
    else if (name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

/** With a shard count: the artifact directories ci-io-trace-shard-1..n must all be there, each with its trace. */
export function missingShards(dir: string, shards: number): string[] {
  const out: string[] = [];
  for (let k = 1; k <= shards; k++) {
    const sub = join(dir, `ci-io-trace-shard-${k}`);
    if (!existsSync(sub) || !traceFiles(sub).length) out.push(`ci-io-trace-shard-${k}`);
  }
  return out;
}

function main(args: string[]): void {
  const [dir, out, sha, n] = args;
  if (!dir || !out || !sha) throw new Error("用法：<分片工件目录> <输出 io-map.json> <sha> [片数]");
  if (!existsSync(dir)) throw new Error(`没有分片工件目录 ${dir}`);
  if (n !== undefined) {
    const shards = Number(n);
    if (!Number.isSafeInteger(shards) || shards < 1) throw new Error(`片数 ${n} 不合法`);
    const missing = missingShards(dir, shards);
    if (missing.length) throw new Error(`缺分片记录，不出图：${missing.join(", ")}`);
  }
  const files = traceFiles(dir);
  if (!files.length) throw new Error(`${dir} 下没有 .jsonl 记录`);
  const { map, bad, lines } = buildIoMap(files.map((f) => readFileSync(f, "utf8")), sha, new Date());
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(map, null, 1)}\n`);
  console.log(`io-map：${files.length} 份记录 · ${lines} 行 · ${map.entries.length} 个模块${bad ? ` · 跳过读不懂的 ${bad} 行` : ""} → ${out}`);
  const u = map.untracked;
  if (u.length) console.log(`未追踪子进程 ${u.length} 个（起过但没留下任何记录，图里是盲区）：${u.map((x) => `${x.module} ← ${x.spawnedBy.join(", ")}`).join("；")}`);
}

if (import.meta.main) {
  try { main(process.argv.slice(2)); } catch (e) { console.log(`::warning::ci-io-map 汇总失败（不影响判绿）：${(e as Error).message}`); process.exit(1); }
}

// CI 单元测试分片（ci.yml / nightly.yml）。用法：
//   bun scripts/ci-test-shard.ts 2/8                       打印第 2/8 片的测试文件（每行一个 ./路径，按路径排序，片内照旧串行；不含慢清单）
//   bun scripts/ci-test-shard.ts slow 1/2                  夜间：只在慢清单（tests/slow-tests.txt）里分片
//   bun scripts/ci-test-shard.ts verify <目录> 8 <head>     汇总闸：核对下载下来的 8 份分片日志（见 verifyShards），不过就非零退出
//   bun scripts/ci-test-shard.ts plan 8                    打印各片的预计秒数与文件数
//   bun scripts/ci-test-shard.ts durations <日志目录>       从带时间戳的分片作业日志重算 scripts/ci-test-durations.json（见 durationsFromLogs）
// 不用 `bun test --shard`：它按路径轮流分，增删一个文件后面全体移位，重文件会扎堆。
// 耗时表过时 / 缺失只影响均衡、不影响正确性——汇总闸核对每片恰好跑了这里给它的文件。tests/ci-test-shard.test.ts。
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** bun test 的发现规则：*.test / _test / .spec / _spec 加 js/ts 族扩展名。 */
const TEST_FILE = /(\.|_)(test|spec)\.(c|m)?[jt]sx?$/;

/** 每个测试文件在 CI（ubuntu，Bun 1.3.14）里实测的秒数，「路径 → 秒」；用 durations 子命令从分片作业日志刷新。 */
const DURATIONS_FILE = join(import.meta.dir, "ci-test-durations.json");
/** 慢清单：每行一个路径，`#` 之后是注释（实测秒数）。PR / push 的分片不跑它们，夜间（nightly.yml）只跑它们。 */
const SLOW_FILE = join(import.meta.dir, "..", "tests", "slow-tests.txt");
/** 慢清单的上限：最多这么多个文件、合计不超过全量预计耗时的这个比例（防止把测试成批挪走）。 */
export const SLOW_MAX_FILES = 20;
export const SLOW_MAX_SHARE = 0.3;
/** 耗时表里没有的文件（新加的测试；表缺失 / 坏掉时是全部文件）按这么多秒算。 */
const LIGHT = 1;
/** 第 1 片另外跑 typecheck、guard、打包入口（实测合计 14 ~ 23 s），先记在它账上。 */
const SHARD1_EXTRA = 20;
/** Bun 在 Actions 里给每个跑过的文件打一行（被别的测试 import 过、自己注册 0 条用例的也有）。 */
const GROUP = /^::group::(.+):$/;

export type Durations = Readonly<Record<string, number>>;

/** 耗时表的内容 → 「路径 → 秒」；不是「对象、值全是非负有限数」就返回 null。 */
export function parseDurations(text: string): Durations | null {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return null; }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  return Object.values(raw).every((v) => typeof v === "number" && Number.isFinite(v) && v >= 0) ? raw as Durations : null;
}

/** 读耗时表。缺失 / 解析失败时全部文件按 LIGHT 算（seconds 为空）并给一句提示，不抛：CI 不因此变红。 */
export function loadDurations(path = DURATIONS_FILE): { seconds: Durations; note: string | null } {
  if (!existsSync(path)) return { seconds: {}, note: `耗时表 ${path} 不存在，全部测试文件按 ${LIGHT} s 分片（只影响均衡）` };
  const seconds = parseDurations(readFileSync(path, "utf8"));
  return seconds ? { seconds, note: null } : { seconds: {}, note: `耗时表 ${path} 解析失败，全部测试文件按 ${LIGHT} s 分片（只影响均衡）` };
}

let repoDurations: Durations | undefined;
/** 入库的那份耗时表（各片与汇总闸在同一 head 上读到同一份，分法因此一致）。 */
const defaultDurations = (): Durations => (repoDurations ??= loadDurations().seconds);

/** 慢清单的内容 → 路径（保留重复，由 slowProblems 报）。 */
export const parseSlowList = (text: string): string[] => text.split("\n").map((l) => l.replace(/#.*$/, "").trim()).filter(Boolean);

/** 慢清单的问题（空 = 没有）：不存在的文件、重复的文件、超过个数 / 耗时占比上限。 */
export function slowProblems(slow: string[], files: string[], seconds: Durations = defaultDurations()): string[] {
  const known = new Set(files), seen = new Set<string>();
  const dup = [...new Set(slow.filter((f) => seen.has(f) || !seen.add(f)))], missing = [...seen].filter((f) => !known.has(f));
  const weight = (f: string) => seconds[f] ?? LIGHT, sum = (fs: string[]) => fs.reduce((s, f) => s + weight(f), 0);
  const share = files.length ? sum([...seen].filter((f) => known.has(f))) / sum(files) : 0;
  return [
    ...(missing.length ? [`慢清单里有不存在的测试文件：${missing.join(", ")}`] : []),
    ...(dup.length ? [`慢清单里重复的文件：${dup.join(", ")}`] : []),
    ...(seen.size > SLOW_MAX_FILES ? [`慢清单有 ${seen.size} 个文件，上限 ${SLOW_MAX_FILES}`] : []),
    ...(share > SLOW_MAX_SHARE ? [`慢清单占全量预计耗时的 ${(share * 100).toFixed(1)}%，上限 ${SLOW_MAX_SHARE * 100}%`] : []),
  ];
}

/** `git ls-files` 输出里 bun test 会发现的测试文件，按路径排序。 */
export const testFiles = (lsFiles: string): string[] => lsFiles.split("\n").filter((f) => TEST_FILE.test(f)).sort();

/** LPT：最重的先放进当前最轻的一片；同重按路径、同负载按片号，同一份清单与耗时表永远分得一样。extra 先记在第 1 片账上。 */
function assign(files: string[], n: number, seconds: Durations, extra: number): { load: number; files: string[] }[] {
  const weight = (f: string) => seconds[f] ?? LIGHT;
  const shards = Array.from({ length: n }, (_, i) => ({ load: i === 0 ? extra : 0, files: [] as string[] }));
  for (const f of [...files].sort((a, b) => weight(b) - weight(a) || (a < b ? -1 : 1))) {
    const lightest = shards.reduce((a, b) => (b.load < a.load ? b : a));
    lightest.load += weight(f);
    lightest.files.push(f);
  }
  return shards;
}

/** n 片分法（每片按路径排序）。 */
export const planShards = (files: string[], n: number, seconds: Durations = defaultDurations(), extra = SHARD1_EXTRA): string[][] =>
  assign(files, n, seconds, extra).map((s) => s.files.sort());

/** 各片的预计秒数（第 1 片含 typecheck / guard / 打包）。 */
export const shardLoads = (files: string[], n: number, seconds: Durations = defaultDurations(), extra = SHARD1_EXTRA): number[] =>
  assign(files, n, seconds, extra).map((s) => s.load);

/** files 里不在慢清单上的那些：PR / push 的分片只分这些。 */
export const withoutSlow = (files: string[], slow: readonly string[]): string[] => { const s = new Set(slow); return files.filter((f) => !s.has(f)); };

const STAMPED = /^(?:.*\t)?\uFEFF?(\d{4}-\d\d-\d\dT[\d:.]+Z) (.*)$/;
const LOG_GROUP = /^(?:##\[group\]|::group::)(.+):$/;
const LOG_END = /^Ran \d+ tests? across \d+ files?\./;
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };

/**
 * 从带时间戳的分片作业日志（`gh api repos/<repo>/actions/jobs/<id>/logs`，每行开头是 ISO 时间）算每个测试文件的秒数：
 * 片内串行，一个文件的耗时 = 它的 group 行到下一个文件的 group 行（最后一个到 `Ran N tests across M files.`）的间隔。
 * 没跑完的日志里最后一个文件没有结束时间，不计。同一个文件在多份日志（多次 run）里都有时取中位数；结果保留两位小数。
 */
export function durationsFromLogs(logs: string[]): Record<string, number> {
  const samples = new Map<string, number[]>();
  for (const log of logs) {
    let open: { file: string; at: number } | null = null;
    for (const line of log.split("\n")) {
      const m = STAMPED.exec(line.trimEnd());
      if (!m) continue;
      const file = LOG_GROUP.exec(m[2]!)?.[1]?.replace(/^\.\//, "");
      const starts = file !== undefined && TEST_FILE.test(file);
      if (!starts && !LOG_END.test(m[2]!)) continue;
      const at = Date.parse(m[1]!);
      if (open) samples.set(open.file, [...(samples.get(open.file) ?? []), (at - open.at) / 1000]);
      open = starts ? { file: file!, at } : null;
    }
  }
  return Object.fromEntries([...samples].sort(([a], [b]) => (a < b ? -1 : 1)).map(([f, xs]) => [f, Math.round(median(xs) * 100) / 100]));
}

/** 耗时表的落盘格式：按路径排序、每行 3 项（一千多个文件一行一项太长）。 */
export function formatDurations(seconds: Durations): string {
  const items = Object.keys(seconds).sort().map((f) => `${JSON.stringify(f)}: ${seconds[f]}`);
  const rows = Array.from({ length: Math.ceil(items.length / 3) }, (_, i) => `  ${items.slice(i * 3, i * 3 + 3).join(", ")}`);
  return `{\n${rows.join(",\n")}\n}\n`;
}

export interface ShardExpect {
  n: number; head: string; bunVersion: string;
  /** 入库的全部测试文件（含慢清单里的）：bun 自己发现的文件数要等于它。 */
  files: string[];
  /** 慢清单（parseSlowList 的结果）；不给 = 空。 */
  slow?: string[];
  /** 耗时表；不给 = 入库的那份。 */
  seconds?: Durations;
}

/**
 * 一片的日志：开头三行 shard / head / discovered（ci.yml 的分片步骤写的），第 4 行是 bun test 的版本行，之后每个跑过的文件一行 group。
 * 这四类行在整份日志里各恰好一行、就在这四个位置上：后面再出现一行（重复或冲突的值）都拒，免得拼接 / 改写过的日志混过去。
 */
const META = [/^shard=/, /^head=/, /^discovered=/, /^bun test v/];

function checkShard(name: string, log: string, k: number, want: ShardExpect, plan: string[]): string[] {
  const errs: string[] = [];
  const lines = log.split("\n");
  [`shard=${k}/${want.n}`, `head=${want.head}`, `discovered=${want.files.length}`].forEach((h, i) => {
    if (lines[i] !== h) errs.push(`${name} 第 ${i + 1} 行应为「${h}」，实际「${lines[i] ?? ""}」`);
  });
  if (!lines[3]?.startsWith(`bun test v${want.bunVersion} `)) errs.push(`${name} 第 4 行应是 bun test v${want.bunVersion} 的版本行，实际「${lines[3] ?? ""}」`);
  META.forEach((re, i) => {
    const at = lines.flatMap((l, j) => (re.test(l) ? [j + 1] : []));
    if (at.length !== 1 || at[0] !== i + 1) errs.push(`${name} 里 ${re.source.slice(1)} 行应只在第 ${i + 1} 行出现一次，实际在第 ${at.join(", ") || "（无）"} 行`);
  });
  const ran = lines.flatMap((l) => GROUP.exec(l)?.[1] ?? []);
  const seen = new Set<string>(), mine = new Set(plan);
  const dup = ran.filter((f) => seen.has(f) || !seen.add(f));
  const missing = plan.filter((f) => !seen.has(f)), extra = [...seen].filter((f) => !mine.has(f));
  const few = (fs: string[]) => `${fs.length} 个：${fs.slice(0, 5).join(", ")}${fs.length > 5 ? " …" : ""}`;
  if (dup.length) errs.push(`${name} 重复跑了 ${few(dup)}`);
  if (missing.length) errs.push(`${name} 没跑到分给它的 ${few(missing)}`);
  if (extra.length) errs.push(`${name} 跑了不该它跑的 ${few(extra)}`);
  return errs;
}

/**
 * 汇总闸的不漏不重：工件恰好是 test-shard-1..n，每份各自核对开头（片号、head、bun 自己发现的文件数 = 入库测试文件数、
 * Bun 版本）和跑过的文件恰好是分给这一片的那些。每片单独核，一片缺的不会被另一片盖住。返回错误（空 = 通过）。
 * 分片覆盖 = 全部测试文件减去慢清单；慢清单本身有问题（不存在 / 重复的文件、超上限，见 slowProblems）也是错误。
 */
export function verifyShards(logs: Map<string, string>, want: ShardExpect): string[] {
  const names = Array.from({ length: want.n }, (_, i) => `test-shard-${i + 1}`);
  const extra = [...logs.keys()].filter((name) => !names.includes(name));
  const slow = want.slow ?? [], seconds = want.seconds ?? defaultDurations();
  const plan = planShards(withoutSlow(want.files, slow), want.n, seconds);
  return [
    ...slowProblems(slow, want.files, seconds),
    ...(extra.length ? [`多出来的工件：${extra.join(", ")}`] : []),
    ...names.flatMap((name, i) => {
      const log = logs.get(name);
      return log === undefined ? [`缺少工件 ${name}`] : checkShard(name, log, i + 1, want, plan[i]!);
    }),
  ];
}

const usage = (why: string): never => {
  console.error(`ci-test-shard: ${why}（用法：bun scripts/ci-test-shard.ts <k>/<n> | slow <k>/<n> | verify <目录> <n> <head> | plan <n> | durations <日志目录>）`);
  process.exit(1);
};

/** 下载目录里每个工件一个子目录；没有 shard.log 的工件当空日志（开头那几行对不上而报错）。 */
function readLogs(dir: string): Map<string, string> {
  return new Map(readdirSync(dir).map((name) => {
    const path = join(dir, name, "shard.log");
    return [name, existsSync(path) ? readFileSync(path, "utf8") : ""] as const;
  }));
}

const readSlow = (): string[] => (existsSync(SLOW_FILE) ? parseSlowList(readFileSync(SLOW_FILE, "utf8")) : []);
const fmt = (xs: number[]) => xs.map((x) => Math.round(x)).join(" / ");

function verifyMain(args: string[], files: string[], slow: string[], d: ReturnType<typeof loadDurations>): void {
  const [dir, n, head] = args;
  if (!dir || !/^\d+$/.test(n ?? "") || !/^[0-9a-f]{40}$/.test(head ?? "")) usage("verify 参数不对");
  if (d.note) console.log(`::warning::${d.note}`);
  const want = { n: Number(n), head: head!, bunVersion: Bun.version, files, slow, seconds: d.seconds };
  const errs = verifyShards(readLogs(dir!), want);
  errs.forEach((e) => console.log(`::error::${e}`));
  if (errs.length) process.exit(1);
  const sizes = planShards(withoutSlow(files, slow), want.n, d.seconds).map((p) => p.length).join(" / ");
  console.log(`${want.n} 片 · bun ${Bun.version} · head ${head} · bun 发现 ${files.length} 个 · 慢清单 ${slow.length} 个（夜间跑）· 各片按计划跑 ${sizes}，不漏不重`);
}

/** 从目录里的作业日志重算耗时表：只留现在还在库里的测试文件，没量到的文件不写（分片时按 LIGHT）。 */
function durationsMain(dir: string | undefined, files: string[]): void {
  if (!dir || !existsSync(dir)) usage("durations 要一个放分片作业日志的目录");
  const logs = readdirSync(dir!).sort().map((name) => readFileSync(join(dir!, name), "utf8"));
  const measured = durationsFromLogs(logs), known = new Set(files);
  const kept = Object.fromEntries(Object.entries(measured).filter(([f]) => known.has(f)));
  if (!Object.keys(kept).length) usage(`${dir} 里的日志没量出任何测试文件（要带时间戳的作业日志，不是 shard.log 工件）`);
  writeFileSync(DURATIONS_FILE, formatDurations(kept));
  const total = Object.values(kept).reduce((s, x) => s + x, 0);
  console.log(`${logs.length} 份日志 · 量到 ${Object.keys(kept).length} / ${files.length} 个测试文件 · 合计 ${Math.round(total)} s → ${DURATIONS_FILE}`);
}

/** 打印第 k/n 片的清单。空清单会让 `bun test` 不带参数、跑全部文件：宁可这一片直接失败。 */
function listMain(spec: string | undefined, files: string[], seconds: Durations, extra: number): void {
  const m = /^(\d+)\/(\d+)$/.exec(spec ?? "");
  if (!m) usage("参数不是 k/n");
  const [k, n] = [Number(m![1]), Number(m![2])];
  if (n < 1 || n > 32 || k < 1 || k > n) usage(`片号 ${k}/${n} 不合法`);
  const mine = planShards(files, n, seconds, extra)[k - 1]!;
  if (!mine.length) usage(`第 ${k}/${n} 片分不到文件`);
  console.log(mine.map((f) => `./${f}`).join("\n"));
}

function main(args: string[]): void {
  const ls = Bun.spawnSync(["git", "ls-files"], { stdout: "pipe", stderr: "inherit" });
  if (ls.exitCode !== 0) usage("git ls-files 失败");
  const files = testFiles(ls.stdout.toString());
  if (args[0] === "durations") return durationsMain(args[1], files);
  const d = loadDurations(), slow = readSlow();
  if (args[0] === "verify") return verifyMain(args.slice(1), files, slow, d);
  // 清单走 stdout（ci.yml 把它重定向进文件），提示走 stderr
  if (d.note) console.error(`::warning::${d.note}`);
  if (args[0] === "plan") {
    const n = Number(args[1]);
    if (!Number.isSafeInteger(n) || n < 1 || n > 32) usage("plan 要片数");
    const rest = withoutSlow(files, slow);
    console.log(`${n} 片预计秒数 ${fmt(shardLoads(rest, n, d.seconds))} · 文件数 ${planShards(rest, n, d.seconds).map((p) => p.length).join(" / ")}`);
    console.log(`慢清单 ${slow.length} 个 · 夜间 2 片预计秒数 ${fmt(shardLoads(slow, 2, d.seconds, 0))}`);
    return;
  }
  if (args[0] === "slow") {
    // 夜间只跑慢清单；清单有问题（不存在 / 重复的文件）就失败，不带着坏路径去跑
    const errs = slowProblems(slow, files, d.seconds);
    if (errs.length) usage(errs.join("；"));
    return listMain(args[1], slow, d.seconds, 0);
  }
  listMain(args[0], withoutSlow(files, slow), d.seconds, SHARD1_EXTRA);
}

if (import.meta.main) main(process.argv.slice(2));

// CI 单元测试分片（ci.yml）。两个用法：
//   bun scripts/ci-test-shard.ts 2/4                       打印第 2/4 片的测试文件（每行一个 ./路径，按路径排序，片内照旧串行）
//   bun scripts/ci-test-shard.ts verify <目录> 4 <head>     汇总闸：核对下载下来的 4 份分片日志（见 verifyShards），不过就非零退出
// 不用 `bun test --shard`：它按路径轮流分，增删一个文件后面全体移位，重文件会扎堆（模拟最慢片中位 254 s，这里 208 s）。
// 权重表过时只影响均衡、不影响正确性——汇总闸核对每片恰好跑了这里给它的文件。tests/ci-test-shard.test.ts。
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** bun test 的发现规则：*.test / _test / .spec / _spec 加 js/ts 族扩展名。 */
const TEST_FILE = /(\.|_)(test|spec)\.(c|m)?[jt]sx?$/;

/**
 * CI（ubuntu，Bun 1.3.14，run 37387535298）里单文件 ≥ 5 s 的测试（main 上还在的）的秒数；其余按 LIGHT（同一 run 其余 1133 个文件的均值）。
 * 文件明显变慢 / 变快时改这里，不改也只是各片不那么均衡。
 */
const SECONDS: Record<string, number> = {
  "tests/sandbox-isolation.test.ts": 76,
  "tests/bridge-mission.test.ts": 41,
  "tests/acp-host.test.ts": 39,
  "tests/scheduler-service-lease.test.ts": 37,
  "tests/recovery-materials-wiring-process.test.ts": 25,
  "tests/lend-cli-author-family.test.ts": 25,
  "tests/recovery-policy-cli.test.ts": 23,
  "tests/web-build-lock.test.ts": 20,
  "tests/memory-retrieve-tools.test.ts": 17,
  "tests/review-converge-notice-readonly.test.ts": 13,
  "tests/lend-cli.test.ts": 11,
  "tests/caller-reject.test.ts": 11,
  "tests/api-agents-list-recovery.test.ts": 10,
  "tests/ledger-store.test.ts": 9,
  "tests/peer-ingress-proxy-cookie.test.ts": 8,
  "tests/sandbox-parent-watchdog.test.ts": 8,
  "tests/web-dom-bg-shell-state.test.ts": 6,
  "tests/lend-ask-auth.test.ts": 6,
  "tests/state-backup-lock.test.ts": 5,
  "tests/scheduler-singleton.test.ts": 5,
  "tests/shared-ledger-c6-members.test.ts": 5,
  "tests/peer-ingress-body.test.ts": 5,
  "tests/scheduler-child-effects.test.ts": 5,
};
const LIGHT = 0.3;
/** 第 1 片另外跑 typecheck、guard、打包入口（约 15 s），先记在它账上。 */
const SHARD1_EXTRA = 15;
/** Bun 在 Actions 里给每个跑过的文件打一行（被别的测试 import 过、自己注册 0 条用例的也有）。 */
const GROUP = /^::group::(.+):$/;

/** `git ls-files` 输出里 bun test 会发现的测试文件，按路径排序。 */
export const testFiles = (lsFiles: string): string[] => lsFiles.split("\n").filter((f) => TEST_FILE.test(f)).sort();

/** n 片分法（每片按路径排序）：最重的先放进当前最轻的一片（LPT）；同重按路径、同负载按片号，同一份清单永远分得一样。 */
export function planShards(files: string[], n: number): string[][] {
  const weight = (f: string) => SECONDS[f] ?? LIGHT;
  const shards = Array.from({ length: n }, (_, i) => ({ load: i === 0 ? SHARD1_EXTRA : 0, files: [] as string[] }));
  for (const f of [...files].sort((a, b) => weight(b) - weight(a) || (a < b ? -1 : 1))) {
    const lightest = shards.reduce((a, b) => (b.load < a.load ? b : a));
    lightest.load += weight(f);
    lightest.files.push(f);
  }
  return shards.map((s) => s.files.sort());
}

export interface ShardExpect { n: number; head: string; bunVersion: string; files: string[] }

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
 */
export function verifyShards(logs: Map<string, string>, want: ShardExpect): string[] {
  const names = Array.from({ length: want.n }, (_, i) => `test-shard-${i + 1}`);
  const extra = [...logs.keys()].filter((name) => !names.includes(name));
  const plan = planShards(want.files, want.n);
  return [
    ...(extra.length ? [`多出来的工件：${extra.join(", ")}`] : []),
    ...names.flatMap((name, i) => {
      const log = logs.get(name);
      return log === undefined ? [`缺少工件 ${name}`] : checkShard(name, log, i + 1, want, plan[i]!);
    }),
  ];
}

const usage = (why: string): never => {
  console.error(`ci-test-shard: ${why}（用法：bun scripts/ci-test-shard.ts <k>/<n> | verify <目录> <n> <head>）`);
  process.exit(1);
};

/** 下载目录里每个工件一个子目录；没有 shard.log 的工件当空日志（开头那几行对不上而报错）。 */
function readLogs(dir: string): Map<string, string> {
  return new Map(readdirSync(dir).map((name) => {
    const path = join(dir, name, "shard.log");
    return [name, existsSync(path) ? readFileSync(path, "utf8") : ""] as const;
  }));
}

function main(args: string[]): void {
  const ls = Bun.spawnSync(["git", "ls-files"], { stdout: "pipe", stderr: "inherit" });
  if (ls.exitCode !== 0) usage("git ls-files 失败");
  const files = testFiles(ls.stdout.toString());
  if (args[0] === "verify") {
    const [dir, n, head] = args.slice(1);
    if (!dir || !/^\d+$/.test(n ?? "") || !/^[0-9a-f]{40}$/.test(head ?? "")) usage("verify 参数不对");
    const want = { n: Number(n), head: head!, bunVersion: Bun.version, files };
    const errs = verifyShards(readLogs(dir!), want);
    errs.forEach((e) => console.log(`::error::${e}`));
    if (errs.length) process.exit(1);
    const sizes = planShards(files, want.n).map((p) => p.length).join(" / ");
    console.log(`${want.n} 片 · bun ${Bun.version} · head ${head} · bun 发现 ${files.length} 个 · 各片按计划跑 ${sizes}，不漏不重`);
    return;
  }
  const m = /^(\d+)\/(\d+)$/.exec(args[0] ?? "");
  if (!m) usage("参数不是 k/n");
  const [k, n] = [Number(m![1]), Number(m![2])];
  if (n < 1 || n > 32 || k < 1 || k > n) usage(`片号 ${k}/${n} 不合法`);
  const mine = planShards(files, n)[k - 1]!;
  // 空清单会让 `bun test` 不带参数、跑全部文件：宁可这一片直接失败
  if (!mine.length) usage(`第 ${k}/${n} 片分不到文件`);
  console.log(mine.map((f) => `./${f}`).join("\n"));
}

if (import.meta.main) main(process.argv.slice(2));

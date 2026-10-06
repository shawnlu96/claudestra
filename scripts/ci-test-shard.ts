// CI 单元测试分片：把 bun test 会发现的测试文件按耗时分成 n 片，打印第 k 片（每行一个 ./路径，按路径排序，片内照旧串行）。
// 不用 `bun test --shard`：它按路径轮流分，增删一个文件后面全体移位，重文件会扎堆（模拟最慢片中位 254 s，这里 208 s）。
// 表过时只影响均衡、不影响正确性——ci.yml 的汇总作业核对各片合起来恰好每个文件一次、且与 bun 自己发现的总数一致。
// 用法：bun scripts/ci-test-shard.ts 2/4
const usage = (why: string): never => {
  console.error(`ci-test-shard: ${why}（用法：bun scripts/ci-test-shard.ts <k>/<n>）`);
  process.exit(1);
};

/** bun test 的发现规则（与 ci.yml 汇总作业里的 grep 同一条）：*.test / _test / .spec / _spec 加 js/ts 族扩展名。 */
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

const m = /^(\d+)\/(\d+)$/.exec(process.argv[2] ?? "");
if (!m) usage("参数不是 k/n");
const [k, n] = [Number(m![1]), Number(m![2])];
if (n < 1 || n > 32 || k < 1 || k > n) usage(`片号 ${k}/${n} 不合法`);

const ls = Bun.spawnSync(["git", "ls-files"], { stdout: "pipe", stderr: "inherit" });
if (ls.exitCode !== 0) usage("git ls-files 失败");
const weight = (f: string) => SECONDS[f] ?? LIGHT;
// 最重的先放进当前最轻的一片（LPT）；同重按路径、同负载按片号，各片在同一 head 上算出的分法完全一致
const files = ls.stdout.toString().split("\n").filter((f) => TEST_FILE.test(f)).sort((a, b) => weight(b) - weight(a) || (a < b ? -1 : 1));
const shards = Array.from({ length: n }, (_, i) => ({ load: i === 0 ? SHARD1_EXTRA : 0, files: [] as string[] }));
for (const f of files) {
  const lightest = shards.reduce((a, b) => (b.load < a.load ? b : a));
  lightest.load += weight(f);
  lightest.files.push(f);
}
const mine = shards[k - 1]!.files.sort();
// 空清单会让 `bun test` 不带参数、跑全部文件：宁可这一片直接失败
if (!mine.length) usage(`第 ${k}/${n} 片分不到文件`);
console.log(mine.map((f) => `./${f}`).join("\n"));

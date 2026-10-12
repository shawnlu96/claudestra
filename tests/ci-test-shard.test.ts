/** scripts/ci-test-shard.ts：CI 单元测试的分片与汇总闸的「每片各自核对」（CIS1，r1 P1 的反例都在这里；8 片与慢清单见 CISHARD1）。 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SLOW_MAX_FILES, parseSlowList, planShards, shardLoads, slowProblems, testFiles, verifyShards, withoutSlow, type ShardExpect,
} from "../scripts/ci-test-shard.ts";

const N = 8, KS = Array.from({ length: N }, (_, i) => i + 1);
const HEAVY = ["tests/sandbox-isolation.test.ts", "tests/bridge-mission.test.ts", "tests/acp-host.test.ts"];
const SLOW = ["tests/slow-a.test.ts", "tests/slow-b.test.ts"];
const light = Array.from({ length: 77 }, (_, i) => `tests/f${String(i).padStart(2, "0")}.test.ts`);
/** Every checked-in test file of the fixture repo, the two slow ones included. */
const files = [...light, ...HEAVY, ...SLOW].sort();
const seconds = { ...Object.fromEntries(light.map((f) => [f, 2])), [HEAVY[0]!]: 76, [HEAVY[1]!]: 41, [HEAVY[2]!]: 39, [SLOW[0]!]: 60, [SLOW[1]!]: 40 };
const HEAD = "a".repeat(40);
const want: ShardExpect = { n: N, head: HEAD, bunVersion: "1.3.14", files, slow: SLOW, seconds };
const covered = withoutSlow(files, SLOW);
const plan = planShards(covered, N, seconds);
const logOf = (k: number, ran = plan[k - 1]!, header = [`shard=${k}/${N}`, `head=${HEAD}`, `discovered=${files.length}`, "bun test v1.3.14 (0d9b296a)"]) =>
  [...header, "", ...ran.flatMap((f) => [`::group::${f}:`, "(pass) ok [1.00ms]", "::endgroup::"]), " 9 pass", " 0 fail"].join("\n");
const good = () => new Map(KS.map((k) => [`test-shard-${k}`, logOf(k)]));
const edit = (k: number, f: (log: string) => string) => { const logs = good(); logs.set(`test-shard-${k}`, f(logs.get(`test-shard-${k}`)!)); return logs; };

describe("planShards", () => {
  test("every file lands in exactly one shard; same input, same plan; heavy files are spread out", () => {
    expect(plan.flat().sort()).toEqual(covered);
    expect(planShards([...covered].reverse(), N, seconds)).toEqual(plan);
    expect(new Set(HEAVY.map((f) => plan.findIndex((p) => p.includes(f)))).size).toBe(3);
  });
  test("testFiles keeps only what bun test discovers", () => {
    expect(testFiles("a.ts\ntests/x.test.ts\nweb/y_spec.tsx\ntests/z.test.mjs\nREADME.md\n")).toEqual(["tests/x.test.ts", "tests/z.test.mjs", "web/y_spec.tsx"]);
  });
});

describe("[验收线 1] eight shards by measured seconds", () => {
  test("the repo's own test files, slow list excluded: the heaviest predicted shard is within 1.3x of the lightest", () => {
    const root = join(import.meta.dir, "..");
    const all = testFiles(Bun.spawnSync(["git", "ls-files"], { cwd: root }).stdout.toString());
    const slow = parseSlowList(readFileSync(join(root, "tests", "slow-tests.txt"), "utf8"));
    expect(slowProblems(slow, all)).toEqual([]);
    const loads = shardLoads(withoutSlow(all, slow), N);
    expect(loads).toHaveLength(N);
    expect(Math.max(...loads) / Math.min(...loads)).toBeLessThanOrEqual(1.3);
    // 第 1 片仍然负责 typecheck / guard / 打包：它的预计负载里含这一份，分到的测试因此比别的片少
    const tests = shardLoads(withoutSlow(all, slow), N, undefined, 0);
    expect(Math.max(...tests) / Math.min(...tests)).toBeLessThanOrEqual(1.3);
  });
  test("the fixture: shard loads are what the table says, and the slow files are in no shard", () => {
    const loads = shardLoads(covered, N, seconds, 0);
    expect(loads.reduce((a, b) => a + b, 0)).toBe(77 * 2 + 76 + 41 + 39);
    for (const f of SLOW) expect(plan.flat()).not.toContain(f);
  });
});

describe("[验收线 2] verifyShards: eight shards cover every test file minus the slow list, exactly once", () => {
  test("eight logs, each on its own plan with the right header → no error", () => {
    expect(verifyShards(good(), want)).toEqual([]);
  });
  test("red first: the four-shard layout this replaced is refused, and so is any other shard count", () => {
    const four = planShards(covered, 4, seconds);
    const old = new Map([1, 2, 3, 4].map((k) => [`test-shard-${k}`, logOf(k, four[k - 1]!, [`shard=${k}/4`, `head=${HEAD}`, `discovered=${files.length}`, "bun test v1.3.14 (0d9b296a)"])]));
    const errs = verifyShards(old, want);
    expect(errs).toContain("缺少工件 test-shard-8");
    expect(errs.join("\n")).toContain("第 1 行应为「shard=1/8」，实际「shard=1/4」");
    expect(verifyShards(good(), { ...want, n: 4 }).join("\n")).toContain("多出来的工件：test-shard-5, test-shard-6, test-shard-7, test-shard-8");
    expect(verifyShards(good().set("test-shard-9", logOf(8)), want)).toContain("多出来的工件：test-shard-9");
  });
  test("a file left out, run twice, or run by a shard it was not given to is refused", () => {
    const other = plan[1]![0]!;
    for (const ran of [plan[0]!.slice(1), [...plan[0]!, plan[0]![0]!], [...plan[0]!, other]]) {
      expect(verifyShards(new Map(good()).set("test-shard-1", logOf(1, ran)), want).length).toBeGreaterThan(0);
    }
    expect(verifyShards(new Map(good()).set("test-shard-3", logOf(3, plan[2]!.slice(1))), want).join("\n")).toContain("test-shard-3 没跑到分给它的 1 个");
  });
  test("a slow file run by a shard is refused; without the slow list the same logs leave the slow files uncovered", () => {
    expect(verifyShards(new Map(good()).set("test-shard-2", logOf(2, [...plan[1]!, SLOW[0]!])), want).join("\n")).toContain(`test-shard-2 跑了不该它跑的 1 个：${SLOW[0]}`);
    expect(verifyShards(good(), { ...want, slow: [] }).join("\n")).toContain("没跑到分给它的");
  });
  test("a slow list naming a file that does not exist, or the same file twice, is refused", () => {
    expect(verifyShards(good(), { ...want, slow: [...SLOW, "tests/gone.test.ts"] })).toContain("慢清单里有不存在的测试文件：tests/gone.test.ts");
    expect(verifyShards(good(), { ...want, slow: [...SLOW, SLOW[0]!] })).toContain(`慢清单里重复的文件：${SLOW[0]}`);
  });
  test("the slow list is capped: at most 20 files and 30% of the predicted total", () => {
    const many = light.slice(0, SLOW_MAX_FILES + 1);
    expect(slowProblems(many, files, seconds).join("\n")).toContain(`慢清单有 ${SLOW_MAX_FILES + 1} 个文件，上限 ${SLOW_MAX_FILES}`);
    // 夹具里两个慢文件合计 100 s、全量 410 s；改成合计 500 s（全量 810 s）就超了
    expect(slowProblems(SLOW, files, seconds)).toEqual([]);
    const heavier = { ...seconds, [SLOW[0]!]: 300, [SLOW[1]!]: 200 };
    expect(slowProblems(SLOW, files, heavier).join("\n")).toContain("慢清单占全量预计耗时的 61.7%，上限 30%");
    expect(verifyShards(good(), { ...want, seconds: heavier }).length).toBeGreaterThan(0);
  });
  test("parseSlowList drops comments and blank lines, keeps duplicates for slowProblems to report", () => {
    expect(parseSlowList("# 说明\n\ntests/a.test.ts # 120.5\n  tests/b.test.ts\ntests/a.test.ts\n")).toEqual(["tests/a.test.ts", "tests/b.test.ts", "tests/a.test.ts"]);
  });
});

describe("verifyShards headers", () => {
  const w = want;
  test("a header missing from one shard is not covered by the others (r1 P1)", () => {
    expect(verifyShards(good(), w)).toEqual([]);
    for (const drop of [`head=${HEAD}`, "bun test v1.3.14 (0d9b296a)", `discovered=${files.length}`, `shard=2/${N}`]) {
      expect(verifyShards(edit(2, (l) => l.replace(`${drop}\n`, "")), w).length).toBeGreaterThan(0);
    }
  });
  test("wrong values in one shard's header are refused", () => {
    for (const [from, to] of [[`head=${HEAD}`, `head=${"b".repeat(40)}`], [`discovered=${files.length}`, `discovered=${files.length + 1}`],
      ["bun test v1.3.14", "bun test v1.3.15"], [`shard=3/${N}`, `shard=1/${N}`]]) {
      expect(verifyShards(edit(3, (l) => l.replace(from!, to!)), w).length).toBeGreaterThan(0);
    }
  });
  test("a duplicate or conflicting meta line appended after a valid header is refused (r2 P1 residue)", () => {
    for (const line of [`head=${HEAD}`, `shard=1/${N}`, `discovered=${files.length}`, "bun test v1.3.14 (0d9b296a)",
      `head=${"b".repeat(40)}`, `shard=4/${N}`, "discovered=0", "bun test v9.9.9 (deadbeef)"]) {
      expect(verifyShards(edit(1, (l) => `${l}\n${line}`), w).length).toBeGreaterThan(0);
      expect(verifyShards(edit(1, (l) => l.replace("::endgroup::", `::endgroup::\n${line}`)), w).length).toBeGreaterThan(0);
    }
  });
  test("only test-shard-1..8: an extra empty artifact, a missing one, or all logs in one artifact are refused (r1 P1)", () => {
    const extra = good().set("test-shard-9", "");
    const missing = good();
    missing.delete("test-shard-4");
    const merged = new Map([["test-shard-1", KS.map((k) => logOf(k)).join("\n")]]);
    for (const logs of [extra, missing, merged]) expect(verifyShards(logs, w).length).toBeGreaterThan(0);
  });
});

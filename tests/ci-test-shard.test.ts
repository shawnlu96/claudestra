/** scripts/ci-test-shard.ts：CI 单元测试的分片与汇总闸的「每片各自核对」（CIS1，r1 P1 的反例都在这里）。 */
import { describe, expect, test } from "bun:test";
import { planShards, testFiles, verifyShards, type ShardExpect } from "../scripts/ci-test-shard.ts";

const files = [...Array.from({ length: 37 }, (_, i) => `tests/f${String(i).padStart(2, "0")}.test.ts`),
  "tests/sandbox-isolation.test.ts", "tests/bridge-mission.test.ts", "tests/acp-host.test.ts"].sort();
const HEAD = "a".repeat(40);
const want: ShardExpect = { n: 4, head: HEAD, bunVersion: "1.3.14", files };
const plan = planShards(files, 4);
const logOf = (k: number, ran = plan[k - 1]!, header = [`shard=${k}/4`, `head=${HEAD}`, `discovered=${files.length}`, "bun test v1.3.14 (0d9b296a)"]) =>
  [...header, "", ...ran.flatMap((f) => [`::group::${f}:`, "(pass) ok [1.00ms]", "::endgroup::"]), " 9 pass", " 0 fail"].join("\n");
const good = () => new Map([1, 2, 3, 4].map((k) => [`test-shard-${k}`, logOf(k)]));
const edit = (k: number, f: (log: string) => string) => { const logs = good(); logs.set(`test-shard-${k}`, f(logs.get(`test-shard-${k}`)!)); return logs; };

describe("planShards", () => {
  test("every file lands in exactly one shard; same input, same plan; heavy files are spread out", () => {
    expect(plan.flat().sort()).toEqual(files);
    expect(planShards([...files].reverse(), 4)).toEqual(plan);
    const heavy = ["tests/sandbox-isolation.test.ts", "tests/bridge-mission.test.ts", "tests/acp-host.test.ts"];
    expect(new Set(heavy.map((f) => plan.findIndex((p) => p.includes(f)))).size).toBe(3);
  });
  test("testFiles keeps only what bun test discovers", () => {
    expect(testFiles("a.ts\ntests/x.test.ts\nweb/y_spec.tsx\ntests/z.test.mjs\nREADME.md\n")).toEqual(["tests/x.test.ts", "tests/z.test.mjs", "web/y_spec.tsx"]);
  });
});

describe("verifyShards", () => {
  test("four logs, each on its own plan with the right header → no error", () => {
    expect(verifyShards(good(), want)).toEqual([]);
  });
  test("a header missing from one shard is not covered by the other three (r1 P1)", () => {
    for (const drop of [`head=${HEAD}`, "bun test v1.3.14 (0d9b296a)", `discovered=${files.length}`, "shard=2/4"]) {
      expect(verifyShards(edit(2, (l) => l.replace(`${drop}\n`, "")), want).length).toBeGreaterThan(0);
    }
  });
  test("wrong values in one shard's header are refused", () => {
    for (const [from, to] of [[`head=${HEAD}`, `head=${"b".repeat(40)}`], [`discovered=${files.length}`, `discovered=${files.length + 1}`],
      ["bun test v1.3.14", "bun test v1.3.15"], ["shard=3/4", "shard=1/4"]]) {
      expect(verifyShards(edit(3, (l) => l.replace(from!, to!)), want).length).toBeGreaterThan(0);
    }
  });
  test("only test-shard-1..4: an extra empty artifact, a missing one, or all four logs in one artifact are refused (r1 P1)", () => {
    const extra = good().set("test-shard-5", "");
    const missing = good();
    missing.delete("test-shard-4");
    const merged = new Map([["test-shard-1", [1, 2, 3, 4].map((k) => logOf(k)).join("\n")]]);
    for (const logs of [extra, missing, merged]) expect(verifyShards(logs, want).length).toBeGreaterThan(0);
  });
  test("a shard that skipped a file, ran one twice, or ran another shard's file is refused", () => {
    const other = plan[1]![0]!;
    for (const ran of [plan[0]!.slice(1), [...plan[0]!, plan[0]![0]!], [...plan[0]!, other]]) {
      expect(verifyShards(new Map(good()).set("test-shard-1", logOf(1, ran)), want).length).toBeGreaterThan(0);
    }
  });
});

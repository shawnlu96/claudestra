/**
 * merge-arch-CISEL2: the unified read port of the CI selected-gate receipt (src/lib/ci-selected-receipt.ts) — the verdict must be
 * this run's latest attempt, bound to the PR head (or its test merge) / the full re-check's merge commit, and well formed.
 */
import { describe, expect, test } from "bun:test";
import { type CiSelectedPort, type CiSelectedRun, ghCiSelectedPort, readCiSelectedReceipt, readCiSelectedRunReceipt } from "../src/lib/ci-selected-receipt.js";

const HEAD = "a".repeat(40), MERGE = "b".repeat(40), MAIN = "c".repeat(40), OTHER = "d".repeat(40);
const D = (c: string) => `sha256:${c.repeat(64)}`;
const verdict = (over: Record<string, unknown> = {}) => JSON.stringify({ version: 1, kind: "ci-selected-verdict", mode: "on", runId: 11, attempt: 2,
  head: MERGE, responsibilityDigest: D("1"), outOfScope: [{ file: "tests/x.test.ts", name: "x > flaky" }], shards: { "2": D("2") }, ...over });
const RUN: CiSelectedRun = { id: 11, attempt: 2, headSha: HEAD, event: "pull_request", status: "completed", conclusion: "success",
  url: "https://github.com/o/r/actions/runs/11" };

function fakeSelectedPort(o: { run?: CiSelectedRun | null; art?: { present: boolean; text: string | null }; variable?: string | null | Error } = {}) {
  const calls: string[] = [];
  const port: CiSelectedPort = {
    prRun: async (_repo, head) => { calls.push(`prRun:${head.slice(0, 4)}`); return o.run === undefined ? RUN : o.run; },
    runById: async (_repo, id) => { calls.push(`run:${id}`); return o.run ?? RUN; },
    verdict: async (_repo, id) => { calls.push(`verdict:${id}`); return o.art ?? { present: true, text: verdict() }; },
    commitParents: async (_repo, sha) => { calls.push(`parents:${sha.slice(0, 4)}`); return sha === MERGE ? [MAIN, HEAD] : [MAIN]; },
    variable: async () => { calls.push("variable"); if (o.variable instanceof Error) throw o.variable; return o.variable === undefined ? "on" : o.variable; },
  };
  return { port, calls };
}

describe("[验收线 3] the read port only answers a receipt that binds to this run", () => {
  test("a verdict of the latest attempt on the PR's test merge reads back with allowed / outOfScope / runUrl", async () => {
    const r = await readCiSelectedReceipt(fakeSelectedPort().port, "o/r", HEAD);
    expect(r.marked).toBe(true);
    expect(r.receipt).toMatchObject({ allowed: true, outOfScope: [{ file: "tests/x.test.ts", name: "x > flaky" }], runUrl: RUN.url, runId: 11, attempt: 2 });
    expect(r.receipt!.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("no verdict artifact = not marked; no run for the head = not marked", async () => {
    expect(await readCiSelectedReceipt(fakeSelectedPort({ art: { present: false, text: null } }).port, "o/r", HEAD)).toMatchObject({ marked: false, receipt: null });
    expect(await readCiSelectedReceipt(fakeSelectedPort({ run: null }).port, "o/r", HEAD)).toMatchObject({ marked: false, receipt: null });
  });

  test("marked but missing / unreadable / stale attempt / other run / other head / bad digest → receipt null", async () => {
    const cases: [string, Parameters<typeof fakeSelectedPort>[0], RegExp][] = [
      ["download failed", { art: { present: true, text: null } }, /下载不下来/],
      ["not JSON", { art: { present: true, text: "{" } }, /不是合法回执/],
      ["stale attempt", { art: { present: true, text: verdict({ attempt: 1 }) } }, /不是最新 attempt 2/],
      ["other run", { art: { present: true, text: verdict({ runId: 12 }) } }, /不是 run 11/],
      ["other head", { art: { present: true, text: verdict({ head: OTHER }) } }, /对不上/],
      ["bad responsibility digest", { art: { present: true, text: verdict({ responsibilityDigest: "sha256:zz" }) } }, /不是合法回执/],
      ["bad shard digest", { art: { present: true, text: verdict({ shards: { "1": "x" } }) } }, /不是合法回执/],
      ["no shards", { art: { present: true, text: verdict({ shards: {} }) } }, /不是合法回执/],
      ["extra field", { art: { present: true, text: verdict({ extra: 1 }) } }, /不是合法回执/],
    ];
    for (const [, o, why] of cases) {
      const r = await readCiSelectedReceipt(fakeSelectedPort(o).port, "o/r", HEAD);
      expect(r.marked).toBe(true);
      expect(r.receipt).toBeNull();
      expect(r.problem).toMatch(why);
    }
  });

  test("a run listed for another head is not this PR's run", async () => {
    const r = await readCiSelectedReceipt(fakeSelectedPort({ run: { ...RUN, headSha: OTHER } }).port, "o/r", HEAD);
    expect(r).toMatchObject({ marked: false, receipt: null });
  });

  test("CI under observe / an empty out-of-scope list is a receipt that does not allow", async () => {
    const obs = await readCiSelectedReceipt(fakeSelectedPort({ art: { present: true, text: verdict({ mode: "observe" }) } }).port, "o/r", HEAD);
    expect(obs.receipt?.allowed).toBe(false);
    const none = await readCiSelectedReceipt(fakeSelectedPort({ art: { present: true, text: verdict({ outOfScope: [] }) } }).port, "o/r", HEAD);
    expect(none.receipt?.allowed).toBe(false);
  });

  test("full re-check path: the checkout must be exactly the request's merge commit", async () => {
    const ok = await readCiSelectedRunReceipt(fakeSelectedPort().port, "o/r", 11, MERGE);
    expect(ok.receipt?.allowed).toBe(true);
    const off = await readCiSelectedRunReceipt(fakeSelectedPort().port, "o/r", 11, OTHER);
    expect(off).toMatchObject({ marked: true, receipt: null });
  });
});

describe("gh port", () => {
  test("GET only, structured argv; an unset variable is null; the artifact is fetched by name only when listed", async () => {
    const argv: string[][] = [];
    const answers: Record<string, { code: number; stdout: string; stderr: string }> = {
      runs: { code: 0, stdout: JSON.stringify({ workflow_runs: [{ id: 5, run_attempt: 1, head_sha: HEAD, path: ".github/workflows/ci.yml", html_url: "u5" },
        { id: 9, run_attempt: 3, head_sha: HEAD, path: ".github/workflows/ci.yml@refs/pull/1/merge", html_url: "u9" },
        { id: 99, run_attempt: 1, head_sha: HEAD, path: ".github/workflows/other.yml" }] }), stderr: "" },
      artifacts: { code: 0, stdout: JSON.stringify({ artifacts: [] }), stderr: "" },
      variables: { code: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" },
    };
    const command = (async (a: string[]) => {
      argv.push(a);
      const key = Object.keys(answers).find((k) => a.join(" ").includes(k))!;
      return { ...answers[key]!, timedOut: false };
    }) as unknown as Parameters<typeof ghCiSelectedPort>[0];
    const port = ghCiSelectedPort(command);
    expect(await port.prRun("o/r", HEAD)).toMatchObject({ id: 9, attempt: 3, url: "u9" });
    expect(await port.verdict("o/r", 9)).toEqual({ present: false, text: null });
    expect(await port.variable("o/r")).toBeNull();
    expect(argv.every((a) => a[0] === "gh" && a[1] === "api" && !a.includes("-X"))).toBe(true);
    expect(argv[0]).toEqual(["gh", "api", `repos/o/r/actions/runs?head_sha=${HEAD}&event=pull_request&per_page=100`]);
    expect(argv[1]).toEqual(["gh", "api", "repos/o/r/actions/runs/9/artifacts?per_page=100"]);
  });

  /** gh faked at the command boundary: the run's artifact list, its latest jobs, the check job's log. */
  function ghArtifacts(artifacts: Record<string, unknown>[], log: { code: number; stdout?: string; stderr?: string } | null = null) {
    const argv: string[][] = [];
    const command = (async (a: string[]) => {
      argv.push(a);
      const path = a[2] ?? "";
      const ok = (v: unknown) => ({ code: 0, stdout: JSON.stringify(v), stderr: "", timedOut: false });
      if (path.includes("/artifacts")) return ok({ artifacts });
      if (path.includes("/jobs?")) return ok({ jobs: [{ id: 3, name: "test shard 1 of 8" }, { id: 4, name: "typecheck + test + guard" }] });
      if (path.endsWith("/jobs/4/logs") && log) return { stdout: "", stderr: "", ...log, timedOut: false };
      if (a[1] === "run" && a[2] === "download") return { code: 1, stdout: "", stderr: "gone", timedOut: false };
      throw new Error(`unexpected ${a.join(" ")}`);
    }) as unknown as Parameters<typeof ghCiSelectedPort>[0];
    return { port: ghCiSelectedPort(command), argv };
  }
  const shardLog = (expired = false) => ({ name: "test-shard-1", expired });

  test("[验收线 3] an expired ci-selected-verdict still marks the run: no receipt, never plain", async () => {
    const g = ghArtifacts([{ name: "ci-selected-verdict", expired: true }, shardLog(true)]);
    expect(await g.port.verdict("o/r", 9)).toEqual({ present: true, text: null, problem: expect.stringMatching(/已过期/) });
    expect(g.argv.some((a) => a[1] === "run")).toBe(false); // nothing to download
    const r = await readCiSelectedReceipt({ ...fakeSelectedPort().port, verdict: (repo, id) => g.port.verdict(repo, id) }, "o/r", HEAD);
    expect(r).toMatchObject({ marked: true, receipt: null, problem: expect.stringMatching(/已过期/) });
  });

  test("no verdict artifact beside unexpired shard logs = no release (one listing, no log read)", async () => {
    const g = ghArtifacts([shardLog(), { name: "ci-related-plan", expired: false }]);
    expect(await g.port.verdict("o/r", 9)).toEqual({ present: false, text: null });
    expect(g.argv).toHaveLength(1);
  });

  test("[验收线 3] the artifacts are gone: the check job's log decides; a log that is gone too cannot prove no release", async () => {
    const released = ghArtifacts([], { code: 0, stdout: "2026-10-14T00:00:00Z ci-selected: allow=1 out_of_scope=2\n" });
    expect(await released.port.verdict("o/r", 9)).toEqual({ present: true, text: null, problem: expect.stringMatching(/日志显示放行/) });
    expect(released.argv.map((a) => a[2])).toEqual(["repos/o/r/actions/runs/9/artifacts?per_page=100", "repos/o/r/actions/runs/9/jobs?filter=latest&per_page=100",
      "repos/o/r/actions/jobs/4/logs"]);
    const quiet = ghArtifacts([shardLog(true)], { code: 0, stdout: "2026-10-14T00:00:00Z ci-selected: allow=0 out_of_scope=0\nok\n" });
    expect(await quiet.port.verdict("o/r", 9)).toEqual({ present: false, text: null });
    const lost = ghArtifacts([], { code: 1, stderr: "gh: Gone (HTTP 410)" });
    expect(await lost.port.verdict("o/r", 9)).toEqual({ present: true, text: null, problem: expect.stringMatching(/证不了没放行/) });
    const flaky = ghArtifacts([], { code: 1, stderr: "gh: Server Error (HTTP 502)" });
    await expect(flaky.port.verdict("o/r", 9)).rejects.toThrow(/日志读不出/); // a transient read waits, it is not a verdict
    expect(lost.argv.concat(released.argv).every((a) => a[0] === "gh" && a[1] === "api" && !a.includes("-X"))).toBe(true);
  });
});

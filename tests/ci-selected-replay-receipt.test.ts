import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { collectReplayEvidence, type ReplayEvidence, type ReplayReceipt, REPLAY_POLICY, readReplayReceipt,
  replayDigest, replayRefs, saveReplayReceipt } from "../src/lib/ci-selected-replay-receipt.js";
import { judgeSelected, logDigest, responsibility, type ShardReceipt } from "../src/lib/ci-selected-verdict.js";
import { judgeReplayEvidence } from "../src/lib/ci-selected-replay.js";
import { readCiSelectedArchiveRun, type CiSelectedPort } from "../src/lib/ci-selected-receipt.js";

export const HEAD = "a".repeat(40), CHECKOUT = "b".repeat(40), BASE = "c".repeat(40);
export function evidence(): ReplayEvidence {
  const universe = Array.from({ length: 8 }, (_, i) => `tests/file${i + 1}.test.ts`);
  const plan = { version: 1, sha: CHECKOUT, prHead: HEAD, event: "pull_request", scope: "full", shards: universe.map(() => []),
    responsibility: responsibility([universe[1]!]), universe: universe.length, reasons: ["observe 执行全量"], mode: "observe" };
  const files: Record<string, string> = {};
  const jobs: ReplayEvidence["jobs"] = ["ci related plan", "ci scope full", "typecheck + test + guard", "web typecheck + lint",
    "web production build", "desktop scope", "desktop typecheck + cargo test"].map((name) => ({ name, status: "completed", conclusion: "success", steps: [] }));
  for (let k = 1; k <= 8; k++) {
    const file = universe[k - 1]!, failed = k === 1;
    const log = `shard=${k}/8\nhead=${CHECKOUT}\ndiscovered=8\n::group::${file}:\n(${failed ? "fail" : "pass"}) case [1.00ms]\n`
      + `::endgroup::\n ${failed ? 0 : 1} pass\n ${failed ? 1 : 0} fail\nRan 1 test across 1 file. [1.00ms]\n`;
    files[`test-shard-${k}/shard.log`] = log;
    files[`ci-facts-shard-${k}/job-facts.json`] = JSON.stringify({ version: 1, job: `test-shard-${k}`, runId: 7, attempt: 1,
      head: CHECKOUT, status: failed ? "failure" : "success", logDigest: logDigest(log),
      ...(k === 1 ? { core: { typecheck: "success", guard: "skipped", build: "skipped" } } : {}) });
    if (failed) {
      const r: ShardReceipt = { version: 1, kind: "ci-selected-shard", mode: "observe", shard: k, runId: 7, attempt: 1, head: CHECKOUT,
        planDigest: `sha256:${createHash("sha256").update(JSON.stringify(plan)).digest("hex")}`, responsibilityDigest: plan.responsibility.digest,
        logDigest: logDigest(log), exitCode: 1, allow: true, applied: false, reason: "范围外", outOfScope: [{ file, name: "case" }] };
      files[`ci-selected-shard-${k}/receipt.json`] = JSON.stringify(r);
    }
    jobs.push({ name: `test shard ${k} of 8`, status: "completed", conclusion: failed ? "failure" : "success",
      steps: [{ name: "Unit tests", conclusion: failed ? "failure" : "success" }] });
  }
  return { repo: "example/repo", run: { id: 7, attempt: 1, headSha: HEAD, event: "pull_request", status: "completed", conclusion: "failure", url: "https://github.com/example/repo/actions/runs/7" },
    checkout: CHECKOUT, base: BASE, parents: [BASE, HEAD], planText: JSON.stringify(plan), changed: ["src/lib/mine.ts"], diff: "diff --git a/src/lib/mine.ts b/src/lib/mine.ts\n",
    jobs, universe, slow: [], files, gaps: [] };
}
export function receipt(): ReplayReceipt {
  const e = evidence();
  return { version: 1, policyVersion: REPLAY_POLICY, project: "p", taskId: "T", intentId: "i", mergeRev: 1, head: HEAD,
    round: 1, specRev: 1, capturedAt: 100, effectiveMode: "observe", checks: [{ name: "typecheck + test + guard", link: e.run.url }],
    failures: judgeReplayEvidence(e, HEAD).failures, evidence: e, gaps: [], verdict: judgeReplayEvidence(e, HEAD).verdict };
}
const dirs: string[] = [];
export const tempRoot = () => { const dir = mkdtempSync(join(tmpdir(), "ciselrp1-")); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("attempt archives", () => {
  test("same attempt is idempotent, another attempt cannot overwrite it; digest detects tampering", async () => {
    const root = tempRoot(), r = receipt(), first = await saveReplayReceipt(r, root);
    const bytes = readFileSync(join(root, first.file), "utf8");
    expect(await saveReplayReceipt({ ...r, capturedAt: 200 }, root)).toEqual(first);
    const second = receipt(); second.evidence!.run.attempt = 2;
    const next = await saveReplayReceipt(second, root);
    expect(next.file).not.toBe(first.file);
    expect(readFileSync(join(root, first.file), "utf8")).toBe(bytes);
    expect(replayRefs({ project: "p", taskId: "T", intentId: "i", rev: 1, reviewedHead: HEAD }, root)).toHaveLength(2);
    writeFileSync(join(root, first.file), JSON.stringify({ ...r, effectiveMode: "on" }));
    expect(() => readReplayReceipt(root, first)).toThrow("摘要");
  });
  test("missing and malformed evidence are explicit; a path cannot leave the root", async () => {
    const root = tempRoot(), r = receipt(); r.evidence = null; r.gaps = ["工件过期"];
    const ref = await saveReplayReceipt(r, root);
    expect(readReplayReceipt(root, ref).gaps).toEqual(["工件过期"]);
    expect(() => readReplayReceipt(root, { file: "../../secret", digest: replayDigest(r) })).toThrow("路径");
    writeFileSync(join(root, ref.file), "partial");
    expect(() => readReplayReceipt(root, ref)).toThrow();
    expect(readdirSync(root)).toHaveLength(1);
  });
  test("reader rejects a changed attempt, head or unfinished run", async () => {
    const run = evidence().run;
    for (const change of [{ attempt: 2 }, { headSha: BASE }, { status: "in_progress" }, { event: "push" }]) {
      const port: CiSelectedPort = { runById: async () => ({ ...run, ...change }), prRun: async () => null,
        verdict: async () => ({ present: false, text: null }), commitParents: async () => [], variable: async () => null };
      expect(readCiSelectedArchiveRun(port, "example/repo", 7, HEAD, 1)).rejects.toThrow("归档期间");
    }
  });
  test("read failure never produces replayable evidence", async () => {
    const command = async () => ({ code: 1, stdout: "", stderr: "HTTP 404", timedOut: false });
    expect(collectReplayEvidence("example/repo", HEAD, [], command)).rejects.toThrow();
  });
});

describe("same-input judgments", () => {
  test("a complete observe archive hypothetically releases exactly the online judge's failures", () => {
    const e = evidence(), j = judgeReplayEvidence(e, HEAD);
    const online = judgeSelected({ responsibility: responsibility(["tests/file2.test.ts"]),
      changed: e.changed, failures: [{ file: "tests/file1.test.ts", name: "case", timedOut: false }], complete: true, steps: { typecheck: "success" } });
    expect(j.gaps).toEqual([]);
    expect(j.replayable).toBe(true);
    expect(j.verdict?.allow).toBe(online.allow);
    expect(j.verdict?.outOfScope).toEqual(online.outOfScope);
  });
  test.each(["all", "selected", "diff", "typecheck", "guard"])("%s cannot be hypothetically released", (kind) => {
    const e = evidence(), p = JSON.parse(e.planText);
    if (kind === "all" || kind === "selected") {
      p.responsibility = responsibility(kind === "all" ? "all" : ["tests/file1.test.ts"]);
      e.planText = JSON.stringify(p);
      const r = JSON.parse(e.files["ci-selected-shard-1/receipt.json"]!);
      r.responsibilityDigest = p.responsibility.digest;
      r.planDigest = `sha256:${createHash("sha256").update(JSON.stringify(p)).digest("hex")}`;
      e.files["ci-selected-shard-1/receipt.json"] = JSON.stringify(r);
    }
    if (kind === "diff") e.changed.push("tests/file1.test.ts");
    if (kind === "typecheck" || kind === "guard") e.jobs[7]!.steps.push({ name: kind, conclusion: "failure" });
    expect(judgeReplayEvidence(e, HEAD).verdict?.allow).toBe(false);
  });
  test.each(["parse", "attempt", "log", "missing-shard", "universe", "jobs", "core"])("%s is not silently replayable", (kind) => {
    const e = evidence();
    if (kind === "parse") e.files["test-shard-1/shard.log"] = e.files["test-shard-1/shard.log"]!.replace(" 1 fail", " 2 fail");
    if (kind === "attempt") e.run.attempt++;
    if (kind === "log") e.files["test-shard-1/shard.log"] += "extra\n";
    if (kind === "missing-shard") delete e.files["test-shard-8/shard.log"];
    if (kind === "universe") e.universe.push("tests/never.test.ts");
    if (kind === "jobs") e.jobs = [];
    if (kind === "core") e.files["ci-facts-shard-1/job-facts.json"] = e.files["ci-facts-shard-1/job-facts.json"]!.replace('"typecheck":"success"', '"other":"success"');
    expect(judgeReplayEvidence(e, HEAD).replayable).toBe(false);
  });
});

test("collector pins the real PR run, downloads necessary artifacts, and rejects a racing attempt", async () => {
  const e = evidence(), calls: string[][] = [];
  const names = [...new Set(["ci-related-plan", ...Object.keys(e.files).map((p) => p.split("/")[0]!)])];
  let rereads = 0, racing = false;
  const command: typeof import("../src/lib/run-bounded.js").runBounded = async (argv) => {
    calls.push(argv);
    if (argv[1] === "run") {
      const name = argv[argv.indexOf("-n") + 1]!, dir = argv[argv.indexOf("-D") + 1]!;
      const file = name === "ci-related-plan" ? "plan.json" : Object.keys(e.files).find((p) => p.startsWith(`${name}/`))!.split("/")[1]!;
      const { mkdirSync } = await import("node:fs");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, file), name === "ci-related-plan" ? e.planText : e.files[`${name}/${file}`]!);
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    }
    const path = argv[2]!;
    const row = { id: 7, run_attempt: racing && ++rereads > 1 ? 2 : 1, head_sha: HEAD, event: "pull_request", status: "completed",
      conclusion: "failure", html_url: e.run.url, path: ".github/workflows/ci.yml" };
    let value: unknown;
    if (path.includes("runs?head_sha=")) value = { workflow_runs: [row] };
    else if (path.endsWith("/runs/7")) value = row;
    else if (path.includes("/jobs?")) value = { jobs: e.jobs, total_count: e.jobs.length };
    else if (path.includes("/artifacts?")) value = { artifacts: names.map((name) => ({ name, expired: false })), total_count: names.length };
    else if (path.includes("/commits/")) value = { parents: [BASE, HEAD].map((sha) => ({ sha })) };
    else if (path.includes("/git/trees/")) value = { tree: e.universe.map((path) => ({ path, type: "blob" })), truncated: false };
    else if (path.includes("/contents/")) value = { encoding: "base64", content: "" };
    else if (path.includes("/compare/")) value = argv.includes("-H") ? e.diff : { files: e.changed.map((filename) => ({ filename })) };
    else throw new Error(`unexpected GET: ${path}`);
    return { code: 0, stdout: typeof value === "string" ? value : JSON.stringify(value), stderr: "", timedOut: false };
  };
  const got = await collectReplayEvidence("example/repo", HEAD, [e.run.url], command);
  expect(judgeReplayEvidence(got, HEAD)).toMatchObject({ replayable: true, verdict: { allow: true } });
  expect(calls.every((a) => a[0] === "gh" && (a[1] === "api" || a[2] === "download") && !a.includes("--method"))).toBe(true);
  racing = true; rereads = 0;
  expect(collectReplayEvidence("example/repo", HEAD, [e.run.url], command)).rejects.toThrow("归档期间");
});


test.each(["related", "light"])("%s scope retains the frozen selection and rejects extra old shards", (scope) => {
  const e = evidence(), p = JSON.parse(e.planText), n = scope === "light" ? 1 : 8;
  p.scope = scope; p.shards = e.universe.slice(0, n).map((f) => [f]);
  e.planText = JSON.stringify(p);
  e.jobs.find((j) => j.name === "ci scope full")!.name = `ci scope ${scope}`;
  const digest = `sha256:${createHash("sha256").update(JSON.stringify(p)).digest("hex")}`;
  for (let k = 1; k <= 8; k++) {
    const logKey = `test-shard-${k}/shard.log`, factsKey = `ci-facts-shard-${k}/job-facts.json`;
    if (k > n) { delete e.files[logKey]; delete e.files[factsKey]; continue; }
    e.files[logKey] = e.files[logKey]!.replace(`shard=${k}/8`, `shard=${k}/${n}`).replace("discovered=8", `plan=${digest}`);
    const f = JSON.parse(e.files[factsKey]!); f.logDigest = logDigest(e.files[logKey]!); e.files[factsKey] = JSON.stringify(f);
    if (k === 1) {
      const r = JSON.parse(e.files["ci-selected-shard-1/receipt.json"]!);
      r.planDigest = digest; r.logDigest = f.logDigest; e.files["ci-selected-shard-1/receipt.json"] = JSON.stringify(r);
    }
  }
  expect(judgeReplayEvidence(e, HEAD)).toMatchObject({ replayable: true, verdict: { allow: true } });
  if (scope === "light") {
    e.files["test-shard-8/shard.log"] = "old attempt";
    expect(judgeReplayEvidence(e, HEAD).replayable).toBe(false);
  }
});

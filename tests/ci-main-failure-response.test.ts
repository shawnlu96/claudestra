import { describe, expect, test } from "bun:test";
import { correlateMainFailure, planFailureResponse, type FailureRun } from "../src/lib/ci-main-failure-response.js";

const sha = (n: string) => n.repeat(40);
export const related: FailureRun = { origin: "actions-api", repo: "example/repo", runId: 11, attempt: 1, latestAttempt: 1,
  event: "pull_request", scope: "related", workflow: ".github/workflows/ci.yml", head: sha("a"), base: sha("b"),
  checkout: sha("c"), tree: sha("d"), completedAt: 100, conclusion: "success",
  checks: [{ name: "test", conclusion: "success" }] };
export const full: FailureRun = { ...related, runId: 12, event: "push", scope: "full", checkout: sha("e"), completedAt: 200,
  conclusion: "failure", checks: [{ name: "test", conclusion: "failure" }] };
export const correlationInput = () => ({ project: "p", repo: related.repo, mainSha: full.checkout, now: 300,
  requiredChecks: ["test"], related, full, integration: { origin: "github-api" as const, head: related.head, base: related.base,
    sha: full.checkout, tree: full.tree, parents: [related.base], mergedHead: related.head } });

describe("[验收线 1、2] precise correlation without causal blame", () => {
  test("related green then full red: exact identities, failed check, first discovery", () => {
    const e = correlateMainFailure(correlationInput());
    expect(e).toMatchObject({ relation: "correlation-only", head: related.head, base: related.base, tree: full.tree,
      failedChecks: ["test"], firstDiscoveredAt: 300, related: { runId: 11 }, full: { runId: 12 } });
    expect(correlateMainFailure({ ...correlationInput(), now: 400, previous: e })).toMatchObject({ firstDiscoveredAt: 300 });
    const rerun = correlateMainFailure({ ...correlationInput(), now: 400, previous: e, full: { ...full, attempt: 2, latestAttempt: 2 } });
    expect(rerun!.key).not.toBe(e!.key);
    expect(rerun!.firstDiscoveredAt).toBe(400);
    expect(planFailureResponse({ mode: "on", evidence: e, pm: "agent-pm" })).toMatchObject({ reuseMainCi: true,
      receipt: { owner: "agent-pm", deadline: 1800300, choice: "pending", resume: "current-main-full-green" } });
  });
  test("observe only records would pause/notify; off leaves original MAINCIW", () => {
    const e = correlateMainFailure(correlationInput());
    expect(planFailureResponse({ mode: "observe", evidence: e, pm: "agent-pm" })).toMatchObject({ reuseMainCi: false, notify: false,
      would: ["main-ci-pause", "project-pm-notice"] });
    expect(planFailureResponse({ mode: "off", evidence: e, pm: "agent-pm" }).receipt).toBeNull();
    expect(planFailureResponse({ mode: "on", evidence: null, pm: "agent-pm" }).receipt).toBeNull();
  });
  test("unknown identity, stale attempt, missing checks, mismatched tree, chronology never assign blame", () => {
    for (const patch of [{ mainSha: sha("f") }, { full: { ...full, latestAttempt: 2 } },
      { related: { ...related, conclusion: "failure" } }, { related: { ...related, origin: "author-json" as never } },
      { full: { ...full, tree: sha("f") } }, { full: { ...full, checks: [] } },
      { related: { ...related, completedAt: 250 } }, { related: { ...related, base: sha("f") } },
      { integration: { ...correlationInput().integration, mergedHead: sha("f") } }]) {
      expect(correlateMainFailure({ ...correlationInput(), ...patch })).toBeNull();
    }
  });
});

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { mergedCard } from "./deploy-test-kit.js";
import { readFailureResponse, recordFailureResponse, setFailureResponsePortsForTest } from "../src/lib/ci-main-failure-response-runtime.js";
import { evaluateMainCi, type MainCiHealth } from "../src/lib/scheduler-main-ci.js";
import type { runBounded } from "../src/lib/run-bounded.js";

test("[验收线 1、2、4] real Actions reader binds plan checkout/parents/tree and rejects missing evidence and racing attempts", async () => {
  for (const broken of ["none", "tree", "missing-artifact", "attempt", "read-error", "moving-main"]) {
    const f = mergedCard(), x = correlationInput(), commands: string[][] = [], payloads: any[] = [];
    const target = { project: "p", repo: x.repo, requiredChecks: ["test"] };
    const main = { ...target, sha: x.mainSha, ref: "refs/heads/main" };
    const h = evaluateMainCi(target, { before: main, after: main, observedAt: x.now, checks: { ...target, sha: x.mainSha,
      total_count: 1, check_runs: [{ id: 1, name: "test", head_sha: x.mainSha, status: "completed", conclusion: "failure" }],
      commit_status: { sha: x.mainSha, total_count: 0, statuses: [] } } });
    let rereads = 0;
    const run = (id: number) => ({ id, repository: { full_name: x.repo }, run_attempt: id === 12 && broken === "attempt" && ++rereads > 1 ? 2 : 1,
      path: ".github/workflows/ci.yml", head_sha: id === 11 ? related.head : full.checkout, event: id === 11 ? "pull_request" : "push",
      status: "completed", conclusion: id === 11 ? "success" : "failure" });
    const command = (async (argv: string[]) => {
      commands.push(argv);
      let value: unknown;
      if (argv[1] === "run") {
        const id = Number(argv[3]), dir = argv[argv.indexOf("--dir") + 1]!;
        writeFileSync(join(dir, "plan.json"), JSON.stringify({ version: 1, event: id === 11 ? "pull_request" : "push",
          scope: id === 11 ? "related" : "full", sha: id === 11 ? related.checkout : full.checkout }));
        return { code: 0, stdout: "", stderr: "", timedOut: false };
      }
      const path = argv.at(-1)!;
      if (broken === "read-error") return { code: 1, stdout: "", stderr: "read unavailable", timedOut: false };
      if (path.includes("/git/commits/")) {
        const checked = path.split("/").pop();
        value = { sha: checked, tree: { sha: broken === "tree" && checked === related.checkout ? sha("f") : full.tree },
          parents: [{ sha: related.base }, ...(checked === related.checkout ? [{ sha: related.head }] : [])] };
      } else if (path.endsWith("/pulls")) value = [{ merged_at: "yes", merge_commit_sha: full.checkout,
        head: { sha: related.head }, base: { repo: { full_name: x.repo } } }];
      else if (path.includes("/actions/runs?")) value = { total_count: 1, workflow_runs: [run(path.includes("pull_request") ? 11 : 12)] };
      else if (path.includes("/jobs?")) {
        const id = Number(/runs\/(\d+)/.exec(path)![1]);
        const jobs = [{ name: `ci scope ${id === 11 ? "related" : "full"}`, conclusion: "success" },
          { name: "test", conclusion: id === 11 ? "success" : "failure" }].map((j) => ({ ...j, run_attempt: 1, status: "completed",
            completed_at: new Date(id === 11 ? 100 : 200).toISOString() }));
        value = { total_count: jobs.length, jobs };
      } else if (path.includes("/artifacts?")) {
        const id = Number(/runs\/(\d+)/.exec(path)![1]);
        const items = broken === "missing-artifact" ? [] : [{ name: "ci-related-plan", expired: false,
          workflow_run: { id, head_sha: id === 11 ? related.head : full.checkout } }];
        value = { total_count: items.length, artifacts: items };
      } else if (path.endsWith("/git/ref/heads/main")) value = { ref: "refs/heads/main", object: { sha: broken === "moving-main" ? sha("f") : full.checkout } };
      else value = run(Number(path.split("/").pop()));
      return { code: 0, stdout: JSON.stringify(value), stderr: "", timedOut: false };
    }) as typeof runBounded;
    setFailureResponsePortsForTest(null);
    try {
      const read = (now: number) => readFailureResponse(f.db, { project: "p", health: h, currentMainSha: full.checkout, now }, {
        command, policy: () => ({ mode: "observe", source: "default", manualAfterMs: null }),
        manager: async (...args) => {
          const raw = args[args.indexOf("--response") + 1]!; payloads.push(JSON.parse(raw));
          return recordFailureResponse(f.db, { actor: "scheduler", now: x.now }, "p", raw);
        } });
      await read(x.now);
      const firstCommands = commands.length;
      await read(x.now + 5000);
      await read(x.now + 10000);
      expect(commands).toHaveLength(firstCommands);
      expect(payloads).toHaveLength(broken === "none" ? 1 : 0);
      if (broken === "none") {
        expect(payloads[0].evidence).not.toBeNull();
        setFailureResponsePortsForTest(null); // Restart discards retry memory but keeps the historical receipt.
        await read(x.now + 65000);
        expect(commands).toHaveLength(firstCommands);
        expect(payloads).toHaveLength(1);
      } else {
        await read(x.now + 65000);
        expect(commands.length).toBeGreaterThan(firstCommands);
        const secondCommands = commands.length;
        await read(x.now + 100000);
        expect(commands).toHaveLength(secondCommands);
        await read(x.now + 200000);
        expect(commands.length).toBeGreaterThan(secondCommands);
        expect(payloads).toHaveLength(0);
      }
      expect(commands.every((a) => a[0] === "gh" && (a[1] === "api" || a[2] === "download"))).toBe(true);
    } finally { setFailureResponsePortsForTest(null); f.close(); }
  }
});


test("[回归 F2] healthy/off passes write nothing; a durable incident avoids readers and writers across restart and mode change", async () => {
  const f = mergedCard(), x = correlationInput();
  const health: MainCiHealth = { target: { project: "p", repo: x.repo, requiredChecks: ["test"] }, mainSha: x.mainSha,
    observedAt: x.now, state: "red" as const, reasons: [{ code: "unsuccessful_check" as const }], checks: [] };
  let reads = 0, writes = 0, mode: "off" | "observe" | "on" = "off";
  const reader = async (i: any) => {
    reads++;
    return { ...x, now: i.now, mainSha: i.currentMainSha, integration: { ...x.integration, sha: i.currentMainSha },
      full: { ...x.full, checkout: i.currentMainSha } };
  };
  const read = (h = health, current = h.mainSha, now = x.now) => readFailureResponse(f.db,
    { project: "p", health: h, currentMainSha: current, now }, {
      command: (async () => { throw new Error("unintended live command"); }) as typeof runBounded,
      policy: () => ({ mode, source: "default", manualAfterMs: null }),
      manager: async (...args) => {
        writes++; return recordFailureResponse(f.db, { actor: "scheduler", now }, "p", args[args.indexOf("--response") + 1]!);
      } });
  setFailureResponsePortsForTest({ read: reader });
  try {
    await read(); mode = "observe";
    await read({ ...health, state: "green", reasons: [] });
    await read({ ...health, state: "unknown" });
    await read(health, null); await read({ ...health, mainSha: sha("f") }, health.mainSha);
    expect([reads, writes]).toEqual([0, 0]);
    await read();
    for (let n = 1; n <= 100; n++) await read(health, health.mainSha, x.now + n * 5000);
    expect([reads, writes]).toEqual([1, 1]);
    setFailureResponsePortsForTest({ read: reader }); await read();
    expect([reads, writes]).toEqual([1, 1]);
    mode = "on"; await read(); await read();
    expect([reads, writes]).toEqual([1, 2]);
    const next = { ...health, mainSha: sha("f") }; await read(next);
    expect([reads, writes]).toEqual([2, 3]);
    expect(f.db.query("SELECT COUNT(*) AS n FROM events WHERE json_extract(data,'$.op')='main_ci_response_read'").get()).toEqual({ n: 0 });
    await read({ ...health, reasons: [] });
    expect([reads, writes]).toEqual([2, 3]);
  } finally { setFailureResponsePortsForTest(null); f.close(); }
});

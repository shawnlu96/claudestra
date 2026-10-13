/**
 * merge-arch-GATE1: the deploy worker (src/lib/scheduler-deploy-worker.ts) hands a request's deploySha to the steps unchanged and
 * adds no judgement of its own; a request without one runs the steps as before. Lease, result and SIGTERM behaviour of the worker
 * are in tests/scheduler-deploy-steps.test.ts.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { runBounded } from "../src/lib/run-bounded.js";
import { runDeployJob } from "../src/lib/scheduler-deploy-worker.js";
import { writeJsonAtomicSync } from "../src/lib/state-file.js";

const MERGE = "d".repeat(40), PIN = "e".repeat(40);
const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

/** Runs one request through the worker with a fake git whose tree follows each fast-forward; returns the commands and the result. */
async function work(extra: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), "gate1-worker-")), path = join(dir, "request.json"), calls: string[][] = [];
  roots.push(dir);
  writeJsonAtomicSync(path, { intentId: "m9", mergeSha: MERGE, taskId: "T9", prRef: "https://github.com/a/b/pull/7",
    label: `com.claudestra.scheduler.deploy.${"a".repeat(32)}`, repoDir: "/repo", relayArgv: null, restartLabels: ["x.fake"],
    timeoutMs: 600_000, createdAt: Date.now(), env: {}, ...extra });
  let at = MERGE;
  const run: typeof runBounded = async (argv) => {
    calls.push(argv);
    if (argv.includes("--ff-only")) at = argv.at(-1) === "origin/main" ? "f".repeat(40) : argv.at(-1)!;
    return { code: 0, timedOut: false, stderr: "", stdout: argv.includes("--abbrev-ref") ? "main" : argv.includes("rev-parse") ? at : "" };
  };
  const outcome = await runDeployJob(path, { run, acquire: async () => ({ path: "/l", token: "t", held: () => true, release: () => {} }) });
  return { calls, outcome, result: JSON.parse(readFileSync(join(dir, "result.json"), "utf8")) as { ok: boolean; head: string } };
}

describe("merge-arch-GATE1 deploy worker: deploySha is passed through", () => {
  test("a request with deploySha: the steps fast-forward to it and the result names it as the deployed head", async () => {
    const w = await work({ deploySha: PIN });
    expect(w.calls.filter((a) => a.includes("--ff-only")).map((a) => a.at(-1))).toEqual([PIN]);
    expect(w.result).toMatchObject({ ok: true, head: PIN, mergeSha: MERGE });
  });

  test("a request without it (off / observe, or written before this card): the same commands as ever, onto origin/main", async () => {
    const plain = await work({}), pinned = await work({ deploySha: PIN });
    expect(plain.calls.filter((a) => a.includes("--ff-only")).map((a) => a.at(-1))).toEqual(["origin/main"]);
    expect(plain.calls.filter((a) => a.includes("--is-ancestor"))).toHaveLength(1);
    // the pin only adds its three ancestry checks and changes the fast-forward target
    const unpinned = pinned.calls.filter((a) => !(a.includes("--is-ancestor") && a.includes(PIN))).map((a) => a.map((x) => (x === PIN ? "origin/main" : x)));
    expect(unpinned.slice(0, 6)).toEqual(plain.calls.slice(0, 6));
  });
});

/** Private ledger + real scheduler CLI writes; all external argv is answered by the recording fake, never spawned. */
import type { Database } from "bun:sqlite";
import { expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { acquireLock } from "../src/lib/file-lock.js";
import { LedgerReader } from "../src/lib/ledger-read.js";
import { planIntent, setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { settleIntent } from "../src/lib/ledger-scheduler-settle.js";
import { closeLedger, getMeta, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import { encodeLease } from "../src/lib/scheduler-lease-env.js";
import { parseSchedulerConfig } from "../src/lib/scheduler-config.js";
import { getMergeRun } from "../src/lib/scheduler-merge.js";
import type { PrSnapshot } from "../src/lib/scheduler-merge-driver.js";
import { ciBehindGh } from "../src/lib/scheduler-merge-ci-behind.js";
import { ciRerunGh } from "../src/lib/scheduler-merge-ci-rerun.js";
import { guardedCommand } from "../src/lib/scheduler-merge-train-tick.js";
import { mergeExternal } from "../src/lib/scheduler-merge-external.js";
import type { runBounded } from "../src/lib/run-bounded.js";
import { mergeTick } from "../src/lib/scheduler-service.js";
import { testChildEnv } from "./test-env.js";

export const READY_HEAD = "a".repeat(40), READY_MAIN = "b".repeat(40), READY_MERGE = "c".repeat(40);
export const READY_PR = "https://github.com/example/repo/pull/84", READY_RUN = "https://github.com/example/repo/actions/runs/840";
export const READY_GATE = "typecheck + test + guard", READY_SHARD = "test shard 3 of 4", READY_SLOW = "tests/outside.test.ts";
type Bucket = PrSnapshot["checks"][number]["bucket"];
export function readyChecks(shard: Bucket, gate: Bucket | null): PrSnapshot["checks"] {
  const rows: PrSnapshot["checks"][number][] = [{ name: READY_SHARD, bucket: shard, link: `${READY_RUN}/job/3` }];
  if (gate) rows.push({ name: READY_GATE, bucket: gate, link: `${READY_RUN}/job/5` });
  return rows;
}
export function readyLog(timeout: boolean): string {
  const body = [`##[group]${READY_SLOW}:`, ...(timeout ? [] : ["error: expect(received).toBe(expected)"]),
    "(fail) outside > ready fixture [5100.00ms]", ...(timeout ? ["  ^ this test timed out after 5000ms."] : []),
    "##[endgroup]", " 0 pass", " 1 fail", "Ran 1 tests across 1 files. [5.10s]", "##[error]Process completed with exit code 1."];
  return body.map((s) => `${READY_SHARD}\tUnit tests\t2026-10-09T01:00:00.000Z ${s}`).join("\n");
}
function seedReady(db: Database) {
  const owner = { actor: "owner", now: 100 };
  createTask(db, owner, { project: "p", id: "R84", title: "ready CI", kind: "code", agent: "agent-author" });
  setWorkflow(db, owner, { taskId: "R84", taskRev: 1, template: "code", templateVersion: 2, mode: "auto", authorFamily: "claude", fallback: "PM" });
  db.query("UPDATE tasks SET stage='review', round=1, headSHA=?, pr=?, branch='feat/r84' WHERE id='R84'").run(READY_HEAD, READY_PR);
  db.prepare("INSERT INTO events (ts,actor,project,target,kind,text,data) VALUES (100,'owner','p','R84','stage','',?)")
    .run(JSON.stringify({ from: "build", to: "review", round: 1 }));
  planIntent(db, { actor: "scheduler", now: 101 }, { id: "review84", taskId: "R84", taskRev: 1, workflowRev: 1,
    causalSeq: (db.query("SELECT MAX(seq) AS n FROM events WHERE project='p'").get() as { n: number }).n,
    node: "adversarial_review", action: "review", recipient: "agent-rv", reason: "review" });
  settleIntent(db, { actor: "scheduler" }, { id: "review84", from: "pending", to: "submitted", receipt: "review claimed" });
  const facts = { round: 1, head: READY_HEAD, verdict: "pass", reviewer: "agent-rv", reviewerFamily: "codex", reviewerSessionId: "session84",
    path: "reviews/R84-r1/review.md", findings: [], p0: 0, p1: 0, p2: 0 };
  db.prepare("INSERT INTO events (ts,actor,project,target,kind,text,data) VALUES (102,'agent-rv','p','R84','review','',?)").run(JSON.stringify(facts));
  settleIntent(db, { actor: "scheduler" }, { id: "review84", from: "submitted", to: "done", receipt: "review recorded" });
  db.prepare(`INSERT INTO scheduler_sessions (taskId,role,agent,sessionId,family,transport,state,createIntentId,createdAt,updatedAt)
    VALUES ('R84','reviewer','agent-rv','session84','codex','acp','active','review84',100,100)`).run();
  db.prepare("UPDATE tasks SET stage='merge' WHERE id='R84'").run();
  db.prepare("INSERT INTO events (ts,actor,project,target,kind,text,data) VALUES (103,'owner','p','R84','stage','',?)")
    .run(JSON.stringify({ from: "review", to: "merge", round: 1, specRev: 1 }));
}
export interface ReadyHub {
  snapshot: PrSnapshot; calls: string[][]; log: string | null; files: string[]; behind: number;
  attempt: number; status: string; conclusion: string; onMerge?: () => void; onRerun?: () => void;
}
function readyNetwork(hub: ReadyHub): typeof runBounded {
  return async (argv) => {
    hub.calls.push([...argv]);
    const good = (value: unknown) => ({ code: 0, timedOut: false, stderr: "", stdout: typeof value === "string" ? value : JSON.stringify(value) });
    const tail = argv.slice(1);
    const verb = tail.slice(0, 2).join(" ");
    if (argv[0] !== "gh") throw new Error(`unexpected executable ${argv[0]}`);
    if (verb === "repo view") return good({ nameWithOwner: "example/repo" });
    if (verb === "pr checks") return { ...good(hub.snapshot.checks), code: 8 };
    if (verb === "pr view" && tail.includes("files")) return good({ files: hub.files.map((path) => ({ path })) });
    if (verb === "pr view") {
      const p = hub.snapshot;
      return good({ state: p.state, headRefOid: p.head, headRefName: p.branch, baseRefName: p.base, isDraft: p.draft,
        isCrossRepository: p.crossRepository, mergeStateStatus: p.mergeState, mergeCommit: p.mergeSha ? { oid: p.mergeSha } : null });
    }
    if (verb === "run view" && tail.includes("--log-failed")) return hub.log === null
      ? { code: 1, timedOut: false, stdout: "", stderr: "fixture unreadable log" } : good(hub.log);
    if (verb === "run view") return good({ attempt: hub.attempt, status: hub.status, conclusion: hub.conclusion });
    if (verb === "run rerun") { hub.onRerun?.(); hub.attempt++; hub.status = "queued"; hub.conclusion = ""; return good(""); }
    if (verb === "pr update-branch") return good("");
    if (tail[0] === "api" && tail[1]?.startsWith("repos/example/repo/compare/main...")) return good({ behind: hub.behind, main: READY_MAIN });
    if (tail[0] === "api" && tail[1]?.startsWith("repos/example/repo/compare/")) return good({ base: READY_MAIN, commits: [] });
    if (tail[0] === "api" && tail[1] === "-X") {
      expect(tail).toEqual(["api", "-X", "PUT", "repos/example/repo/pulls/84/merge", "-f", `sha=${READY_HEAD}`, "-f", "merge_method=merge"]);
      hub.onMerge?.();
      Object.assign(hub.snapshot, { state: "MERGED", mergeSha: READY_MERGE });
      return good({ merged: true, sha: READY_MERGE });
    }
    throw new Error(`unexpected fixture argv ${argv.join(" ")}`);
  };
}
/** Every manager call launches a real CLI child with the service's two verified leases and this ledger's private paths. */
export async function readyFixture() {
  const dir = mkdtempSync(join(tmpdir(), "cif4-ready-")), ledger = join(dir, "ledger.sqlite");
  const home = join(dir, "home"), runtime = join(dir, "runtime");
  mkdirSync(home); mkdirSync(runtime);
  const db = openLedger(ledger);
  seedReady(db);
  writeFileSync(join(dir, "registry.json"), '{"agents":{}}');
  const locks = await Promise.all([acquireLock(join(dir, "singleton.lock"), 0), acquireLock(join(dir, "maintenance.lock"), 0)]);
  expect(locks.every(Boolean)).toBe(true);
  const lease = encodeLease({ singleton: { path: join(dir, "singleton.lock"), token: locks[0]!.token },
    maintenance: { path: join(dir, "maintenance.lock"), token: locks[1]!.token } });
  const env = testChildEnv({ HOME: home, TMPDIR: dir, CLAUDESTRA_STATE_DIR: dir, CLAUDESTRA_RUNTIME_DIR: runtime,
    CLAUDESTRA_SCHEDULER_SERVICE: "1", CLAUDESTRA_SCHEDULER_LEASE: lease });
  const childCalls: string[][] = [], cliResults: Record<string, unknown>[] = [];
  const hooks: { afterWrite?: (args: string[]) => void } = {};
  const manager = async (...args: string[]) => {
    childCalls.push(args);
    const p = Bun.spawn([process.execPath, "--no-env-file", resolve("src/manager.ts"), ...args], { env, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    expect(err).not.toContain("[test-guard]");
    const result = JSON.parse(out) as Record<string, unknown>;
    expect({ code, result }).toMatchObject({ code: 0, result: { ok: true } });
    cliResults.push({ args, result }); hooks.afterWrite?.(args);
    return result;
  };
  const seq = (db.query("SELECT MAX(seq) AS n FROM events").get() as { n: number }).n;
  await manager("ledger", "scheduler-plan", "R84", "--id", "merge84", "--rev", "1", "--workflow-rev", "1", "--seq", String(seq),
    "--node", "merge_deploy", "--action", "merge", "--reason", "ready fixture", "--resources", "merge:p");
  const reader = new LedgerReader(ledger);
  const hub: ReadyHub = { snapshot: { state: "OPEN", head: READY_HEAD, branch: "feat/r84", base: "main", crossRepository: false,
    draft: false, mergeState: "UNSTABLE", mergeSha: null, checks: readyChecks("fail", "pending") }, calls: [], log: readyLog(false),
    files: ["src/fixture.ts"], behind: 0, attempt: 1, status: "in_progress", conclusion: "" };
  const guard = { check: () => {} };
  const command = guardedCommand(() => guard.check(), readyNetwork(hub));
  const config = parseSchedulerConfig({ enabled: true, projects: { p: { maxActiveWorkers: 1, requiredChecks: [READY_GATE], repoDir: dir } } });
  const ext = Object.assign(mergeExternal(config.projects.p!, command), { ciRerun: ciRerunGh(command), ciBehind: ciBehindGh(command) });
  const observations: unknown[] = [];
  const tick = async (assertActive: () => void = () => {}) => {
    expect(() => reader.get()!.run("UPDATE meta SET value=value")).toThrow(/readonly/);
    const result = await mergeTick(reader.get()!, config, manager, () => ext, assertActive);
    observations.push({ row: row(), task: getTask(db, "R84"), frozen: getMeta(db, "p").queueFrozen });
    return result;
  };
  const row = () => getMergeRun(db, "merge84")!;
  const state = () => ({ phase: row().phase, stage: getTask(db, "R84")!.stage, frozen: getMeta(db, "p").queueFrozen.frozen });
  const events = (op: string) => listEvents(db, { target: "R84" }).filter((e) => e.data.op === op);
  const sent = () => hub.calls.filter((a) => a[1] === "run" && a[2] === "rerun" || a[1] === "pr" && a[2] === "update-branch" || a.includes("PUT"));
  const finish = (gate: Bucket = "fail") => {
    hub.snapshot.checks = readyChecks("fail", gate); hub.status = "completed"; hub.conclusion = "failure";
  };
  const close = () => { reader.close(); locks.forEach((l) => l!.release()); closeLedger(ledger); rmSync(dir, { recursive: true, force: true }); };
  return { db, dir, env, guard, manager, childCalls, cliResults, observations, hooks, reader, hub, config, ext, tick, row, state, events, sent, finish, close };
}
export async function withReady(body: (f: Awaited<ReturnType<typeof readyFixture>>) => Promise<void>) {
  const f = await readyFixture();
  try { await body(f); } finally {
    const evidence = process.env.CIF4_EVIDENCE_DIR;
    if (evidence) {
      mkdirSync(evidence, { recursive: true });
      writeFileSync(join(evidence, `${f.dir.split("/").pop()}.json`), JSON.stringify({ observations: f.observations, cli: f.cliResults,
        network: f.hub.calls, events: listEvents(f.db, { target: "R84" }) }, null, 2));
    }
    f.close();
  }
}

import { expect, test } from "bun:test";
import { join } from "node:path";
import { replayBounceEvent, replayBounceStep, useReplayPorts } from "../src/lib/ci-selected-replay.js";
import { bounceStep, closeMergeRun, bounceReceipt } from "../src/lib/scheduler-merge-conflict.js";
import { closeLedger, getTask, openLedger } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { collectReplayEvidence, readReplayReceipt, replayRefs, saveReplayReceipt } from "../src/lib/ci-selected-replay-receipt.js";
import { recoveryPolicy } from "../src/lib/recovery-policy.js";
import type { MergeRun } from "../src/lib/scheduler-merge.js";
import type { MergeExternal, PrSnapshot } from "../src/lib/scheduler-merge-driver.js";
import { HEAD, evidence, replayCommand, receipt, tempRoot } from "./ci-selected-replay-receipt.test.js";

const run: MergeRun = { project: "p", taskId: "T", intentId: "i", rev: 1, reviewedHead: HEAD, phase: "ready", prRef: "https://github.com/example/repo/pull/1",
  expectedBranch: "feat/t", requiredChecks: "check", createdAt: 100, updatedAt: 100, reason: null, mergeSha: null };
const pr: PrSnapshot = { head: HEAD, state: "OPEN", branch: "feat/t", base: "main", draft: false, crossRepository: false,
  mergeState: "CLEAN", mergeSha: null, checks: [{ name: "check", bucket: "fail", link: "https://github.com/example/repo/actions/runs/7" }] };
const external = { ciSelected: true } as MergeExternal;
const rawReceipt = bounceReceipt({ cause: "ci_fail", prHead: HEAD, mainHead: null, checks: [{ name: "check", link: pr.checks[0]!.link! }] });

test("actual bounceStep captures before the original resolved step without changing its receipt", async () => {
  const calls: string[] = [];
  using ports = useReplayPorts({ mode: "on", capture: async () => { calls.push("archive"); } });
  const step = async (to: string, text?: string) => { calls.push(to); expect(text).toBe(rawReceipt); return run; };
  await bounceStep(run, pr, external, step);
  expect(calls).toEqual(["archive", "resolved"]);
});

test("off returns the identical step and produces the identical bounce; observe does not capture", async () => {
  for (const mode of ["off", "observe"] as const) {
    let captured = 0;
    using ports = useReplayPorts({ mode, capture: async () => { captured++; } });
    const step = async (_to: string, text?: string) => { expect(text).toBe(rawReceipt); return run; };
    expect(replayBounceStep(run, pr, external, step)).toBe(step);
    expect(await bounceStep(run, pr, external, step)).toBe(run);
    expect(captured).toBe(0);
  }
});

test("capture failure still calls the unchanged bounce; unrelated transitions never capture", async () => {
  const calls: string[] = [];
  using ports = useReplayPorts({ mode: "on", capture: async () => { calls.push("failed-archive"); throw new Error("disk full"); } });
  const step = async (to: string) => { calls.push(to); return run; };
  const wrapped = replayBounceStep(run, pr, external, step);
  await wrapped("await_ci", "CI 恢复判定");
  await wrapped("resolved", rawReceipt);
  expect(calls).toEqual(["await_ci", "failed-archive", "resolved"]);
});

test("ledger close pins artifact digest, round and intent to the real bounce event, or records the missing gap", async () => {
  const root = tempRoot(), path = join(root, "ledger.sqlite"), db = openLedger(path);
  try {
    createTask(db, { actor: "owner", now: 100 }, { project: "p", id: "T", title: "t", kind: "code", agent: "author" });
    db.query("UPDATE tasks SET stage='merge', round=1, headSHA=? WHERE id='T'").run(HEAD);
    db.query(`INSERT INTO scheduler_intents (id,taskId,project,node,action,causalSeq,eventSeq,taskRev,specRev,head,templateVersion,
      status,reason,createdAt,updatedAt) VALUES ('i','T','p','merge_deploy','merge',1,1,1,1,?,2,'submitted','r',100,100)`).run(HEAD);
    const ref = await saveReplayReceipt(receipt(), root);
    using ports = useReplayPorts({ mode: "on", root });
    closeMergeRun(db, { actor: "scheduler", now: 200 }, run, rawReceipt, null);
    const raw = db.query("SELECT data FROM events WHERE json_extract(data,'$.op')='merge_conflict'").get() as { data: string };
    expect(JSON.parse(raw.data).ciSelectedReplay).toMatchObject({ head: HEAD, round: 1, specRev: 1, intentId: "i", refs: [ref], gap: null });
    expect(getTask(db, "T")!.stage).toBe("fix");
    expect(getWorkflow(db, "T")).toBeNull();
    const missing = replayBounceEvent(db, { ...run, rev: 2 }, "ci_fail") as any;
    expect(missing.ciSelectedReplay.gap).toContain("没有归档");
    using off = useReplayPorts({ mode: "off", root });
    const count = db.query("SELECT count(*) AS n FROM events").get();
    expect(replayBounceEvent(db, run, "ci_fail")).toEqual({});
    expect(db.query("SELECT count(*) AS n FROM events").get()).toEqual(count);
  } finally { closeLedger(path); }
});

test("new archive key defaults on while ciSelectedGate defaults observe", () => {
  const root = tempRoot(), absent = join(root, "absent.json");
  expect(recoveryPolicy("p", "ciSelectedReplayReceipt", absent).mode).toBe("on");
  expect(recoveryPolicy("p", "ciSelectedGate", absent).mode).toBe("observe");
});


test("first red defers actual bounce across ticks until necessary jobs finish, without waiting for proof", async () => {
  const root = tempRoot(), e = evidence(), io = replayCommand(e), calls: string[] = [];
  e.run.status = "in_progress";
  const web = e.jobs.find((j) => j.name === "web production build")!; web.status = "in_progress";
  e.jobs.push({ name: "ci coverage proof", status: "queued", conclusion: null, steps: [] });
  const step = async (to: string, text?: string) => { calls.push(to); expect(text).toBe(rawReceipt); return run; };
  using ports = useReplayPorts({ mode: "on", root, now: () => 100, revision: () => ({ round: 1, specRev: 1 }), effectiveMode: async () => "observe",
    collect: (repo, head, links, _cmd, _cwd, opts) => collectReplayEvidence(repo, head, links, io.command, undefined, opts) });
  expect(await bounceStep(run, pr, external, step)).toBe(run);
  expect(calls).toEqual([]);
  expect(replayRefs(run, root)).toEqual([]);
  expect(io.calls.some((a) => a[2] === "download")).toBe(false);
  web.status = "completed";
  await bounceStep(run, pr, external, step);
  expect(calls).toEqual(["resolved"]);
  const refs = replayRefs(run, root);
  expect(refs).toHaveLength(1);
  expect(readReplayReceipt(root, refs[0]!)).toMatchObject({ gaps: [], verdict: { allow: true }, evidence: { run: { status: "in_progress" } } });
  await bounceStep(run, pr, external, step);
  expect(io.calls.filter((a) => a[2] === "download")).toHaveLength(1);
});

test("readiness deadline persists across reconstructed ports and times out into an explicit attempt-bound gap", async () => {
  const root = tempRoot(), e = evidence(), io = replayCommand(e), calls: string[] = [];
  e.jobs[0]!.status = "queued";
  const step = async (to: string) => { calls.push(to); return run; };
  const base = { mode: "on" as const, root, waitMs: 100, revision: () => ({ round: 1, specRev: 1 }), effectiveMode: async () => "observe" as const,
    collect: ((repo, head, links, _cmd, _cwd, opts) => collectReplayEvidence(repo, head, links, io.command, undefined, opts)) as typeof collectReplayEvidence };
  { using ports = useReplayPorts({ ...base, now: () => 100 }); await bounceStep(run, pr, external, step); }
  { using ports = useReplayPorts({ ...base, now: () => 199 }); await bounceStep(run, pr, external, step); }
  expect(calls).toEqual([]);
  { using ports = useReplayPorts({ ...base, now: () => 200 }); await bounceStep(run, pr, external, step); }
  expect(calls).toEqual(["resolved"]);
  const r = readReplayReceipt(root, replayRefs(run, root)[0]!);
  expect(r.subject).toEqual({ id: 7, attempt: 1 });
  expect(r.evidence).toBeNull();
  expect(r.gaps.join("；")).toContain("超时");
  expect(io.calls.some((a) => a[2] === "download")).toBe(false);
});

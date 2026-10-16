import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { intakeWrite } from "../src/lib/peer-pr-ledger.js";
import type { PeerPrConfig } from "../src/lib/peer-pr-config.js";
import { closeLedger, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask, deliver, moveStage, recordVerify, setMeta } from "../src/lib/ledger-write.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { peerPrVerifyKey, schedulerCanVerify } from "../src/lib/scheduler-verify-gate.js";
import { SCHEDULER_CONFIG_PATH } from "../src/lib/scheduler-config.js";
import { LedgerReader } from "../src/lib/ledger-read.js";
import { tempLedgerPath } from "./ledger-test-helpers.js";

import { peerPrAutoVerify } from "../src/lib/peer-pr-auto-verify.js";
import { runLedger } from "../src/manager/ledger.js";
import { highRiskRecoveryKey } from "../src/lib/recovery-key-class.js";
import { defaultRecoveryMode } from "../src/lib/recovery-key-defaults.js";
import { RECOVERY_KEYS } from "../src/lib/recovery-keys.js";
import type { FactsDeps } from "../src/lib/ledger-verify-facts.js";
import type { RecoveryMode, RecoveryPolicyPort } from "../src/lib/recovery-policy.js";

const HEAD = "a".repeat(40), NEXT = "b".repeat(40), PR = "https://github.com/o/r/pull/401";
const cfg: PeerPrConfig = { project: "p", repoDir: "/repo", fromNumber: 1, pollSec: 60, headSettleSec: 60, maxOpen: 10,
  maxRounds: 3, fixTimeoutH: 24, replyTo: "pm@home", extraSecurityGlobs: [],
  peers: [{ peer: "he", fp: "0a1b-2c3d-4e5f-6a7b", agent: "agent-x", githubLogins: ["he-dev"], authorFamily: "codex" }] };
const config = { enabled: true, autoDispatch: false, pollMs: 1000,
  projects: { p: { repoDir: "/repo", requiredChecks: ["check"], maxActiveWorkers: 1 } } };
let db: Database;
let path: string;
const task = () => getTask(db, "PR401")!;
const events = () => listEvents(db, { project: "p", target: "PR401" });
const at = { actor: "owner", now: 1000 };
function ship() {
  moveStage(db, at, { taskId: "PR401", from: "review", to: "merge" });
  moveStage(db, at, { taskId: "PR401", from: "merge", to: "live" });
}
function redeliver(head = NEXT) {
  moveStage(db, at, { taskId: "PR401", from: "live", to: "fix" });
  deliver(db, { actor: "peer:he", now: 2000 }, { taskId: "PR401", headSHA: head, evidence: `${PR}@${head}`, moveFrom: "fix" });
  ship();
}
beforeEach(() => {
  path = tempLedgerPath("peer-pr-auto-verify-"); db = openLedger(path);
  setMeta(db, at, { project: "p", key: "pms", value: ["pm"] });
  intakeWrite(db, { actor: "scheduler", now: 100 }, { project: "p", number: 401, url: PR, head: HEAD,
    branch: "fix/x", base: "main", login: "he-dev", title: "peer", surface: "plain", reasons: [], spec: "accepted" }, cfg);
  setWorkflow(db, at, { taskId: "PR401", taskRev: task().rev, workflowRev: 1, template: "security", templateVersion: 2,
    mode: "manual", reason: "pm_takeover: manual deploy", authorFamily: "codex", fallback: "PM deploys" });
  ship();
  writeFileSync(SCHEDULER_CONFIG_PATH, JSON.stringify(config));
});
afterEach(() => { closeLedger(path); rmSync(SCHEDULER_CONFIG_PATH, { force: true }); });

describe("[验收线 2] imported PR verify gate", () => {
  test("accepts the real intake lineage without a deploy journal or auto workflow", () => {
    expect(db.query("SELECT * FROM scheduler_deploys").all()).toHaveLength(0);
    expect(schedulerCanVerify(db, "PR401")).toBe(true);
  });
  test.each([
    ["PR number", "UPDATE tasks SET pr='https://github.com/o/r/pull/402' WHERE id='PR401'"],
    ["head", `UPDATE tasks SET headSHA='${NEXT}' WHERE id='PR401'`],
    ["spec", "UPDATE tasks SET specRev=2 WHERE id='PR401'"],
    ["repository", "UPDATE tasks SET pr='https://github.com/other/r/pull/401' WHERE id='PR401'"],
    ["project", "UPDATE tasks SET project='other' WHERE id='PR401'"],
    ["metadata", "UPDATE tasks SET extra=json_set(extra,'$.peerPr.number',402) WHERE id='PR401'"],
    ["declared repo", "UPDATE tasks SET extra=json_set(extra,'$.repo','other/r') WHERE id='PR401'"],
  ])("rejects mismatched %s", (_name, sql) => {
    db.run(sql); expect(schedulerCanVerify(db, "PR401")).toBe(false);
  });
  test("matching the workflow spec alone cannot reuse a previous generation's delivery", () => {
    db.run("UPDATE tasks SET specRev=2 WHERE id='PR401'");
    db.run("UPDATE task_workflows SET specRev=2 WHERE taskId='PR401'");
    expect(schedulerCanVerify(db, "PR401")).toBe(false);
  });
  test("a later valid peer delivery is eligible and no-deployment cards reject foreign dedup keys", () => {
    redeliver(); expect(schedulerCanVerify(db, "PR401")).toBe(true);
    expect(schedulerCanVerify(db, "PR401", "deploy-verify:unrelated")).toBe(false);
  });
  test("ordinary manual card cannot borrow metadata from an imported card", () => {
    createTask(db, at, { project: "p", id: "ordinary", title: "manual", kind: "code", stage: "live", headSHA: HEAD,
      pr: PR, assigneeKind: task().assigneeKind!, assignee: task().assignee!, extra: task().extra });
    expect(schedulerCanVerify(db, "ordinary")).toBe(false);
  });
});

// The tick drives the real CLI and transactional writer; only external repository probes are replaced.

function driver(mode: RecoveryMode = "on") {
  let now = 10_000, result = "pass", changed: (() => void) | undefined;
  const calls: string[][] = [];
  const policy: RecoveryPolicyPort = () => ({ mode, manualAfterMs: null, source: "config" });
  const fd: FactsDeps = {
    repoRoot: "/repo", localWebCommit: () => null, relayStatus: async () => null, relayWebCommit: async () => null,
    bridgePort: () => 9, fileSize: () => null, isDir: () => true, readRepoFile: () => null,
    run: async (args) => {
      if (changed) { const change = changed; changed = undefined; change(); }
      const cmd = args.join(" ");
      if (cmd.includes("remote get-url")) return { code: 0, stdout: "https://github.com/o/r.git", stderr: "" };
      if (cmd.startsWith("gh pr view")) return { code: result === "unknown" ? 1 : 0,
        stdout: JSON.stringify({ state: result === "fail" ? "OPEN" : "MERGED", mergeCommit: { oid: "c".repeat(40) },
          mergedAt: "2026-10-15T00:00:00Z", headRefOid: HEAD, headRefName: "fix/x" }), stderr: "" };
      if (cmd.startsWith("gh api")) return { code: 0, stdout: "README.md\n", stderr: "" };
      if (cmd.includes("merge-base --is-ancestor") || cmd.includes("fetch --quiet")) return { code: 0, stdout: "", stderr: "" };
      return { code: 1, stdout: "", stderr: `unexpected ${cmd}` };
    },
  };
  const manager = async (...args: string[]) => {
    calls.push(args);
    return await runLedger(args.slice(1), { db, actor: "scheduler", projectIds: ["p"], factsDeps: () => fd, now: () => now,
      loadRegistry: async () => ({ socket: "", agents: {} }), saveRegistry: async () => {} });
  };
  const tick = (assertActive = () => {}, reader = db) => peerPrAutoVerify(reader, config, { manager, policy, assertActive, now: () => now });
  return { get calls() { return calls.filter((a) => a[1] === "verify"); }, tick, manager, change: (fn: () => void) => { changed = fn; }, advance: () => { now += 600_000; },
    result: (r: string) => { result = r; }, mode: (m: RecoveryMode) => { mode = m; } };
}

describe("peer PR verification loop", () => {
  test("[验收线 1] on runs all checks and records only a pass", async () => {
    const d = driver();
    expect(await d.tick()).toEqual([]);
    expect(task().stage).toBe("verified");
    expect(db.query("SELECT * FROM scheduler_deploys").all()).toHaveLength(0);
    expect(db.query("SELECT mode FROM task_workflows WHERE taskId='PR401'").get()).toEqual({ mode: "manual" });
    expect(events().filter((e) => e.kind === "verify")).toHaveLength(1);
    expect(d.calls).toHaveLength(1);
    expect(d.calls[0]).toContain("--pass-only");
    await d.tick(); expect(d.calls).toHaveLength(1);
  });
  test.each(["fail", "unknown"])("[验收线 1] %s writes no result, throttles and retries", async (result) => {
    const d = driver(); d.result(result);
    await d.tick(); await d.tick();
    expect(d.calls).toHaveLength(1);
    expect(task().stage).toBe("live");
    expect(events().filter((e) => e.kind === "verify")).toHaveLength(0);
    d.advance(); d.result("pass"); await d.tick();
    expect(d.calls).toHaveLength(2); expect(task().stage).toBe("verified");
  });
  test.each(["fail", "unknown"])("[验收线 1] scheduler pass-only %s performs zero writes", async (result) => {
    const d = driver(); d.result(result); const before = events(), snapshot = task();
    expect(await d.manager("ledger", "verify", "PR401", "--dedup", peerPrVerifyKey(db, "PR401")!, "--pass-only"))
      .toMatchObject({ ok: false, recorded: false, result });
    expect(events()).toEqual(before); expect(task()).toEqual(snapshot);
  });
  test("[验收线 3] observe samples exactly once per head, never invokes verify", async () => {
    const d = driver("observe"); await d.tick(); await d.tick();
    expect(d.calls).toEqual([]); expect(task().stage).toBe("live");
    expect(events().filter((e) => e.data.mechanism === "peerPrAutoVerify")).toHaveLength(1);
    redeliver(); await d.tick();
    expect(events().filter((e) => e.data.mechanism === "peerPrAutoVerify")).toHaveLength(2);
  });
  test("[验收线 4] off does nothing and the permission key defaults to observe", async () => {
    const d = driver("off"), before = events().length; await d.tick();
    expect(d.calls).toEqual([]); expect(events()).toHaveLength(before);
    expect(RECOVERY_KEYS).toContain("peerPrAutoVerify");
    expect(highRiskRecoveryKey("peerPrAutoVerify")).toBe(true);
    expect(defaultRecoveryMode("peerPrAutoVerify")).toBe("observe");
  });
  test("[验收线 2] a new valid delivery while probes run cannot receive the old pass", async () => {
    const d = driver(); d.change(() => redeliver()); await d.tick();
    expect(task().headSHA).toBe(NEXT); expect(task().stage).toBe("live");
    expect(events().filter((e) => e.kind === "verify")).toHaveLength(0);
  });
  test("[验收线 2] the same head returning to live is a new episode", () => {
    const old = peerPrVerifyKey(db, "PR401"); redeliver(HEAD);
    expect(peerPrVerifyKey(db, "PR401")).not.toBe(old);
    expect(schedulerCanVerify(db, "PR401", old!)).toBe(false);
  });
  test("[验收线 2] transactional writer refuses a stale key even when the next generation qualifies", () => {
    const key = peerPrVerifyKey(db, "PR401")!; redeliver();
    expect(() => recordVerify(db, { actor: "scheduler", dedupKey: key }, { taskId: "PR401", result: "pass",
      data: { checks: [{ id: "pr-merged", status: "pass" }] } })).toThrow();
    expect(task().stage).toBe("live");
  });
});

function migrate(bind = true) {
  if (bind) db.run("UPDATE tasks SET extra=json_set(extra,'$.sharedFeatureId','f') WHERE id='PR401'");
  writeFileSync(join(dirname(path), "shared-ledger-modes.json"), JSON.stringify({ features: { f: {
    authorityMode: "planning", sharedPlanning: true, migrating: { batchId: "b", kind: "execute" },
  } } }));
}

describe("[验收线 2] retry and migration boundaries", () => {
  test("migration skips both observe and on without writes", async () => {
    migrate(); const before = events().length;
    for (const mode of ["observe", "on"] as const) {
      const d = driver(mode); await d.tick(); expect(d.calls).toEqual([]);
    }
    expect(events()).toHaveLength(before);
  });
  test("migration starting at claim prevents the call", async () => {
    db.run("UPDATE tasks SET extra=json_set(extra,'$.sharedFeatureId','f') WHERE id='PR401'");
    const d = driver(); let n = 0;
    await d.tick(() => { if (++n === 2) migrate(false); });
    expect(d.calls).toEqual([]);
    expect(events().some((e) => e.data.op === "peer_pr_verify_attempt")).toBe(false);
  });
  test("migration during probes is rejected by the existing transactional write gate", async () => {
    const d = driver(); d.change(() => migrate()); await d.tick();
    expect(task().stage).toBe("live"); expect(events().some((e) => e.kind === "verify")).toBe(false);
  });
  test("throttling survives a new tick driver and changed head", async () => {
    const d = driver(); d.result("fail"); await d.tick(); redeliver();
    closeLedger(path); db = openLedger(path);
    const next = driver(); await next.tick(); expect(next.calls).toHaveLength(0);
    next.advance(); await next.tick(); expect(next.calls).toHaveLength(1);
  });
  test("replaying a successful episode never repeats probes or events", async () => {
    const d = driver(), key = peerPrVerifyKey(db, "PR401")!; await d.tick();
    const before = events().length;
    expect(await d.manager("ledger", "verify", "PR401", "--pass-only", "--dedup", key)).toMatchObject({ ok: true, duplicate: true });
    expect(events()).toHaveLength(before);
  });
  test("overlapping ticks share the persisted attempt and only run one verify", async () => {
    const d = driver(); d.result("fail"); await Promise.all([d.tick(), d.tick()]);
    expect(d.calls).toHaveLength(1); expect(events().filter((e) => e.data.op === "peer_pr_verify_attempt")).toHaveLength(1);
  });
  test("policy switched off between selection and claim makes no attempt", async () => {
    const d = driver(); let n = 0; const before = events().length;
    await d.tick(() => { if (++n === 2) d.mode("off"); });
    expect(d.calls).toEqual([]); expect(events()).toHaveLength(before);
  });
});


describe("[验收线 1] daemon read-only connection", () => {
  test.each(["observe", "on"] as const)("%s uses the existing short-lived ledger writer", async (mode) => {
    const reader = new LedgerReader(path), d = driver(mode);
    try {
      expect(await d.tick(() => {}, reader.get()!)).toEqual([]);
      expect(task().stage).toBe(mode === "on" ? "verified" : "live");
      if (mode === "observe") expect(events().filter((e) => e.data.mechanism === "peerPrAutoVerify")).toHaveLength(1);
    } finally { reader.close(); }
  });
});

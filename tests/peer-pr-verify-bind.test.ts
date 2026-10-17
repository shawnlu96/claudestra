import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { intakeWrite } from "../src/lib/peer-pr-ledger.js";
import type { PeerPrConfig } from "../src/lib/peer-pr-config.js";
import { closeLedger, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { deliver, moveStage, recordVerify, setMeta } from "../src/lib/ledger-write.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { peerPrVerifyKey, schedulerCanDryRunVerify, schedulerCanVerify } from "../src/lib/scheduler-verify-gate.js";
import { SCHEDULER_CONFIG_PATH } from "../src/lib/scheduler-config.js";
import { RECOVERY_POLICY_PATH, type RecoveryMode } from "../src/lib/recovery-policy.js";
import { highRiskRecoveryKey } from "../src/lib/recovery-key-class.js";
import { defaultRecoveryMode } from "../src/lib/recovery-key-defaults.js";
import { RECOVERY_KEYS } from "../src/lib/recovery-keys.js";
import { peerPrAutoVerify } from "../src/lib/peer-pr-auto-verify.js";
import { BACKOFF_MS, MAX_ATTEMPTS } from "../src/lib/peer-pr-verify-retry.js";
import type { FactsDeps } from "../src/lib/ledger-verify-facts.js";
import { runLedger } from "../src/manager/ledger.js";
import { tempLedgerPath } from "./ledger-test-helpers.js";

const HEAD = "a".repeat(40), NEXT = "b".repeat(40), PR = "https://github.com/o/r/pull/401";
const cfg: PeerPrConfig = { project: "p", repoDir: "/repo", fromNumber: 1, pollSec: 60, headSettleSec: 60, maxOpen: 10,
  maxRounds: 3, fixTimeoutH: 24, replyTo: "pm@home", extraSecurityGlobs: [],
  peers: [{ peer: "he", fp: "0a1b-2c3d-4e5f-6a7b", agent: "agent-x", githubLogins: ["he-dev"], authorFamily: "codex" }] };
const config = { enabled: true, autoDispatch: false, pollMs: 1000,
  projects: { p: { repoDir: "/repo", requiredChecks: ["check"], maxActiveWorkers: 1 } } };
const MIN = 60_000;
let db: Database;
let path: string;
const task = () => getTask(db, "PR401")!;
const events = () => listEvents(db, { project: "p", target: "PR401" });
const verifies = () => events().filter((e) => e.kind === "verify");
const attempts = () => events().filter((e) => e.data.op === "peer_pr_verify_attempt");
const bindNotes = () => events().filter((e) => e.data.mechanism === "peerPrVerifyBind");
const todos = () => events().filter((e) => e.data.op === "pm_todo");
const at = { actor: "owner", now: 1000 };

/** The real recovery-policy.json both the tick and the `ledger verify` subprocess path read; rewriting it switches at runtime. */
function policy(bind: RecoveryMode | undefined, auto: RecoveryMode = "on") {
  writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify({ projects: { p: { keys: { peerPrAutoVerify: auto, ...(bind ? { peerPrVerifyBind: bind } : {}) } } } }));
}
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
  path = tempLedgerPath("peer-pr-verify-bind-"); db = openLedger(path);
  setMeta(db, at, { project: "p", key: "pms", value: ["pm"] });
  intakeWrite(db, { actor: "scheduler", now: 100 }, { project: "p", number: 401, url: PR, head: HEAD,
    branch: "fix/x", base: "main", login: "he-dev", title: "peer", surface: "plain", reasons: [], spec: "accepted" }, cfg);
  setWorkflow(db, at, { taskId: "PR401", taskRev: task().rev, workflowRev: 1, template: "security", templateVersion: 2,
    mode: "manual", reason: "pm_takeover: manual deploy", authorFamily: "codex", fallback: "PM deploys" });
  ship();
  writeFileSync(SCHEDULER_CONFIG_PATH, JSON.stringify(config));
  policy("on");
});
afterEach(() => { closeLedger(path); rmSync(SCHEDULER_CONFIG_PATH, { force: true }); rmSync(RECOVERY_POLICY_PATH, { force: true }); });

/** The real CLI and transactional writer; only external repository probes are faked. */
function cli() {
  let now = 10_000, result = "pass", changed: (() => void) | undefined;
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
  const verify = async (...args: string[]) => await runLedger(["verify", "PR401", ...args], { db, actor: "scheduler", projectIds: ["p"],
    factsDeps: () => fd, now: () => now, loadRegistry: async () => ({ socket: "", agents: {} }), saveRegistry: async () => {} });
  return { verify, result: (r: string) => { result = r; }, change: (fn: () => void) => { changed = fn; }, advance: (ms: number) => { now += ms; } };
}

describe("[验收线 1] reproduction: a formal scheduler verify with no key", () => {
  test("pure gate: the baseline lets an absent key through, strict binding refuses it", () => {
    expect(schedulerCanVerify(db, "PR401")).toBe(true); // the audited hole (still the off / observe answer)
    expect(schedulerCanVerify(db, "PR401", undefined, { autoVerifyOn: true })).toBe(false);
    expect(schedulerCanVerify(db, "PR401", peerPrVerifyKey(db, "PR401")!, { autoVerifyOn: true })).toBe(true);
  });
  test("real entry: off records a pass without any key; on refuses with zero writes", async () => {
    const c = cli(), before = events();
    expect(await c.verify("--pass-only")).toMatchObject({ ok: false, code: "forbidden" });
    expect(events()).toEqual(before); expect(task().stage).toBe("live");
    policy("off");
    expect(await c.verify("--pass-only")).toMatchObject({ ok: true, moved: true });
    expect(task().stage).toBe("verified");
  });
});

describe("[验收线 2] on: only the exact current key with every check green moves the card", () => {
  const forged = `peer-pr-verify:${JSON.stringify(["p", "PR401", 1, 1, HEAD])}`;
  test.each([
    ["no key", [] as string[]],
    ["forged key", ["--dedup", forged]],
    ["deploy-shaped key", ["--dedup", "deploy-verify:x"]],
  ])("%s writes no verify", async (_n, args) => {
    const c = cli(), before = events();
    expect(await c.verify(...args, "--pass-only")).toMatchObject({ ok: false, code: "forbidden" });
    expect(events()).toEqual(before);
  });
  test("a stale key from the previous live episode is refused, the current one passes", async () => {
    const c = cli(), old = peerPrVerifyKey(db, "PR401")!; redeliver(HEAD);
    expect(await c.verify("--dedup", old, "--pass-only")).toMatchObject({ ok: false, code: "forbidden" });
    expect(verifies()).toHaveLength(0);
    expect(await c.verify("--dedup", peerPrVerifyKey(db, "PR401")!, "--pass-only")).toMatchObject({ ok: true, moved: true });
    expect(verifies()).toHaveLength(1);
  });
  test.each(["observe", "off"] as const)("peerPrAutoVerify %s refuses even the current key, and stays as configured", async (auto) => {
    policy("on", auto); const c = cli(), before = events();
    expect(await c.verify("--dedup", peerPrVerifyKey(db, "PR401")!, "--pass-only")).toMatchObject({ ok: false, code: "forbidden" });
    expect(events()).toEqual(before);
  });
  test("peerPrAutoVerify switched off while facts are collected: the write transaction refuses", async () => {
    const c = cli(); c.change(() => policy("on", "off"));
    expect(await c.verify("--dedup", peerPrVerifyKey(db, "PR401")!, "--pass-only")).toMatchObject({ ok: false, code: "forbidden" });
    expect(verifies()).toHaveLength(0); expect(task().stage).toBe("live");
  });
  test.each([["head", NEXT], ["live episode", HEAD]])("a new %s after the facts were collected writes nothing", async (_n, head) => {
    const c = cli(); c.change(() => redeliver(head));
    await c.verify("--dedup", peerPrVerifyKey(db, "PR401")!, "--pass-only").catch(() => null);
    expect(verifies()).toHaveLength(0); expect(task().stage).toBe("live");
  });
  test("a red checklist on the current key writes nothing", async () => {
    const c = cli(); c.result("fail");
    expect(await c.verify("--dedup", peerPrVerifyKey(db, "PR401")!, "--pass-only")).toMatchObject({ ok: false, recorded: false });
    expect(verifies()).toHaveLength(0);
  });
  // r1 P1: the exported writer itself enforces the binding; no caller-supplied authorization exists to forget or replace
  const direct = (dedupKey?: string) => recordVerify(db, { actor: "scheduler", now: 10_000, ...(dedupKey ? { dedupKey } : {}) },
    { taskId: "PR401", result: "pass", data: { checks: [{ id: "pr-merged", status: "pass" }] } });
  test("writer boundary must refuse missing dedup when bind is on", () => {
    expect(() => direct()).toThrow(); expect(() => direct("deploy-verify:x")).toThrow();
    expect(verifies()).toHaveLength(0); expect(task().stage).toBe("live");
  });
  test("writer boundary refuses the current key while peerPrAutoVerify is off, and accepts it when on", () => {
    policy("on", "off"); expect(() => direct(peerPrVerifyKey(db, "PR401")!)).toThrow(); expect(verifies()).toHaveLength(0);
    policy("on"); expect(direct(peerPrVerifyKey(db, "PR401")!).row.stage).toBe("verified"); expect(verifies()).toHaveLength(1);
  });
  test.each(["observe", "off"] as const)("writer boundary under %s keeps the baseline answer", (mode) => {
    policy(mode); expect(direct().row.stage).toBe("verified");
    expect(bindNotes()).toHaveLength(mode === "observe" ? 1 : 0); // observe records the refusal it would make, once
  });
});

describe("[验收线 3] dry-run is read-only in every mode", () => {
  test.each(["on", "observe", "off"] as const)("%s: dry-run with and without a key writes nothing", async (mode) => {
    policy(mode); const c = cli(), before = events(), snap = task();
    expect(await c.verify("--dry-run")).toMatchObject({ ok: true, dryRun: true, result: "pass" });
    expect(await c.verify("--dry-run", "--dedup", peerPrVerifyKey(db, "PR401")!)).toMatchObject({ ok: true, dryRun: true });
    expect(events()).toEqual(before); expect(task()).toEqual(snap);
  });
  test("the explicit read-only branch: current lineage on a live card only", () => {
    expect(schedulerCanDryRunVerify(db, "PR401")).toBe(true);
    db.run(`UPDATE tasks SET headSHA='${NEXT}' WHERE id='PR401'`);
    expect(schedulerCanDryRunVerify(db, "PR401")).toBe(false);
  });
});

/** The real claim transaction with a stub verify outcome; the attempt is counted whatever the outcome. */
function ticker(outcome: () => Record<string, unknown>) {
  let now = 1_000_000;
  const calls: string[][] = [];
  const manager = async (...args: string[]) => { calls.push(args); return outcome(); };
  const tick = () => peerPrAutoVerify(db, config, { manager, assertActive: () => {}, now: () => now });
  return { tick, calls, advance: (ms: number) => { now += ms; }, get now() { return now; } };
}
/** Tick every minute for `minutes`. */
async function run(t: ReturnType<typeof ticker>, minutes: number) {
  for (let i = 0; i < minutes; i++) { await t.tick(); t.advance(MIN); }
}

describe("[验收线 3] bounded back-off per binding key", () => {
  test.each([
    ["fail", { ok: false, code: "unverified" }], ["unknown", { ok: false, code: "unverified" }],
    ["forbidden", { ok: false, code: "forbidden", error: "x" }], ["conflict", { ok: false, code: "conflict", error: "x" }],
  ])("%s: 10/20/40/80 minutes, five attempts, one PM todo after 160, then silence", async (_n, out) => {
    const t = ticker(() => out), start = t.now, seen: number[] = [];
    for (let i = 0; i < 600; i++) { const n = t.calls.length; await t.tick(); if (t.calls.length > n) seen.push((t.now - start) / MIN); t.advance(MIN); }
    expect(seen).toEqual([0, 10, 30, 70, 150]);
    expect(attempts()).toHaveLength(MAX_ATTEMPTS);
    expect(todos()).toHaveLength(1);
    expect(todos()[0]!.ts - start).toBe(310 * MIN);
    expect(BACKOFF_MS).toEqual([10, 20, 40, 80, 160].map((m) => m * MIN));
  });
  test("a restart keeps the count: a fresh connection and driver wait out the same back-off", async () => {
    const t = ticker(() => ({ ok: false, code: "unverified" }));
    await run(t, 15); expect(t.calls).toHaveLength(2);
    closeLedger(path); db = openLedger(path);
    const next = ticker(() => ({ ok: false, code: "unverified" })); next.advance(t.now - next.now);
    await run(next, 15); expect(next.calls).toHaveLength(0);
    await run(next, 1); expect(next.calls).toHaveLength(1); expect(attempts()).toHaveLength(3);
  });
  test("overlapping ticks share one attempt", async () => {
    const t = ticker(() => ({ ok: false, code: "unverified" }));
    await Promise.all([t.tick(), t.tick(), t.tick()]);
    expect(t.calls).toHaveLength(1); expect(attempts()).toHaveLength(1);
  });
  test("a new head (new binding key) starts its own count, an exhausted one stays quiet", async () => {
    const t = ticker(() => ({ ok: false, code: "unverified" }));
    await run(t, 320); expect(attempts()).toHaveLength(5); expect(todos()).toHaveLength(1);
    redeliver(); await t.tick();
    expect(t.calls).toHaveLength(6); expect(t.calls.at(-1)).toContain(peerPrVerifyKey(db, "PR401")!);
  });
});

describe("[验收线 4] modes, runtime switch and upstream combinations", () => {
  test("permission key, observe by default", () => {
    expect(RECOVERY_KEYS).toContain("peerPrVerifyBind");
    expect(highRiskRecoveryKey("peerPrVerifyBind")).toBe(true);
    expect(defaultRecoveryMode("peerPrVerifyBind")).toBe("observe");
  });
  test("observe keeps the business result of a keyless verify and records the would-be refusal once", async () => {
    policy("observe"); const c = cli();
    expect(await c.verify("--pass-only")).toMatchObject({ ok: true, moved: true });
    expect(bindNotes()).toHaveLength(1); expect(bindNotes()[0]!.data.why).toBe("no_key");
  });
  test("off behaves as the baseline and records nothing", async () => {
    policy("off"); const c = cli();
    expect(await c.verify("--pass-only")).toMatchObject({ ok: true, moved: true });
    expect(bindNotes()).toHaveLength(0);
  });
  test("observe retries on the old 10-minute rhythm, with bounded would-be back-off notes", async () => {
    policy("observe"); const t = ticker(() => ({ ok: false, code: "unverified" }));
    await run(t, 600);
    expect(t.calls).toHaveLength(60); expect(todos()).toHaveLength(0);
    expect(bindNotes().length).toBeGreaterThan(0); expect(bindNotes().length).toBeLessThanOrEqual(MAX_ATTEMPTS);
  });
  test("off retries on the old rhythm without notes", async () => {
    policy("off"); const t = ticker(() => ({ ok: false, code: "unverified" }));
    await run(t, 100); expect(t.calls).toHaveLength(10); expect(bindNotes()).toHaveLength(0);
  });
  test("switching on → off → on at runtime takes effect on the next tick, with no restart", async () => {
    const t = ticker(() => ({ ok: false, code: "unverified" }));
    await run(t, 15); expect(t.calls).toHaveLength(2); // on: 0 and 10
    policy("off"); await run(t, 10); expect(t.calls).toHaveLength(3); // off: the old 10 minutes after the last attempt
    policy("on"); await run(t, 20); expect(t.calls).toHaveLength(3); // on again: the third attempt waits 40 minutes
  });
  test.each([["off", 0], ["observe", 0]] as const)("peerPrAutoVerify %s: no attempt whatever the bind mode", async (auto) => {
    for (const bind of ["on", "observe", "off"] as const) {
      policy(bind, auto); const t = ticker(() => ({ ok: true })); await run(t, 3);
      expect(t.calls).toHaveLength(0);
    }
    expect(attempts()).toHaveLength(0); expect(bindNotes()).toHaveLength(0);
  });
});

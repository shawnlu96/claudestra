/** Production sink → bridge intake → persistent PM digest, including repository URL boundaries. */
import { afterEach, expect, mock } from "bun:test";
import { isolatedStateSuite } from "./isolated-state.js";

// The production sink reads the default ledger; isolate its cached writer/reader and bridge mock from other suites.
const { test, afterAll } = isolatedStateSuite(import.meta.path);
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const frames: Record<string, unknown>[] = [];
let faking = false;
// mock.module is process-wide under bun's single-process runner: outside this file's tests it delegates to the real bridgeSend.
const real = await import("../src/lib/bridge-client.js");
const realSend = real.bridgeSend;
mock.module("../src/lib/bridge-client.js", () => ({
  ...real,
  bridgeSend: async (msg: Record<string, unknown>, opts?: Parameters<typeof realSend>[1]) => {
    if (!faking) return realSend(msg, opts);
    frames.push(msg);
    if (msg.type === "ci_selected_repair") enqueueSelectedRepair(msg, activeStore!);
    return { ok: true, result: { ok: true } };
  },
}));
const { LEDGER_PATH, openLedger, closeLedger } = await import("../src/lib/ledger-store.js");
afterAll(() => closeLedger(LEDGER_PATH));
const { setMeta } = await import("../src/lib/ledger-write.js");
const { asInfo } = await import("../src/lib/pm-notice-level.js");
const { PmDigestStore } = await import("../src/lib/pm-digest-store.js");
const { enqueueSelectedRepair } = await import("../src/bridge/scheduler-ci-selected-notice.js");
let activeStore: InstanceType<typeof PmDigestStore> | null = null;
const { digestText } = await import("../src/lib/pm-digest.js");
const { bindCiSelectedSink, CI_SELECTED_REPAIR, CI_SELECTED_REPAIR_NOTIFIED, useCiSelectedPorts, withCiSelectedGate } = await import("../src/lib/scheduler-ci-selected-gate.js");
type CiSelectedPort = import("../src/lib/ci-selected-receipt.js").CiSelectedPort;
type MergeExternal = import("../src/lib/scheduler-merge-driver.js").MergeExternal;

const PM = "agent-cisel2-pm", H = "a".repeat(40);
/** a real-length run page of a real-length repository */
let RUN_URL = "https://github.com/shawnlu96/claudestra/actions/runs/18234567890";
const D = (c: string) => `sha256:${c.repeat(64)}`;
let outOfScope = [{ file: "tests/x.test.ts", name: "x > flaky" }];
const port: CiSelectedPort = {
  prRun: async () => ({ id: 18234567890, attempt: 1, headSha: H, event: "pull_request", status: "completed", conclusion: "success", url: RUN_URL }),
  runById: async () => { throw new Error("unused"); },
  verdict: async () => ({ present: true, text: JSON.stringify({ version: 1, kind: "ci-selected-verdict", mode: "on", runId: 18234567890, attempt: 1, head: H,
    responsibilityDigest: D("1"), outOfScope, shards: { "1": D("2") } }) }),
  commitParents: async () => [],
  variable: async () => "on",
};
const ops: MergeExternal = {
  inspect: async () => ({ state: "OPEN", head: H, branch: "task/T1", base: "main", draft: false, crossRepository: false, mergeState: "CLEAN", mergeSha: null,
    checks: [{ name: "typecheck + test + guard", bucket: "pass", link: `${RUN_URL}/job/1` }] }),
  freshness: async () => ({ behindBy: 0, mainHead: H }),
  carryReview: async () => ({ ok: false, reason: "x" }),
  updateBranch: async () => {},
  merge: async () => H,
  ciSelected: true,
};

const dirs: string[] = [];
let open: Disposable | null = null;
afterEach(() => { faking = false; frames.length = 0; open?.[Symbol.dispose](); open = null; for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const cases = [
  { title: "failed confirmation retries after scheduler and bridge restart", project: "cisel2-route-retry", retry: true,
    failures: [{ file: "tests/x.test.ts", name: "x > flaky" }] },
  { title: "failover repository stays non-urgent", project: "cisel2-route-failover",
    url: "https://github.com/org/failover/actions/runs/18234567890", failures: [{ file: "tests/x.test.ts", name: "x" }] },
  { title: "long repository keeps complete URL", project: "cisel2-route-long",
    url: `https://github.com/org/${"a".repeat(100)}/actions/runs/18234567890`, failures: [{ file: "tests/x.test.ts", name: "x" }] },
  { title: "a plain test name", project: "cisel2-route", failures: [{ file: "tests/x.test.ts", name: "x > flaky" }] },
  { title: "a long test name that reads urgent (failed / 失败 / ?)", project: "cisel2-route-urgent", failures: [{
    file: "tests/scheduler-merge-train-bisect-recovery.test.ts",
    name: "merge train bisect > rejects failed requests after the second attempt timed out and the car was sent back for 失败 recheck?" }] },
];
for (const c of cases) test(`[验收线 4] ${c.title}: the repair notice from the bound sink is queued in the PM's digest with its run link, then counted as told`, async () => {
  faking = true;
  RUN_URL = "url" in c ? c.url! : "https://github.com/shawnlu96/claudestra/actions/runs/18234567890";
  outOfScope = c.failures;
  const PROJ = c.project;
  const dir = mkdtempSync(join(tmpdir(), "cisel2-route-"));
  dirs.push(dir);
  activeStore = new PmDigestStore(join(dir, "pm-digest.json"), join(dir, "pm-digest-mode.json"));
  const db = openLedger(LEDGER_PATH); // the sink reads through the production read-only LedgerReader on the same file
  setMeta(db, { actor: "owner" }, { project: PROJ, key: "pms", value: [PM] });
  /** the leased manager's `ledger scheduler-recovery-observe`, written as recordObserved would */
  let failConfirmation = "retry" in c ? 1 : 0;
  const manager = async (...a: string[]) => {
    const flag = (k: string) => a[a.indexOf(k) + 1]!;
    const data: Record<string, unknown> = { ...JSON.parse(flag("--data")) as Record<string, unknown>, op: "recovery_observe", mechanism: flag("--mechanism"), actionKey: flag("--action-key") };
    if (data.kind === CI_SELECTED_REPAIR_NOTIFIED && failConfirmation-- > 0) throw new Error("temporary confirmation failure");
    if (db.query("SELECT 1 FROM events WHERE project=? AND target=? AND json_extract(data,'$.actionKey')=?")
      .get(PROJ, a[2]!, flag("--action-key"))) return { ok: true };
    db.query("INSERT INTO events (ts, actor, project, target, kind, text, data) VALUES (?, 'scheduler', ?, ?, 'note', ?, ?)").run(Date.now(), PROJ, a[2]!, flag("--action"), JSON.stringify(data));
    return { ok: true };
  };
  open = useCiSelectedPorts({ port, policy: () => ({ mode: "on", manualAfterMs: null, source: "config" }) });
  {
    using _sink = bindCiSelectedSink(manager, () => {});
    // the tick's inspect, even inside a routine asInfo context
    await asInfo(() => withCiSelectedGate(ops, { project: PROJ, taskId: "T1", requiredChecks: "typecheck + test + guard" }).inspect("https://github.com/o/r/pull/7"));
    if ("retry" in c) {
      expect(activeStore.queued(PROJ)).toHaveLength(1);
      expect(db.query("SELECT 1 FROM events WHERE project=? AND json_extract(data,'$.kind')=?")
        .get(PROJ, CI_SELECTED_REPAIR_NOTIFIED)).toBeNull();
      // The scheduler loses all memory and the bridge reloads the persisted queue and receipt.
      open![Symbol.dispose]();
      open = useCiSelectedPorts({ port, policy: () => ({ mode: "on", manualAfterMs: null, source: "config" }) });
      activeStore = new PmDigestStore(activeStore.path, activeStore.modePath);
      await withCiSelectedGate(ops, { project: PROJ, taskId: "T1", requiredChecks: "typecheck + test + guard" })
        .inspect("https://github.com/o/r/pull/7");
    }

  }
  expect(frames).toHaveLength("retry" in c ? 2 : 1);
  const frame = frames[0]!;
  expect(frame).toMatchObject({ type: "ci_selected_repair", project: PROJ, runUrl: RUN_URL });
  const queued = activeStore.queued(PROJ);
  expect(queued).toHaveLength(1);
  expect(queued[0]!.detail).toContain(RUN_URL);
  expect(digestText(queued)).toContain(RUN_URL);
  expect(JSON.stringify(frame)).not.toContain(c.failures[0]!.name);
  // Fresh bridge/store instance after consumption: retry cannot requeue within 24 hours.
  activeStore.remove(new Set(queued.map((q) => q.id)), Date.now());
  const restarted = new PmDigestStore(activeStore.path, activeStore.modePath);
  enqueueSelectedRepair(frame, restarted);
  expect(restarted.queued(PROJ)).toEqual([]);

  const kinds = (db.query("SELECT json_extract(data,'$.kind') AS k FROM events WHERE project=? AND kind='note' ORDER BY seq").all(PROJ) as { k: string }[]).map((r) => r.k);
  expect(kinds).toEqual([CI_SELECTED_REPAIR, CI_SELECTED_REPAIR_NOTIFIED]);
  const told = db.query("SELECT data FROM events WHERE project=? AND json_extract(data,'$.kind')=?").get(PROJ, CI_SELECTED_REPAIR_NOTIFIED) as { data: string };
  expect(JSON.parse(told.data)).toMatchObject(c.failures[0]!);
});

/**
 * merge-arch-CISEL2 [验收线 4]: a repair notice reaches the PM's non-urgent digest. The production sink (bindCiSelectedSink →
 * notifyProjectPm) sends a frame; the bridge's own PmDigest (pmRoute / pmDigest on, pull mode) must queue it for `pm-digest --list`,
 * not record it as a card-only info push — even when the merge tick runs under asInfo.
 */
import { afterEach, expect, mock, test } from "bun:test";
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
    return { ok: true, result: { ok: true } };
  },
}));
const { LEDGER_PATH, openLedger } = await import("../src/lib/ledger-store.js");
const { setMeta } = await import("../src/lib/ledger-write.js");
const { asInfo } = await import("../src/lib/pm-notice-level.js");
const { PmDigestStore } = await import("../src/lib/pm-digest-store.js");
const { PmDigest } = await import("../src/bridge/pm-digest.js");
const { bindCiSelectedSink, CI_SELECTED_REPAIR, CI_SELECTED_REPAIR_NOTIFIED, useCiSelectedPorts, withCiSelectedGate } = await import("../src/lib/scheduler-ci-selected-gate.js");
type Envelope = import("../src/bridge/router.js").Envelope;
type LocalEndpoint = import("../src/bridge/router.js").LocalEndpoint;
type CiSelectedPort = import("../src/lib/ci-selected-receipt.js").CiSelectedPort;
type MergeExternal = import("../src/lib/scheduler-merge-driver.js").MergeExternal;

const PROJ = "cisel2-route", PM = "agent-cisel2-pm", H = "a".repeat(40), RUN_URL = "https://github.com/o/r/actions/runs/11";
const D = (c: string) => `sha256:${c.repeat(64)}`;
const verdict = JSON.stringify({ version: 1, kind: "ci-selected-verdict", mode: "on", runId: 11, attempt: 1, head: H, responsibilityDigest: D("1"),
  outOfScope: [{ file: "tests/x.test.ts", name: "x > flaky" }], shards: { "1": D("2") } });
const port: CiSelectedPort = {
  prRun: async () => ({ id: 11, attempt: 1, headSha: H, event: "pull_request", status: "completed", conclusion: "success", url: RUN_URL }),
  runById: async () => { throw new Error("unused"); },
  verdict: async () => ({ present: true, text: verdict }),
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

test("[验收线 4] the repair notice from the bound sink is queued in the PM's digest (not dropped as an info push), then counted as told", async () => {
  faking = true;
  const db = openLedger(LEDGER_PATH); // the sink reads through the production read-only LedgerReader on the same file
  setMeta(db, { actor: "owner" }, { project: PROJ, key: "pms", value: [PM] });
  /** the leased manager's `ledger scheduler-recovery-observe`, written as recordObserved would */
  const manager = async (...a: string[]) => {
    const flag = (k: string) => a[a.indexOf(k) + 1]!;
    const data = { ...JSON.parse(flag("--data")) as Record<string, unknown>, op: "recovery_observe", mechanism: flag("--mechanism"), actionKey: flag("--action-key") };
    db.query("INSERT INTO events (ts, actor, project, target, kind, text, data) VALUES (?, 'scheduler', ?, ?, 'note', ?, ?)").run(Date.now(), PROJ, a[2]!, flag("--action"), JSON.stringify(data));
    return { ok: true };
  };
  open = useCiSelectedPorts({ port, policy: () => ({ mode: "on", manualAfterMs: null, source: "config" }) });
  {
    using _sink = bindCiSelectedSink(manager, () => {});
    // the tick's inspect, even inside a routine asInfo context
    await asInfo(() => withCiSelectedGate(ops, { project: PROJ, taskId: "T1", requiredChecks: "typecheck + test + guard" }).inspect("https://github.com/o/r/pull/7"));
  }
  expect(frames).toHaveLength(1);
  const frame = frames[0] as { targetName: string; text: string; fromName: string; oneShot: boolean; pmLevel?: string };
  expect(frame).toMatchObject({ type: "route_to_agent", targetName: PM, oneShot: true });
  expect(frame.pmLevel).toBeUndefined();
  expect(frame.fromName).not.toBe("scheduler"); // the scheduler's unlevelled notices are delivered at once, not digested

  // the bridge's route_to_agent envelope for that frame, through the bridge's own PM digest (route on, digest on, pull mode)
  const dir = mkdtempSync(join(tmpdir(), "cisel2-route-"));
  dirs.push(dir);
  const store = new PmDigestStore(join(dir, "pm-digest.json"), join(dir, "pm-digest-mode.json"));
  store.setMode(PROJ, "on");
  store.setRouteMode(PROJ, "on");
  store.setPullMode(PROJ, "on");
  const ws = { send: () => {} } as unknown as LocalEndpoint["ws"];
  const to: LocalEndpoint = { kind: "local", agentName: PM, channelId: "ch-pm", ws };
  const env: Envelope = { from: { kind: "local", agentName: frame.fromName, channelId: "", ws }, to, intent: "request", content: frame.text,
    meta: { messageId: "m1", threadId: "t1", ts: "2026-10-15T00:00:00Z", triggerKind: "agent_tool", skipInterAgentWatchdog: true,
      ...(frame.pmLevel ? { pmLevel: frame.pmLevel as "info" } : {}) } };
  const delivered: string[] = [];
  const digest = new PmDigest({ store, now: () => 1, db: () => db, agents: () => [], heldCarriers: () => new Set() });
  const d = await digest.wrap(async (e) => { delivered.push(e.content); return { envelope: e, outcome: { kind: "sent" } }; }, db, PROJ)(env, to);
  expect(d.outcome).toEqual({ kind: "sent", note: "digest" });
  expect(delivered).toEqual([]); // non-urgent: not pushed …
  const queued = store.queued(PROJ);
  expect(queued).toHaveLength(1); // … but in the digest the PM pulls
  expect(queued[0]!.firstLine).toContain("tests/x.test.ts > x > flaky");
  expect(queued[0]!.firstLine).toContain(RUN_URL);

  const kinds = (db.query("SELECT json_extract(data,'$.kind') AS k FROM events WHERE project=? AND kind='note' ORDER BY seq").all(PROJ) as { k: string }[]).map((r) => r.k);
  expect(kinds).toEqual([CI_SELECTED_REPAIR, CI_SELECTED_REPAIR_NOTIFIED]);
});

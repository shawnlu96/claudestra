/**
 * state-protection-F3: a UI card PM accepted (or, for ownerVisual, the owner approved) now starts its merge run through the real
 * merge driver instead of failing beginMergeRun before any GitHub call and holding the project merge slot as unknown. The run's
 * own transaction re-reads uiMergeRefusal: stale / forged / missing approvals still refuse, and an approval that changes before
 * the GitHub merge stops the run. Temp ledger, real ledger CLI in-process, fake GitHub port.
 */
import { describe, expect, test } from "bun:test";
import { bindHash } from "../src/lib/ask-bind.js";
import { answerAsk } from "../src/lib/ledger-asks.js";
import { appendEvent } from "../src/lib/ledger-write.js";
import { parseSchedulerConfig } from "../src/lib/scheduler-config.js";
import type { MergeExternal, PrSnapshot } from "../src/lib/scheduler-merge-driver.js";
import { beginMergeRun, carryReceipt, getMergeRun } from "../src/lib/scheduler-merge.js";
import { schedulerMergeTick } from "../src/lib/scheduler-service.js";
import { UI_APPROVED, UI_REJECTED } from "../src/lib/ledger-ui-approve-verdict.js";
import { autoFixture, DIGEST, H2, toBuild } from "./scheduler-auto-helpers.js";

type F = ReturnType<typeof autoFixture>;
const PR = "https://github.com/example/repo/pull/9", BRANCH = "task/T1", M = "9".repeat(40), H3 = "3".repeat(40);
const config = parseSchedulerConfig({ enabled: true, projects: { p: { maxActiveWorkers: 2, requiredChecks: ["ci"], repoDir: "/tmp/p" } } });

/** A UI card whose review on H2 passed and whose screenshots are in front of PM (default) or the owner (ownerVisual). */
async function shown(ownerVisual = false): Promise<F> {
  const f = autoFixture({ template: "ui", ownerVisual });
  f.advance(Date.now()); // the service's own drift read uses the wall clock; keep the fixture's asks on it
  await toBuild(f);
  await f.tick();
  await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H2);
  await f.tick();
  await f.tick();
  await f.review("pass", H2, []);
  expect(await f.tick()).toMatchObject({ step: "ask" });
  return f;
}

/** review → merge, then the merge intent with its project slot; the PR the merge driver will look at. */
async function planned(f: F): Promise<string> {
  expect(await f.tick()).toMatchObject({ step: "stage", detail: "review→merge" });
  expect(await f.tick()).toMatchObject({ step: "merge_queue" });
  const { id } = f.db.query("SELECT id FROM scheduler_intents WHERE action = 'merge' AND status = 'pending'").get() as { id: string };
  expect(f.db.query("SELECT resource FROM scheduler_resources WHERE intentId = ?").all(id)).toContainEqual({ resource: "merge:p" });
  f.db.query("UPDATE tasks SET pr = ?, branch = ? WHERE id = 'T1'").run(PR, BRANCH); // what the author's PR deliver records
  return id;
}

function github(head = H2) {
  const calls: string[] = [];
  let snap: PrSnapshot = { state: "OPEN", head, branch: BRANCH, base: "main", draft: false, crossRepository: false,
    mergeState: "CLEAN", mergeSha: null, checks: [{ name: "ci", bucket: "pass" }] };
  const external: MergeExternal = {
    inspect: async () => { calls.push("inspect"); return snap; },
    freshness: async () => ({ behindBy: 0, mainHead: "e".repeat(40) }),
    carryReview: async () => ({ ok: false, reason: "不沿用" }),
    updateBranch: async () => { throw new Error("clean PR must not be updated"); },
    merge: async () => { calls.push("merge"); snap = { ...snap, state: "MERGED", mergeSha: M }; return M; },
  };
  return { calls, external, setHead: (h: string) => { snap = { ...snap, head: h }; } };
}

const scheduler = (f: F) => (...args: string[]) => f.cli("scheduler", ...args.slice(1)) as Promise<Record<string, unknown>>;
const mergeTick = (f: F, external: MergeExternal) => schedulerMergeTick(f.db, config, scheduler(f), () => external);
const intent = (f: F, id: string) => f.db.query("SELECT status, receipt FROM scheduler_intents WHERE id = ?").get(id) as { status: string; receipt: string | null };
const begin = (f: F, id: string) => f.cli("scheduler", "scheduler-merge-begin", id, "--required-checks", "ci");
const pmApprove = (f: F) => f.cli("pm", "ui-approve", "T1", "--head", H2, "--digest", DIGEST);
const ownerAsk = (f: F) => (f.db.query("SELECT id FROM asks WHERE kind = 'authorize' ORDER BY createdAt DESC LIMIT 1").get() as { id: string }).id;
const answer = (f: F, id: string, opts: { owner?: boolean; button?: string } = {}) => answerAsk(f.db, id, {
  choices: [`[button:${opts.button ?? "scheduler_ui_approve"}]`], labels: ["批准合并"], principal: opts.owner === false ? "agent-pm" : "owner",
  via: "web_card", at: f.at("owner").now, ...(opts.owner === false ? {} : { owner: true as const }) } as never);

async function drive(f: F, external: MergeExternal, id: string): Promise<void> {
  for (let i = 0; i < 4 && getMergeRun(f.db, id)?.phase !== "merged"; i++) expect(await mergeTick(f, external)).toBe(1);
}

describe("default UI card: PM's bound screenshot acceptance releases the automatic merge", () => {
  test("ui-approve via the ledger CLI → merge intent → real merge driver starts the run and merges (was: preflight refused, unknown)", async () => {
    const f = await shown();
    try {
      expect(await pmApprove(f)).toMatchObject({ ok: true });
      const id = await planned(f);
      const gh = github();
      await drive(f, gh.external, id);
      expect(intent(f, id).receipt ?? "").not.toContain("合并预检失败");
      expect(getMergeRun(f.db, id)).toMatchObject({ phase: "merged", mergeSha: M, reviewedHead: H2 });
      expect(gh.calls).toContain("merge");
      expect(intent(f, id).status).toBe("done");
    } finally { f.close(); }
  });

  test("the run's transaction re-reads the gate: changed digest, stale round, raised ownerVisual and a worker-forged approval all refuse", async () => {
    const f = await shown();
    try {
      expect(await pmApprove(f)).toMatchObject({ ok: true });
      const id = await planned(f);
      expect(await scheduler(f)("ledger", "scheduler-settle", id, "--from", "pending", "--to", "submitted", "--receipt", "claimed")).toMatchObject({ ok: true });
      const t = f.task(), extra = JSON.stringify(t.extra);
      const D2 = "e".repeat(64);
      // New screenshots after acceptance (no rev bump, so only the UI gate differs from the plan); a worker then forges PM's approval.
      f.db.query("UPDATE tasks SET extra = ? WHERE id = 'T1'").run(JSON.stringify({ ...t.extra, screenshotsDigest: D2 }));
      expect(await begin(f, id)).toMatchObject({ ok: false, code: "conflict", error: expect.stringContaining("PM 截图验收") });
      appendEvent(f.db, f.at("agent-task-one"), { project: "p", target: "T1", kind: "decision",
        data: { op: UI_APPROVED, head: H2, specRev: 1, round: t.round, screenshotsDigest: D2 } });
      expect(await begin(f, id)).toMatchObject({ ok: false, code: "conflict", error: expect.stringContaining("PM 截图验收") });
      f.db.query("UPDATE tasks SET extra = ? WHERE id = 'T1'").run(extra);
      // Stale round: the acceptance was for another round.
      f.db.query("UPDATE tasks SET round = ? WHERE id = 'T1'").run(t.round + 1);
      expect(await begin(f, id)).toMatchObject({ ok: false, code: "conflict" });
      f.db.query("UPDATE tasks SET round = ? WHERE id = 'T1'").run(t.round);
      // The executor may raise ownerVisual: PM's word no longer counts.
      f.db.query("INSERT INTO events (ts, actor, project, target, kind, text, data) VALUES (?, 'agent-task-one', 'p', 'T1', 'task', 'set', ?)")
        .run(f.at("x").now, JSON.stringify({ op: "set", patch: { extra: { ownerVisual: true } } }));
      expect(await begin(f, id)).toMatchObject({ ok: false, code: "conflict", error: expect.stringContaining("owner") });
      expect(getMergeRun(f.db, id)).toBeNull();
    } finally { f.close(); }
  });

  test("a later bound PM rejection replaces the acceptance before the run starts", async () => {
    const f = await shown();
    try {
      expect(await pmApprove(f)).toMatchObject({ ok: true });
      const id = await planned(f);
      expect(await scheduler(f)("ledger", "scheduler-settle", id, "--from", "pending", "--to", "submitted", "--receipt", "claimed")).toMatchObject({ ok: true });
      appendEvent(f.db, f.at("pm"), { project: "p", target: "T1", kind: "decision",
        data: { op: UI_REJECTED, head: H2, specRev: 1, round: f.task().round, screenshotsDigest: DIGEST, note: "颜色不对" } });
      expect(await begin(f, id)).toMatchObject({ ok: false, code: "conflict", error: expect.stringContaining("PM 截图验收") });
      expect(getMergeRun(f.db, id)).toBeNull();
    } finally { f.close(); }
  });

  test("approval changed after the run started: the driver stops before GitHub's merge, never records it as merged", async () => {
    const f = await shown();
    try {
      expect(await pmApprove(f)).toMatchObject({ ok: true });
      const id = await planned(f);
      const gh = github();
      gh.external.freshness = async () => { // the screenshots are replaced while the driver is between reads
        f.db.query("UPDATE tasks SET extra = ? WHERE id = 'T1'").run(JSON.stringify({ ...f.task().extra, screenshotsDigest: "e".repeat(64) }));
        return { behindBy: 0, mainHead: "e".repeat(40) };
      };
      for (let i = 0; i < 4; i++) await mergeTick(f, gh.external).catch(() => 0);
      expect(gh.calls).not.toContain("merge");
      expect(getMergeRun(f.db, id)?.phase).not.toBe("merged");
      expect(getMergeRun(f.db, id)).toMatchObject({ phase: "unknown", mergeSha: null, reason: expect.stringContaining("UI 截图验收已失效") });
    } finally { f.close(); }
  });

  test("a new head does not inherit the old acceptance", async () => {
    const f = await shown();
    try {
      expect(await pmApprove(f)).toMatchObject({ ok: true });
      const id = await planned(f);
      expect(await scheduler(f)("ledger", "scheduler-settle", id, "--from", "pending", "--to", "submitted", "--receipt", "claimed")).toMatchObject({ ok: true });
      expect(await begin(f, id)).toMatchObject({ ok: true, run: { phase: "ready" } });
      // update-branch carries the review to H3 (the scheduler's own carry write): the run and the card move, PM's acceptance stays on H2.
      const step = (...a: string[]) => f.cli("scheduler", "scheduler-merge-step", id, ...a);
      expect(await step("--from", "ready", "--to", "updating", "--rev", "1")).toMatchObject({ ok: true });
      const receipt = carryReceipt({ oldHead: H2, newHead: H3, mainParent: "e".repeat(40), mainHead: "e".repeat(40), diffHash: "f".repeat(64) });
      expect(await step("--from", "updating", "--to", "await_ci", "--rev", "2", "--new-head", H3, "--receipt", receipt)).toMatchObject({ ok: true });
      expect(f.task().headSHA).toBe(H3);
      const gh = github(H3);
      await mergeTick(f, gh.external).catch(() => 0);
      expect(gh.calls).not.toContain("merge");
      expect(getMergeRun(f.db, id)).toMatchObject({ phase: "unknown", reason: expect.stringContaining("UI 截图验收已失效") });
    } finally { f.close(); }
  });
});

describe("ownerVisual card: still the owner's authenticated answer", () => {
  test("PM's acceptance is not enough; unanswered / non-owner / wrong button / expired / cancelled / deleted / misbound asks refuse", async () => {
    const f = await shown(true);
    try {
      const askId = ownerAsk(f);
      expect(await pmApprove(f)).toMatchObject({ ok: false, code: "conflict" });
      appendEvent(f.db, f.at("pm"), { project: "p", target: "T1", kind: "decision",
        data: { op: UI_APPROVED, head: H2, specRev: 1, round: f.task().round, screenshotsDigest: DIGEST } });
      expect(await f.tick()).toMatchObject({ step: "waiting" });
      expect(f.task().stage).toBe("review");
      answer(f, askId);
      const id = await planned(f);
      expect(await scheduler(f)("ledger", "scheduler-settle", id, "--from", "pending", "--to", "submitted", "--receipt", "claimed")).toMatchObject({ ok: true });
      // Each refusal is the same answered ask turned into one bad shape, inside the run's own transaction.
      const row = f.db.query("SELECT state, answer, expiresAt, fromAgent, bind FROM asks WHERE id = ?").get(askId) as Record<string, unknown>;
      const restore = () => f.db.query("UPDATE asks SET state = ?, answer = ?, expiresAt = ?, fromAgent = ?, bind = ? WHERE id = ?")
        .run(row.state as string, row.answer as string, row.expiresAt as number, row.fromAgent as string, row.bind as string, askId);
      const ans = JSON.parse(row.answer as string) as Record<string, unknown>;
      const { paramsHash: _h, ...bind } = JSON.parse(row.bind as string) as { action: string; params: Record<string, unknown>; approve: string[]; paramsHash: string };
      const rebound = (params: Record<string, unknown>) => ({ ...bind, params, paramsHash: bindHash({ ...bind, params }, "scheduler") });
      const twists: [string, string, unknown][] = [
        ["unanswered", "state", "open"], ["cancelled", "state", "cancelled"], ["expired", "expiresAt", 1],
        ["non-owner answer", "answer", JSON.stringify({ ...ans, owner: undefined, principal: "agent-pm" })],
        ["wrong button", "answer", JSON.stringify({ ...ans, choices: ["[button:scheduler_ui_reject]"] })],
        ["not the scheduler's ask", "fromAgent", "pm"],
        ["bound to another head", "bind", JSON.stringify(rebound({ ...bind.params, head: H3 }))],
        ["bound to another digest", "bind", JSON.stringify(rebound({ ...bind.params, screenshotsDigest: "e".repeat(64) }))],
        ["bound to another specRev", "bind", JSON.stringify(rebound({ ...bind.params, specRev: 2 }))],
      ];
      for (const [label, col, value] of twists) {
        f.db.query(`UPDATE asks SET ${col} = ? WHERE id = ?`).run(value as string, askId);
        expect({ label, r: await begin(f, id) }).toMatchObject({ label, r: { ok: false, code: "conflict", error: expect.stringContaining("owner") } });
        restore();
      }
      f.db.query("DELETE FROM asks WHERE id = ?").run(askId);
      expect(await begin(f, id)).toMatchObject({ ok: false, code: "conflict" });
      expect(getMergeRun(f.db, id)).toBeNull();
    } finally { f.close(); }
  });

  test("the owner's authenticated approval of the scheduler's ask merges through the real driver", async () => {
    const f = await shown(true);
    try {
      answer(f, ownerAsk(f));
      const id = await planned(f);
      const gh = github();
      await drive(f, gh.external, id);
      expect(getMergeRun(f.db, id)).toMatchObject({ phase: "merged", mergeSha: M });
      expect(gh.calls).toContain("merge");
    } finally { f.close(); }
  });

  test("an owner answer without the authenticated owner mark never reaches a merge intent", async () => {
    const f = await shown(true);
    try {
      answer(f, ownerAsk(f), { owner: false });
      expect(await f.tick()).not.toMatchObject({ step: "stage", detail: "review→merge" });
      expect(f.task().stage).toBe("review");
    } finally { f.close(); }
  });
});

test("direct beginMergeRun under a manager is refused the same way for an unapproved UI card", async () => {
  const f = await shown();
  try {
    expect(await pmApprove(f)).toMatchObject({ ok: true });
    const id = await planned(f);
    expect(await scheduler(f)("ledger", "scheduler-settle", id, "--from", "pending", "--to", "submitted", "--receipt", "claimed")).toMatchObject({ ok: true });
    f.db.query("UPDATE tasks SET extra = ? WHERE id = 'T1'").run(JSON.stringify({ ...f.task().extra, screenshotsDigest: "e".repeat(64) }));
    expect(() => beginMergeRun(f.db, f.at("pm"), id, ["ci"])).toThrow(/PM 截图验收/);
  } finally { f.close(); }
});

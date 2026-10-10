/**
 * UPDW lender update gap (src/lib/lend-update-gap.ts) on a real temporary journal file, driven through the real lend tick
 * (tests/lend-harness.ts fakes A and the workers): observe / off have zero effect, on drains without killing, a late claim and
 * a pushed order wait, a pending result keeps the gap open, update success / verified failure / interruption / restart, and
 * the gap never clears a quota pause or a revocation.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { admitOrders } from "../src/lib/lend-inbox.js";
import { claimProblem } from "../src/lib/lend-drive.js";
import { pausedUntil, pauseForQuota } from "../src/lib/lend-health.js";
import { advance, getMeta, getOrder, openLendJournal, recordAsked } from "../src/lib/lend-journal.js";
import {
  COOLDOWN_MS, GAP_KEY, gapHolds, launcherBeginUpdate, launcherGapStep, launcherUpdateExited, READY_MAX_MS, readGap, SETTLE_MS,
  type GapMode, type GapPort, type UpdateState, type UpdateTarget,
} from "../src/lib/lend-update-gap.js";
import { ENTRY, harness, polled, sha, toStarted } from "./lend-harness.js";

const T: UpdateTarget = { channel: "release", ref: "9.9.9", label: "v9.9.9" };

/** The harness on a real journal file; port knobs are mutable from the test. */
function gapHarness(mode: GapMode = "on") {
  const h = harness();
  const path = join(mkdtempSync(join(tmpdir(), "lend-gap-")), "journal.sqlite");
  const db = openLendJournal(path);
  h.d.db = db;
  const knobs = { mode, reached: false as boolean | null, state: { kind: "none" } as UpdateState };
  const port: GapPort = { policy: async () => ({ mode: knobs.mode }), reached: async () => knobs.reached, updateState: async () => knobs.state };
  h.d.updateGap = port;
  return Object.assign(h, { db, path, knobs, port, want: (busy = ["agent-lend-o1"]) => launcherGapStep(db, T, busy, h.d.now()) });
}

const finish = (h: ReturnType<typeof gapHarness>, id = "o1") => {
  const body = { v: 1, orderId: id, gen: 1, verdict: { v: 1 }, report: "r", session: { id: "thr-1", family: "codex" } };
  advance(h.db, id, "started", "result_pending", { payload: body, payloadSha: sha(JSON.stringify(body)) });
};
const polls = (h: ReturnType<typeof gapHarness>) => h.calls.filter((c) => c.op === "poll").length;
const push = (h: ReturnType<typeof gapHarness>, id: string) => admitOrders(h.d, { peer: "team-a", fp: ENTRY.fp! }, [polled(id)], "push");

describe("observe / off: zero effect on intake", () => {
  for (const mode of ["observe", "off"] as const) {
    test(`${mode}: no gap row, pushes admitted, claims and polls continue; observe records the plan once`, async () => {
      const h = gapHarness(mode);
      await toStarted(h);
      h.want();
      await h.tick();
      expect(readGap(h.db)).toBeNull();
      expect((await push(h, "o2")).accepted).toEqual(["o2"]);
      h.advanceTime(31_000);
      const before = polls(h);
      await h.tick();
      expect(polls(h)).toBe(before + 1);
      expect(getOrder(h.db, "o2")!.state).not.toBe("asked"); // claimed as usual
      const lines = h.log.lines.filter((l) => l.includes("observe"));
      expect(lines.length).toBe(mode === "observe" ? 1 : 0);
      expect(!!getMeta(h.db, "updateGap:observed")).toBe(mode === "observe");
      expect(h.log.killed).toEqual([]);
    });
  }
});

describe("on: drain, then update", () => {
  test("opens only with a fresh want and a live order; holds push, poll and late claim; never kills", async () => {
    const h = gapHarness();
    await h.tick(); // no want, no orders: nothing
    expect(readGap(h.db)).toBeNull();
    await toStarted(h);
    await h.tick();
    expect(readGap(h.db)).toBeNull(); // live order but the launcher has not asked
    expect(h.want()).toEqual({ go: false, why: "在忙: agent-lend-o1" });
    recordAsked(h.db, { orderId: "late", peer: "team-a", fp: ENTRY.fp!, family: "codex", preview: polled("late") }, h.d.now());
    await h.tick();
    expect(readGap(h.db)).toMatchObject({ phase: "draining", target: T });
    expect(JSON.parse(getMeta(h.db, "status")!).updateGap).toContain("暂停接新单");
    expect((await push(h, "o2")).refused).toEqual([{ orderId: "o2", code: "paused" }]);
    expect(claimProblem(getOrder(h.db, "late")!, ENTRY, h.db, h.d.now())).toBe("wait");
    h.advanceTime(31_000);
    const before = polls(h);
    await h.tick();
    expect(polls(h)).toBe(before);
    expect(getOrder(h.db, "late")!.state).toBe("asked");
    expect(h.calls.some((c) => c.op === "claim" && c.body.orderId === "late")).toBe(false);
    expect(getOrder(h.db, "o1")!.state).toBe("started");
    expect(h.log.killed).toEqual([]);
    expect(h.want().go).toBe(false); // draining
  });

  test("a pending result keeps the gap draining until it is acked and settled; then ready → updating → reached", async () => {
    const h = gapHarness();
    await toStarted(h);
    h.want();
    await h.tick();
    finish(h);
    const real = h.A.result;
    h.A.result = () => "throw"; // result hand-over still owed
    await h.tick();
    expect(getOrder(h.db, "o1")!.state).toBe("result_pending");
    expect(readGap(h.db)!.phase).toBe("draining");
    h.A.result = real;
    await h.tick();
    expect(getOrder(h.db, "o1")!.state).toBe("acked");
    await h.tick();
    expect(readGap(h.db)!.phase).toBe("ready");
    expect(h.want(["someone-else"])).toEqual({ go: false, why: "出借空档已排空，但在忙: someone-else" });
    expect(h.want([])).toEqual({ go: true });
    expect(launcherBeginUpdate(h.db, T, h.d.now())).toEqual({ go: true, flipped: true });
    expect(readGap(h.db)!.phase).toBe("updating");
    expect(h.want([]).go).toBe(false); // never a second update
    h.knobs.state = { kind: "running" };
    await h.tick();
    expect(gapHolds(h.db)).toBe(true);
    h.knobs.reached = true; // checked out, tail still running
    await h.tick();
    expect(gapHolds(h.db)).toBe(true);
    h.knobs.state = { kind: "none" }; // marker cleared after the full reload
    await h.tick();
    expect(readGap(h.db)).toBeNull();
    expect((await push(h, "o9")).accepted).toEqual(["o9"]);
  });
});

/** Gap already in updating (drained, launcher flipped it). */
async function updating(h: ReturnType<typeof gapHarness>) {
  await toStarted(h);
  h.want();
  await h.tick();
  advance(h.db, "o1", "started", "stopped", { reason: "test" });
  await h.tick();
  expect(readGap(h.db)!.phase).toBe("ready");
  expect(launcherBeginUpdate(h.db, T, h.d.now())).toEqual({ go: true, flipped: true });
}

describe("issued update: verified outcomes only", () => {
  test("failure: the update exited while the launcher lived and the target was not reached → resume", async () => {
    const h = gapHarness();
    await updating(h);
    await h.tick();
    expect(gapHolds(h.db)).toBe(true);
    launcherUpdateExited(h.db, T.ref, 1, h.d.now());
    await h.tick();
    expect(readGap(h.db)).toBeNull();
    expect(h.log.lines.some((l) => l.includes("已验证失败"))).toBe(true);
  });

  test("interrupted: no exit record, update gone — held until SETTLE_MS, then resume; a live update is never judged", async () => {
    const h = gapHarness();
    await updating(h);
    h.advanceTime(SETTLE_MS - 1);
    await h.tick();
    expect(gapHolds(h.db)).toBe(true);
    h.knobs.state = { kind: "running" };
    h.advanceTime(SETTLE_MS);
    await h.tick();
    expect(gapHolds(h.db)).toBe(true);
    h.knobs.state = { kind: "none" };
    await h.tick();
    expect(readGap(h.db)).toBeNull();
  });

  test("off after the update was issued does not fake-withdraw it; off while draining withdraws honestly", async () => {
    const h = gapHarness();
    await updating(h);
    h.knobs.mode = "off";
    await h.tick();
    expect(readGap(h.db)!.phase).toBe("updating");
    const g = gapHarness();
    await toStarted(g);
    g.want();
    await g.tick();
    g.knobs.mode = "off";
    await g.tick();
    expect(readGap(g.db)).toBeNull();
    g.want();
    await g.tick();
    expect(readGap(g.db)).toBeNull(); // off starts no new gap
  });

  test("checked out is not done: a running, unfinished, abandoned or unreadable update keeps intake held whatever HEAD says", async () => {
    const h = gapHarness();
    await updating(h);
    h.knobs.reached = true;
    launcherUpdateExited(h.db, T.ref, 1, h.d.now());
    const states: [UpdateState, string][] = [
      [{ kind: "running" }, "进行中"],
      [{ kind: "unfinished", step: "built" }, "停在「built」没做完"],
      [{ kind: "abandoned", why: "HEAD 被改到别处" }, "补完被放弃"],
      [{ kind: "unknown", why: "m.json 读不了" }, "标记核不了"],
    ];
    for (const [state, says] of states) {
      h.knobs.state = state;
      h.advanceTime(SETTLE_MS);
      expect((await h.tick(), readGap(h.db))!.phase).toBe("updating");
      expect((await push(h, `p-${state.kind}`)).accepted).toEqual([]);
      expect(h.log.lines.some((l) => l.includes("恢复接单"))).toBe(false);
      const line = (JSON.parse(getMeta(h.db, "status")!) as { updateGap?: string }).updateGap ?? "";
      expect([says, line.includes(says), line.includes("卡住") === (state.kind !== "running")]).toEqual([says, true, true]);
    }
    h.knobs.state = { kind: "none" };
    await h.tick();
    expect(readGap(h.db)).toBeNull();
    expect(h.log.lines.some((l) => l.includes("更新尾段已做完"))).toBe(true);
  });

  test("an unreadable version is never a resume: exited and past SETTLE_MS still held, closed once a verified answer arrives", async () => {
    const h = gapHarness();
    await updating(h);
    h.knobs.reached = null;
    launcherUpdateExited(h.db, T.ref, 1, h.d.now());
    for (let i = 0; i < 3; i++) {
      h.advanceTime(SETTLE_MS);
      await h.tick();
      expect(readGap(h.db)!.phase).toBe("updating");
    }
    expect(h.log.lines.some((l) => l.includes("恢复接单"))).toBe(false);
    h.knobs.reached = false; // git readable again: still on the old version, nothing owed → verified failure
    await h.tick();
    expect(readGap(h.db)).toBeNull();
    expect(h.log.lines.some((l) => l.includes("已验证失败"))).toBe(true);
  });

  test("draining, already at the target (manual update) but its tail still running: not closed until it is done", async () => {
    const h = gapHarness();
    await toStarted(h);
    h.want();
    await h.tick();
    h.knobs.reached = true;
    h.knobs.state = { kind: "unfinished", step: "installed" };
    await h.tick();
    expect(readGap(h.db)!.phase).toBe("draining");
    h.knobs.state = { kind: "none" };
    await h.tick();
    expect(readGap(h.db)).toBeNull();
  });

  test("restart: the gap survives reopening the journal (a new scheduler process) and resolves from there", async () => {
    const h = gapHarness();
    await updating(h);
    h.db.close();
    const db = openLendJournal(h.path);
    h.d.db = db;
    expect(readGap(db)!.phase).toBe("updating");
    h.knobs.reached = true;
    await h.tick();
    expect(readGap(db)).toBeNull();
  });
});

describe("independence and bounds", () => {
  test("closing the gap leaves a Codex quota pause and a revocation in force", async () => {
    const h = gapHarness();
    await toStarted(h);
    h.want();
    await h.tick();
    pauseForQuota(h.db, "o1", null, h.d.now(), h.d.log);
    h.lend.lend = []; // revoked
    h.knobs.reached = true;
    await h.tick();
    expect(readGap(h.db)).toBeNull();
    expect(pausedUntil(h.db, h.d.now())).not.toBeNull();
    expect((await push(h, "o2")).refused[0]!.code).toBe("no_grant");
  });

  test("a ready gap the launcher never acts on is withdrawn after READY_MAX_MS, then cools down for that target", async () => {
    const h = gapHarness();
    await toStarted(h);
    h.want(["busy-agent"]);
    await h.tick();
    advance(h.db, "o1", "started", "stopped", { reason: "test" });
    await h.tick();
    expect(readGap(h.db)!.phase).toBe("ready");
    h.advanceTime(READY_MAX_MS);
    h.want(["busy-agent"]);
    await h.tick();
    expect(readGap(h.db)).toBeNull();
    expect(h.log.lines.some((l) => l.includes("busy-agent"))).toBe(true);
    recordAsked(h.db, { orderId: "o5", peer: "team-a", fp: ENTRY.fp!, family: "codex", preview: polled("o5") }, h.d.now());
    await h.tick(); // o5 claimed → live again
    h.want(["busy-agent"]);
    await h.tick();
    expect(readGap(h.db)).toBeNull();
    h.advanceTime(COOLDOWN_MS);
    h.want(["busy-agent"]);
    await h.tick();
    expect(readGap(h.db)?.phase).toBe("draining");
  });

  test("a stale want (launcher stopped asking) withdraws a draining gap", async () => {
    const h = gapHarness();
    await toStarted(h);
    h.want();
    await h.tick();
    h.advanceTime(2 * 3600_000);
    await h.tick();
    expect(readGap(h.db)).toBeNull();
    expect(getMeta(h.db, GAP_KEY)).toBe("");
  });

  test("without a port the tick opens nothing (old wiring = old behaviour)", async () => {
    const h = gapHarness();
    delete h.d.updateGap;
    await toStarted(h);
    h.want();
    await h.tick();
    expect(readGap(h.db)).toBeNull();
  });
});

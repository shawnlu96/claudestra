/**
 * RRL-3 r4 (bounce-second-read-stale): every successful `gh pr ready --undo` is followed by a fresh `gh pr view` inside ghPrState,
 * so no caller acts on the view from before the undo. Cells: {not handed over, handed over} × {the pass's first read undoes, the
 * undo's own read in backToDraft undoes}; a PR closed or moved between gh's view and the undo is never bounced on the old head.
 * Not handed over, the first read follows no head and never undoes (pinned below), so that cell's undo is always the second read's.
 */
import { describe, expect, test } from "bun:test";
import { listEvents } from "../src/lib/ledger-store.js";
import type { runBounded } from "../src/lib/run-bounded.js";
import { ghPrState, HANDOFF_POLL_MS } from "../src/lib/scheduler-merge-handoff-tick.js";
import { autoFixture, H1, H2 } from "./scheduler-auto-helpers.js";
import { book, type F, ghStub, PR, toMerge } from "./helpers/remote-review-draft-fixture.js";

const H3 = "3".repeat(40);
type G = ReturnType<typeof ghStub>;
const bounced = (f: F) => listEvents(f.db, { project: "p", target: "T1" }).some((e) => e.data.op === "remote_bounce");

/**
 * Each cell brings the card to the pass that undoes; `road` = where a closed / moved PR goes. `thisPass`: the undo was the pass's
 * first read, whose fresh view the pass itself acts on (to PM at once); otherwise the undo's own read holds and the next pass goes.
 */
const cells: { name: string; setup(f: F, g: G): Promise<void>; road: { closed: string; moved: string }; thisPass?: true }[] = [
  { name: "not handed over × the undo's own read", road: { closed: "不交接", moved: "不交接" },
    async setup(f, g) {
      g.s.view = { ...g.s.view, isDraft: false }; // PM made it ready by hand
      book(f, H1);
    } },
  { name: "handed over × the pass's first read", road: { closed: "被关闭", moved: "交接后 PR head 变了" }, thisPass: true,
    async setup(f, g) {
      expect(await g.tick()).toMatchObject({ step: "handoff" });
      book(f, H1);
    } },
  { name: "handed over × the undo's own read (after a carried main merge)", road: { closed: "被关闭", moved: "交接后 PR head 变了" },
    async setup(f, g) {
      expect(await g.tick()).toMatchObject({ step: "handoff" });
      g.s.view = { ...g.s.view, headRefOid: H2 }; // the owner merged main in, still ready
      book(f, H2);
      f.advance(HANDOFF_POLL_MS); // nothing pending on H1 yet: the carry is found at the next poll
    } },
];

describe("bounce-second-read-stale: a fresh view after every undo", () => {
  for (const cell of cells) {
    for (const [why, onUndo] of [["closed", { state: "CLOSED" }], ["moved", { headRefOid: H3 }]] as const) {
      test(`${cell.name}: the PR is ${why} by the time the undo succeeds → no bounce, the PR taken as it now is`, async () => {
        const f = autoFixture(), g = ghStub(f);
        try {
          await toMerge(f);
          await cell.setup(f, g);
          g.s.onUndo = onUndo;
          g.s.calls.length = 0;
          const road = { step: "manual", detail: expect.stringContaining(cell.road[why]) };
          expect(await g.tick()).toMatchObject(cell.thisPass ? road : { step: "held", detail: expect.stringContaining("PR 变了") });
          expect(g.s.calls.filter((c) => c === "undo")).toHaveLength(1);
          expect(g.s.calls[g.s.calls.indexOf("undo") + 1]).toBe("view"); // the undo is followed by a fresh view
          expect(f.task().stage).toBe("merge");
          expect(bounced(f)).toBe(false);
          if (!cell.thisPass) expect(await g.tick()).toMatchObject(road);
          expect(bounced(f)).toBe(false);
        } finally { f.close(); }
      });
    }
    test(`${cell.name}: still OPEN at the P1's head after the undo → back to fix as before, the PR a draft`, async () => {
      const f = autoFixture(), g = ghStub(f);
      try {
        await toMerge(f);
        await cell.setup(f, g);
        g.s.calls.length = 0;
        expect(await g.tick()).toMatchObject({ step: "remote_bounce" });
        expect(f.task().stage).toBe("fix");
        expect(g.s.view.isDraft).toBe(true);
        expect(g.s.calls.filter((c) => c === "undo")).toHaveLength(1);
      } finally { f.close(); }
    });
  }

  test("not handed over, the first read never undoes: view, then the undo's own read (view, undo, fresh view)", async () => {
    const f = autoFixture(), g = ghStub(f);
    try {
      await toMerge(f);
      await cells[0]!.setup(f, g);
      g.s.calls.length = 0;
      expect(await g.tick()).toMatchObject({ step: "remote_bounce" });
      expect(g.s.calls).toEqual(["view", "view", "undo", "view"]);
    } finally { f.close(); }
  });

  test("ghPrState: a successful undo returns the fresh view's state and head (flipped), a refused one no second view", async () => {
    const calls: string[] = [];
    let view: Record<string, unknown> = { state: "OPEN", headRefOid: H1, mergeCommit: null, baseRefName: "main", isDraft: false }, code = 0;
    const command = (async (argv: string[]) => {
      calls.push(argv[2]!);
      if (argv[2] === "ready" && code === 0) view = { ...view, state: "CLOSED", isDraft: true };
      return argv[2] === "ready" ? { code, stdout: "", stderr: code ? "HTTP 502" : "", timedOut: false }
        : { code: 0, stdout: JSON.stringify(view), stderr: "", timedOut: false };
    }) as unknown as typeof runBounded;
    const none = () => null, read = ghPrState(command, none, none, none);
    expect(await read(PR, { project: "p", head: H1 }, undefined, "draft")).toMatchObject({ state: "CLOSED", head: H1, draft: true, flipped: true });
    expect(calls).toEqual(["view", "ready", "view"]);
    view = { state: "OPEN", headRefOid: H1, mergeCommit: null, baseRefName: "main", isDraft: false };
    code = 1;
    calls.length = 0;
    const refused = await read(PR, { project: "p", head: H1 }, undefined, "draft");
    expect(refused).toMatchObject({ state: "OPEN", draft: false, flipError: "gh pr ready --undo 失败：HTTP 502" });
    expect(refused.flipped).toBeUndefined();
    expect(calls).toEqual(["view", "ready"]);
  });
});

/** i28-MT1f2: cards outside a live merge train wait for it (or its timeout); a green train's members merge one per round. Fake gh, no network. */
import { describe, expect, test } from "bun:test";
import { driveMerge, type MergeExternal, type PrSnapshot } from "../src/lib/scheduler-merge-driver.js";
import type { MergeRun } from "../src/lib/scheduler-merge.js";
import { formTrain, stepTrain, type MemberStatus, type TrainDeps, type TrainEvent, type TrainGh, type TrainState, type TrainStore } from "../src/lib/scheduler-merge-train.js";
import { HOLD_LIMIT_MS } from "../src/lib/scheduler-merge-train-hold.js";
import { withMergeTrain } from "../src/lib/scheduler-merge-train-tick.js";

const REPO = "example/repo";
let shaSeq = 0;
const newSha = () => (++shaSeq).toString(16).padStart(40, "0");

/** main as a merge-commit chain, PRs, train branches and their draft PRs; every effect lands in `calls` in order. */
function env(n: number, startedAgo = 0) {
  const hub = { main: newSha(), parents: new Map<string, string[]>(), heads: new Map<string, string>(), merged: new Map<string, string>(),
    drafts: new Map<number, string>(), pending: false, calls: [] as string[] };
  const gh: TrainGh = {
    mainHead: async () => hub.main,
    prFiles: async (pr) => [`src/${pr.split("/").pop()}.ts`],
    prHead: async (pr) => hub.heads.get(pr)!,
    createBranch: async () => {},
    mergeInto: async () => "merged",
    openDraft: async (_r, b) => { const id = 1000 + hub.drafts.size; hub.drafts.set(id, b); return id; },
    checks: async () => [{ name: "check", bucket: hub.pending ? "pending" : "pass" }],
    failLog: async () => "",
    parents: async (_r, sha) => hub.parents.get(sha) ?? [newSha()],
    mergeMatchHead: async (prRef, head) => {
      const sha = newSha();
      hub.parents.set(sha, [hub.main, head]); hub.main = sha; hub.merged.set(prRef, sha);
      hub.calls.push(`match-head:${prRef.split("/").pop()}`);
      return sha;
    },
    closePr: async () => {},
    deleteBranch: async () => {},
  };
  let state: TrainState | null = null, seq = 0;
  const events: TrainEvent[] = [];
  const store: TrainStore = { load: () => state && structuredClone(state), all: () => (state ? [structuredClone(state)] : []),
    save: (s) => { state = structuredClone(s); seq = Math.max(seq, s.seq); }, event: (_p, ev) => { events.push(ev); }, nextSeq: () => seq + 1 };
  const cards = Array.from({ length: n }, (_, i) => {
    const prRef = `https://github.com/${REPO}/pull/${i + 1}`, head = newSha();
    hub.heads.set(prRef, head);
    return { taskId: `T${i + 1}`, prRef, head };
  });
  const status = new Map<string, MemberStatus>();
  // The driver's gate reads Date.now (withMergeTrain), so the train's clock is the real one, shifted to age the train.
  const deps: TrainDeps = { gh, store, now: () => Date.now() - startedAgo, requiredChecks: ["check"],
    memberStatus: (id) => status.get(id) ?? { kind: "waiting" }, notify: async () => {} };
  const tick = async () => { const live = store.load("p"); return live && live.phase !== "done" ? stepTrain(live, deps) : null; };
  const form = (ids: number[]) => formTrain("p", ids.map((i) => cards[i]!), deps);
  return { hub, gh, store, events, cards, status, deps, tick, form };
}
type Env = ReturnType<typeof env>;

/** One card's merge run through the production hook; update-branch and a serial merge are recorded, not performed. */
function cardRun(e: Env, i: number, phase: MergeRun["phase"] = "ready") {
  const card = e.cards[i]!, start = e.hub.main;
  let row: MergeRun = { intentId: `m-${card.taskId}`, taskId: card.taskId, project: "p", prRef: card.prRef, expectedBranch: `task/${card.taskId}`,
    reviewedHead: card.head, requiredChecks: "check", phase, rev: 1, mergeSha: null, reason: null, createdAt: 1, updatedAt: 1 };
  const pr = (): PrSnapshot => {
    const merged = e.hub.merged.get(card.prRef) ?? null;
    return { state: merged ? "MERGED" : "OPEN", head: e.hub.heads.get(card.prRef)!, branch: `task/${card.taskId}`, base: "main", draft: false,
      crossRepository: false, mergeState: "CLEAN", mergeSha: merged, checks: [{ name: "check", bucket: "pass" }] };
  };
  const base: MergeExternal = {
    inspect: async () => pr(),
    freshness: async () => ({ behindBy: e.hub.main === start ? 0 : 1, mainHead: e.hub.main }),
    carryReview: async () => ({ ok: false, reason: "不沿用" }),
    updateBranch: async () => { e.hub.calls.push(`update:${card.taskId}`); },
    merge: async () => {
      const sha = newSha();
      e.hub.parents.set(sha, [e.hub.main, card.head]); e.hub.main = sha; e.hub.merged.set(card.prRef, sha);
      e.hub.calls.push(`serial-merge:${card.taskId}`);
      return sha;
    },
  };
  const external = withMergeTrain(base, { gh: e.gh, store: e.store });
  const advance = async (from: MergeRun["phase"], to: MergeRun["phase"], rev: number, receipt?: string, mergeSha?: string) => {
    expect([from, rev]).toEqual([row.phase, row.rev]);
    row = { ...row, phase: to, rev: from === to ? row.rev : row.rev + 1, reason: receipt ?? null, mergeSha: mergeSha ?? row.mergeSha };
    if (to === "merged") e.status.set(card.taskId, { kind: "merged", sha: mergeSha! });
    return row;
  };
  return { get row() { return row; }, once: () => driveMerge(row, external, advance) };
}

const effects = (e: Env, id: string) => e.hub.calls.filter((c) => c.endsWith(`:${id}`));
const holds = (e: Env) => e.events.filter((ev) => ev.kind === "hold");

describe("i28-MT1f2 merge train right of way", () => {
  test("train testing: an outside card at ready neither updates nor merges, the wait names the train; after the train ends it merges as usual", async () => {
    const e = env(3);
    e.hub.pending = true;
    const s = await e.form([0, 1]);
    await e.tick(); // assembled, CI running
    expect(e.store.load("p")!.phase).toBe("testing");
    const outside = cardRun(e, 2);
    for (let i = 0; i < 3; i++) expect((await outside.once()).phase).toBe("ready");
    expect(effects(e, "T3")).toEqual([]);
    expect(holds(e).map((h) => h.text)).toEqual([`T3 等第 1 辆列车 ${s!.id} 结束（拼车 / 跑 CI）再走串行合并，不 update-branch、不合并`]);
    expect(outside.row.reason).toBeNull(); // not journaled as unknown, not a bounce: the run just keeps its phase
    for (const id of ["T1", "T2"]) e.status.set(id, { kind: "gone", why: "流程改为 manual" });
    expect((await e.tick())?.outcome).toBe("void");
    expect((await e.tick())?.phase).toBe("done");
    await outside.once();
    expect((await outside.once()).phase).toBe("merged");
    expect(effects(e, "T3")).toEqual(["serial-merge:T3"]);
  });

  test("train settling: an outside card waits at ready and at await_ci while the members merge, then goes on once the train is done", async () => {
    const e = env(4);
    await e.form([0, 1]);
    while (e.store.load("p")!.phase !== "settling") await e.tick();
    const atReady = cardRun(e, 2), atCi = cardRun(e, 3, "await_ci");
    expect((await atReady.once()).phase).toBe("ready");
    expect((await atCi.once()).phase).toBe("await_ci");
    expect(holds(e).map((h) => h.data?.phase)).toEqual(["settling", "settling"]);
    expect(holds(e)[0]!.text).toContain("逐张合并");
    expect((await cardRun(e, 0).once()).phase).toBe("merged");
    await e.tick();
    expect((await atReady.once()).phase).toBe("ready"); // still waiting: one member is left to merge
    expect((await atCi.once()).phase).toBe("await_ci");
    expect((await cardRun(e, 1).once()).phase).toBe("merged");
    expect(e.hub.calls.filter((c) => /T3|T4/.test(c))).toEqual([]);
    while (e.store.load("p")!.phase !== "done") await e.tick();
    expect(e.store.load("p")!.outcome).toBe("merged");
    expect((await atReady.once()).phase).toBe("updating"); // main moved by the train: the ordinary serial path, update-branch first
    expect((await atCi.once()).phase).toBe("updating");
    expect(e.hub.calls.filter((c) => /T3|T4/.test(c))).toEqual(["update:T3", "update:T4"]);
    expect(holds(e)).toHaveLength(2); // one reason per card and phase, not one per pass
  });

  test("a train still testing or settling past the limit is voided as timed out, and the outside card goes on serially", async () => {
    const young = env(3, HOLD_LIMIT_MS - 60_000);
    young.hub.pending = true;
    await young.form([0, 1]); await young.tick();
    expect((await cardRun(young, 2).once()).phase).toBe("ready");
    expect(young.store.load("p")!.phase).toBe("testing");

    for (const phase of ["testing", "settling"] as const) {
      const e = env(3, HOLD_LIMIT_MS + 60_000);
      e.hub.pending = phase === "testing";
      await e.form([0, 1]);
      while (e.store.load("p")!.phase !== phase) await e.tick();
      const outside = cardRun(e, 2);
      e.hub.main = (() => { const sha = newSha(); e.hub.parents.set(sha, [e.hub.main, newSha()]); return sha; })(); // T3 is behind
      expect((await outside.once()).phase).toBe("updating");
      expect(effects(e, "T3")).toEqual(["update:T3"]);
      const s = e.store.load("p")!;
      expect(s).toMatchObject({ phase: "cleanup", outcome: "void" });
      expect(s.reason).toContain("列车超时");
      expect(s.reason).toContain("放行串行合并 T3");
    }
  });

  test("after the train turns green every member merges in its own round, one after another, with no round spent only waiting", async () => {
    const e = env(4);
    await e.form([0, 1, 2, 3]);
    while (e.store.load("p")!.phase !== "settling") await e.tick();
    const rounds: string[][] = [];
    for (const i of [0, 1, 2, 3]) {
      const before = e.hub.calls.length;
      await e.tick(); // the pass's train step comes first, then the merge slot's run (scheduler-pass.ts)
      const run = cardRun(e, i);
      expect((await run.once()).phase).toBe("merged"); // ready → await_ci → merging → merged in one driver call
      rounds.push(e.hub.calls.slice(before));
    }
    expect(rounds).toEqual([["match-head:1"], ["match-head:2"], ["match-head:3"], ["match-head:4"]]);
    expect((await e.tick())?.phase).toBe("cleanup");
    expect((await e.tick())).toMatchObject({ phase: "done", outcome: "merged" });
    expect(e.hub.calls.filter((c) => c.startsWith("update:") || c.startsWith("serial-merge:"))).toEqual([]);
  });
});

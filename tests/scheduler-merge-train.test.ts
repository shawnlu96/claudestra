/** i28-MT1 merge train: fake GitHub (refs, merges API, draft PR checks, merge commits), no network. Fixtures: 本机 / peer A only. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { driveMerge, type MergeExternal, type PrSnapshot } from "../src/lib/scheduler-merge-driver.js";
import type { MergeRun } from "../src/lib/scheduler-merge.js";
import { parseBounceReceipt } from "../src/lib/scheduler-merge-conflict.js";
import {
  formTrain, nextSkip, stepTrain, TRAIN_MAX_DEPTH, type MemberStatus, type TrainDeps, type TrainEvent, type TrainGh, type TrainState, type TrainStore,
} from "../src/lib/scheduler-merge-train.js";
import { fileTrainStore, withMergeTrain } from "../src/lib/scheduler-merge-train-tick.js";

const REPO = "example/repo";
let shaSeq = 0;
const newSha = () => (++shaSeq).toString(16).padStart(40, "0");
const BASE = "f".repeat(40);

interface FakePr { head: string; files: string[]; merged: string | null }
/** Just enough GitHub: main as a merge-commit chain, PRs, train branches holding merged heads, one CI run per draft PR. */
function fakeHub() {
  const hub = {
    main: BASE, parents: new Map<string, string[]>(), prs: new Map<string, FakePr>(), branches: new Map<string, string[]>(),
    drafts: new Map<number, string>(), red: new Set<string>(), conflicts: new Set<string>(), pending: false, calls: [] as string[],
  };
  const gh: TrainGh = {
    mainHead: async () => hub.main,
    prFiles: async (pr) => hub.prs.get(pr)!.files,
    prHead: async (pr) => hub.prs.get(pr)!.head,
    createBranch: async (_r, b) => { hub.calls.push(`branch:${b}`); hub.branches.set(b, []); },
    mergeInto: async (_r, b, head) => {
      if (hub.conflicts.has(head)) return "conflict";
      const held = hub.branches.get(b)!;
      if (!held.includes(head)) held.push(head);
      return "merged";
    },
    openDraft: async (_r, b) => {
      const found = [...hub.drafts].find(([, br]) => br === b);
      if (found) return found[0];
      const n = 1000 + hub.drafts.size;
      hub.drafts.set(n, b); hub.calls.push(`draft:${b}`);
      return n;
    },
    checks: async (_r, n) => {
      if (hub.pending) return [{ name: "check", bucket: "pending" }];
      const heads = hub.branches.get(hub.drafts.get(n)!) ?? [];
      return heads.some((h) => hub.red.has(h))
        ? [{ name: "check", bucket: "fail", link: "https://github.com/example/repo/actions/runs/77/job/1" }]
        : [{ name: "check", bucket: "pass" }];
    },
    failLog: async () => "FAIL tests/x.test.ts > boom: expected 1 to be 2",
    parents: async (_r, sha) => hub.parents.get(sha) ?? [newSha()],
    mergeMatchHead: async (prRef, head) => {
      const pr = hub.prs.get(prRef)!;
      if (pr.head !== head) throw new Error("head moved");
      const sha = newSha();
      hub.parents.set(sha, [hub.main, head]); hub.main = sha; pr.merged = sha;
      hub.calls.push(`match-head:${prRef.split("/").pop()}:${head.slice(-4)}`);
      return sha;
    },
    closePr: async (_r, n) => { hub.calls.push(`close:${n}`); },
    deleteBranch: async (_r, b) => { hub.calls.push(`delete:${b}`); hub.branches.delete(b); },
  };
  /** Someone outside the train merges straight into main. */
  const pushMain = () => { const sha = newSha(); hub.parents.set(sha, [hub.main, newSha()]); hub.main = sha; };
  return { hub, gh, pushMain };
}

function memStore(): TrainStore & { events: TrainEvent[] } {
  let state: TrainState | null = null, seq = 0;
  const events: TrainEvent[] = [];
  return {
    events, load: () => state && structuredClone(state), all: () => (state ? [structuredClone(state)] : []),
    save: (s) => { state = structuredClone(s); seq = Math.max(seq, s.seq); }, event: (_p, ev) => { events.push(ev); }, nextSeq: () => seq + 1,
  };
}

/** Cards T1..Tn, PR n, each with its own head and file list (本机 project). */
function setup(files: string[][], store: TrainStore = memStore()) {
  const f = fakeHub();
  const cards = files.map((fl, i) => {
    const prRef = `https://github.com/${REPO}/pull/${i + 1}`, head = newSha();
    f.hub.prs.set(prRef, { head, files: fl, merged: null });
    return { taskId: `T${i + 1}`, prRef, head };
  });
  const status = new Map<string, MemberStatus>();
  const notices: string[] = [];
  const deps: TrainDeps = { gh: f.gh, store, now: () => 1_000, requiredChecks: ["check"],
    memberStatus: (id) => status.get(id) ?? { kind: "waiting" }, notify: async (_s, text) => { notices.push(text); } };
  const tick = async () => {
    const live = store.load("p");
    return live && live.phase !== "done" ? stepTrain(live, deps) : formTrain("p", cards, deps);
  };
  const until = async (phase: TrainState["phase"], max = 20) => {
    for (let i = 0; i < max; i++) { const s = await tick(); if (!s || s.phase === phase) return s; }
    throw new Error(`train never reached ${phase}`);
  };
  return { ...f, cards, status, deps, store, tick, until, notices };
}

/** The serial merge driver of one card over the same fake GitHub; `train` is the production hook. */
function cardRun(env: ReturnType<typeof setup>, i: number, initialMain = BASE, phase: MergeRun["phase"] = "ready") {
  const card = env.cards[i]!;
  let row: MergeRun = { intentId: `m-${card.taskId}`, taskId: card.taskId, project: "p", prRef: card.prRef, expectedBranch: `task/${card.taskId}`,
    reviewedHead: card.head, requiredChecks: "check", phase, rev: 1, mergeSha: null, reason: null, createdAt: 1, updatedAt: 1 };
  const pr = (): PrSnapshot => {
    const p = env.hub.prs.get(card.prRef)!;
    return { state: p.merged ? "MERGED" : "OPEN", head: p.head, branch: `task/${card.taskId}`, base: "main", draft: false, crossRepository: false,
      mergeState: "CLEAN", mergeSha: p.merged, checks: [{ name: "check", bucket: "pass" }] };
  };
  /** A test may wrap `freshness` (e.g. push main while it reads). */
  const hooks: Pick<MergeExternal, "freshness"> = { freshness: async () => ({ behindBy: env.hub.main === initialMain ? 0 : 1, mainHead: env.hub.main }) };
  const base: MergeExternal = {
    inspect: async () => pr(),
    freshness: (...a) => hooks.freshness(...a),
    carryReview: async () => ({ ok: false, reason: "不沿用" }),
    updateBranch: async () => { env.hub.calls.push(`update:${card.taskId}`); },
    merge: async () => { env.hub.calls.push(`rest-merge:${card.taskId}`); throw new Error("serial merge not expected here"); },
  };
  const external = withMergeTrain(base, { gh: env.gh, store: env.store });
  const advance = async (from: MergeRun["phase"], to: MergeRun["phase"], rev: number, receipt?: string, mergeSha?: string) => {
    expect([from, rev]).toEqual([row.phase, row.rev]);
    row = { ...row, phase: to, rev: row.rev + 1, reason: receipt ?? null, mergeSha: mergeSha ?? row.mergeSha };
    if (to === "merged") env.status.set(card.taskId, { kind: "merged", sha: mergeSha! });
    return row;
  };
  return {
    hooks,
    get row() { return row; },
    once: () => driveMerge(row, external, advance),
    drive: async (times = 4) => { for (let i = 0; i < times && !["merged", "resolved", "unknown", "updating"].includes(row.phase); i++) await driveMerge(row, external, advance); return row; },
  };
}

const evs = (env: ReturnType<typeof setup>): TrainEvent[] => (env.store as { events?: TrainEvent[] }).events ?? [];
const calls = (env: ReturnType<typeof setup>, prefix: string) => env.hub.calls.filter((c) => c.startsWith(prefix));

describe("i28-MT1 merge train", () => {
  test("3 disjoint cards: one train, one CI; all merge with --match-head-commit, no update-branch for anyone", async () => {
    const env = setup([["src/a.ts"], ["src/b.ts"], ["src/c.ts", "tests/c.test.ts"]]);
    const formed = await env.tick();
    expect(formed?.members.map((m) => m.taskId)).toEqual(["T1", "T2", "T3"]);
    const early = cardRun(env, 0);
    await early.drive(1);
    expect(early.row.phase).toBe("ready"); // holds the slot while its train tests, no update-branch
    const s = await env.until("settling");
    expect(s?.ciRuns).toBe(1);
    expect(calls(env, "draft:")).toEqual([`draft:train/${s!.id}`]);
    for (const i of [0, 1, 2]) {
      const run = i === 0 ? early : cardRun(env, i);
      expect((await run.drive()).phase).toBe("merged");
      await env.tick();
    }
    expect(calls(env, "match-head:").map((c) => c.split(":")[1])).toEqual(["1", "2", "3"]);
    for (const c of env.cards) expect(calls(env, "match-head:")).toContain(`match-head:${c.prRef.split("/").pop()}:${c.head.slice(-4)}`);
    expect(calls(env, "update:")).toEqual([]);
    expect(calls(env, "rest-merge:")).toEqual([]);
    const done = await env.until("done");
    expect(done).toMatchObject({ outcome: "merged", ciRuns: 1 });
    expect(done!.merged.map((m) => m.taskId)).toEqual(["T1", "T2", "T3"]);
    expect(env.hub.branches.size).toBe(0);
    expect(calls(env, "close:")).toHaveLength(1);
    expect(env.store.load("p")?.cars).toHaveLength(1);
  });

  test("overlapping files never share a batch: the other card keeps the serial path unchanged", async () => {
    const env = setup([["src/shared.ts", "src/a.ts"], ["src/shared.ts"]]);
    expect(await env.tick()).toBeNull();
    expect(env.store.load("p")).toBeNull();
    env.pushMain();
    const run = cardRun(env, 1);
    await run.drive();
    expect(run.row.phase).toBe("updating");
    expect(calls(env, "update:")).toEqual(["update:T2"]);

    const three = setup([["src/shared.ts"], ["src/shared.ts", "src/b.ts"], ["src/c.ts"]]);
    const s = await three.tick();
    expect(s?.members.map((m) => m.taskId)).toEqual(["T1", "T3"]);
    three.pushMain();
    const outside = cardRun(three, 1);
    await outside.drive();
    expect(outside.row.phase).toBe("updating"); // not a member: gate says nothing, update-branch as today
    expect(calls(three, "update:")).toEqual(["update:T2"]);
  });

  test("4 cards, the 3rd turns CI red: bisect pins it, it bounces to fix with a log summary, the other 3 merge", async () => {
    const env = setup([["a"], ["b"], ["c"], ["d"]]);
    env.hub.red.add(env.cards[2]!.head);
    const s = await env.until("settling");
    const levels = Math.max(...s!.cars.map((c) => c.level));
    expect(levels).toBeLessThanOrEqual(TRAIN_MAX_DEPTH);
    expect(s!.ciRuns).toBeLessThanOrEqual(1 + 2 * levels);
    expect(s!.ciRuns).toBe(5);
    expect(s!.cleared.sort()).toEqual(["T1", "T2", "T4"]);
    expect(s!.bounced.map((b) => b.taskId)).toEqual(["T3"]);
    const bounce = parseBounceReceipt(s!.bounced[0]!.receipt);
    expect(bounce).toMatchObject({ cause: "ci_fail", prHead: env.cards[2]!.head });
    expect(bounce!.checks[0]!.name).toBe("check");
    expect(bounce!.checks[0]!.link).toContain("日志摘要：FAIL tests/x.test.ts");
    expect(evs(env).filter((e: TrainEvent) => e.kind === "bisect").length).toBe(3); // two split levels + the pin
    const culprit = cardRun(env, 2);
    await culprit.drive();
    expect(culprit.row).toMatchObject({ phase: "resolved", reason: s!.bounced[0]!.receipt });
    env.status.set("T3", { kind: "gone", why: "阶段 fix" });
    for (const i of [0, 1, 3]) expect((await cardRun(env, i).drive()).phase).toBe("merged");
    expect(calls(env, "match-head:")).toHaveLength(3);
    expect(calls(env, "update:")).toEqual([]);
    expect((await env.until("done"))?.outcome).toBe("merged");
    expect(env.hub.branches.size).toBe(0);
  });

  test("main moves during train CI: the whole batch is void and regroups; nothing untested reaches main", async () => {
    const env = setup([["a"], ["b"], ["c"]]);
    env.hub.pending = true;
    await env.tick(); await env.tick(); // formed, assembled, CI running
    expect(env.store.load("p")?.cars[0]?.status).toBe("ci");
    env.pushMain();
    env.hub.pending = false;
    const s = await env.tick();
    expect(s).toMatchObject({ phase: "cleanup", outcome: "void" });
    const run = cardRun(env, 0);
    await run.drive();
    expect(run.row.phase).toBe("updating"); // back on the serial path
    expect(calls(env, "match-head:")).toEqual([]);
    expect((await env.tick())?.phase).toBe("done");
    expect(env.hub.branches.size).toBe(0);
    const again = await env.tick();
    expect(again?.seq).toBe(2); // regrouped from the queue (here: the same three, on the new main)
    expect(again?.base).toBe(env.hub.main);
  });

  test("a member head moves after the first merge: that merge stands, the rest is void and goes serial", async () => {
    const env = setup([["a"], ["b"], ["c"]]);
    await env.until("settling");
    expect((await cardRun(env, 0).drive()).phase).toBe("merged");
    env.hub.prs.get(env.cards[1]!.prRef)!.head = newSha();
    const s = await env.tick();
    expect(s).toMatchObject({ phase: "cleanup", outcome: "void" });
    expect(s!.merged.map((m) => m.taskId)).toEqual(["T1"]);
    const third = cardRun(env, 2);
    await third.drive();
    expect(third.row.phase).toBe("updating");
    expect(calls(env, "match-head:")).toHaveLength(1);
  });

  test("an outside commit lands on main between member merges: the gate refuses and voids, no unverified combination merges", async () => {
    const env = setup([["a"], ["b"]]);
    await env.until("settling");
    expect((await cardRun(env, 0).drive()).phase).toBe("merged");
    env.pushMain();
    const second = cardRun(env, 1);
    await second.drive();
    expect(second.row.phase).toBe("updating");
    expect(calls(env, "match-head:")).toHaveLength(1);
    expect(env.store.load("p")).toMatchObject({ phase: "cleanup", outcome: "void" });
  });

  test("restart during train CI resumes from the state file: no second train, branch or PR, and no orphan branch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "merge-train-"));
    try {
      const env = setup([["a"], ["b"]], fileTrainStore(dir));
      env.hub.pending = true;
      await env.tick(); await env.tick();
      expect(env.store.load("p")?.cars[0]?.status).toBe("ci");
      const restarted = { ...env.deps, store: fileTrainStore(dir) };
      const live = restarted.store.load("p")!;
      expect(live.phase).toBe("testing");
      await stepTrain(live, restarted); // still pending
      env.hub.pending = false;
      const s = await stepTrain(restarted.store.load("p")!, restarted);
      expect(s.phase).toBe("settling");
      expect(calls(env, "branch:")).toHaveLength(1);
      expect(calls(env, "draft:")).toHaveLength(1);
      // A crash after the draft PR was opened but before its number was saved reuses that PR.
      expect(await env.gh.openDraft(REPO, s.cars[0]!.branch, "", "")).toBe(s.cars[0]!.pr!);
      for (const c of env.cards) env.status.set(c.taskId, { kind: "gone", why: "PM 改为 manual" });
      await stepTrain(restarted.store.load("p")!, restarted);
      const done = await stepTrain(restarted.store.load("p")!, restarted);
      expect(done.phase).toBe("done");
      expect(env.hub.branches.size).toBe(0);
      expect(fileTrainStore(dir).load("p")?.phase).toBe("done");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("cleanup deletes only this train's recorded train/ branches; a non-train/ name in the state is refused", async () => {
    const env = setup([["a"], ["b"]]);
    env.hub.red.add(env.cards[0]!.head);
    env.hub.red.add(env.cards[1]!.head);
    await env.until("settling");
    const s = env.store.load("p")!;
    s.cars[1]!.branch = "main";
    s.cars[2]!.branch = "feature/peer-A";
    s.phase = "cleanup";
    env.store.save(s);
    const done = await env.tick();
    expect(done?.phase).toBe("done");
    const deleted = calls(env, "delete:");
    expect(deleted).toEqual([`delete:train/${s.id}`]);
    expect(deleted.some((c) => !c.startsWith("delete:train/"))).toBe(false);
    const alarm = evs(env).find((e: TrainEvent) => e.kind === "alarm");
    expect(alarm?.text).toContain("拒绝删除");
    expect(env.notices.some((n) => n.includes("拒绝删除"))).toBe(true);
  });

  test("a merge conflict while assembling kicks only that card to the serial path; the rest still ride", async () => {
    const env = setup([["a"], ["b"], ["c"]]);
    env.hub.conflicts.add(env.cards[1]!.head);
    const s = await env.until("settling");
    expect(s!.serial).toEqual(["T2"]);
    expect(s!.cleared).toEqual(["T1", "T3"]);
    expect(evs(env).some((e: TrainEvent) => e.kind === "conflict")).toBe(true);
  });

  test("red halves that are each green (combination-only failure): whole batch serial plus a PM alarm", async () => {
    const env = setup([["a"], ["b"]]);
    const gh = env.gh, checks = gh.checks;
    gh.checks = async (r, n) => (env.hub.drafts.get(n) === `train/${env.store.load("p")!.id}`
      ? [{ name: "check", bucket: "fail", link: "https://github.com/example/repo/actions/runs/9" }] : checks(r, n));
    const s = await env.until("cleanup");
    expect(s).toMatchObject({ outcome: "serial", cleared: [] });
    expect(s!.serial.sort()).toEqual(["T1", "T2"]);
    expect(env.notices.some((n) => n.includes("定位不到"))).toBe(true);
    const done = await env.tick();
    expect(done?.phase).toBe("done");
    // The same heads are not regrouped (that would replay the failure and the alarm every pass); a new head may ride again.
    expect(await formTrain("p", env.cards, env.deps, undefined, nextSkip(done!))).toBeNull();
    const moved = [{ ...env.cards[0]!, head: newSha() }, env.cards[1]!];
    expect(await formTrain("p", moved, env.deps, async () => ["x"], nextSkip(done!))).toBeNull(); // T2 still skipped: one card left
    expect(nextSkip({ ...done!, outcome: "void" })).toEqual([]);
  });

  test("review P1 head-drift: a member's remote head moves after green, a sibling is driven before any train tick: void, no match-head", async () => {
    const env = setup([["a"], ["b"], ["c"]]);
    await env.until("settling");
    env.hub.prs.get(env.cards[1]!.prRef)!.head = newSha();
    await cardRun(env, 0).drive();
    expect(calls(env, "match-head:")).toEqual([]);
    expect(env.store.load("p")).toMatchObject({ phase: "cleanup", outcome: "void" });
    expect(env.store.load("p")!.reason).toContain("T2 head 变成");
  });

  test("review P1 head-drift: the ledger already reports a cleared member's head moved: the train voids instead of dropping it", async () => {
    const env = setup([["a"], ["b"], ["c"]]);
    await env.until("settling");
    env.status.set("T2", { kind: "gone", why: "head 变成 abc", moved: true });
    const s = await env.tick();
    expect(s).toMatchObject({ phase: "cleanup", outcome: "void" });
    expect(s!.dropped).toEqual([]);
    await cardRun(env, 0).drive();
    expect(calls(env, "match-head:")).toEqual([]);
  });

  test("review P1 restart-orphan: the branch lands on GitHub but the process dies before saving; recovery after main moved still deletes it", async () => {
    const env = setup([["a"], ["b"]]);
    const create = env.gh.createBranch;
    let crash = true;
    env.gh.createBranch = async (r, b, sha) => { await create(r, b, sha); if (crash) { crash = false; throw new Error("crash after create"); } };
    await env.tick(); // formed
    await expect(env.tick()).rejects.toThrow("crash after create");
    expect(env.hub.branches.size).toBe(1);
    expect(env.store.load("p")!.cars[0]).toMatchObject({ created: true, status: "new" }); // the claim was saved before the call
    env.pushMain();
    expect(await env.tick()).toMatchObject({ phase: "cleanup", outcome: "void" });
    expect((await env.tick())?.phase).toBe("done");
    expect(env.hub.branches.size).toBe(0);
    expect(calls(env, "delete:")).toEqual([`delete:train/${env.store.load("p")!.id}`]);
  });

  test("review P1 updating-gate: a member already in updating waits for its train at await_ci, never merges or re-updates unverified", async () => {
    for (const behind of [false, true]) {
      const env = setup([["a"], ["b"]]);
      env.hub.pending = true;
      await env.tick(); await env.tick(); // formed, CI running
      const run = cardRun(env, 0, behind ? "e".repeat(40) : BASE, "updating");
      await run.once();
      expect(run.row.phase).toBe("await_ci");
      await run.drive(3);
      expect(run.row.phase).toBe("await_ci"); // gate says wait: neither a serial merge nor another update-branch
      expect([...calls(env, "update:"), ...calls(env, "rest-merge:"), ...calls(env, "match-head:")]).toEqual([]);
      env.hub.pending = false;
      expect((await env.tick())?.phase).toBe("settling");
      expect((await run.drive()).phase).toBe("merged");
      expect(calls(env, "match-head:")).toHaveLength(1);
      expect(calls(env, "update:")).toEqual([]);
    }
  });

  test("review r2 head-drift: a cleared member's remote head moves while it leaves merge (gone, no moved flag): void, never dropped", async () => {
    const env = setup([["a"], ["b"], ["c"]]);
    await env.until("settling");
    env.hub.prs.get(env.cards[1]!.prRef)!.head = newSha();
    env.status.set("T2", { kind: "gone", why: "阶段 fix" });
    const s = await env.tick();
    expect(s).toMatchObject({ phase: "cleanup", outcome: "void" });
    expect(s!.dropped).toEqual([]);
    await cardRun(env, 0).drive();
    expect(calls(env, "match-head:")).toEqual([]);
  });

  test("review r2 main-drift: main moves between the gate and the await_ci freshness read: re-gated, void, no match-head", async () => {
    const env = setup([["a"], ["b"]]);
    await env.until("settling");
    const run = cardRun(env, 0, BASE, "await_ci");
    const fresh = run.hooks.freshness;
    run.hooks.freshness = async (...a) => { env.pushMain(); run.hooks.freshness = fresh; return fresh(...a); };
    await run.once();
    expect(calls(env, "match-head:")).toEqual([]);
    expect(run.row.phase).toBe("updating"); // re-gated before the merge claim: back on the serial path, not unknown
    expect(env.store.load("p")).toMatchObject({ phase: "cleanup", outcome: "void" });
  });

  test("review r2 main-drift: the head-pinned merge itself re-checks main and refuses an outside commit", async () => {
    const env = setup([["a"], ["b"]]);
    await env.until("settling");
    const external = withMergeTrain({} as MergeExternal, { gh: env.gh, store: env.store });
    env.pushMain();
    await expect(external.merge(env.cards[0]!.prRef, env.cards[0]!.head)).rejects.toThrow("合并前核对");
    expect(calls(env, "match-head:")).toEqual([]);
    expect(env.store.load("p")).toMatchObject({ phase: "cleanup", outcome: "void" });
  });
});

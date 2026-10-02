/**
 * i28-MT1f2: a live merge train's right of way, end to end on a temporary ledger. Each `pass()` runs the production order of
 * scheduler-pass.ts: train step → mergeTick (real merge intents, the one `merge:p` slot, begin / step / settle through the ledger
 * CLI, the driver behind withMergeTrain) → the auto tick's merge planning (mergeSlotHold, then the slot taken exactly as
 * planIntent takes it). GitHub is a fake that records every update-branch and merge in order. No network.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { closeLedger, getTask, openLedger } from "../src/lib/ledger-store.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { createTask } from "../src/lib/ledger-write.js";
import { parseSchedulerConfig } from "../src/lib/scheduler-config.js";
import type { MergeExternal, PrSnapshot } from "../src/lib/scheduler-merge-driver.js";
import { getMergeRun } from "../src/lib/scheduler-merge.js";
import { formTrain, stepTrain, type TrainDeps, type TrainEvent, type TrainGh, type TrainState, type TrainStore } from "../src/lib/scheduler-merge-train.js";
import { HOLD_LIMIT_MS } from "../src/lib/scheduler-merge-train-hold.js";
import { mergeSlotHold, trainProjects } from "../src/lib/scheduler-merge-train-hold-slot.js";
import { memberStatusOf, withMergeTrain } from "../src/lib/scheduler-merge-train-tick.js";
import { mergeTick } from "../src/lib/scheduler-service.js";
import { listEvents } from "../src/lib/ledger-store.js";
import { runLedger } from "../src/manager/ledger.js";
import type { Registry } from "../src/manager/core.js";

const REPO = "example/repo";
let shaSeq = 0;
const newSha = () => (++shaSeq).toString(16).padStart(40, "0");
const config = parseSchedulerConfig({ enabled: true, projects: { p: { maxActiveWorkers: 2, requiredChecks: ["check"], repoDir: "/tmp/p" } } });

/** n auto code cards T1..Tn in `merge` with a passing cross-family review; `files` lets two cards overlap (then they never share a car). */
function world(n: number, opts: { startedAgo?: number; files?: (i: number) => string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "mt1f2-")), path = join(dir, "ledger.sqlite"), db = openLedger(path);
  const hub = { main: newSha(), parents: new Map<string, string[]>(), heads: new Map<string, string>(), merged: new Map<string, string>(),
    synced: new Map<string, string>(), pending: false, calls: [] as string[] };
  const cards = Array.from({ length: n }, (_, i) => {
    const id = `T${i + 1}`, prRef = `https://github.com/${REPO}/pull/${i + 1}`, head = newSha();
    createTask(db, { actor: "owner", now: 100 }, { project: "p", id, title: id, kind: "code", agent: "agent-author" });
    setWorkflow(db, { actor: "owner", now: 100 }, { taskId: id, taskRev: 1, template: "code", templateVersion: 2, mode: "auto",
      authorFamily: "claude", fallback: "缩小范围" });
    db.query("UPDATE tasks SET stage='merge', round=1, rev=2, headSHA=?, pr=?, branch=?, updatedAt=? WHERE id=?").run(head, prRef, `task/${id}`, 100 + i, id);
    db.query("INSERT INTO events (ts,actor,project,target,kind,text,data) VALUES (100,'agent-review','p',?,'review','',?)").run(id, JSON.stringify({
      round: 1, head, verdict: "pass", reviewer: "agent-review", reviewerSessionId: `rs-${id}`, reviewerFamily: "codex", path: "r.md",
      findings: [], p0: 0, p1: 0, p2: 0 }));
    db.query(`INSERT INTO scheduler_intents (id,taskId,project,node,action,causalSeq,eventSeq,taskRev,specRev,head,templateVersion,status,reason,
      createdAt,updatedAt) VALUES (?,?,'p','adversarial_review','ensure_session',1,2,1,1,?,2,'done','reviewer',100,100)`).run(`rc-${id}`, id, head);
    db.query(`INSERT INTO scheduler_sessions (taskId,role,agent,sessionId,family,transport,state,createIntentId,createdAt,updatedAt)
      VALUES (?,'reviewer','agent-review',?,'codex','acp','active',?,100,100)`).run(id, `rs-${id}`, `rc-${id}`);
    hub.heads.set(prRef, head); hub.synced.set(prRef, hub.main);
    return { taskId: id, prRef, head };
  });
  const mergeInto = (prRef: string, head: string, call: string) => {
    const sha = newSha();
    hub.parents.set(sha, [hub.main, head]); hub.main = sha; hub.merged.set(prRef, sha);
    hub.calls.push(`${call}:${prRef.split("/").pop()}`);
    return sha;
  };
  const gh: TrainGh = {
    mainHead: async () => hub.main,
    prFiles: async (pr) => [opts.files?.(Number(pr.split("/").pop()) - 1) ?? `src/${pr.split("/").pop()}.ts`],
    prHead: async (pr) => hub.heads.get(pr)!,
    createBranch: async () => {},
    mergeInto: async () => "merged",
    openDraft: async () => 1000,
    checks: async () => [{ name: "check", bucket: hub.pending ? "pending" : "pass" }],
    failLog: async () => "",
    parents: async (_r, sha) => hub.parents.get(sha) ?? [newSha()],
    mergeMatchHead: async (prRef, head) => mergeInto(prRef, head, "match-head"),
    closePr: async () => {},
    deleteBranch: async () => {},
  };
  let state: TrainState | null = null, seq = 0;
  const events: TrainEvent[] = [];
  const store: TrainStore = { load: () => state && structuredClone(state), all: () => (state ? [structuredClone(state)] : []),
    save: (s) => { state = structuredClone(s); seq = Math.max(seq, s.seq); }, event: (_p, ev) => { events.push(ev); }, nextSeq: () => seq + 1 };
  // The driver's gate reads Date.now (withMergeTrain), so the train's clock is the real one, shifted to age the train.
  const deps: TrainDeps = { gh, store, now: () => Date.now() - (opts.startedAgo ?? 0), requiredChecks: ["check"],
    memberStatus: (id, head) => memberStatusOf(db, id, head), notify: async () => {} };
  const pr = (prRef: string): PrSnapshot => {
    const merged = hub.merged.get(prRef) ?? null, n = prRef.split("/").pop();
    return { state: merged ? "MERGED" : "OPEN", head: hub.heads.get(prRef)!, branch: `task/T${n}`, base: "main", draft: false,
      crossRepository: false, mergeState: "CLEAN", mergeSha: merged, checks: [{ name: "check", bucket: "pass" }] };
  };
  const base: MergeExternal = {
    inspect: async (prRef) => pr(prRef),
    freshness: async (prRef) => ({ behindBy: hub.synced.get(prRef) === hub.main ? 0 : 1, mainHead: hub.main }),
    carryReview: async () => ({ ok: false, reason: "不沿用" }),
    updateBranch: async (prRef) => { hub.synced.set(prRef, hub.main); hub.calls.push(`update:${prRef.split("/").pop()}`); }, // head kept: a no-op merge of main
    merge: async (prRef, head) => mergeInto(prRef, head, "serial-merge"),
  };
  const manager = async (...args: string[]) => runLedger(args.slice(1), { db, actor: "scheduler", projectIds: ["p"],
    loadRegistry: async () => ({} as Registry), saveRegistry: async () => {}, now: () => Date.now() }) as Promise<Record<string, unknown>>;
  const held: Record<string, string> = {};
  let intentSeq = 0;
  /** The auto tick's merge step for every card in `order`: no live intent → mergeSlotHold → take the slot as planIntent does. */
  const plan = (order: string[]) => {
    for (const id of order) {
      const task = getTask(db, id)!;
      if (task.stage !== "merge" || db.query("SELECT 1 FROM scheduler_intents WHERE taskId=? AND action='merge' AND status IN ('pending','submitted','unknown')").get(id)) continue;
      if (db.query("SELECT 1 FROM scheduler_intents WHERE taskId=? AND action='merge' AND status='done'").get(id)) continue; // merged, waits for PM deploy
      const why = mergeSlotHold(task, store);
      if (why) { held[id] = why; continue; }
      delete held[id];
      if (db.query("SELECT 1 FROM scheduler_resources WHERE project='p' AND resource='merge:p'").get()) continue; // planIntent: resource busy → wait
      const intent = `merge-${id}-${++intentSeq}`;
      db.query(`INSERT INTO scheduler_intents (id,taskId,project,node,action,causalSeq,eventSeq,taskRev,specRev,head,templateVersion,status,reason,
        createdAt,updatedAt) VALUES (?,?,'p','merge_deploy','merge',3,?,?,1,?,2,'pending','merge',100,100)`).run(intent, id, 1000 + intentSeq, task.rev, task.headSHA);
      db.query("INSERT INTO scheduler_resources (project,resource,taskId,intentId,acquiredAt) VALUES ('p','merge:p',?,?,100)").run(id, intent);
    }
  };
  const ids = cards.map((c) => c.taskId);
  /** One service pass in scheduler-pass.ts order; returns the GitHub effects it caused. */
  const pass = async (order = ids) => {
    const before = hub.calls.length, live = store.load("p");
    if (live && live.phase !== "done") await stepTrain(live, deps);
    await mergeTick(db, config, manager, () => withMergeTrain(base, { gh, store }), () => {}, undefined, store);
    plan(order);
    return hub.calls.slice(before);
  };
  const phase = (id: string) => {
    const row = db.query("SELECT intentId FROM scheduler_intents i JOIN scheduler_merges m ON m.intentId = i.id WHERE i.taskId=? ORDER BY i.eventSeq DESC LIMIT 1")
      .get(id) as { intentId: string } | null;
    return row ? getMergeRun(db, row.intentId)!.phase : null;
  };
  const slot = () => (db.query("SELECT taskId FROM scheduler_resources WHERE project='p' AND resource='merge:p'").get() as { taskId: string } | null)?.taskId ?? null;
  const form = (idx: number[]) => formTrain("p", idx.map((i) => cards[i]!), deps);
  const close = () => { closeLedger(path); rmSync(dir, { recursive: true, force: true }); };
  /** Take the slot and begin the merge run the way mergeTick does, without driving it: the card sits at ready holding the slot. */
  const begin = async (id: string) => {
    plan([id]);
    const intent = (db.query("SELECT id FROM scheduler_intents WHERE taskId=? AND action='merge' AND status='pending'").get(id) as { id: string }).id;
    await manager("ledger", "scheduler-settle", intent, "--from", "pending", "--to", "submitted", "--receipt", "merge controller claimed");
    expect((await manager("ledger", "scheduler-merge-begin", intent, "--required-checks", "check")).ok).toBe(true);
    return intent;
  };
  return { db, hub, store, events, cards, deps, held, plan, pass, phase, slot, form, begin, close };
}
const holdEvents = (w: ReturnType<typeof world>) => w.events.filter((e) => e.kind === "hold");

describe("i28-MT1f2 merge train right of way", () => {
  test("train testing: a ready card outside it gets no slot, no update-branch and no merge, the wait names the train; members still take the slot; after the train it merges as usual", async () => {
    const w = world(3);
    try {
      w.hub.pending = true;
      const s = (await w.form([0, 1]))!;
      for (let i = 0; i < 3; i++) expect(await w.pass()).toEqual([]);
      expect(w.store.load("p")!.phase).toBe("testing");
      expect(w.held.T3).toBe(`T3 等第 1 辆列车 ${s.id} 结束（拼车 / 跑 CI）再申请合并槽，不 update-branch、不合并`);
      expect(w.slot()).toBe("T1"); // a member holds the slot, waiting at ready for the train's CI
      expect([w.phase("T1"), w.phase("T3")]).toEqual(["ready", null]);
      expect(w.db.query("SELECT status FROM scheduler_intents WHERE taskId='T3' AND action='merge'").all()).toEqual([]); // not unknown, not bounced
      expect(holdEvents(w)).toHaveLength(1); // one train event per card and phase, not one per pass
      w.hub.pending = false;
      const effects: string[][] = [];
      for (let i = 0; i < 8 && w.phase("T3") !== "merged"; i++) effects.push(await w.pass());
      expect(effects.flat()).toEqual(["match-head:1", "match-head:2", "update:3", "serial-merge:3"]);
      expect(w.store.load("p")).toMatchObject({ phase: "done", outcome: "merged" });
      expect(w.held.T3).toBeUndefined();
    } finally { w.close(); }
  });

  test("train settling: a card that becomes ready meanwhile waits for the slot, the members merge, then it goes on once the train is done", async () => {
    const w = world(4);
    try {
      await w.form([0, 1, 2]);
      w.db.query("UPDATE tasks SET stage='fix' WHERE id='T4'").run(); // not in merge yet when the train formed
      await w.pass(); await w.pass(); // assemble, then CI green → settling and T1 merges in the same pass
      expect(w.store.load("p")!.phase).toBe("settling");
      w.db.query("UPDATE tasks SET stage='merge' WHERE id='T4'").run();
      const order = ["T4", "T1", "T2", "T3"]; // T4 asks first every pass and still never gets the slot
      const effects: string[][] = [];
      for (let i = 0; i < 8 && w.store.load("p")!.phase === "settling"; i++) {
        effects.push(await w.pass(order));
        if (w.store.load("p")!.phase === "settling") expect(w.held.T4).toContain("逐张合并");
      }
      expect(effects.flat()).toEqual(["match-head:2", "match-head:3"]);
      expect(holdEvents(w).map((e) => e.data?.phase)).toEqual(["settling"]);
      for (let i = 0; i < 6 && w.phase("T4") !== "merged"; i++) await w.pass(order);
      expect(w.hub.calls).toEqual(["match-head:1", "match-head:2", "match-head:3", "update:4", "serial-merge:4"]);
      expect(w.store.load("p")).toMatchObject({ phase: "done", outcome: "merged" });
    } finally { w.close(); }
  });

  test("a train still testing or settling past the limit holds no one: the outside card takes the slot, voids it as timed out and goes on serially", async () => {
    const young = world(3, { startedAgo: HOLD_LIMIT_MS - 60_000 });
    try {
      young.hub.pending = true;
      await young.form([0, 1]);
      await young.pass(["T3", "T1", "T2"]);
      expect(young.held.T3).toContain("拼车 / 跑 CI");
      expect(young.slot()).toBe("T1");
    } finally { young.close(); }
    for (const phase of ["testing", "settling"] as const) {
      const w = world(3, { startedAgo: HOLD_LIMIT_MS + 60_000 });
      try {
        w.hub.pending = phase === "testing";
        await w.form([0, 1]);
        for (let i = 0; i < 6 && w.store.load("p")!.phase !== phase; i++) await w.pass([]);
        expect(w.store.load("p")!.phase).toBe(phase);
        w.plan(["T3"]); // the slot is free and the stuck train no longer holds T3
        expect(w.slot()).toBe("T3"); expect(w.held.T3).toBeUndefined();
        w.hub.calls.push("--");
        await w.pass([]);
        const s = w.store.load("p")!;
        expect(s).toMatchObject({ outcome: "void" });
        expect(s.reason).toContain("列车超时");
        expect(s.reason).toContain("放行串行合并 T3");
        for (let i = 0; i < 4 && w.phase("T3") !== "merged"; i++) await w.pass([]);
        expect(w.hub.calls.slice(w.hub.calls.indexOf("--") + 1)).toEqual(["serial-merge:3"]);
      } finally { w.close(); }
    }
  });

  test("after the train turns green every member merges in consecutive passes through its own merge intent, with no pass spent only waiting", async () => {
    const w = world(4);
    try {
      w.hub.pending = true;
      await w.form([0, 1, 2, 3]);
      await w.pass(); await w.pass(); // assembled, CI running; T1 holds the slot at ready
      expect([w.slot(), w.phase("T1")]).toEqual(["T1", "ready"]);
      w.hub.pending = false;
      const rounds: string[][] = [];
      for (let i = 0; i < 10 && w.store.load("p")!.phase !== "done"; i++) rounds.push(await w.pass());
      // green → settling → T1 merges in that same pass; each later pass settles one train step, merges the next member, plans the one after
      expect(rounds).toEqual([["match-head:1"], ["match-head:2"], ["match-head:3"], ["match-head:4"], [], []]); // then cleanup, done
      expect(w.store.load("p")!.outcome).toBe("merged");
      expect(w.db.query("SELECT taskId, status FROM scheduler_intents WHERE action='merge' ORDER BY eventSeq").all()).toEqual(
        ["T1", "T2", "T3", "T4"].map((taskId) => ({ taskId, status: "done" })));
      expect(w.slot()).toBeNull();
    } finally { w.close(); }
  });

  /** The card's own journal: the slot lent to the train (with the reason) and taken back. */
  const slotTurns = (w: ReturnType<typeof world>, id: string) => listEvents(w.db, { project: "p", target: id })
    .filter((e) => e.data.op === "merge_slot").map((e) => `${String(e.data.turn)} ${e.text}`);
  const overlapT1 = { files: (i: number) => (i === 2 ? "src/1.ts" : `src/${i + 1}.ts`) }; // T3 overlaps T1, so it can't share a car

  test("i28-MT1f2f2 line 1: an outsider already holding the slot at ready lends it to the testing train — no update-branch, no merge, a readable wait, the train goes on", async () => {
    const w = world(3, overlapT1);
    try {
      await w.begin("T3");
      expect([w.slot(), w.phase("T3")]).toEqual(["T3", "ready"]);
      expect(trainProjects(w.db, ["p"], w.store)).toEqual(["p"]); // ready can still ride or lend: the train may form around it
      w.hub.pending = true;
      const s = (await w.form([0, 1, 2]))!;
      expect(s.members.map((m) => m.taskId)).toEqual(["T1", "T2"]);
      for (let i = 0; i < 2; i++) expect(await w.pass()).toEqual([]);
      expect(w.store.load("p")).toMatchObject({ phase: "testing", outcome: null });
      expect([w.slot(), w.phase("T1"), w.phase("T3")]).toEqual(["T1", "ready", "ready"]); // the slot went to the train's first member
      const why = `T3 等第 1 辆列车 ${s.id} 结束（拼车 / 跑 CI）再申请合并槽，不 update-branch、不合并`;
      expect(slotTurns(w, "T3")).toEqual([`yield 合并队列：让出合并槽：${why}`]);
      expect(holdEvents(w).map((e) => e.text)).toEqual([why]);
      expect(w.db.query("SELECT status FROM scheduler_intents WHERE taskId='T3' AND action='merge'").all()).toEqual([{ status: "submitted" }]); // not unknown, not bounced
      expect(w.events.some((e) => e.kind === "void")).toBe(false);
      w.hub.pending = false;
      const effects: string[][] = [];
      for (let i = 0; i < 10 && w.phase("T3") !== "merged"; i++) effects.push(await w.pass());
      expect(effects.flat()).toEqual(["match-head:1", "match-head:2", "update:3", "serial-merge:3"]);
      expect(w.store.load("p")!.outcome).toBe("merged");
      expect(slotTurns(w, "T3")).toEqual([`yield 合并队列：让出合并槽：${why}`, "reclaim 合并队列：取回合并槽，接着合并"]);
    } finally { w.close(); }
  });

  test("i28-MT1f2f2 line 2: the same outsider while the train settles: the members merge one by one, then it takes the slot back and merges as usual", async () => {
    const w = world(3, overlapT1);
    try {
      await w.begin("T3");
      const s = (await w.form([0, 1, 2]))!;
      for (let i = 0; i < 2; i++) await stepTrain(w.store.load("p")!, w.deps); // assemble, CI green: settling before any merge pass ran
      expect(w.store.load("p")!.phase).toBe("settling");
      const rounds: string[][] = [];
      for (let i = 0; i < 10 && w.phase("T3") !== "merged"; i++) {
        rounds.push(await w.pass());
        if (w.store.load("p")!.phase === "settling") expect(w.slot()).not.toBe("T3");
      }
      expect(rounds.flat()).toEqual(["match-head:1", "match-head:2", "update:3", "serial-merge:3"]);
      expect(w.store.load("p")).toMatchObject({ phase: "done", outcome: "merged" });
      expect(slotTurns(w, "T3")).toEqual([`yield 合并队列：让出合并槽：T3 等第 1 辆列车 ${s.id} 结束（逐张合并）再申请合并槽，不 update-branch、不合并`,
        "reclaim 合并队列：取回合并槽，接着合并"]);
      expect(w.slot()).toBeNull();
    } finally { w.close(); }
  });

  test("i28-MT1f2f2 line 3: no new train while an outsider is merging (or unknown); once it settles the next pass forms one", async () => {
    const w = world(3);
    try {
      await w.begin("T3");
      for (const [phase, can] of [["ready", true], ["updating", true], ["await_ci", true], ["merging", false], ["merged", false]] as const) {
        w.db.query("UPDATE scheduler_merges SET phase=? WHERE taskId='T3'").run(phase);
        expect([phase, trainProjects(w.db, ["p"], w.store)]).toEqual([phase, can ? ["p"] : []]);
      }
      w.db.query("UPDATE scheduler_merges SET phase='merging' WHERE taskId='T3'").run();
      w.db.query("UPDATE scheduler_intents SET status='unknown' WHERE taskId='T3' AND action='merge'").run();
      expect(trainProjects(w.db, ["p"], w.store)).toEqual([]);
      w.db.query("UPDATE scheduler_merges SET phase='merged' WHERE taskId='T3'").run(); // the merge settles: intent done frees the slot
      w.db.query("UPDATE scheduler_intents SET status='done' WHERE taskId='T3' AND action='merge'").run();
      w.db.query("DELETE FROM scheduler_resources WHERE taskId='T3'").run();
      expect(trainProjects(w.db, ["p"], w.store)).toEqual(["p"]);
      expect((await w.form([0, 1]))!.members.map((m) => m.taskId)).toEqual(["T1", "T2"]);
      expect(trainProjects(w.db, ["p"], w.store)).toEqual(["p"]); // a live train is always stepped
      expect(trainProjects(w.db, ["p"], null)).toEqual(["p"]); // a test process has no store: unchanged
    } finally { w.close(); }
  });

  test("i28-MT1f2f2: a card that lent its slot to one train is not made to lend it again — no new train forms until it merged", async () => {
    const w = world(5, { files: (i) => (i === 2 ? "src/1.ts" : `src/${i + 1}.ts`) });
    try {
      await w.begin("T3");
      w.hub.pending = true;
      await w.form([0, 1, 2]);
      await w.pass([]); // T3 lends the slot
      expect(w.slot()).toBeNull();
      w.hub.main = newSha(); // main moves under the train: it is voided before any member merged
      for (let i = 0; i < 4 && w.store.load("p")!.phase !== "done"; i++) await w.pass([]);
      expect(w.store.load("p")).toMatchObject({ phase: "done", outcome: "void" });
      expect(w.phase("T3")).not.toBe("merged");
      expect(trainProjects(w.db, ["p"], w.store)).toEqual([]); // T4 + T5 could form a train, but T3 goes first
      for (let i = 0; i < 4 && w.phase("T3") !== "merged"; i++) await w.pass([]);
      expect(w.phase("T3")).toBe("merged");
      expect(trainProjects(w.db, ["p"], w.store)).toEqual(["p"]);
    } finally { w.close(); }
  });

  test("the merge step that lends or takes back the slot is refused once a merge may be in flight, or when the slot is not free", async () => {
    const w = world(2);
    try {
      const intent = await w.begin("T1");
      const step = (from: string, receipt: string) => runLedger(["scheduler-merge-step", intent, "--from", from, "--to", from, "--rev",
        String(getMergeRun(w.db, intent)!.rev), "--receipt", receipt], { db: w.db, actor: "scheduler", projectIds: ["p"],
        loadRegistry: async () => ({} as Registry), saveRegistry: async () => {}, now: () => Date.now() }) as Promise<Record<string, unknown>>;
      expect((await step("ready", "取回合并槽，接着合并")).error).toContain("本意图已占项目合并槽");
      expect((await step("ready", "让出合并槽：x")).ok).toBe(true);
      expect(w.slot()).toBeNull();
      expect((await step("ready", "让出合并槽：x")).error).toContain("本意图未占项目合并槽");
      w.plan(["T2"]);
      expect((await step("ready", "取回合并槽，接着合并")).error).toContain("项目合并槽仍被占用");
      w.db.query("DELETE FROM scheduler_resources WHERE taskId='T2'").run();
      expect((await step("ready", "取回合并槽，接着合并")).ok).toBe(true);
      expect(w.slot()).toBe("T1");
      w.db.query("UPDATE scheduler_merges SET phase='updating' WHERE intentId=?").run(intent);
      expect((await step("updating", "让出合并槽：x")).error).toContain("不能让出合并槽");
      w.db.query("UPDATE scheduler_merges SET phase='merging' WHERE intentId=?").run(intent);
      expect((await step("merging", "让出合并槽：x")).error).toContain("同阶段只接受");
      expect(w.slot()).toBe("T1");
    } finally { w.close(); }
  });
});

/**
 * i28-TRAINREPO1: the merge train never picks a card known to be outside the project's repository. Reviewer's scenario
 * (i28-SECPOOL4 r3 train-routing): two private-repo cards (auto, merge, review pass) first in line, trainMode on — the train
 * runs every pass before the autoDispatch gate (scheduler-pass.ts), so autoDispatch false does not stop it. Local ledger, fake GitHub.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { createTask } from "../src/lib/ledger-write.js";
import { mergeCandidates, mergeTrainTick, trainCandidates } from "../src/lib/scheduler-merge-train-tick.js";
import { projectRepoFor, setForeignRepoLookupForTest } from "../src/lib/scheduler-foreign-repo.js";
import { setTrainModeSource, trainMode } from "../src/lib/scheduler-merge-train-switch.js";
import type { TrainGh, TrainState, TrainStore } from "../src/lib/scheduler-merge-train.js";

const PUBLIC = "shawnlu96/claudestra", PRIVATE = "floka-ai/cloud";
const head = (i: number) => String(i).repeat(40).slice(0, 40);

function fixture(cards: { id: string; repo: string }[]) {
  const dir = mkdtempSync(join(tmpdir(), "trainrepo1-")), path = join(dir, "ledger.sqlite"), db = openLedger(path);
  const ctx = { actor: "owner", now: 100 };
  cards.forEach((c, i) => {
    createTask(db, ctx, { project: "p", id: c.id, title: c.id, kind: "code", agent: "agent-author" });
    setWorkflow(db, ctx, { taskId: c.id, taskRev: 1, template: "code", templateVersion: 2, mode: "auto", authorFamily: "claude", fallback: "缩小范围" });
    db.query("UPDATE tasks SET stage='merge', round=1, rev=2, headSHA=?, pr=?, branch=?, updatedAt=? WHERE id=?")
      .run(head(i + 1), `https://github.com/${c.repo}/pull/${i + 1}`, `task/${c.id}`, 100 + i, c.id);
    db.query("INSERT INTO events (ts,actor,project,target,kind,text,data) VALUES (100,'agent-review','p',?,'review','',?)").run(c.id, JSON.stringify({
      round: 1, head: head(i + 1), verdict: "pass", reviewer: "agent-review", reviewerSessionId: "s", reviewerFamily: "codex", path: "r.md",
      findings: [], p0: 0, p1: 0, p2: 0 }));
  });
  return { db, close: () => { closeLedger(path); rmSync(dir, { recursive: true, force: true }); } };
}

/** Two private cards first in line, then two public ones. */
const QUEUE = [{ id: "S1", repo: PRIVATE }, { id: "S2", repo: PRIVATE }, { id: "T1", repo: PUBLIC }, { id: "T2", repo: PUBLIC }];

afterEach(() => { setForeignRepoLookupForTest({ project: null, origin: null }); setTrainModeSource(null); });

describe("i28-TRAINREPO1 merge train skips foreign-repo cards", () => {
  test("reviewer scenario: trainMode on, private cards first in line — the formed train carries only the public cards", async () => {
    setForeignRepoLookupForTest({ project: () => PUBLIC });
    setTrainModeSource(() => "on");
    const f = fixture(QUEUE);
    try {
      expect(trainMode("p")).toBe("on");
      let state: TrainState | null = null;
      const store: TrainStore = { load: () => state, all: () => (state ? [state] : []), save: (s) => { state = structuredClone(s); },
        event: () => {}, nextSeq: () => 1 };
      const touched: string[] = [];
      const gh = { mainHead: async () => "f".repeat(40),
        prFiles: async (pr: string) => { touched.push(pr); return [`src/${pr.split("/").pop()}.ts`]; },
        prHead: async (pr: string) => head(Number(pr.split("/").pop())),
        createBranch: async () => {}, mergeInto: async () => "merged" as const, openDraft: async () => 1,
        checks: async () => [{ name: "check", bucket: "pending" as const }] } as unknown as TrainGh;
      await mergeTrainTick(f.db, ["p"], { notifyPm: async () => {}, now: () => 1 }, { gh, store }, () => ["check"]);
      expect(state).not.toBeNull();
      expect(state!.members.map((m) => m.taskId)).toEqual(["T1", "T2"]);
      expect(touched.some((pr) => pr.includes(PRIVATE))).toBe(false); // never even listed
    } finally { f.close(); }
  });

  test("both call shapes (train and the manual queue's { now } fairness check) leave private cards out", () => {
    setForeignRepoLookupForTest({ project: () => PUBLIC });
    const f = fixture(QUEUE);
    try {
      expect(trainCandidates(f.db, "p").map((c) => c.taskId)).toEqual(["T1", "T2"]);
      expect(mergeCandidates(f.db, "p", { now: 1 }).map((c) => c.taskId)).toEqual(["T1", "T2"]);
      const only = fixture([{ id: "S1", repo: PRIVATE }]);
      try { expect(mergeCandidates(only.db, "p", { now: 1 })).toEqual([]); } // owedToAuto sees no auto card owed
      finally { only.close(); }
    } finally { f.close(); }
  });

  test("project repository unknown: no verdict, private cards stay candidates; the lookup is read once per call", () => {
    let reads = 0;
    setForeignRepoLookupForTest({ project: () => { reads++; return null; } });
    const f = fixture(QUEUE);
    try {
      expect(trainCandidates(f.db, "p").map((c) => c.taskId)).toEqual(["S1", "S2", "T1", "T2"]);
      expect(mergeCandidates(f.db, "p", { now: 1 }).map((c) => c.taskId)).toEqual(["S1", "S2", "T1", "T2"]);
      expect(reads).toBe(2);
    } finally { f.close(); }
  });

  test("projectRepoFor goes through the injectable lookup; a case difference is the same repository", () => {
    setForeignRepoLookupForTest({ project: (p) => (p === "p" ? "ShawnLu96/Claudestra" : null) });
    expect(projectRepoFor("p")).toBe("ShawnLu96/Claudestra");
    expect(projectRepoFor("q")).toBeNull();
    const f = fixture([{ id: "T1", repo: "ShawnLu96/claudestra" }]);
    try { expect(trainCandidates(f.db, "p").map((c) => c.taskId)).toEqual(["T1"]); }
    finally { f.close(); }
  });
});

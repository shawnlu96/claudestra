/** i28-MT1f1: a corrupt merge-train state file fails closed in `all()` and in the merge override (never a plain merge). Fixtures: 本机 only. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { driveMerge, type MergeExternal, type PrSnapshot } from "../src/lib/scheduler-merge-driver.js";
import type { MergeRun } from "../src/lib/scheduler-merge.js";
import type { TrainGh, TrainState } from "../src/lib/scheduler-merge-train.js";
import { fileTrainStore, withMergeTrain } from "../src/lib/scheduler-merge-train-tick.js";

const BASE = "f".repeat(40), HEAD = "a".repeat(40), MERGED = "b".repeat(40);
const PR = "https://github.com/example/repo/pull/1";

let dir = "";
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "merge-train-store-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

/** A settling train whose only member T1 is cleared at HEAD, main still at its base. */
const settling = (): TrainState => ({
  v: 1, id: "p#1", seq: 1, project: "p", repo: "example/repo", base: BASE, phase: "settling", outcome: null, reason: null,
  members: [{ taskId: "T1", prRef: PR, head: HEAD, files: ["a"] }], cars: [], cleared: ["T1"], merged: [], bounced: [], serial: [],
  dropped: [], ciRuns: 1, startedAt: 1, updatedAt: 1, skip: [],
});

describe("fileTrainStore.all()", () => {
  test("no directory or no file = no train; a valid file lists its train", () => {
    expect(fileTrainStore(join(dir, "absent")).all()).toEqual([]);
    expect(fileTrainStore(dir).all()).toEqual([]);
    fileTrainStore(dir).save(settling());
    expect(fileTrainStore(dir).all().map((s) => s.id)).toEqual(["p#1"]);
  });

  test("a corrupt file throws like read(), never reads as no train", () => {
    fileTrainStore(dir).save(settling());
    writeFileSync(join(dir, "p.json"), "{ half-writ");
    expect(() => fileTrainStore(dir).all()).toThrow(/合并列车状态文件损坏/);
    expect(() => fileTrainStore(dir).load("p")).toThrow(/合并列车状态文件损坏/);
  });
});

/** One card in await_ci with green CI on an up-to-date branch; `onMerging` runs when the driver journals the merging claim. */
function harness(onMerging: () => void) {
  const calls: string[] = [];
  let merged: string | null = null;
  const gh = {
    mainHead: async () => (merged ? MERGED : BASE),
    prHead: async () => HEAD,
    parents: async () => [BASE, HEAD],
    mergeMatchHead: async (_pr: string, head: string) => { calls.push(`match-head:${head.slice(-4)}`); merged = MERGED; return MERGED; },
  } as unknown as TrainGh;
  const pr = (): PrSnapshot => ({ state: merged ? "MERGED" : "OPEN", head: HEAD, branch: "task/T1", base: "main", draft: false, crossRepository: false,
    mergeState: "CLEAN", mergeSha: merged, checks: [{ name: "check", bucket: "pass" }] });
  const base: MergeExternal = {
    inspect: async () => pr(),
    freshness: async () => ({ behindBy: 0, mainHead: BASE }),
    carryReview: async () => ({ ok: false, reason: "不沿用" }),
    updateBranch: async () => { calls.push("update"); },
    merge: async () => { calls.push("rest-merge"); merged = MERGED; return MERGED; },
  };
  let row: MergeRun = { intentId: "m-T1", taskId: "T1", project: "p", prRef: PR, expectedBranch: "task/T1", reviewedHead: HEAD,
    requiredChecks: "check", phase: "await_ci", rev: 1, mergeSha: null, reason: null, createdAt: 1, updatedAt: 1 };
  const external = withMergeTrain(base, { gh, store: fileTrainStore(dir) });
  const drive = () => driveMerge(row, external, async (from, to, rev, receipt, mergeSha) => {
    expect([from, rev]).toEqual([row.phase, row.rev]);
    row = { ...row, phase: to, rev: row.rev + 1, reason: receipt ?? null, mergeSha: mergeSha ?? row.mergeSha };
    if (to === "merging") onMerging();
    return row;
  });
  return { calls, drive };
}

describe("withMergeTrain().merge() over the state file", () => {
  test("the file corrupted after the train cleared the member and the merging claim: no merge of any kind, readable reason", async () => {
    fileTrainStore(dir).save(settling());
    const h = harness(() => writeFileSync(join(dir, "p.json"), "{ half-writ"));
    const row = await h.drive();
    expect(h.calls).toEqual([]); // neither base.merge (rest-merge) nor the head-pinned train merge
    expect(row.phase).toBe("unknown");
    expect(row.mergeSha).toBeNull();
    expect(row.reason).toContain("合并列车状态读不出来，本轮不合并（不退回普通合并）");
    expect(row.reason).toContain("合并列车状态文件损坏");
  });

  test("an intact file keeps the train path: cleared member merges head-pinned, not through base.merge", async () => {
    fileTrainStore(dir).save(settling());
    const h = harness(() => {});
    const row = await h.drive();
    expect(h.calls).toEqual(["match-head:aaaa"]);
    expect(row).toMatchObject({ phase: "merged", mergeSha: MERGED });
  });

  test("no train file at all is still a plain merge", async () => {
    const h = harness(() => {});
    const row = await h.drive();
    expect(h.calls).toEqual(["rest-merge"]);
    expect(row).toMatchObject({ phase: "merged", mergeSha: MERGED });
  });
});

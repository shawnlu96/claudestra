import { afterEach, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { getMergeRun } from "../src/lib/scheduler-merge.js";
import { RECOVERY_POLICY_PATH } from "../src/lib/recovery-policy.js";
import { mainCiWorld, writePolicy, type MainCiWorld } from "./scheduler-main-ci-wiring-world.test.js";
import { manualCard, requestArgs } from "./manual-merge-queue-world.test.js";
import type { ReclaimWorld } from "./scheduler-merge-reclaim-world.js";
let w: MainCiWorld;
afterEach(() => { w?.close(); rmSync(RECOVERY_POLICY_PATH, { force: true }); });
async function paused(mode: "on" | "off" | "observe") {
  mkdirSync(dirname(RECOVERY_POLICY_PATH), { recursive: true });
  w = mainCiWorld();
  writePolicy({ mergeQueueOwner: mode, manualMergeQueue: "on", manualCaseOwnership: "off", mainCiPause: "off" });
  const m = await manualCard(w as unknown as ReclaimWorld, "M");
  expect(await w.ledger("agent-pm", requestArgs(m))).toMatchObject({ ok: true });
  await w.pass();
  expect(w.intentOf("M")?.status).toBe("submitted");
  writePolicy({ mergeQueueOwner: mode, manualMergeQueue: "on", manualCaseOwnership: "off", mainCiPause: "on" });
  w.ci.bySha.set(w.hub.main, "failure");
  const repair = w.card("R");
  expect(await w.ledger("agent-pm", ["main-ci-repair", "R", "--head", repair.head, "--main", w.hub.main, "--reason", "修主线"])).toMatchObject({ ok: true });
  return w.intentOf("M")!.id;
}
test("[验收线 2] a manual holder yields to the bound repair and keeps its intent through repeated mergeSlotTurn/restart", async () => {
  const id = await paused("on");
  await w.pass();
  expect(w.db.query("SELECT taskId FROM scheduler_resources WHERE resource = 'merge:p'").get()).toEqual({ taskId: "R" });
  expect(w.intentOf("M")).toEqual({ id, status: "submitted" });
  expect(w.taskEvents("M").filter((e) => e.data.op === "merge_slot").map((e) => e.data.turn)).toEqual(["yield"]);
  w.restart();
  for (let n = 0; n < 6 && w.intentOf("R")?.status !== "done"; n++) await w.pass();
  expect(w.intentOf("R")?.status).toBe("done");
  expect(w.hub.calls.filter((x) => x.endsWith(":M"))).toEqual([]);
  expect(w.hub.calls.filter((x) => x.startsWith("failed:"))).toEqual([]);
  w.ci.defaultCi = "success";
  for (let n = 0; n < 8 && w.intentOf("M")?.status !== "done"; n++) await w.pass();
  expect(w.intentOf("M")).toEqual({ id, status: "done" });
  expect(getMergeRun(w.db, id)?.phase).toBe("merged");
}, 60_000);
test("[验收线 1] a repair binding alone cannot overtake stable queue order on healthy main", async () => {
  mkdirSync(dirname(RECOVERY_POLICY_PATH), { recursive: true }); w = mainCiWorld();
  writePolicy({ mergeQueueOwner: "on", manualMergeQueue: "on", manualCaseOwnership: "off", mainCiPause: "on" });
  const m = await manualCard(w as unknown as ReclaimWorld, "M");
  expect(await w.ledger("agent-pm", requestArgs(m))).toMatchObject({ ok: true });
  w.ci.bySha.set(w.hub.main, "failure");
  const r = w.card("R");
  expect(await w.ledger("agent-pm", ["main-ci-repair", "R", "--head", r.head, "--main", w.hub.main, "--reason", "修主线"])).toMatchObject({ ok: true });
  w.ci.bySha.set(w.hub.main, "success");
  await w.pass();
  expect(w.db.query("SELECT taskId FROM scheduler_resources WHERE resource = 'merge:p'").get()).toEqual({ taskId: "M" });
});

for (const mode of ["off", "observe"] as const) test(`[验收线 4] ${mode} keeps the old manual main-CI wait`, async () => {
  const id = await paused(mode);
  await w.pass();
  expect(w.db.query("SELECT intentId FROM scheduler_resources WHERE resource = 'merge:p'").get()).toEqual({ intentId: id });
  expect(w.taskEvents("M").filter((e) => e.data.op === "merge_slot")).toEqual([]);
  expect(w.intentOf("R")).toBeNull();
}, 60_000);

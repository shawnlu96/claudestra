/** Updating retries require the same transactional proof as other unsent phases, plus a precise send-stack attestation. */
import { expect, test } from "bun:test";
import { getIntent } from "../src/lib/ledger-scheduler.js";
import { getTask } from "../src/lib/ledger-store.js";
import { unsentRetryPlan } from "../src/lib/scheduler-merge-unsent-plan.js";
import { MAIN_CI_UPDATE_NOT_SENT } from "../src/lib/scheduler-merge-unsent-receipts.js";
import { useMainCiWorld, writePolicy } from "./scheduler-main-ci-wiring-world.test.ts";

const world = useMainCiWorld();
test("[验收线 2] updating retry rejects missing cause, counted attempts, missing attestation and broken adjacent proof", async () => {
  const w = world();
  writePolicy({ mainCiPause: "on", mergeUnsentCancel: "off" });
  w.card("C");
  const intent = await w.begin("C");
  await w.step(intent, "ready", "updating");
  await w.step(intent, "updating", "unknown", `${MAIN_CI_UPDATE_NOT_SENT}暂停`);
  const events = w.taskEvents("C"), marker = events.find((e) => e.data.op === "merge_unsent_cancel")!;
  const plan = (rows = events) => unsentRetryPlan(rows, getIntent(w.db, intent)!, getTask(w.db, "C")!);
  expect(plan()).toBe("retry");
  for (const patch of [{ cause: undefined }, { cause: "other" }, { counted: true }, { receipt: "main_ci_pause：暂停" }]) {
    expect(plan(events.map((e) => e === marker ? { ...e, data: { ...e.data, ...patch } } : e))).toBe("other");
  }
  expect(plan(events.filter((e) => e.seq !== marker.seq - 1))).toBe("other");
  expect(plan(events.filter((e) => e.seq !== marker.seq - 2))).toBe("other");
});

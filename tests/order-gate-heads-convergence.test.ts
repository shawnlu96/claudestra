import { test, expect } from "bun:test";
import { randomBytes } from "node:crypto";
import { fourRoundFix } from "./fix-strategy-helpers.js";
import { remoteProbe } from "./fix-strategy-remote-helpers.js";
import { fixSwapStep } from "../src/lib/fix-strategy-runtime.js";
import { listEvents } from "../src/lib/ledger-store.js";

test("acceptance 3: convergence gate refusal must record an alarm", async () => {
  const f = await fourRoundFix();
  try {
    const p = remoteProbe(f, ["peer A"]), intent = p.plan();
    p.deps.localFamilyWait = () => "本机不接codex";
    const foreignHead = randomBytes(20).toString("hex");
    p.deps.readReport = async () => `credential ${foreignHead}`;
    await fixSwapStep(f.db, f.at("scheduler"), intent.id, p.deps);
    await expect(fixSwapStep(f.db, f.at("scheduler"), intent.id, p.deps)).rejects.toThrow();
    const alarms = () => listEvents(f.db, { target: "T1" }).filter((e) => e.data.op === "gate_refused");
    expect(alarms()).toHaveLength(1);
    expect(alarms()[0]!.data.waiting).toContain("等本机执行者接手");
    expect(f.db.query("SELECT orderId FROM lend_orders WHERE taskId = 'T1'").all()).toEqual([]);
    expect(listEvents(f.db, { target: "T1" }).filter((e) => e.data.op === "fix_strategy")).toEqual([]);
    await expect(fixSwapStep(f.db, f.at("scheduler"), intent.id, p.deps)).rejects.toThrow();
    expect(alarms()).toHaveLength(1);
  } finally { f.close(); }
});

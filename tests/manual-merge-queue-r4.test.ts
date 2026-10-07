/** Expiry scanning must not decide whether a different head's approval permits this head to merge. */
import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { checkAsk } from "../src/lib/ask-bind.js";
import { closeAsk, getAsk } from "../src/lib/ledger-asks.js";
import { setMeta } from "../src/lib/ledger-write.js";
import { RECOVERY_POLICY_PATH } from "../src/lib/recovery-policy.js";
import { reclaimWorld, type ReclaimWorld } from "./scheduler-merge-reclaim-world.js";
import { answer, authorize, ledgerAs, manualCard, requestArgs, writePolicy } from "./manual-merge-queue-world.test.js";

let w: ReclaimWorld;
afterEach(() => { w?.close(); rmSync(RECOVERY_POLICY_PATH, { force: true }); });

for (const scanned of [false, true]) {
  test(`approval-expiry r4: expired open authorization, scan=${scanned}, another head never merges the original`, async () => {
    w = reclaimWorld({ store: "memory" });
    setMeta(w.db, { actor: "owner", now: 1 }, { project: "p", key: "pms", value: ["agent-pm"] });
    writePolicy("on");
    const m = await manualCard(w, "M");
    const binding = { askKey: "merge-current", params: { task: "M", head: m.head } };
    const a = authorize(w, "M", "merge-current", binding);
    expect(await ledgerAs(w, "agent-pm", ...requestArgs(m))).toMatchObject({ ok: true, state: "waiting" });
    // Simulate time passing without running the bridge's expiry scan.
    w.db.query("UPDATE asks SET expiresAt = ? WHERE id = ?").run(Date.now() - 1, a.id);
    if (scanned) closeAsk(w.db, a.id, "expired", "到期扫描", Date.now());
    const b = authorize(w, "M", "merge-current", { ...binding, params: { task: "M", head: "b".repeat(40) } });
    answer(w, b.id, "go");
    expect(getAsk(w.db, a.id)?.state).toBe(scanned ? "expired" : "superseded");
    expect(checkAsk(getAsk(w.db, b.id), a.bind!.paramsHash, "scheduler")).toMatchObject({ ok: false, reason: expect.stringMatching(/hash mismatch/) });
    // Run the actual sender too: a red baseline must record a real fake-GH merge, not stop at a helper assertion.
    const requested = await ledgerAs(w, "agent-pm", ...requestArgs(m));
    for (let i = 0; i < 4; i++) await w.pass();
    const merges = w.hub.calls.filter((c) => c.endsWith("merge:M")).length;
    console.log(JSON.stringify({ scanned, requested: requested.state, phase: w.phase("M"), merges }));
    expect(merges).toBe(0);
    expect(requested).toMatchObject({ ok: true, state: "waiting" });
    expect(w.intentOf("M")).toBeNull();
    expect(w.slot()).toBeNull();
    // Only a fresh approval of the original complete decision clears its expiry wait.
    answer(w, authorize(w, "M", "merge-current", binding).id, "go");
    for (let i = 0; i < 4 && w.phase("M") !== "merged"; i++) await w.pass();
    expect([w.phase("M"), w.hub.calls.filter((c) => c.endsWith("merge:M")).length]).toEqual(["merged", 1]);
  }, 30_000);
}

/**
 * MQ1S: in a mergeHandoff project (scheduler.json, MHO1: the repository owner merges) a manual merge request is never silent. The
 * request CLI refuses it with the handoff reason; one queued before the project switched to handoff shows void with that reason in
 * `ledger merge-queue` in every mode (on / observe / off), and the pass neither claims nor sends a merge for it. On the real ledger CLI
 * + real schedulerPass + fake GitHub (tests/scheduler-merge-reclaim-world.ts). A normal project with the same policies keeps its
 * behaviour: on merges once, observe only records the would-be claim, off claims nothing.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { setMeta } from "../src/lib/ledger-write.js";
import { RECOVERY_POLICY_PATH } from "../src/lib/recovery-policy.js";
import { SCHEDULER_CONFIG_PATH } from "../src/lib/scheduler-config.js";
import { reclaimWorld, type ReclaimWorld } from "./scheduler-merge-reclaim-world.js";
import { ledgerAs, manualCard, requestArgs, writePolicy } from "./manual-merge-queue-world.test.js";

const PM = "agent-pm";
let w: ReclaimWorld;
afterEach(() => { w?.close(); rmSync(RECOVERY_POLICY_PATH, { force: true }); rmSync(SCHEDULER_CONFIG_PATH, { force: true }); });

/** scheduler.json as the ledger CLI reads it (the world hands the pass the same project config). */
const writeConfig = (handoff: boolean) => writeFileSync(SCHEDULER_CONFIG_PATH, JSON.stringify({ enabled: true, autoDispatch: true,
  projects: { p: { maxActiveWorkers: 2, requiredChecks: ["check"], repoDir: "/tmp/p", ...(handoff ? { mergeHandoff: true } : {}) } } }));
const merges = (id: string) => w.hub.calls.filter((c) => c.endsWith(`merge:${id}`)).length;
const count = (sql: string) => (w.db.query(sql).get() as { n: number }).n;
const claims = () => count("SELECT COUNT(*) AS n FROM events WHERE json_extract(data, '$.op') = 'manual_merge_claim'");
const observed = () => count("SELECT COUNT(*) AS n FROM events WHERE json_extract(data, '$.op') = 'recovery_observe' AND json_extract(data, '$.mechanism') = 'manualMergeQueue'");
const view = async () => (await ledgerAs(w, PM, "merge-queue", "--project", "p")) as { ok: boolean; manual: { rows: { state: string; why: string | null }[] }; lines: string[] };

function setup(mode: "on" | "observe" | "off", handoff: boolean) {
  w = reclaimWorld({ store: "memory", handoff });
  setMeta(w.db, { actor: "owner", now: 1 }, { project: "p", key: "pms", value: [PM] });
  writePolicy(mode);
}

/** Nothing local happened for the request: no claim, no intent, no slot, no merge call, no observe note. */
const nothingLocal = () => expect([claims(), observed(), w.intentOf("M"), w.slot(), merges("M")]).toEqual([0, 0, null, null, 0]);

describe("P1 handoff: a manual request in a mergeHandoff project is refused or shown void with the reason", () => {
  for (const mode of ["on", "observe", "off"] as const) {
    test(`policy ${mode}: the request CLI refuses with the handoff reason; the pass claims and merges nothing`, async () => {
      setup(mode, true);
      writeConfig(true);
      const m = await manualCard(w, "M");
      const r = await ledgerAs(w, PM, ...requestArgs(m));
      expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/mergeHandoff.*仓库方/) });
      for (let i = 0; i < 3; i++) await w.pass();
      nothingLocal();
      expect((await view()).ok).toBe(true);
    }, 30_000);

    test(`policy ${mode}: a request queued before the switch to handoff shows void with the reason; nothing is claimed or sent`, async () => {
      setup(mode, true);
      writeConfig(false);
      const m = await manualCard(w, "M");
      expect(await ledgerAs(w, PM, ...requestArgs(m))).toMatchObject({ ok: true, state: "queued" });
      writeConfig(true);
      for (let i = 0; i < 3; i++) await w.pass();
      nothingLocal();
      const v = await view();
      expect(v.manual.rows).toEqual([expect.objectContaining({ state: "void", why: expect.stringMatching(/mergeHandoff/) })]);
      expect(v.lines.join("\n")).toMatch(/人工#\d+ M｜已失效.*mergeHandoff/);
    }, 30_000);
  }
});

describe("normal (non-handoff) project: on / observe / off unchanged", () => {
  test("on: queued, merges exactly once", async () => {
    setup("on", false);
    writeConfig(false);
    const m = await manualCard(w, "M");
    expect(await ledgerAs(w, PM, ...requestArgs(m))).toMatchObject({ ok: true, state: "queued" });
    for (let i = 0; i < 5 && w.phase("M") !== "merged"; i++) await w.pass();
    await w.pass();
    expect([w.phase("M"), merges("M"), claims()]).toEqual(["merged", 1, 1]);
  }, 30_000);

  test("observe: the would-be claim is recorded once with a readable action; no claim, no merge", async () => {
    setup("observe", false);
    const m = await manualCard(w, "M"); // no scheduler.json at all: not a handoff project
    expect(await ledgerAs(w, PM, ...requestArgs(m))).toMatchObject({ ok: true, state: "queued" });
    for (let i = 0; i < 3; i++) await w.pass();
    expect([claims(), observed(), w.intentOf("M"), merges("M")]).toEqual([0, 1, null, 0]);
    const note = w.db.query("SELECT text FROM events WHERE json_extract(data, '$.op') = 'recovery_observe'").get() as { text: string };
    expect(note.text).toMatch(/本会 给人工合并请求 #\d+（M @/);
    expect((await view()).lines.join("\n")).toMatch(/人工合并排队策略：observe[\s\S]*人工#\d+ M｜排队/);
  }, 30_000);

  test("off: queued and shown, nothing claimed or recorded", async () => {
    setup("off", false);
    writeConfig(false);
    const m = await manualCard(w, "M");
    expect(await ledgerAs(w, PM, ...requestArgs(m))).toMatchObject({ ok: true, state: "queued" });
    for (let i = 0; i < 3; i++) await w.pass();
    nothingLocal();
    expect((await view()).lines.join("\n")).toMatch(/人工合并排队策略：off[\s\S]*人工#\d+ M｜排队/);
  }, 30_000);
});

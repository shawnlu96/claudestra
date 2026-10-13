/**
 * merge-arch-MRGPIPE1 · the merge-slot pipe in the real schedulerPass world (real ledger CLI, fake GitHub, deploy on, the switches
 * claude-orchestrator runs with): T1 holds the slot at await_ci with its CI pending, T2 is green with disjoint files. With
 * mergePipe on, T1 lends the slot through the same-phase SLOT_YIELD step, T2 is planned and merged in that pass, and T1 takes the
 * slot back once T2's deploy ends and merges behind main, never updated. Pure judgments: scheduler-merge-pipe-judge.test.ts.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { setMeta } from "../src/lib/ledger-write.js";
import { listEvents } from "../src/lib/ledger-store.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { RECOVERY_POLICY_PATH } from "../src/lib/recovery-policy.js";
import { mergePipeHold, useMergePipeReads } from "../src/lib/scheduler-merge-pipe.js";
import { reclaimWorld, type ReclaimWorld, type WorldOpts } from "./scheduler-merge-reclaim-world.js";
import { ledgerAs, manualCard, requestArgs } from "./manual-merge-queue-world.test.js";

type Mode = "on" | "observe" | "off";
let w: ReclaimWorld;
afterEach(() => { w?.close(); rmSync(RECOVERY_POLICY_PATH, { force: true }); });

/** mergeUnion off: a DIRTY borrower bounces as before, without a local union trial in /tmp/p. */
const policy = (pipe: Mode, direct: Mode = "on", keys: Record<string, Mode> = {}) => writeFileSync(RECOVERY_POLICY_PATH,
  JSON.stringify({ projects: { p: { keys: { mergeDirect: direct, mergePipe: pipe, mergeUnion: "off", ...keys } } } }));
const merges = (calls = w.hub.calls) => calls.filter((c) => /^(serial-merge|match-head):/.test(c)).map((c) => c.split(":")[1]);
const pipeNotes = () => listEvents(w.db, { project: "p" }).filter((e) => e.data.mechanism === "mergePipe");
const slotEvents = () => listEvents(w.db, { project: "p" }).filter((e) => e.data.op === "merge_slot" || /MRGPIPE|mergePipe/.test(e.text));
/** Cards enter merge in this order (the `stage → merge` event mergeFirst orders the queue by). */
const enter = (...ids: string[]) => { for (const id of ids) insertEvent(w.db, { actor: "scheduler", now: Date.now() },
  { project: "p", target: id, kind: "stage", text: "", data: { from: "review", to: "merge", round: 1 } }, false); };
const intentOpen = (id: string) => !!w.db.query("SELECT 1 FROM scheduler_intents WHERE taskId = ? AND action = 'merge'").get(id);

/** T1 (pending CI) then T2 (green): the first pass plans T1's merge and leaves it at await_ci, T2's plan is refused (slot). */
async function holding(pipe: Mode, o: Partial<WorldOpts> = {}, direct: Mode = "on", keys: Record<string, Mode> = {}) {
  w = reclaimWorld({ store: "memory", deploy: true, live: true, ...o });
  policy(pipe, direct, keys);
  w.card("T1"); w.card("T2");
  w.hub.ci.set("T1", "pending");
  expect(await w.pass()).toEqual([]);
  expect([w.phase("T1"), w.slot(), intentOpen("T2")]).toEqual(["await_ci", "T1", false]);
}
/** `n` passes with T1 pending, then T1 green and passes until both merged (at most 8); every pass's own calls. */
async function run(n: number): Promise<string[][]> {
  const passes: string[][] = [];
  for (let i = 0; i < n; i++) passes.push(await w.pass());
  w.hub.ci.delete("T1");
  for (let i = 0; i < 8 && (w.phase("T1") !== "merged" || w.phase("T2") !== "merged"); i++) passes.push(await w.pass());
  passes.push(await w.pass());
  return passes;
}
/** The same scenario with mergePipe off: the calls main makes. */
async function offCalls(o: Partial<WorldOpts> = {}, n = 3): Promise<string[]> {
  await holding("off", o);
  await run(n);
  const calls = [...w.hub.calls];
  w.close(); rmSync(RECOVERY_POLICY_PATH, { force: true });
  return calls;
}

describe("MRGPIPE1 on: T1 lends the slot while its CI runs", () => {
  test("[验收线 1] T2 merges in the lending pass, T1 waits unchanged, takes the slot back after T2's deploy and merges; T2, T1, no update", async () => {
    await holding("on");
    const t1Head = (w.db.query("SELECT headSHA FROM tasks WHERE id = 'T1'").get() as { headSHA: string }).headSHA;
    const lend = await w.pass();
    expect(w.turns("T1")).toEqual(["yield"]);
    expect(lend).toEqual(["serial-merge:T2"]); // exactly one merge call this pass: T2's
    expect([w.phase("T1"), w.phase("T2"), w.slot()]).toEqual(["await_ci", "merged", "T2"]);
    expect([...w.hub.heads.values()]).toContain(t1Head);
    w.hub.ci.delete("T1");
    const later: string[][] = [];
    for (let i = 0; i < 6 && w.phase("T1") !== "merged"; i++) later.push(await w.pass());
    const back = later.findIndex((c) => c.includes("serial-merge:T1"));
    expect(back).toBeGreaterThan(-1);
    expect(later.slice(0, back).flat()).toEqual(["deploy:T2"]); // the slot stays with T2 until its deploy ends
    expect(w.turns("T1")).toEqual(["yield", "reclaim"]); // taken back and merged in that same pass
    await w.pass();
    expect(merges()).toEqual(["T2", "T1"]);
    expect(w.hub.calls.filter((c) => c.startsWith("update:"))).toEqual([]);
  }, 60_000);

  test("[验收线 1] red on main's behaviour (off): T2's plan stays refused, 0 merges until T1 is green, T2 merges after T1", async () => {
    await holding("off");
    for (let i = 0; i < 3; i++) await w.pass(); // T2's plan is refused every pass: 资源 … 与 … 重叠（T1 占用）
    expect([merges(), intentOpen("T2"), w.turns("T1"), w.slot()]).toEqual([[], false, [], "T1"]);
    await run(0);
    expect(merges()).toEqual(["T1", "T2"]);
  }, 60_000);
});

describe("MRGPIPE1 overlapping files never lend", () => {
  const cases: [string, (n: number) => string | string[]][] = [
    ["same file", (n) => (n === 2 ? "src/1.ts" : `src/${n}.ts`)],
    ["recovery-keys.ts on both sides", (n) => [`src/${n}.ts`, "src/lib/recovery-keys.ts"]],
    ["T2 renamed T1's file (old path listed)", (n) => (n === 2 ? ["src/renamed.ts", "src/1.ts"] : `src/${n}.ts`)],
  ];
  for (const [what, files] of cases) {
    test(`[验收线 2] ${what}: T1 keeps the slot, T2 queues, GitHub sees the same calls as with mergePipe off`, async () => {
      const off = await offCalls({ files });
      await holding("on", { files });
      await run(3);
      expect(w.turns("T1")).toEqual([]);
      expect(w.hub.calls).toEqual(off);
      expect(merges()).toEqual(["T1", "T2"]);
    }, 60_000);
  }
});

describe("MRGPIPE1 modes", () => {
  test("[验收线 3] observe: one deduplicated mergePipe note over many passes, no slot turn, GitHub calls as off", async () => {
    const off = await offCalls();
    await holding("observe");
    await run(3);
    const notes = pipeNotes();
    expect(notes.length).toBe(1);
    expect(notes[0]!.target).toBe("T1");
    expect(String(notes[0]!.data.actionKey ?? notes[0]!.text)).toMatch(/T2/);
    expect(w.turns("T1")).toEqual([]);
    expect(w.hub.calls).toEqual(off);
  }, 60_000);

  test("[验收线 3] off: no PR read by the step, no note, no slot turn, GitHub calls as main", async () => {
    let reads = 0;
    using _reads = useMergePipeReads({ inspect: async () => { reads++; throw new Error("off 不该读 PR"); },
      files: async () => { reads++; throw new Error("off 不该读文件表"); } });
    await holding("off");
    await run(3);
    expect([reads, pipeNotes().length, slotEvents().length]).toEqual([0, 0, 0]);
    expect(merges()).toEqual(["T1", "T2"]);
  }, 60_000);

  for (const direct of ["observe", "off"] as const) {
    test(`[验收线 3] mergeDirect ${direct}, mergePipe on: nothing is lent`, async () => {
      w = reclaimWorld({ store: "memory", deploy: true, live: true });
      policy("on", direct);
      w.card("T1"); w.card("T2");
      w.hub.ci.set("T1", "pending");
      for (let i = 0; i < 4; i++) await w.pass();
      expect([w.turns("T1"), merges(), pipeNotes().length]).toEqual([[], [], 0]);
    }, 60_000);
  }
});

describe("MRGPIPE1 refusals in the pass", () => {
  test("[验收线 4] another card's manual merge request is queued: T1 does not lend", async () => {
    await holding("on", {}, "on", { manualMergeQueue: "on" });
    setMeta(w.db, { actor: "owner", now: 1 }, { project: "p", key: "pms", value: ["agent-pm"] });
    const m = await manualCard(w, "M");
    expect(await ledgerAs(w, "agent-pm", ...requestArgs(m))).toMatchObject({ ok: true, state: "queued" });
    for (let i = 0; i < 3; i++) await w.pass();
    expect([w.turns("T1"), merges()]).toEqual([[], []]);
  }, 60_000);

  test("[验收线 4] store \"default\" (no store in a test process): T1 does not lend", async () => {
    await holding("on", { store: "default" });
    for (let i = 0; i < 3; i++) await w.pass();
    expect([w.turns("T1"), merges(), pipeNotes().length]).toEqual([[], [], 0]);
  }, 60_000);
});

describe("MRGPIPE1 candidates per pass", () => {
  test("[验收线 4] at most 3 borrower PRs are read per pass: three pending cards ahead of T2 keep it from being reached", async () => {
    w = reclaimWorld({ store: "memory", deploy: true, live: true });
    policy("on");
    for (const id of ["T1", "A", "B", "C", "T2"]) w.card(id);
    enter("T1", "C", "B", "A", "T2");
    for (const id of ["T1", "A", "B", "C"]) w.hub.ci.set(id, "pending");
    await w.pass();
    for (let i = 0; i < 3; i++) await w.pass();
    expect([w.turns("T1"), merges()]).toEqual([[], []]);
    w.hub.ci.delete("A");
    await w.pass();
    expect([w.turns("T1"), merges()]).toEqual([["yield"], ["A"]]);
  }, 60_000);
});

describe("MRGPIPE1 between the lend and the plan", () => {
  test("[验收线 5] T3 entered merge before T2 with CI pending: it gets the mergePipeHold reason, is not planned, the slot goes to T2", async () => {
    w = reclaimWorld({ store: "memory", deploy: true, live: true });
    policy("on");
    w.card("T1"); w.card("T2"); w.card("T3");
    enter("T1", "T3", "T2");
    w.hub.ci.set("T1", "pending"); w.hub.ci.set("T3", "pending");
    await w.pass();
    let hold: string | null = null;
    const calls = await w.pass({ afterManager: (a, r) => {
      if (a[1] === "scheduler-merge-step" && r.ok === true && /MRGPIPE/.test(a.join(" "))) hold = mergePipeHold(w.db, { id: "T3", project: "p" });
    } });
    expect(hold).toMatch(/MRGPIPE/);
    expect(mergePipeHold(w.db, { id: "T2", project: "p" })).toBeNull();
    expect([calls, w.turns("T1"), intentOpen("T3"), w.slot()]).toEqual([["serial-merge:T2"], ["yield"], false, "T2"]);
  }, 60_000);

  test("[验收线 5] the borrower is not planned (budget): the slot stays free, nobody else plans; T1 takes it back and never lends to that T2 head again", async () => {
    w = reclaimWorld({ store: "memory", deploy: true, live: true });
    policy("on");
    w.card("T1"); w.card("T2"); w.card("T3");
    enter("T1", "T3", "T2");
    w.hub.ci.set("T1", "pending"); w.hub.ci.set("T3", "pending");
    await w.pass();
    const calls = await w.pass({ budgetMs: 1 });
    expect([calls, w.turns("T1"), w.slot(), intentOpen("T2"), intentOpen("T3")]).toEqual([[], ["yield"], null, false, false]);
    for (let i = 0; i < 4; i++) await w.pass();
    expect([w.turns("T1"), w.slot(), merges()]).toEqual([["yield", "reclaim"], "T1", []]);
    w.hub.ci.delete("T1"); w.hub.ci.delete("T3");
    for (let i = 0; i < 10 && merges().length < 3; i++) await w.pass();
    expect(merges()[0]).toBe("T1");
    expect(w.turns("T1")).toEqual(["yield", "reclaim"]);
  }, 60_000);

  test("[验收线 5] the borrower turns DIRTY after the lend, before its claim: it bounces, the slot frees, T1 takes it back next pass", async () => {
    await holding("on");
    const lent = (a: string[], r: Record<string, unknown>) => a[1] === "scheduler-merge-step" && r.ok === true && /MRGPIPE/.test(a.join(" "));
    const calls = await w.pass({ afterManager: (a, r) => { if (lent(a, r)) w.hub.dirty.add("T2"); } });
    expect([calls, w.phase("T2"), w.slot(), w.turns("T1")]).toEqual([[], "resolved", null, ["yield"]]);
    await w.pass();
    expect([w.turns("T1"), w.slot(), w.phase("T1")]).toEqual([["yield", "reclaim"], "T1", "await_ci"]);
    expect(merges()).toEqual([]);
  }, 60_000);
});

describe("MRGPIPE1 one merge call at a time", () => {
  test("[验收线 6] T1 goes green while T2 deploys: no T1 merge until it holds the slot again, then no more lends; ≤1 merge per pass", async () => {
    await holding("on");
    const passes = [await w.pass()];
    expect(passes[0]).toEqual(["serial-merge:T2"]);
    w.hub.ci.delete("T1");
    for (let i = 0; i < 6 && w.phase("T1") !== "merged"; i++) {
      const before = w.slot();
      passes.push(await w.pass());
      if (merges(passes.at(-1)!).includes("T1")) expect(before).toBe("T2"); // T2's deploy ended in this very pass, then reclaim
      else expect(w.slot()).toBe("T2");
    }
    for (let i = 0; i < 2; i++) passes.push(await w.pass());
    for (const p of passes) expect(merges(p).length).toBeLessThanOrEqual(1);
    expect(merges()).toEqual(["T2", "T1"]);
    expect(w.turns("T1")).toEqual(["yield", "reclaim"]);
  }, 60_000);
});

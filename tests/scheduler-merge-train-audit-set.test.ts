/**
 * dispatch-recovery-TRAINSET1 (audit a03 A03-02): a merge train releases only a member set that passed CI together. Real engine
 * (formTrain / stepTrain / trainGate / the driver hook) over a fake GitHub whose CI verdict is a rule on the exact heads a car
 * holds, a state file in a temp directory, synthetic cards only.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { driveMerge, type MergeExternal } from "../src/lib/scheduler-merge-driver.js";
import type { MergeRun } from "../src/lib/scheduler-merge.js";
import {
  clearedMember, formTrain, recheckCleared, stepTrain, trainGate, trainView, type MemberStatus, type TrainDeps, type TrainEvent, type TrainGh,
  type TrainState,
} from "../src/lib/scheduler-merge-train.js";
import { jointlyProven, proofFor, provenHeads } from "../src/lib/scheduler-merge-train-set.js";
import { setTrainModeSource } from "../src/lib/scheduler-merge-train-switch.js";
import { fileTrainStore, withMergeTrain } from "../src/lib/scheduler-merge-train-tick.js";

const REPO = "example/repo", BASE = "b".repeat(40), NAMES = ["A", "B", "C", "D"] as const;
const sha = (n: number) => n.toString(16).padStart(40, "0");
const HEAD: Record<string, string> = { A: sha(0xa1), B: sha(0xb2), C: sha(0xc3), D: sha(0xd4) };
const prOf = (id: string) => `https://github.com/${REPO}/pull/${NAMES.indexOf(id as "A") + 1}`;
const letters = (heads: readonly string[]) => NAMES.filter((n) => heads.includes(HEAD[n]!)).join("");

let dir = "";
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "train-set-")); setTrainModeSource(() => "on"); });
afterEach(() => { setTrainModeSource(null); rmSync(dir, { recursive: true, force: true }); });

/** Its own state directory per world. A car is red when `red` says so for the member letters it holds, e.g. "ABCD" → true. Every CI verdict asked is in `ran`. */
function world(ids: readonly string[], red: (car: string) => boolean) {
  const w = {
    main: BASE, seq: 0x1000, heads: { ...HEAD } as Record<string, string>, branches: new Map<string, { at: string; heads: string[] }>(),
    drafts: [] as string[], parents: new Map<string, string[]>(), ran: [] as string[], merges: [] as string[], updates: [] as string[],
    status: new Map<string, MemberStatus>(), notices: [] as { text: string; alarm: boolean }[], events: [] as TrainEvent[], pending: false,
  };
  const gh: TrainGh = {
    mainHead: async () => w.main,
    prFiles: async (pr) => [`src/${pr.split("/").pop()}.ts`],
    prHead: async (pr) => w.heads[NAMES[Number(pr.split("/").pop()) - 1]!]!,
    createBranch: async (_r, b, at) => { w.branches.set(b, { at, heads: [] }); },
    mergeInto: async (_r, b, head) => { const br = w.branches.get(b)!; if (!br.heads.includes(head)) br.heads.push(head); return "merged"; },
    openDraft: async (_r, b) => (w.drafts.includes(b) ? w.drafts.indexOf(b) : w.drafts.push(b) - 1) + 500,
    checks: async (_r, n) => {
      if (w.pending) return [{ name: "check", bucket: "pending" }];
      const car = letters(w.branches.get(w.drafts[n - 500]!)!.heads);
      if (w.ran.at(-1) !== car) w.ran.push(car);
      return red(car) ? [{ name: "check", bucket: "fail", link: "https://github.com/example/repo/actions/runs/7/job/1" }] : [{ name: "check", bucket: "pass" }];
    },
    failLog: async () => "error TS2304: main does not compile",
    parents: async (_r, c) => w.parents.get(c) ?? [sha(++w.seq)],
    mergeMatchHead: async (pr, head) => {
      const id = NAMES[Number(pr.split("/").pop()) - 1]!, at = sha(++w.seq);
      if (w.heads[id] !== head) throw new Error("head moved");
      w.parents.set(at, [w.main, head]); w.main = at; w.merges.push(id); w.status.set(id, { kind: "merged", sha: at });
      return at;
    },
    closePr: async () => {}, deleteBranch: async (_r, b) => { w.branches.delete(b); },
  };
  const home = mkdtempSync(join(dir, "w-")), file = fileTrainStore(home), saves: TrainState[] = [];
  const store = { ...file, save: (s: TrainState) => { saves.push(structuredClone(s)); file.save(s); },
    event: (_p: string, ev: TrainEvent) => { w.events.push(ev); } };
  const deps: TrainDeps = { gh, store, now: () => 1_000, requiredChecks: ["check"], memberStatus: (id) => w.status.get(id) ?? { kind: "waiting" },
    notify: async (_s, text, alarm) => { w.notices.push({ text, alarm }); } };
  const cards = ids.map((id) => ({ taskId: id, prRef: prOf(id), head: HEAD[id]! }));
  const load = () => store.load("p");
  const tick = async () => { const live = load(); return live && live.phase !== "done" ? stepTrain(live, deps) : formTrain("p", cards, deps); };
  const until = async (ok: (s: TrainState) => boolean, max = 30) => {
    for (let i = 0; i < max; i++) { const s = await tick(); if (s && ok(s)) return s; }
    throw new Error(`the train never got there: ${JSON.stringify(load())}`);
  };
  const run = (id: string): MergeRun => ({ intentId: `m-${id}`, taskId: id, project: "p", prRef: prOf(id), expectedBranch: `task/${id}`,
    reviewedHead: HEAD[id]!, requiredChecks: "check", phase: "ready", rev: 1, mergeSha: null, reason: null, createdAt: 1, updatedAt: 1 });
  const gate = (id: string) => trainGate(load(), run(id), deps);
  /** Someone outside the train merges `head` (default: an unknown commit) straight into main. */
  const pushMain = (head = sha(++w.seq)) => { const at = sha(++w.seq); w.parents.set(at, [w.main, head]); w.main = at; };
  return { w, gh, store, saves, deps, home, cards, load, tick, until, run, gate, pushMain };
}
type World = ReturnType<typeof world>;

const phase = (p: TrainState["phase"]) => (s: TrainState) => s.phase === p;
const cars = (s: TrainState) => s.cars.map((c) => `${c.members.join("")}:${c.status}${c.confirm ? ":confirm" : ""}`);
const confirmCar = (s: TrainState) => s.cars.find((c) => c.confirm);
/** The audit's four members: D is red alone, and A+C are red together though each half passes. */
const AUDIT = (car: string) => car.includes("D") || (car.includes("A") && car.includes("C"));
const ONLY_D = (car: string) => car.includes("D");

/** One pass of the real serial merge driver for `id` over the same fake GitHub, through the production train hook. */
async function serialPass(env: World, id: string, forkedFrom: string) {
  let row = env.run(id);
  const base: MergeExternal = {
    inspect: async () => ({ state: "OPEN", head: HEAD[id]!, branch: `task/${id}`, base: "main", draft: false, crossRepository: false, mergeState: "CLEAN",
      mergeSha: null, checks: [{ name: "check", bucket: "pass" }] }),
    freshness: async () => ({ behindBy: env.w.main === forkedFrom ? 0 : 1, mainHead: env.w.main }),
    carryReview: async () => ({ ok: false, reason: "不沿用" }),
    updateBranch: async () => { env.w.updates.push(id); },
    merge: async () => { throw new Error("no merge expected before the card re-ran CI on current main"); },
  };
  await driveMerge(row, withMergeTrain(base, { gh: env.gh, store: env.store }), async (_from, to, _rev, receipt) => (row = { ...row, phase: to, rev: row.rev + 1, reason: receipt ?? null }));
  return row;
}

describe("[验收线 1] ABCD red, AB green, CD red, C green, D red, ABC red because of A+C: ABC is never released", () => {
  test("the bisect only locates D; the confirmation car of ABC is red, so A, B and C go serial and re-check against current main", async () => {
    const env = world(NAMES, AUDIT), { w } = env;
    const local = await env.until((s) => !!confirmCar(s) || s.phase !== "testing");
    expect(w.ran).toEqual(["ABCD", "AB", "CD", "C", "D"]);
    // The local greens are recorded, but they are not a release: the gate waits (the old engine answered cleared for all three,
    // and A+C on main does not compile), there is no proof, and the override finds no cleared member.
    expect([await env.gate("A"), await env.gate("B"), await env.gate("C")]).toEqual(["wait", "wait", "wait"]);
    expect(local).toMatchObject({ phase: "testing", cleared: ["A", "B", "C"] });
    expect(local.proof).toBeUndefined();
    expect(local.bounced.map((b) => b.taskId)).toEqual(["D"]);
    expect(clearedMember(env.store.all(), prOf("A"), HEAD.A!)).toBeNull();

    const s = await env.until((x) => x.phase !== "testing");
    expect(w.ran).toEqual(["ABCD", "AB", "CD", "C", "D", "ABC"]);
    expect(cars(s)).toEqual(["ABCD:split", "AB:green", "CD:split", "C:green", "D:red", "ABC:red:confirm"]);
    expect(s).toMatchObject({ phase: "settling", cleared: [], ciRuns: 5, confirmRuns: 1 });
    expect(s.proof).toBeUndefined();
    expect([...s.serial].sort()).toEqual(["A", "B", "C"]);
    expect(s.cars.filter((c) => c.parent === confirmCar(s)!.id)).toEqual([]); // the confirmation car is never bisected again
    expect(w.notices.filter((n) => n.alarm).map((n) => n.text).join()).toMatch(/确认车 .* 整体CI 红.*A、B、C 回串行路径，各自按当前 main 重新核/);
    expect(trainView(s)).toContain("CI 5 次，确认车 1 次");
    // Nobody is cleared, at the gate or through the merge override; D still gets its own bounce.
    for (const id of ["A", "B", "C"]) expect(await env.gate(id)).not.toBe("cleared");
    for (const id of ["A", "B", "C"]) expect(clearedMember(env.store.all(), prOf(id), HEAD[id]!)).toBeNull();
    expect(await env.gate("D")).toEqual({ bounce: s.bounced[0]!.receipt });
    w.status.set("D", { kind: "gone", why: "阶段 fix" });
    const done = await env.until(phase("done"));
    expect(done).toMatchObject({ outcome: "void", merged: [], cleared: [] });
    expect(w.merges).toEqual([]);
    expect(w.branches.size).toBe(0);

    // Serial: main moved on (someone merged), so each of A, B, C is sent to update-branch = its own CI on current main.
    env.pushMain();
    for (const id of ["A", "B", "C"]) expect((await serialPass(env, id, BASE)).phase).toBe("updating");
    expect(w.updates).toEqual(["A", "B", "C"]);
    expect(w.merges).toEqual([]);
  });
});

describe("[验收线 2] the confirmation car is the only joint proof", () => {
  test("ABC confirmation green: built from the same base and the exact heads, then A, B and C are released one by one", async () => {
    const env = world(NAMES, ONLY_D), { w } = env;
    const queued = await env.until((s) => !!confirmCar(s));
    expect(await env.gate("A")).toBe("wait");
    const s = await env.until(phase("settling"));
    expect(w.ran).toEqual(["ABCD", "AB", "CD", "C", "D", "ABC"]);
    const car = confirmCar(s)!;
    expect(car).toMatchObject({ members: ["A", "B", "C"], status: "green", parent: null });
    expect(w.branches.get(car.branch)).toEqual({ at: BASE, heads: [HEAD.A!, HEAD.B!, HEAD.C!] });
    expect(queued.base).toBe(BASE);
    expect(s.proof).toEqual({ car: car.id, base: BASE, heads: { A: HEAD.A!, B: HEAD.B!, C: HEAD.C! } });
    expect(s).toMatchObject({ cleared: ["A", "B", "C"], ciRuns: 5, confirmRuns: 1 });
    // The cars it replaces are no longer green: the only green car carrying a member is the one that proves the union.
    expect(cars(s)).toEqual(["ABCD:split", "AB:partial", "CD:split", "C:partial", "D:red", "ABC:green:confirm"]);
    for (const id of ["A", "B", "C"]) expect(s.cars.filter((c) => c.status === "green" && c.members.includes(id)).map((c) => c.id)).toEqual([car.id]);
    expect(w.events.filter((e) => e.kind === "confirm").map((e) => e.data?.result ?? "queued")).toEqual(["queued", "green"]);

    w.status.set("D", { kind: "gone", why: "阶段 fix" });
    for (const id of ["A", "B", "C"]) {
      expect(await env.gate(id)).toBe("cleared");
      const live = clearedMember(env.store.all(), prOf(id), HEAD[id]!)!;
      await recheckCleared(live, env.deps);
      await env.gh.mergeMatchHead(prOf(id), HEAD[id]!);
      await env.tick();
    }
    expect(w.merges).toEqual(["A", "B", "C"]);
    expect((await env.until(phase("done"))).outcome).toBe("merged");
  });

  test("one green car already carried every survivor: it is the proof, no confirmation run", async () => {
    const env = world(NAMES, (car) => car.includes("C") || car.includes("D")), { w } = env;
    const s = await env.until(phase("settling"));
    expect(w.ran).toEqual(["ABCD", "AB", "CD", "C", "D"]);
    expect(confirmCar(s)).toBeUndefined();
    expect(s.proof).toEqual({ car: s.cars[1]!.id, base: BASE, heads: { A: HEAD.A!, B: HEAD.B! } });
    expect(s).toMatchObject({ cleared: ["A", "B"], ciRuns: 5 });
    expect(s.confirmRuns).toBeUndefined();
    expect(await env.gate("A")).toBe("cleared");
  });

  test("head drift after the proof: a sibling's head moves, the proof is void and nobody merges on it", async () => {
    const env = world(NAMES, ONLY_D), { w } = env;
    await env.until(phase("settling"));
    expect(await env.gate("A")).toBe("cleared");
    w.heads.B = sha(0xbad);
    expect(await env.gate("A")).toBeNull();
    expect(env.load()).toMatchObject({ phase: "cleanup", outcome: "void" });
    expect(clearedMember(env.store.all(), prOf("A"), HEAD.A!)).toBeNull();
    // A proof whose recorded head no longer matches the state's member is refused on its own, whatever GitHub says.
    const forged = (await world(NAMES, ONLY_D).until(phase("settling")));
    forged.members.find((m) => m.taskId === "B")!.head = sha(0xbad);
    expect([jointlyProven(forged), provenHeads(forged)]).toEqual([false, []]);
    await expect(recheckCleared(forged, env.deps)).rejects.toThrow("联合证明");
  });

  test("base drift: main moves while the confirmation car runs, or an outside commit lands after the proof: void, nothing released", async () => {
    const during = world(NAMES, ONLY_D);
    await during.until((s) => confirmCar(s)?.status === "ci");
    during.pushMain();
    const voided = await during.until((s) => s.phase !== "testing");
    expect(voided).toMatchObject({ phase: "cleanup", outcome: "void" });
    expect(voided.proof).toBeUndefined();
    expect(await during.gate("A")).toBeNull();
    expect(during.w.ran).toEqual(["ABCD", "AB", "CD", "C", "D"]); // the confirmation verdict was never read on the moved main

    const after = world(NAMES, ONLY_D);
    const s = await after.until(phase("settling"));
    expect(await after.gate("A")).toBe("cleared");
    const moved = structuredClone(s);
    moved.base = sha(0xfeed); // the same proof under another base proves nothing
    expect(jointlyProven(moved)).toBe(false);
    after.pushMain(HEAD.D!); // D was tested, but red and alone: its merge on main is not one the proof covers
    expect(await after.gate("A")).toBeNull();
    expect(after.load()).toMatchObject({ phase: "cleanup", outcome: "void" });
    expect(after.w.merges).toEqual([]);
  });

  test("restart between the local greens and the confirmation car: the reloaded state still builds it, once", async () => {
    const env = world(NAMES, AUDIT), { w } = env;
    await env.until((s) => !!confirmCar(s));
    // The last state saved before the confirmation car existed: every bisect car has its verdict, A, B, C are locally green.
    const crash = env.saves.findLast((s) => !confirmCar(s))!;
    expect(crash).toMatchObject({ phase: "testing", cleared: ["A", "B", "C"] });
    expect(crash.cars.every((c) => !["new", "assemble", "ci"].includes(c.status))).toBe(true);
    expect(crash.proof).toBeUndefined();
    env.store.save(structuredClone(crash)); // the process died right there
    expect(await env.gate("A")).toBe("wait");
    const reborn = { ...env.deps, store: { ...fileTrainStore(env.home), event: () => {} } }; // a new process: nothing but the file
    const next = await stepTrain(reborn.store.load("p")!, reborn);
    expect(next).toMatchObject({ phase: "testing", cleared: ["A", "B", "C"] });
    expect(confirmCar(next)).toMatchObject({ members: ["A", "B", "C"], status: "new" });
    expect(next.proof).toBeUndefined();
    // Restart again while it runs: no second confirmation car, branch or draft; its red verdict still decides.
    w.pending = true;
    for (let i = 0; i < 3; i++) await stepTrain(fileTrainStore(env.home).load("p")!, reborn);
    expect(fileTrainStore(env.home).load("p")!.cars.filter((c) => c.confirm)).toHaveLength(1);
    expect(w.drafts.filter((b) => b.endsWith("-set"))).toHaveLength(1);
    w.pending = false;
    const s = await env.until((x) => x.phase !== "testing");
    expect(s).toMatchObject({ phase: "settling", cleared: [], confirmRuns: 1 });
    expect([...s.serial].sort()).toEqual(["A", "B", "C"]);
  });

  test("a state without a joint proof (what the build before this card saved) is refused: serial, never cleared", async () => {
    const env = world(NAMES, AUDIT), { w } = env;
    await env.until((s) => !!confirmCar(s));
    // The old build went straight to settling here, with the union of the green cars as `cleared` and no proof.
    const old = structuredClone(env.saves.findLast((s) => !confirmCar(s))!);
    old.phase = "settling";
    expect(proofFor(old, old.cleared)).toBeNull();
    expect(jointlyProven(old)).toBe(false);
    env.store.save(old);
    expect(clearedMember(env.store.all(), prOf("A"), HEAD.A!)).toBeNull();
    await expect(recheckCleared(structuredClone(old), env.deps)).rejects.toThrow("联合证明");
    env.store.save(old);
    expect(await env.gate("A")).not.toBe("cleared");
    expect(env.load()).toMatchObject({ phase: "settling", cleared: [] });
    expect([...env.load()!.serial].sort()).toEqual(["A", "B", "C"]);
    // The same through the tick alone, and a forged proof naming a car that did not carry everyone is no better.
    env.store.save({ ...structuredClone(old), proof: { car: old.cars[1]!.id, base: BASE, heads: { A: HEAD.A!, B: HEAD.B!, C: HEAD.C! } } });
    expect(jointlyProven(env.load()!)).toBe(false);
    const ticked = await env.tick();
    expect(ticked).toMatchObject({ phase: "settling", cleared: [] });
    expect([...ticked!.serial].sort()).toEqual(["A", "B", "C"]);
    expect(w.notices.some((n) => n.alarm && n.text.includes("没有这些成员一起通过 CI 的联合证明"))).toBe(true);
    expect(w.merges).toEqual([]);
  });

  test("both children green under a red parent stays the old safe negative: whole batch serial, no confirmation car", async () => {
    const two = world(["A", "B"], (car) => car === "AB");
    const s = await two.until((x) => x.phase !== "testing");
    expect(two.w.ran).toEqual(["AB", "A", "B"]);
    expect(s).toMatchObject({ phase: "cleanup", outcome: "serial", cleared: [] });
    expect([confirmCar(s), s.proof, s.confirmRuns]).toEqual([undefined, undefined, undefined]);
    expect([...s.serial].sort()).toEqual(["A", "B"]);
    expect(two.w.notices.some((n) => n.alarm && n.text.includes("定位不到"))).toBe(true);

    const four = world(NAMES, (car) => car === "ABCD");
    const t = await four.until((x) => x.phase !== "testing");
    expect(four.w.ran).toEqual(["ABCD", "AB", "CD"]);
    expect(t).toMatchObject({ phase: "cleanup", outcome: "serial", cleared: [] });
    expect(confirmCar(t)).toBeUndefined();
    expect([...t.serial].sort()).toEqual(["A", "B", "C", "D"]);
    for (const id of NAMES) expect(await four.gate(id)).toBeNull();
  });
});

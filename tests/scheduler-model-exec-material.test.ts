/**
 * dispatch-recovery-MODELX r4 (监工 10-06 19:1x, finding material-digest-is-ticket-identity): every formal review dispatch freezes a
 * material snapshot — the normalized order plus { path, sha256 } of the spec body, the prior report and fix_strategy's material,
 * from structured fields — and the exemption compares only against it. r4's three attacks (a spaced file name whose body changes
 * after the epoch, a body changed after the order but before the refusal, a spec body changed without a specRev bump) all refuse
 * the continuation; so do an order without a snapshot and a file that cannot be read. Production tick path, temp ledger, fake workers.
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OWNER_PRINCIPAL_ID } from "../src/lib/devices.js";
import { answerAsk, openAsk } from "../src/lib/ledger-asks.js";
import { getIntent, type SchedulerIntent } from "../src/lib/ledger-scheduler.js";
import { getEventByDedup, listEvents } from "../src/lib/ledger-store.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { schedulerAutoTick } from "../src/lib/scheduler-auto-tick.js";
import { setModelOutcomeReader, snapshotKey } from "../src/lib/scheduler-model-wiring.js";
import { reviewSwapStep, type ReviewSwapDeps } from "../src/lib/scheduler-review-swap-runtime.js";
import { getSchedulerSession } from "../src/lib/scheduler-sessions.js";
import { autoFixture, H1, toBuild } from "./scheduler-auto-helpers.js";

const CYBER = "This request has been flagged for possible cybersecurity risk";
const EX = "agent-task-rv-t1-r1-ex";
const dir = mkdtempSync(join(tmpdir(), "modelx-mat-"));
const g = globalThis as { __modelxMat?: string };
const CFG = join(dir, "recovery-policy.ts");
writeFileSync(CFG, "export function recoveryPolicy() { return { mode: globalThis.__modelxMat, manualAfterMs: null }; }\n");

let f: ReturnType<typeof autoFixture>;
let first: SchedulerIntent;
let errors: ReturnType<typeof spyOn>;
let created: string[];
let spec: string;
const real = new WeakMap<object, ReturnType<typeof autoFixture>["tickDeps"]["worker"]>();
beforeEach(() => {
  errors = spyOn(console, "error").mockImplementation(() => {});
  setModelOutcomeReader(CFG);
  g.__modelxMat = "on";
  created = [];
  f = autoFixture();
  spec = join(f.dir, "T1.md");
  writeFileSync(spec, "# T1\n验收：原文\n");
  f.db.run("UPDATE tasks SET spec = ? WHERE id = 'T1'", [spec]);
});
afterEach(() => { f.close(); errors.mockRestore(); setModelOutcomeReader(); delete g.__modelxMat; });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Build → deliver → the first review order goes out; before: what exists when that order is planned and frozen. */
async function sendFirst(before?: () => void) {
  await toBuild(f);
  await f.tick();
  expect((await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H1)).ok).toBe(true);
  await f.tick();
  before?.();
  expect(await f.tick()).toMatchObject({ step: "sent" });
  first = getIntent(f.db, f.intents().findLast((i) => i.action === "review")!.id)!;
  const ask = openAsk(f.db, { project: "p", source: "reply", kind: "decide", title: "Refusal rule", askKey: "policy-refusal-rule" }, 1999);
  answerAsk(f.db, ask.id, { choices: ["[button:policy_refusal_rule_go]"], labels: ["x"], text: "", principal: OWNER_PRINCIPAL_ID, owner: true,
    via: "web_card", at: 2000, final: true });
}
function failWith(message: string | null) {
  const worker = real.get(f) ?? f.tickDeps.worker;
  real.set(f, worker);
  f.tickDeps.worker = message === null ? worker : (ref) => {
    const w = worker(ref);
    return "manual" in w ? w : { ...w, observe: async () => ({ state: "result", outcome: "failed", failure: { kind: "error", message } }) };
  };
}
const swapDeps = (): ReviewSwapDeps => ({
  registryPath: f.registryPath, active: () => {}, agents: async () => [], agent: async () => ({ ok: true }),
  ensure: async (task, family) => {
    created.push(family);
    const r = JSON.parse(readFileSync(f.registryPath, "utf8"));
    r.agents[EX] = { runtime: family === "codex" ? "codex" : "claude-code", sessionId: "s-ex", cwd: join(f.dir, "rv-ex") };
    writeFileSync(f.registryPath, JSON.stringify(r));
    return { kind: "ready", created: true, ref: { taskId: task.id, role: "reviewer", agent: EX, sessionId: "s-ex", family, transport: "tmux" } };
  },
});
async function tick() {
  const manager = (...a: string[]) => a[1] === "scheduler-review-swap"
    ? reviewSwapStep(f.db, f.at("scheduler"), a[2], Number(a[4]), swapDeps()).catch((e: Error) => ({ ok: false, error: e.message })) : f.tickDeps.manager(...a);
  const r = await schedulerAutoTick(f.db, { p: { maxActiveWorkers: 2 } }, { ...f.tickDeps, manager });
  if (r.failed.length) throw new Error(JSON.stringify(r.failed));
  return r.cards[0];
}
const ops = (op: string) => listEvents(f.db, { project: "p", target: "T1" }).filter((e) => e.data.op === op);
const strategy = (at: string) => insertEvent(f.db, { actor: "scheduler", now: f.at("x").now }, { project: "p", target: "T1", kind: "scheduler",
  text: "fix strategy", data: { op: "fix_strategy", specRev: f.task().specRev, round: f.task().round, material: at } }, true);
const exemptSent = () => f.intents().filter((i) => i.action === "review" && i.recipient === EX);
/** Refusal → epoch; then a material change; the next tick refuses the continuation before anything is created / sent. */
async function epochThen(change: () => void, why: string) {
  failWith(CYBER);
  expect(await tick()).toMatchObject({ step: "refusal_epoch" });
  failWith(null);
  change();
  const r = await tick();
  expect(r).toMatchObject({ step: "manual" });
  expect(r!.detail).toContain(why);
  expect(created).toEqual([]);
  expect(exemptSent()).toEqual([]);
}
/** Refusal with the materials already off the snapshot: no epoch, the refused binding kept, manual with why. */
async function refusedAtRefusal(why: string) {
  failWith(CYBER);
  const r = await tick();
  expect(r).toMatchObject({ step: "manual" });
  expect(r!.detail).toContain(why);
  expect(ops("reviewer_swap")).toEqual([]);
  expect(getSchedulerSession(f.db, "T1", "reviewer")).toMatchObject({ sessionId: "s-rv", state: "active" });
}

describe("the snapshot is frozen at every formal review dispatch", () => {
  test("structured list: spec body and fix_strategy material (spaced name) with their sha256; normalized order; ticket identity removed", async () => {
    const spaced = join(f.dir, "prior reports.md");
    writeFileSync(spaced, "original bytes");
    await sendFirst(() => strategy(spaced));
    const snap = getEventByDedup(f.db, snapshotKey(first.id))!;
    expect(snap).toMatchObject({ actor: "scheduler", kind: "note", data: { op: "review_material_snapshot", intentId: first.id, head: H1,
      files: [{ role: "spec", path: spec, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
        { role: "fix_strategy", path: spaced, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }] } });
    expect(String(snap.data.order)).toContain("<order>");
    expect(String(snap.data.order)).not.toContain(first.id);
  });

  test("control: unchanged materials (spaced name included) — the exemption runs, is bound and sent", async () => {
    const spaced = join(f.dir, "prior reports.md");
    writeFileSync(spaced, "original bytes");
    await sendFirst(() => strategy(spaced));
    failWith(CYBER);
    expect(await tick()).toMatchObject({ step: "refusal_epoch" });
    failWith(null);
    expect(await tick()).toMatchObject({ step: "session" });
    expect(await tick()).toMatchObject({ step: "sent" });
    expect(exemptSent()).toHaveLength(1);
    expect(getEventByDedup(f.db, snapshotKey(exemptSent()[0].id))!.data.digest).toBe(getEventByDedup(f.db, snapshotKey(first.id))!.data.digest);
  });
});

describe("r4 attacks: the continuation is refused (manual), never sent", () => {
  test("1 · a spaced file name, its body changed after the epoch", async () => {
    const spaced = join(f.dir, "prior reports.md");
    writeFileSync(spaced, "original bytes");
    await sendFirst(() => strategy(spaced));
    await epochThen(() => writeFileSync(spaced, "CHANGED bytes"), `fix_strategy 材料 ${spaced} 内容与原派单快照不一致`);
  });

  test("2 · a body changed after the order went out, before the refusal", async () => {
    const at = join(f.dir, "prior-reports.md");
    writeFileSync(at, "original bytes");
    await sendFirst(() => strategy(at));
    writeFileSync(at, "CHANGED bytes");
    await refusedAtRefusal(`fix_strategy 材料 ${at} 内容与原派单快照不一致`);
  });

  test("3 · the spec body changed after the epoch, specRev unchanged", async () => {
    await sendFirst();
    const rev = f.task().specRev;
    await epochThen(() => writeFileSync(spec, "# T1\n验收：改过\n"), `规格正文 ${spec} 内容与原派单快照不一致`);
    expect(f.task().specRev).toBe(rev);
  });

  test("3b · the spec body changed after the order, before the refusal", async () => {
    await sendFirst();
    writeFileSync(spec, "# T1\n验收：改过\n");
    await refusedAtRefusal("规格正文");
  });
});

describe("no snapshot / unreadable material: manual, never treated as nothing to check", () => {
  test("an order sent before snapshots existed: 原派单无材料快照", async () => {
    await sendFirst();
    f.db.run("DROP TRIGGER IF EXISTS events_no_update"); // fault injection on this private fixture: the order loses its snapshot
    f.db.run("UPDATE events SET dedupKey = NULL WHERE dedupKey = ?", [snapshotKey(first.id)]);
    await refusedAtRefusal("原派单无材料快照");
  });

  test("a material file gone before the refusal: read failure", async () => {
    await sendFirst();
    rmSync(spec);
    await refusedAtRefusal(`规格正文 ${spec} 读取失败`);
  });

  test("a material file gone after the epoch: read failure, nothing created", async () => {
    const at = join(f.dir, "prior-reports.md");
    writeFileSync(at, "original bytes");
    await sendFirst(() => strategy(at));
    await epochThen(() => rmSync(at), `fix_strategy 材料 ${at} 读取失败`);
  });

  test("a material unreadable when the order went out: the order is still sent, the exemption is not run", async () => {
    await sendFirst(() => rmSync(spec));
    expect(getEventByDedup(f.db, snapshotKey(first.id))!.data.files).toMatchObject([{ role: "spec", path: spec, error: expect.stringContaining("ENOENT") }]);
    writeFileSync(spec, "# T1\n验收：原文\n");
    await refusedAtRefusal("原派单时就读不到");
  });
});

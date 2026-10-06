/**
 * MODELX safe handling (PM spec dispatch-recovery-MODELX-safe-handling.md): a provider safety refusal under on is preserved,
 * paused and told once — never continued. Production tick path on a temp ledger with fake workers: zero session creates,
 * swaps or merges across ticks and replays, late refusals of an old head stay evidence only, a recorded result is untouched.
 */
import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OWNER_PRINCIPAL_ID } from "../src/lib/devices.js";
import { answerAsk, openAsk } from "../src/lib/ledger-asks.js";
import { getIntent, getWorkflow, type SchedulerIntent } from "../src/lib/ledger-scheduler.js";
import { listEvents } from "../src/lib/ledger-store.js";
import { informKey, modelOutcomeStep, refusalKind, setModelOutcomeReader, type ModelWiringCard } from "../src/lib/scheduler-model-wiring.js";
import type { SessionRef } from "../src/lib/worker-session.js";
import { autoFixture, H1, toBuild } from "./scheduler-auto-helpers.js";

const CYBER = "This request has been flagged for possible cybersecurity risk";
const USAGE = "API Error: Claude Code is unable to respond to this request, which appears to violate our Usage Policy";
const dir = mkdtempSync(join(tmpdir(), "modelx-safe-"));
const g = globalThis as { __modelxSafeMode?: string };
const CFG = join(dir, "recovery-policy.ts");
writeFileSync(CFG, "export function recoveryPolicy() { return { mode: globalThis.__modelxSafeMode, manualAfterMs: null }; }\n");

let f: ReturnType<typeof autoFixture>;
let first: SchedulerIntent;
let errors: ReturnType<typeof spyOn>;
beforeEach(async () => {
  errors = spyOn(console, "error").mockImplementation(() => {});
  setModelOutcomeReader(CFG);
  g.__modelxSafeMode = "on";
  f = autoFixture();
  await toBuild(f);
  await f.tick();
  expect((await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H1)).ok).toBe(true);
  await f.tick();
  expect(await f.tick()).toMatchObject({ step: "sent" });
  first = getIntent(f.db, f.intents().findLast((i) => i.action === "review")!.id)!;
  const ask = openAsk(f.db, { project: "p", source: "reply", kind: "decide", title: "Refusal rule", askKey: "policy-refusal-rule" }, 1000);
  answerAsk(f.db, ask.id, { choices: ["[button:policy_refusal_rule_go]"], labels: ["go"], text: "", principal: OWNER_PRINCIPAL_ID,
    owner: true, via: "web_card", at: 2000, final: true });
});
afterEach(() => { f.close(); errors.mockRestore(); setModelOutcomeReader(); delete g.__modelxSafeMode; });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const events = () => listEvents(f.db, { project: "p", target: "T1" });
const ops = (op: string) => events().filter((e) => e.data.op === op);
const card = (): ModelWiringCard => ({ db: f.db, task: f.task(), opts: {}, deps: { now: () => f.at("x").now! } });
const rv = (sessionId: string): SessionRef => ({ taskId: "T1", role: "reviewer", agent: "agent-rv-t1", sessionId, family: "codex", transport: "acp" });
const effects = () => ({ ensured: f.ensured.length, swaps: ops("reviewer_swap").length,
  started: f.intents().filter((i) => ["review_swap", "ensure_session", "merge"].includes(i.action) && i.status !== "cancelled").length,
  sessions: (f.db.query("SELECT COUNT(*) AS n FROM scheduler_sessions").get() as { n: number }).n });
function failWith(message: string) {
  const real = f.tickDeps.worker;
  f.tickDeps.worker = (ref) => {
    const w = real(ref);
    return "manual" in w ? w : { ...w, observe: async () => ({ state: "result", outcome: "failed", failure: { kind: "error", message } }) };
  };
}

test("on: two ticks and a restart replay keep one record, one inform, and zero create / swap / merge", async () => {
  const before = effects(), sent = f.sent.length;
  failWith(CYBER);
  expect(await f.tick()).toMatchObject({ step: "manual" });
  await f.tick();
  setModelOutcomeReader(CFG); // a restarted service reloads the policy and replays the same failed ticket
  await modelOutcomeStep(card(), first, rv("s-rv"), { kind: "error", message: CYBER });
  expect(ops("model_refusal_retry")).toHaveLength(1);
  expect(ops("model_refusal_retry")[0].data).toMatchObject({ evidence: CYBER, intentId: first.id, agent: "agent-rv-t1", family: "codex",
    session: "s-rv", head: H1, specRev: f.task().specRev, round: f.task().round, noReport: true, verdict: null });
  expect(ops("refusal_owner_inform")).toHaveLength(1);
  expect(effects()).toEqual(before);
  expect(f.sent.length).toBe(sent);
  expect(getWorkflow(f.db, "T1")!.mode).toBe("manual");
  expect(events().some((e) => e.kind === "review")).toBe(false); // no report is never a pass
});

test("several signals on one ticket: the first refusal is the evidence, later ones replay it", async () => {
  await modelOutcomeStep(card(), first, rv("s-rv"), { kind: "error", message: CYBER });
  await modelOutcomeStep(card(), first, rv("s-rv"), { kind: "error", message: USAGE });
  await modelOutcomeStep(card(), first, rv("s-rv"), { kind: "quota", message: "You've hit your usage limit" });
  const safety = events().filter((e) => e.data.cls === "safety");
  expect(safety).toHaveLength(1);
  expect(safety[0].data.evidence).toBe(CYBER);
  expect(ops("refusal_owner_inform").map((e) => e.data.refusal)).toEqual(["cyber_policy"]);
  // the inform's dedup is card + refusal kind, so a usage-policy refusal of another ticket would be told separately
  expect([refusalKind(CYBER), refusalKind(USAGE)]).toEqual(["cyber_policy", "usage_policy"]);
  expect(ops("refusal_owner_inform")[0].dedupKey).toBe(informKey("T1", "cyber_policy"));
  expect(ops("reviewer_swap")).toEqual([]);
});

test("a late refusal of an old head stays evidence of its own window: no hold or continuation on the current head", async () => {
  f.db.run("UPDATE tasks SET headSHA = ? WHERE id = 'T1'", ["2".repeat(40)]);
  await modelOutcomeStep(card(), first, rv("s-rv"), { kind: "error", message: CYBER });
  expect(ops("model_refusal_stale")).toHaveLength(1);
  expect(ops("model_safety_hold")).toEqual([]);
  expect(ops("model_refusal_retry")).toEqual([]);
  expect(ops("reviewer_swap")).toEqual([]);
});

test("a recorded result is never overwritten by a later refusal of its ticket", async () => {
  expect(await f.review("pass", H1, [])).toMatchObject({ ok: true });
  const review = JSON.stringify(events().filter((e) => e.kind === "review"));
  await modelOutcomeStep(card(), first, rv("s-rv"), { kind: "error", message: CYBER });
  expect(JSON.stringify(events().filter((e) => e.kind === "review"))).toBe(review);
  expect(events().filter((e) => e.data.cls === "safety")).toEqual([]);
  expect(ops("refusal_owner_inform")).toEqual([]);
});

test("observe and off: zero create / swap / merge and nothing told", async () => {
  const before = effects();
  for (const mode of ["observe", "off"]) {
    g.__modelxSafeMode = mode;
    expect(await modelOutcomeStep(card(), first, rv("s-rv"), { kind: "error", message: CYBER })).toBe("");
  }
  expect(effects()).toEqual(before);
  expect(ops("refusal_owner_inform")).toEqual([]);
});

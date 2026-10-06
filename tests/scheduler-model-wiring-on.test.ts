/**
 * dispatch-recovery-MODELW · modelOutcomeStep against the real ledger: the approved refusal sequence under on, MODEL's
 * capacity / host classes, and a throwing MODEL call. "" = today's reason, a string = the on plan for PM, { epoch } = MODELX ran it.
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OWNER_PRINCIPAL_ID } from "../src/lib/devices.js";
import { answerAsk, openAsk } from "../src/lib/ledger-asks.js";
import { getIntent, getWorkflow, type SchedulerIntent } from "../src/lib/ledger-scheduler.js";
import { settleIntent } from "../src/lib/ledger-scheduler-settle.js";
import { planIntent } from "../src/lib/ledger-scheduler-write.js";
import { listEvents } from "../src/lib/ledger-store.js";
import { EXEMPTION_TEXT } from "../src/lib/scheduler-model-outcome.js";
import { modelOutcomeStep, setModelOutcomeReader, type ModelWiringCard } from "../src/lib/scheduler-model-wiring.js";
import type { SessionRef } from "../src/lib/worker-session.js";
import { autoFixture, H1, toBuild } from "./scheduler-auto-helpers.js";

const CYBER = "This request has been flagged for possible cybersecurity risk";
const dir = mkdtempSync(join(tmpdir(), "modelw-on-"));
const g = globalThis as { __modelwOn?: string };
const CFG = join(dir, "recovery-policy.ts");
writeFileSync(CFG, "export function recoveryPolicy() { return { mode: globalThis.__modelwOn, manualAfterMs: null }; }\n");

let f: ReturnType<typeof autoFixture>;
let first: SchedulerIntent;
let errors: ReturnType<typeof spyOn>;
beforeEach(async () => {
  errors = spyOn(console, "error").mockImplementation(() => {});
  setModelOutcomeReader(CFG);
  g.__modelwOn = "on";
  f = autoFixture();
  writeFileSync(join(f.dir, "T1.md"), "# T1\n");
  f.db.run("UPDATE tasks SET spec = ? WHERE id = 'T1'", [join(f.dir, "T1.md")]); // MODELX r4: the review order's frozen spec body
  await toBuild(f);
  await f.tick();
  expect((await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H1)).ok).toBe(true);
  await f.tick();
  expect(await f.tick()).toMatchObject({ step: "sent" });
  first = getIntent(f.db, f.intents().findLast((i) => i.action === "review")!.id)!;
});
afterEach(() => { f.close(); errors.mockRestore(); setModelOutcomeReader(); delete g.__modelwOn; });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const card = (): ModelWiringCard => ({ db: f.db, task: f.task(), opts: {}, deps: { now: () => f.at("x").now!, manager: f.tickDeps.manager, notifyPm: f.tickDeps.notifyPm } });
const rv = (sessionId: string, over: Partial<SessionRef> = {}): SessionRef =>
  ({ taskId: "T1", role: "reviewer", agent: "agent-rv-t1", sessionId, family: "codex", transport: "acp", ...over });
const step = (intent: SchedulerIntent, ref: SessionRef, message = CYBER, kind: "error" | "quota" | "auth" = "error") =>
  modelOutcomeStep(card(), intent, ref, { kind, message });
const outcomes = () => listEvents(f.db, { project: "p", target: "T1" }).filter((e) => String(e.data.op).startsWith("model_"));
function approve() {
  const ask = openAsk(f.db, { project: "p", source: "reply", kind: "decide", title: "Refusal rule", askKey: "policy-refusal-rule" }, 1000);
  answerAsk(f.db, ask.id, { choices: ["[button:policy_refusal_rule_go]"], labels: ["go"], text: "", principal: OWNER_PRINCIPAL_ID,
    owner: true, via: "web_card", at: 2000, final: true });
}
/** A formal new review ticket in the same window (same head / spec / node = same materials). */
function ticket(id: string): SchedulerIntent {
  const t = f.task();
  return planIntent(f.db, f.at("scheduler"), { id, taskId: t.id, taskRev: t.rev, workflowRev: getWorkflow(f.db, t.id)!.rev,
    causalSeq: listEvents(f.db, { project: "p" }).at(-1)!.seq, action: "review", node: "adversarial_review", reason: "批准的接续审查" }).intent;
}

describe("on: the approved refusal sequence (MODELX, owner 10-06 14:45: no same-model retry)", () => {
  test("first refusal → exemption epoch at once (MODEL's retry_same executed as exempt_review); its refusal → manual", async () => {
    approve();
    const once = await step(first, rv("s-rv"));
    const text = typeof once === "string" ? once : once.epoch;
    expect(typeof once).toBe("object");
    expect(text).toContain(`${EXEMPTION_TEXT}(批准 `);
    expect(text).toContain("owner 14:45 去掉同模型重试");
    // A replayed tick on the same intent: MODEL's dedup key, the epoch's dedup key, nothing new.
    const replay = await step(first, rv("s-rv"));
    expect(typeof replay === "object" && replay.epoch.includes("已执行过")).toBe(true);
    expect(outcomes()).toHaveLength(1);
    const swaps = () => listEvents(f.db, { project: "p", target: "T1" }).filter((e) => e.data.op === "reviewer_swap");
    expect(swaps()).toMatchObject([{ data: { fromFamily: "codex", toFamily: "claude", refusal: { crossModel: false, planKind: "retry_same" } } }]);

    const exempt = ticket("refusal-exempt-1");
    expect(await step(exempt, rv("s-claude", { agent: "agent-claude-bk", family: "claude", transport: "tmux" }))).toBe("");
    expect(outcomes().map((e) => e.data.op)).toEqual(["model_refusal_retry", "model_safety_hold"]);
    expect(swaps()).toHaveLength(1);
  });

  test("a late refusal on the retired session after the epoch: MODEL holds, no second epoch", async () => {
    approve();
    await step(first, rv("s-rv"));
    expect(await step(ticket("refusal-retry-1"), rv("s-rv"))).toBe("");
    expect(outcomes().at(-1)).toMatchObject({ data: { op: "model_safety_hold" } });
    expect(listEvents(f.db, { project: "p", target: "T1" }).filter((e) => e.data.op === "reviewer_swap")).toHaveLength(1);
  });
});

describe("capacity / host go through MODEL's own classes", () => {
  const peer = rv("s-peer", { agent: "peer-rv", transport: "peer" });
  test("quota on a peer reviewer: redispatch to an authorized local placement of a non-author family", async () => {
    expect(await step(first, peer, "You've hit your usage limit", "quota"))
      .toContain("MODEL 计划：redispatch（→ local（codex），无现成正式路径），执行路径待 MODELX");
    expect(outcomes()).toMatchObject([{ kind: "note", data: { cls: "capacity", machine: "peer-rv", plan: { kind: "redispatch", to: { family: "codex", machine: "local" } } } }]);
  });

  test("host error with no other placement: manual (\"\", the tick escalates as today)", async () => {
    expect(await step(first, rv("s-rv"), "ECONNRESET: socket hang up")).toBe("");
    expect(outcomes()).toMatchObject([{ kind: "escalate", data: { cls: "host", plan: { kind: "manual", code: "model_recovery_manual" } } }]);
  });

  test("auth failure is never auto-recovered", async () => {
    expect(await step(first, peer, "Please run /login", "auth")).toBe("");
    expect(outcomes()).toMatchObject([{ data: { cls: "host", plan: { kind: "manual" } } }]);
  });

  test("observe records the redispatch it would do and still answers \"\"", async () => {
    g.__modelwOn = "observe";
    expect(await step(first, peer, "529 overloaded")).toBe("");
    expect(outcomes()).toMatchObject([{ kind: "note", data: { op: "model_outcome", mode: "observe", plan: { kind: "redispatch" } } }]);
  });
});

test("MODEL itself throws: one diagnostic line, \"\" so the tick escalates as today", async () => {
  expect(await step({ ...first, id: "no-such-intent" }, rv("s-rv"))).toBe("");
  expect(outcomes()).toEqual([]);
  const lines = errors.mock.calls.map((c: unknown[]) => String(c[0])).filter((l: string) => l.startsWith("[model-outcome]"));
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("照旧退人工");
});

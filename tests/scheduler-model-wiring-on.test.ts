/**
 * dispatch-recovery-MODELW · modelOutcomeStep against the real ledger: the approved refusal sequence under on, MODEL's
 * capacity / host classes, and a throwing MODEL call. The tick always escalates; "" = today's reason, else the on plan for PM.
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
  await toBuild(f);
  await f.tick();
  expect((await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H1)).ok).toBe(true);
  await f.tick();
  expect(await f.tick()).toMatchObject({ step: "sent" });
  first = getIntent(f.db, f.intents().findLast((i) => i.action === "review")!.id)!;
});
afterEach(() => { f.close(); errors.mockRestore(); setModelOutcomeReader(); delete g.__modelwOn; });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const card = (): ModelWiringCard => ({ db: f.db, task: f.task(), opts: {}, deps: { now: () => f.at("x").now! } });
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

describe("on: the approved refusal sequence", () => {
  test("retry_same → (same materials, new session) exempt_review to another family with exemption + owner notice → manual", async () => {
    approve();
    const once = await step(first, rv("s-rv"));
    expect(once).toContain("MODEL 计划：retry_same（批准 ");
    expect(once).toContain("执行路径待 MODELX");
    // A replayed tick on the same intent: MODEL's dedup key, no second record, the same suffix.
    expect(await step(first, rv("s-rv"))).toBe(once);
    expect(outcomes()).toHaveLength(1);

    const second = ticket("refusal-retry-1");
    const exempt = await step(second, rv("s-rv-2"));
    expect(exempt).toContain("MODEL 计划：exempt_review（批准 ");
    expect(exempt).toContain(EXEMPTION_TEXT);
    expect(exempt).toContain("告知 owner");
    expect(outcomes().at(-1)).toMatchObject({ kind: "escalate", data: { op: "model_refusal_exempt", attempt: 2, session: "s-rv-2", oldSession: "s-rv",
      plan: { kind: "exempt_review", to: { family: "claude", machine: "local" }, exemption: EXEMPTION_TEXT, notifyOwner: true } } });

    settleIntent(f.db, f.at("scheduler"), { id: second.id, from: "pending", to: "cancelled", receipt: "拒审，原单终止" });
    const third = ticket("refusal-exempt-1");
    expect(await step(third, rv("s-claude", { agent: "agent-claude-bk", family: "claude", transport: "tmux" }))).toBe("");
    expect(outcomes().map((e) => e.data.op)).toEqual(["model_refusal_retry", "model_refusal_exempt", "model_safety_hold"]);
    expect(outcomes().at(-1)!.data.plan).toMatchObject({ kind: "manual", reason: expect.stringContaining("不再换提供方") });
  });

  test("same session on the retry (not a new session) holds instead of exempting", async () => {
    approve();
    await step(first, rv("s-rv"));
    expect(await step(ticket("refusal-retry-1"), rv("s-rv"))).toBe("");
    expect(outcomes().at(-1)).toMatchObject({ data: { op: "model_safety_hold" } });
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

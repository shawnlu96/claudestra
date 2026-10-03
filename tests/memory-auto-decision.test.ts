import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openLedger, closeLedger, listEvents } from "../src/lib/ledger-store.js";
import { appendEvent, createTask } from "../src/lib/ledger-write.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { ledgerOrigin } from "../src/lib/ledger-origin.js";
import { observeMemory } from "../src/lib/memory-auto.js";
import { projectMemories } from "../src/lib/memory-auto-common.js";
import { configuredLesson } from "../src/lib/memory-auto-summary.js";

let db: Database;
const P = "demo";
const decision = (text: string, data: Record<string, unknown> = {}) =>
  appendEvent(db, { actor: "owner", now: 1000 }, { project: P, target: "A", kind: "decision", text, data }).event;
const run = () => observeMemory(db, "scheduler", P, { assertLease: () => {} });
beforeEach(() => {
  db = openLedger(":memory:"); ledgerOrigin(db, () => "ab12");
  createTask(db, { actor: "owner" }, { project: P, id: "A", title: "Atomic writes", kind: "code" });
});
afterEach(() => closeLedger(":memory:"));

function ask(id: string, kind: string, source: string) {
  db.query(`INSERT INTO asks (id, project, fromAgent, fromChannelId, source, kind, title, context, body,
    options, allowText, chatId, expiresAt, state, extra, createdAt, updatedAt)
    VALUES (?, ?, 'agent-pm', 'fixture', ?, ?, 'transaction choice', '', '', '[]', 1, 'fixture', 9999, 'answered', '{}', 1, 1)`)
    .run(id, P, source, kind);
}

test("decision indices use stable origin/seq; business decide/authorize asks included, permission/AUQ/unknown/partial ignored", async () => {
  const e = decision("Keep revision and writes atomic");
  for (const [id, kind, source] of [["design", "decide", "reply"], ["release", "authorize", "reply"],
    ["permission", "authorize", "permission"], ["auq", "decide", "auq"], ["action", "owner_action", "reply"], ["partial", "decide", "reply"]]) {
    ask(id, kind, source); decision(`Decision ${id}`, { askId: id, ...(id === "partial" ? { partial: true } : {}) });
  }
  decision("Unknown ask", { askId: "absent" });
  await run(); const memories = projectMemories(db, P);
  expect(memories).toHaveLength(3);
  expect(memories[0]).toMatchObject({ id: `ab12-d${e.originSeq}`, via: "decision_index", body: e.text,
    sources: [{ origin: "ab12", originSeq: e.originSeq }] });
  const before = listEvents(db, { project: P }).length;
  await run(); expect(listEvents(db, { project: P })).toHaveLength(before);
});

test("secrets outside the indexed excerpt are still rejected, never downgraded into a home memory", async () => {
  decision("Transaction constraints ".repeat(40) + " ghp_" + "Ab12".repeat(8));
  expect((await run()).rejected).toHaveLength(1); expect(projectMemories(db, P)).toEqual([]);
  const audit = listEvents(db, { project: P }).find((e) => e.data.op === "auto_observed")!;
  expect(JSON.stringify(audit)).not.toContain("ghp_");
});

test("configured model uses injected service endpoint only, with capped tokens and timeout; conflicts do not request", async () => {
  const env = { ANTHROPIC_API_KEY: "fixture", ANTHROPIC_BASE_URL: "https://model.example.test", ANTHROPIC_DEFAULT_HAIKU_MODEL: "fixture-haiku" };
  let calls = 0;
  const fake = async (url: string, options: RequestInit) => {
    calls++; expect(String(url)).toBe("https://model.example.test/v1/messages");
    const body = JSON.parse(String(options?.body)); expect(body.model).toBe("fixture-haiku"); expect(body.max_tokens).toBe(150);
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    return new Response(JSON.stringify({ content: [{ type: "text", text: "Keep writes atomic." }] }));
  };
  expect(await configuredLesson("fixture facts", env, fake)).toBe("Keep writes atomic.");
  expect(calls).toBe(1);
  expect(await configuredLesson("fixture", { ...env, CLAUDE_CODE_USE_BEDROCK: "1" }, fake)).toBeNull();
  expect(calls).toBe(1);
  const offline = async () => { throw new Error("timeout fixture"); };
  expect(await configuredLesson("fixture", env, offline)).toBeNull();
});

test("legacy decisions without global event identity remain local and replay once", async () => {
  db.query("INSERT INTO events (ts, actor, project, target, kind, text, data) VALUES (1, 'owner', ?, 'A', 'decision', 'Keep reads atomic', '{}')").run(P);
  await run(); const m = projectMemories(db, P)[0]!;
  expect(m).toMatchObject({ kind: "decision", via: "tool", visibility: "home" });
  expect(m.sources[0]).toHaveProperty("seq"); await run(); expect(projectMemories(db, P)).toHaveLength(1);
});

test("partial or invalid global decision identity is refused rather than treated as legacy", async () => {
  for (const [origin, seq] of [["ab12", null], [null, 4], ["ab12", 0], ["bad", 5]] as const) {
    db.query("INSERT INTO events (ts, actor, project, target, kind, text, data, origin, originSeq) VALUES (1, 'owner', ?, 'A', 'decision', 'Keep writes atomic', '{}', ?, ?)")
      .run(P, origin, seq);
  }
  expect((await run()).rejected).toHaveLength(4);
  expect(projectMemories(db, P)).toEqual([]);
  expect((await run()).recorded).toBe(0);
});

test("completion facts include business ask decisions but exclude permission/AUQ answers", async () => {
  const { prepareSummary } = await import("../src/lib/memory-auto-summary.js");
  ask("noise", "authorize", "permission"); decision("Permission noise", { askId: "noise" });
  ask("business", "decide", "reply"); const e = decision("Atomic transaction decision", { askId: "business" });
  const summary = await prepareSummary(db, e, {});
  expect(summary!.body).toContain("Atomic transaction decision"); expect(summary!.body).not.toContain("Permission noise");
});

test("feature-targeted decision indices retain their graph anchor", async () => {
  const { createFeature } = await import("../src/lib/ledger-feature-write.js");
  const feature = createFeature(db, { actor: "owner", now: 1 }, { project: P, slug: "widget", title: "Widget writes" }).row;
  insertEvent(db, { actor: "owner", now: 1000 }, { project: P, target: feature.id, kind: "decision", text: "Keep transaction boundaries explicit" }, false);
  await run(); expect(projectMemories(db, P)[0]!.featureId).toBe(feature.id);
});

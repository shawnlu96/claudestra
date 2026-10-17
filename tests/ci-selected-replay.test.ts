import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import { replaySelectedHistory } from "../src/lib/ci-selected-replay.js";
import { saveReplayReceipt } from "../src/lib/ci-selected-replay-receipt.js";
import { runLedger } from "../src/manager/ledger.js";
import { isWriteInvocation, READER_ONLY_SUBS } from "../src/manager/write-commands.js";
import type { Registry } from "../src/manager/core.js";
import { HEAD, CHECKOUT, receipt, tempRoot } from "./ci-selected-replay-receipt.test.js";

function event(db: Database, data: Record<string, unknown>, kind = "scheduler", actor = "scheduler", ts = 110) {
  db.query("INSERT INTO events (ts,actor,project,target,kind,text,data) VALUES (?,?,'p','T',?,'evidence',?)").run(ts, actor, kind, JSON.stringify(data));
  return Number((db.query("SELECT last_insert_rowid() AS seq").get() as { seq: number }).seq);
}
async function history() {
  const root = tempRoot(), path = join(root, "ledger.sqlite"), db = openLedger(path);
  createTask(db, { actor: "owner", now: 100 }, { project: "p", id: "T", title: "t", kind: "code", agent: "author" });
  const ref = await saveReplayReceipt(receipt(), root);
  const seq = event(db, { op: "merge_conflict", cause: "ci_fail", intentId: "i", prHead: HEAD,
    ciSelectedReplay: { version: 1, intentId: "i", head: HEAD, mergeRev: 1, round: 1, specRev: 1, refs: [ref], gap: null } });
  return { root, path, db, ref, seq, close: () => closeLedger(path) };
}

test("counts each bounce, denies guessing for old events or later changed-head green", async () => {
  const f = await history();
  try {
    event(f.db, { op: "merge_conflict", cause: "ci_fail", prHead: HEAD });
    event(f.db, { head: "d".repeat(40), summary: "local green" }, "deliver", "author", 120);
    const out = replaySelectedHistory(f.db, "p", 1, 200, f.root);
    expect(out).toMatchObject({ totalBounces: 2, replayable: 1, hypotheticalAllowed: 1, unreplayable: 1,
      posterior: { confirmedProblem: 0, confirmedRecovered: 0, unknown: 1 } });
    expect(out.allowedWithUnverifiedSteps).toBe(1);
    expect(out.rows[0]!.unverifiedNonTest).toEqual(["core:guard=skipped", "core:build=skipped"]);
    expect(out.rows[0]!.posterior).toBe("unknown");
    expect(out.rows[0]!.evidence).toHaveLength(1);
    expect(out.rows[1]!.reason).toContain("旧事件");
  } finally { f.close(); }
});

test.each(["confirmed_problem", "confirmed_recovered"])("only exact explicit evidence classifies %s", async (outcome) => {
  const f = await history();
  try {
    const data = { op: "ci_selected_replay_followup", bounceSeq: f.seq, head: HEAD, receiptDigest: f.ref.digest,
      outcome, sameHeadRerun: { head: HEAD, checkout: CHECKOUT, runId: 7, attempt: 2, status: "completed", conclusion: "success", coverage: "full" },
      evidence: ["https://github.com/example/repo/actions/runs/7/attempts/2"] };
    event(f.db, { ...data, head: "d".repeat(40) }, "note", "owner", 120);
    event(f.db, data, "note", "author", 121);
    expect(replaySelectedHistory(f.db, "p", 1, 200, f.root).rows[0]!.posterior).toBe("unknown");
    event(f.db, data, "note", "owner", 122);
    expect(replaySelectedHistory(f.db, "p", 1, 200, f.root).rows[0]!.posterior).toBe(outcome);
    event(f.db, { ...data, outcome: outcome === "confirmed_problem" ? "confirmed_recovered" : "confirmed_problem" }, "note", "owner", 123);
    expect(replaySelectedHistory(f.db, "p", 1, 200, f.root).rows[0]!.posterior).toBe("unknown");
  } finally { f.close(); }
});

test("report refuses a copied reference bound to another head or round", async () => {
  const f = await history();
  try {
    const data = JSON.parse((f.db.query("SELECT data FROM events WHERE seq=?").get(f.seq) as { data: string }).data);
    data.ciSelectedReplay.round++;
    event(f.db, data);
    expect(replaySelectedHistory(f.db, "p", 1, 200, f.root).rows[1]!.reason).toContain("轮次");
  } finally { f.close(); }
});

test("real ledger command is classified read-only and works against query_only without changing bytes or events", async () => {
  const f = await history();
  try {
    expect(READER_ONLY_SUBS.has("ci-selected-replay")).toBe(true);
    expect(isWriteInvocation("ledger", ["ci-selected-replay", "p", "--days", "7"])).toBe(false);
    const count = f.db.query("SELECT COUNT(*) AS n FROM events").get();
    const file = readFileSync(join(f.root, f.ref.file), "utf8");
    f.db.exec("PRAGMA query_only=ON");
    const output = await runLedger(["ci-selected-replay", "p", "--days", "7"], { db: f.db, actor: "unknown", projectIds: ["p"],
      loadRegistry: async () => ({ agents: {} } as Registry), saveRegistry: async () => { throw new Error("must not write"); }, now: () => 200 });
    expect(output).toMatchObject({ ok: true, totalBounces: 1 });
    expect(f.db.query("SELECT COUNT(*) AS n FROM events").get()).toEqual(count);
    expect(readFileSync(join(f.root, f.ref.file), "utf8")).toBe(file);
    expect(() => replaySelectedHistory(f.db, "p", 0, 200, f.root)).toThrow("days");
  } finally { f.close(); }
});


test("real manager subprocess replays its isolated archive without writes", async () => {
  const f = await history();
  try {
    await saveReplayReceipt(receipt(), join(f.root, "ci-selected-replay"));
    writeFileSync(join(f.root, "projects.json"), JSON.stringify({ projects: [{ id: "p", name: "p", dirs: [f.root], createdAt: "2026-10-17" }] }));
    const archived = JSON.parse((f.db.query("SELECT data FROM events WHERE seq=?").get(f.seq) as { data: string }).data);
    event(f.db, archived, "scheduler", "scheduler", Date.now());
    mkdirSync(join(f.root, "logs"));
    writeFileSync(join(f.root, "registry.json"), JSON.stringify({ socket: join(f.root, "run/master.sock"), agents: {} }));
    const registry = readFileSync(join(f.root, "registry.json"), "utf8");
    const files = readdirSync(f.root, { recursive: true }).sort();
    const before = f.db.query("SELECT count(*) AS n FROM events").get();
    const env = { ...process.env, CLAUDESTRA_STATE_DIR: f.root, FLOKA_STATE_DIR: f.root,
      CLAUDESTRA_RUNTIME_DIR: join(f.root, "run"), FLOKA_RUNTIME_DIR: join(f.root, "run"), DISCORD_CHANNEL_ID: "", CLAUDESTRA_SCHEDULER_SERVICE: "" };
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "../src/manager.ts"), "ledger", "ci-selected-replay", "p", "--days", "1"],
      { env, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
    expect(JSON.parse(stdout.trim().split("\n").at(-1)!)).toMatchObject({ ok: true, totalBounces: 1, replayable: 1, hypotheticalAllowed: 1 });
    expect(f.db.query("SELECT count(*) AS n FROM events").get()).toEqual(before);
    expect(readdirSync(f.root, { recursive: true }).sort()).toEqual(files);
    expect(readFileSync(join(f.root, "registry.json"), "utf8")).toBe(registry);
  } finally { f.close(); }
}, 30_000);

test("existing ledger note command can record an exact, cited posterior determination", async () => {
  const f = await history();
  try {
    const data = { bounceSeq: f.seq, head: HEAD, receiptDigest: f.ref.digest, outcome: "confirmed_problem",
      evidence: ["https://github.com/example/repo/commit/" + HEAD] };
    const result = await runLedger(["note", "T", "ci-selected-replay-followup " + JSON.stringify(data)], { db: f.db, actor: "owner",
      projectIds: ["p"], loadRegistry: async () => ({ agents: {} } as Registry), saveRegistry: async () => {}, now: () => 130 });
    expect(result.ok).toBe(true);
    expect(replaySelectedHistory(f.db, "p", 1, 200, f.root).rows[0]!.posterior).toBe("confirmed_problem");
  } finally { f.close(); }
});


test("a cited recovery without full same-head/same-checkout rerun facts remains unknown", async () => {
  const f = await history();
  try {
    const data = { op: "ci_selected_replay_followup", bounceSeq: f.seq, head: HEAD, receiptDigest: f.ref.digest,
      outcome: "confirmed_recovered", evidence: ["https://github.com/example/repo/actions/runs/7/attempts/2"] };
    event(f.db, data, "note", "owner", 120);
    const proof = { head: "d".repeat(40), checkout: CHECKOUT, runId: 7, attempt: 2, status: "completed", conclusion: "success", coverage: "full" };
    event(f.db, { ...data, sameHeadRerun: proof }, "note", "owner", 121);
    event(f.db, { ...data, sameHeadRerun: { ...proof, head: HEAD, checkout: "e".repeat(40) } }, "note", "owner", 122);
    expect(replaySelectedHistory(f.db, "p", 1, 200, f.root).rows[0]!.posterior).toBe("unknown");
  } finally { f.close(); }
});

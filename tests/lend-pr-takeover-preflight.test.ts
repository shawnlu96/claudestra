import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { uiDeliverPort } from "../src/lib/ledger-deliver-ui-port.js";
import type { UiDeliverPort } from "../src/lib/ledger-deliver-ui.js";
import { getLendOrder } from "../src/lib/ledger-lend.js";
import { getWriteLease } from "../src/lib/ledger-lend-lease.js";
import { beatLend } from "../src/lib/ledger-lend-peers.js";
import { closeLedger, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import { lendTakeoverStep, type TakeoverGh } from "../src/lib/lend-pr-takeover.js";
import { uiTakeoverRefusal } from "../src/lib/lend-pr-takeover-refusal.js";
import { runLedger } from "../src/manager/ledger.js";
import { takeoverDeps } from "../src/manager/ledger-lend-takeover-cmds.js";
import { testChildEnv } from "./test-env.js";

const project = "uitake", taskId = "UT", branch = "lend/UT", base = "a".repeat(40), head = "b".repeat(40);
let db: Database, now: number, seen: Map<string, string>, id: string;
let dir: string, policyPath: string, creates: number, calls: number;
let gh: TakeoverGh;
const atHead = async () => ({ ok: true as const, head });
const port = (peer: { peer: string; worker: string; orderId: string }) => uiDeliverPort({ peer, policyPath, root: join(dir, "artifacts"), now });
const policy = (value: string) => { writeFileSync(policyPath, JSON.stringify({ projects: { [project]: { keys: { uiDelivery: value } } } })); };
const run = (args: string[], actor = "agent-lead") => runLedger(args, {
  db, actor, projectIds: [project], now: () => now,
  loadRegistry: async () => ({ socket: "", agents: {} }), saveRegistry: async () => {},
  lend: { borrow: async () => [{ peer: "testpeer", projects: [project], roles: ["write" as const], maxOpen: 1 }], notifyPm: async () => {},
    result: { peerFp: async () => "abcd-ef01-2345-6789", remoteHead: async (_repo: string, br: string) => ({ ok: true as const, head: br === "main" ? base : head }) } } as never,
}) as Promise<Record<string, any>>;
const step = (uiPort = port) => lendTakeoverStep(db, { gh, seen, now: () => now, uiPort,
  manager: (...args) => {
    if (args[1] === "lend-takeover") calls++;
    takeoverDeps.make = () => ({ remoteHead: (repo, br) => gh.head(repo, br), uiPort });
    return run(args.slice(1), "scheduler");
  } });
const snapshot = () => JSON.stringify((db.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[])
  .map(({ name }) => [name, db.query(`SELECT * FROM "${name}"`).all()]));
const notes = () => listEvents(db, { target: taskId }).filter(e => e.data.preflight === true);
const savedMake = takeoverDeps.make;

beforeEach(async () => {
  now = 10_000; seen = new Map(); creates = 0; calls = 0;
  dir = mkdtempSync(join(tmpdir(), "uitake-preflight-")); db = openLedger(join(dir, "source.sqlite")); policyPath = join(dir, "policy.json"); policy("on");
  const spec = join(dir, "spec.md"); writeFileSync(spec, "Isolated UI takeover fixture.");
  setMeta(db, { actor: "owner", now }, { project, key: "pms", value: ["agent-lead"] });
  createTask(db, { actor: "owner", now }, { project, id: taskId, title: "UI takeover", kind: "code", spec, agent: "agent-writer" });
  db.run("UPDATE tasks SET stage='build' WHERE id=?", [taskId]);
  db.run(`INSERT INTO task_workflows (taskId,project,template,templateVersion,mode,authorFamily,fallback,specRev,createdAt,updatedAt)
    VALUES (?,?,'ui',3,'manual','codex','',1,1,1)`, [taskId, project]);
  const offered = await run(["lend-offer", taskId, "--peer", "testpeer", "--repo", "example/test"]);
  expect(offered).toMatchObject({ ok: true }); id = offered.orderId;
  expect(await run(["lend-claim", "--", "testpeer", JSON.stringify({ v: 1, orderId: id, worker: "agent-testworker" })], "owner")).toMatchObject({ ok: true });
  db.run("UPDATE lend_orders SET branch=? WHERE orderId=?", [branch, id]);
  const beat = () => beatLend(db, { actor: "owner", now }, "testpeer", { v: 1, orders: [{ orderId: id, gen: 1,
    phase: "publishing", lastActivityAt: 0, excerpt: "fixture", ended: null }] } as never, new Map());
  beat(); now += 180_000; beat(); now += 180_000; beat();
  takeoverDeps.make = () => ({ remoteHead: atHead, uiPort: port });
  gh = { head: atHead, compare: async () => ({ ok: true, value: "ahead" }), openPr: async () => ({ ok: true, value: null }),
    createPr: async () => { creates++; return { ok: true, value: 42 }; } };
});
afterEach(() => { takeoverDeps.make = savedMake; closeLedger(db.filename); });

test("old create-before-CLI refuses after an external PR; new preflight is 0 create / 0 takeover with one persistent diagnostic", async () => {
  await gh.createPr({ repo: "example/test", branch, base: "main", title: "fixture", body: "fixture" });
  const before = snapshot();
  expect(await run(["lend-takeover", id, "--head", head, "--pr", "42"], "scheduler")).toMatchObject({ ok: false, code: "invalid" });
  expect(snapshot()).toBe(before); expect(creates).toBe(1); creates = 0;
  await step(); expect((await step()).failed).toHaveLength(1);
  for (let n = 0; n < 8; n++) expect((await step()).failed).toEqual([]);
  seen = new Map(); await step(); await step(); // Restart: persistent dedup, not in-memory suppression.
  expect(creates).toBe(0); expect(calls).toBe(0); expect(notes()).toHaveLength(1);
  expect(notes()[0].data).toMatchObject({ orderId: id, head, code: "missing", pr: null, preflight: true });
  expect(getWriteLease(db, taskId)?.state).toBe("held");
  expect(getLendOrder(db, id)?.status).toBe("claimed");
  expect(getTask(db, taskId)?.stage).toBe("build");
  const afterDiagnostic = snapshot();
  await run(["lend-takeover", id, "--head", head, "--pr", "42"], "scheduler");
  expect(snapshot()).toBe(afterDiagnostic);
});

for (const value of ["observe", "off", "code"]) test(`${value} preserves original PR / takeover route`, async () => {
  if (value === "code") db.run("UPDATE task_workflows SET template='code' WHERE taskId=?", [taskId]);
  else policy(value);
  await step(); await step();
  expect(creates).toBe(1); expect(calls).toBe(1); expect(getTask(db, taskId)?.stage).toBe("review");
  expect(notes()).toEqual([]);
});

test("existing PR is recorded as existing; unknown lookup never claims not sent or attempts takeover", async () => {
  await step(); gh.openPr = async () => ({ ok: false, error: "unknown external result" });
  expect((await step()).failed[0]?.error).toContain("unknown external result");
  expect(notes()).toEqual([]); expect(creates + calls).toBe(0);
  gh.openPr = async () => ({ ok: true, value: 77 }); await step();
  expect(notes()[0].data.pr).toBe(77); expect(notes()[0].data.effect).toContain("已查到 PR #77");
  expect(notes()[0].data.effect).not.toContain("代开 PR / 接管未发出");
  expect(creates + calls).toBe(0);
});

test("policy changes resume; spec / head changes have distinct diagnostics and no stale retries", async () => {
  await step(); await step();
  const next = "c".repeat(40); gh.head = async () => ({ ok: true, head: next });
  await step(); await step();
  expect(notes()).toHaveLength(2); expect(notes().at(-1)?.data.head).toBe(next);
  db.run("UPDATE tasks SET specRev=2 WHERE id=?", [taskId]); await step();
  expect(notes()).toHaveLength(2); // Changed specification invalidates the old order.
  db.run("UPDATE tasks SET specRev=1 WHERE id=?", [taskId]);
  gh.head = atHead; await step(); policy("off"); await step();
  expect(creates).toBe(1); expect(calls).toBe(1); expect(notes()).toHaveLength(2);
});

test("unreadable policy and thrown pre-read conservatively block", async () => {
  await step(); writeFileSync(policyPath, "{"); await step();
  expect(notes()[0].data.code).toBe("policy_unreadable"); expect(creates + calls).toBe(0);
  const throwing = () => { throw new Error("read unavailable"); };
  expect((await step(throwing)).failed[0]?.error).toContain("接管预读失败"); expect(creates + calls).toBe(0);
});

test("diagnostic storage retries bounded; changed material is re-read before retry", async () => {
  let attempts = 0;
  const failing = (peer: Parameters<typeof port>[0]): UiDeliverPort => ({ ...port(peer), observe: () => { attempts++; throw new Error("store unavailable"); } });
  await step(failing);
  for (let n = 0; n < 8; n++) await step(failing);
  expect(attempts).toBe(3); expect(creates + calls).toBe(0);
  policy("off"); await step(failing);
  expect(attempts).toBe(3); expect(getTask(db, taskId)?.stage).toBe("review");
});

test("pre-read is no authorization: policy drifts after it and final CLI rejects with zero writes", async () => {
  policy("observe"); expect(uiTakeoverRefusal(db, id, head, port)).toBeNull();
  policy("on"); const before = snapshot();
  expect(await run(["lend-takeover", id, "--head", head, "--pr", "42"], "scheduler")).toMatchObject({ ok: false, code: "invalid" });
  expect(snapshot()).toBe(before);
});

test("ownership and ancestry still prevent creation; no author identity bypass", async () => {
  await step(); gh.compare = async () => ({ ok: true, value: "diverged" }); await step();
  expect(notes()).toEqual([]); expect(creates + calls).toBe(0);
  gh.compare = async () => ({ ok: true, value: "ahead" });
  gh.openPr = async () => { db.run("UPDATE lend_orders SET status='cancelled' WHERE orderId=?", [id]); return { ok: true, value: null }; };
  await step(); expect(notes()).toEqual([]); expect(creates + calls).toBe(0);
  expect(await run(["lend-takeover", id, "--head", head, "--pr", "42"], "agent-writer")).toMatchObject({ ok: false, code: "forbidden" });
});


test("real manager CLI subprocess: missing UI evidence refuses after remote lookup, every table unchanged", async () => {
  const state = join(dir, "cli-state"), bin = join(dir, "bin");
  mkdirSync(state); mkdirSync(bin);
  const fakeGit = join(bin, "git");
  writeFileSync(fakeGit, `#!/bin/sh
[ "$1" = "ls-remote" ] || exit 91
printf '%s\t%s\n' '${head}' 'refs/heads/${branch}'
`);
  chmodSync(fakeGit, 0o700);
  writeFileSync(join(state, "registry.json"), JSON.stringify({ socket: "", agents: {} }));
  writeFileSync(join(state, "projects.json"), JSON.stringify({ projects: [{ id: project, name: "Test", dirs: [dir] }] }));
  writeFileSync(join(state, "recovery-policy.json"), JSON.stringify({ projects: { [project]: { keys: { uiDelivery: "on" } } } }));
  db.run("UPDATE lend_orders SET leaseUntil=? WHERE orderId=?", [Date.now() + 60_000, id]);
  const path = join(state, "ledger.sqlite");
  db.query("VACUUM INTO ?").run(path);
  const copy = new Database(path);
  const snap = () => JSON.stringify((copy.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[])
    .map(({ name }) => [name, copy.query(`SELECT * FROM "${name}"`).all()]));
  const before = snap();
  const cli = (command: string) => Bun.spawn([process.execPath, resolve("src/manager.ts"), "ledger", command, id, "--head", head, "--pr", "42"], {
    cwd: dir, env: testChildEnv({ PATH: `${bin}:/usr/bin:/bin`, HOME: dir, CLAUDESTRA_STATE_DIR: state }), stdout: "pipe", stderr: "pipe",
  });
  const child = cli("lend-takeover");
  try {
    const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    await child.exited;
    expect({ output: out, stderr: err }).toMatchObject({ output: expect.stringContaining("截图证据不合格") });
    expect(JSON.parse(out)).toMatchObject({ ok: false, code: "invalid", current: { ui: "missing" } });
    expect(snap()).toBe(before);
    const business = () => JSON.stringify(JSON.parse(snap()).filter(([name]: [string]) => name !== "events")
      .map(([name, rows]: [string, { name?: string }[]]) => [name, name === "sqlite_sequence" ? rows.filter(r => r.name !== "events") : rows]));
    const businessBefore = business();
    const diagnostic = cli("lend-takeover-refusal");
    const reply = await new Response(diagnostic.stdout).text();
    await diagnostic.exited;
    expect(JSON.parse(reply)).toMatchObject({ ok: true, message: expect.stringContaining("截图证据不合格") });
    expect(business()).toBe(businessBefore);
    const diagnosed = snap();
    const duplicate = cli("lend-takeover-refusal");
    expect(JSON.parse(await new Response(duplicate.stdout).text())).toMatchObject({ ok: true, message: null });
    await duplicate.exited; expect(snap()).toBe(diagnosed);
  } finally { copy.close(); }
});


test("diagnostic lock recheck drops a stale policy refusal without creating or delivering", async () => {
  let reads = 0;
  const changing = (peer: Parameters<typeof port>[0]): UiDeliverPort => {
    const p = port(peer);
    return { ...p, mode: () => ({ mode: ++reads === 1 ? "on" : "off" }) };
  };
  await step(changing); expect((await step(changing)).failed).toEqual([]);
  expect(reads).toBe(2); expect(notes()).toEqual([]); expect(creates + calls).toBe(0);
});


test("production query_only scheduler connection records through CLI, never writes its read connection", async () => {
  const reader = new Database(db.filename);
  reader.exec("PRAGMA query_only=ON");
  const deps = { gh, seen, now: () => now, uiPort: port, manager: (...args: string[]) => {
    if (args[1] === "lend-takeover") calls++;
    return run(args.slice(1), "scheduler");
  } };
  try {
    await lendTakeoverStep(reader, deps);
    expect((await lendTakeoverStep(reader, deps)).failed).toHaveLength(1);
    seen.clear(); await lendTakeoverStep(reader, deps); await lendTakeoverStep(reader, deps);
    expect(notes()).toHaveLength(1); expect(creates + calls).toBe(0);
    expect(reader.query("PRAGMA query_only").get()).toEqual({ query_only: 1 });
    expect(await run(["lend-takeover-refusal", id, "--head", head], "agent-writer")).toMatchObject({ ok: false, code: "forbidden" });
  } finally { reader.close(); }
});


test("diagnostic CLI independently refuses obsolete remote head without a stale note", async () => {
  const newHead = "d".repeat(40);
  let reads = 0;
  gh.head = async () => ({ ok: true, head: ++reads <= 2 ? head : newHead });
  await step(); await step();
  expect(notes()).toEqual([]); expect(creates + calls).toBe(0);
});

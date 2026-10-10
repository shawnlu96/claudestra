import { expect, test } from "bun:test";
import { buildCardWorkerIndex, type WorkerRegistration } from "../src/lib/agent-lifecycle-store.js";
import { cardBoundaryMode, cardSoftDecision, isCardSession } from "../src/lib/ctx-boundary-card-worker.js";

const agent = { name: "arbitrary-reviewer", sessionId: "current", status: "active" };
const row: WorkerRegistration = {
  agent: agent.name, sessionId: "current", taskId: "card", role: "reviewer", createdBy: "pm",
  createdAt: 1, state: "active", retiredAt: null, reason: null,
};
const index = buildCardWorkerIndex({ registrations: [row], bound: [], executors: [] });

test("active registry worker and active session-matched LIFE1 reviewer have authority", () => {
  expect(isCardSession({ ...agent, kind: "worker" }, new Map(), [])).toBe(true);
  expect(isCardSession(agent, index, [row])).toBe(true);
  expect(isCardSession({ ...agent, sessionId: "replacement" }, index, [row])).toBe(false);
  expect(isCardSession(agent, index, [{ ...row, state: "retired" }])).toBe(false);
  expect(isCardSession({ ...agent, status: "stopped", kind: "worker" }, index, [row])).toBe(false);
});

test("task names, owner and PM have no implicit authority", () => {
  const taskOnly = buildCardWorkerIndex({ registrations: [], bound: [], executors: [{ agent: agent.name, taskId: "card", stage: "build" }] });
  expect(isCardSession(agent, taskOnly, [])).toBe(false);
  for (const name of ["agent-task-pretender", "owner", "pm"]) {
    expect(isCardSession({ ...agent, name }, index, [row])).toBe(false);
  }
});

test("200K needs three idle minutes; 300K never claims queued enforcement", () => {
  const decide = (tokens: number, idle = 180_000, busy: boolean | null = false) =>
    cardSoftDecision(agent, { sessionId: "current", tokens, observedAt: 200_000 }, 200_000, 200_000 - idle, busy);
  expect(decide(199_999)).toEqual({ fire: false, reason: "under" });
  expect(decide(200_000, 179_999)).toEqual({ fire: false, reason: "busy" });
  expect(decide(200_000)).toEqual({ fire: true, kind: "idle" });
  expect(decide(200_000, 180_000, null)).toEqual({ fire: false, reason: "busy" });
  expect(decide(300_000, 0, true)).toEqual({ fire: false, reason: "blocked-capability" });
});

test("unknown, stale and different-session usage cannot become zero", () => {
  expect(cardSoftDecision(agent, null, 200_000, 0, false).fire).toBe(false);
  for (const usage of [
    { sessionId: "old", tokens: 250_000, observedAt: 200_000 },
    { sessionId: "current", tokens: 250_000, observedAt: 1 },
    { sessionId: "current", tokens: NaN, observedAt: 200_000 },
  ]) expect(cardSoftDecision(agent, usage, 200_000, 0, false)).toEqual({ fire: false, reason: "usage-unknown" });
  expect(cardBoundaryMode(undefined)).toBe("observe");
  expect(cardBoundaryMode("invalid")).toBe("observe");
});

import { ctxBoundaryTick, resetCtxBoundaryState } from "../src/bridge/ctx-boundary.js";
import { agent as boundaryAgent, harness, BUSY_PANE } from "./ctx-boundary-harness.js";

test("on card identity wins conflicting policy; observe and off preserve ordinary action", async () => {
  for (const mode of ["on", "observe", "off"]) {
    resetCtxBoundaryState();
    const worker = boundaryAgent({ name: "arbitrary-worker", kind: "worker", status: "active", executor: false, ctx: 200_000 });
    const h = harness([worker], { autoCompact: { cardWorkers: mode, inject: false, window: 400_000 } });
    worker.usage = {path: "fixture", sessionId: worker.sessionId, tokens: worker.ctx!, observedAt: h.now, usageTs: h.now, size: 1, mtime: 1};
    h.deps.verifyCard = async () => true;
    const result = await ctxBoundaryTick(h.deps);
    expect(h.sent.length).toBe(mode === "on" ? 1 : 0);
    if (mode === "on") {
      expect(result[0].boundary.policy).toBe("card-worker");
      expect(h.sent[0].line.startsWith("/compact ")).toBe(true);
    }
  }
});

test("on card hard line reports missing capability without typing or claiming completion", async () => {
  resetCtxBoundaryState();
  const worker = boundaryAgent({ name: "reviewer", kind: "worker", status: "active", ctx: 300_000 });
  const h = harness([worker], { autoCompact: { cardWorkers: "on" } });
  worker.usage = {path: "fixture", sessionId: worker.sessionId, tokens: worker.ctx!, observedAt: h.now, usageTs: h.now, size: 1, mtime: 1};
  h.win(worker.target).pane = BUSY_PANE;
  const result = await ctxBoundaryTick(h.deps);
  expect(result[0].verdict).toEqual({ fire: false, reason: "blocked-capability" });
  expect(h.alerts.length).toBe(1);
  expect(h.sent).toEqual([]);
});

import { writeFileSync } from "node:fs";
import { readCardUsage, cardUsageUnchanged } from "../src/lib/ctx-boundary-card-worker.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("real bounded usage snapshot rejects later conversation, compact boundary and changed file", () => {
  const path = join(mkdtempSync(join(tmpdir(), "ctx1-source-")), "fixture.jsonl");
  const usage = { type: "assistant", timestamp: new Date(100_000).toISOString(),
    message: { usage: { input_tokens: 200_000, cache_read_input_tokens: 10, cache_creation_input_tokens: 20 } } };
  const save = (extra: unknown[] = []) => writeFileSync(path, [usage, ...extra].map((r) => JSON.stringify(r)).join("\n") + "\n");
  save();
  const snapshot = readCardUsage(path, "claude-code", "current", 500_000);
  expect(snapshot?.tokens).toBe(200_030);
  expect(cardUsageUnchanged(snapshot!, 500_000)).toBe(true);
  expect(cardUsageUnchanged(snapshot!, 560_001)).toBe(false);
  save([{ type: "user", timestamp: new Date(200_000).toISOString(), message: { content: "new turn" } }]);
  expect(cardUsageUnchanged(snapshot!, 500_000)).toBe(false);
  expect(readCardUsage(path, "claude-code", "current", 500_000)).toBeNull();
  save([{ type: "system", subtype: "compact_boundary", timestamp: new Date(200_000).toISOString() }]);
  expect(readCardUsage(path, "claude-code", "current", 500_000)).toBeNull();
});

import { spawnSync } from "node:child_process";
import { testChildEnv } from "./test-env.ts";

test("fresh registry and active registration generation are part of the identity fence", () => {
  const root = mkdtempSync(join(tmpdir(), "ctx1-generation-"));
  const modulePath = join(import.meta.dir, "../src/lib/ctx-boundary-card-worker.ts");
  const script = `
    import {cardIdentityStamp} from ${JSON.stringify(modulePath)};
    import {Database} from "bun:sqlite";
    import {mkdirSync,writeFileSync} from "node:fs";
    const p=process.env.CLAUDESTRA_STATE_DIR;mkdirSync(p,{recursive:true});
    const registry=p+"/registry.json";
    writeFileSync(registry,JSON.stringify({agents:{reviewer:{status:"active",sessionId:"same"}}}));
    const db=new Database(p+"/ledger.sqlite");
    db.exec("CREATE TABLE tasks(id TEXT,agent TEXT,stage TEXT)");
    db.exec("CREATE TABLE worker_agents(agent TEXT,sessionId TEXT,taskId TEXT,role TEXT,createdBy TEXT,createdAt INTEGER,state TEXT,retiredAt INTEGER,reason TEXT)");
    db.exec("INSERT INTO tasks VALUES('card','reviewer','build'); INSERT INTO worker_agents VALUES('reviewer','same','card','reviewer','pm',1,'active',NULL,NULL)");
    const first=cardIdentityStamp("reviewer","same");
    db.exec("UPDATE worker_agents SET createdAt=2");
    const second=cardIdentityStamp("reviewer","same");
    writeFileSync(registry,"{broken");
    console.log(JSON.stringify([!!first,!!second,first!==second,cardIdentityStamp("reviewer","same")]));
    db.close();
  `;
  const r = spawnSync(process.execPath, ["--no-env-file", "-e", script], { encoding: "utf8", env: testChildEnv({
    HOME: join(root, "home"), CLAUDESTRA_STATE_DIR: join(root, "state"),
    CLAUDESTRA_RUNTIME_DIR: join(root, "run"), TMPDIR: root,
  }) });
  expect(r.status).toBe(0);
  expect(JSON.parse(r.stdout)).toEqual([true, true, true, null]);
});

test("r1 idle-above-cap: trusted idle TUI worker still compacts above 300K", async () => {
  resetCtxBoundaryState();
  const worker = boundaryAgent({ name: "idle-reviewer", kind: "worker", status: "active", ctx: 300_001 });
  const h = harness([worker], { autoCompact: { cardWorkers: "on" } });
  worker.usage = { path: "fixture", sessionId: worker.sessionId, tokens: worker.ctx!, observedAt: h.now, usageTs: h.now, size: 1, mtime: 1 };
  h.deps.verifyCard = async () => true;
  await ctxBoundaryTick(h.deps);
  expect(h.sent.length).toBe(1);
});

test("r1 tick-save-compact: unreadable ledger never sends save-compact to an arbitrary reviewer", () => {
  const root = mkdtempSync(join(tmpdir(), "ctx1-r1-unreadable-"));
  const service = join(import.meta.dir, "../src/bridge/ctx-boundary.ts");
  const fixture = join(import.meta.dir, "ctx-boundary-harness.ts");
  const script = `
    import {ctxBoundaryTick} from ${JSON.stringify(service)};
    import {agent,harness} from ${JSON.stringify(fixture)};
    import {mkdirSync,writeFileSync} from "node:fs";
    const p=process.env.CLAUDESTRA_STATE_DIR;mkdirSync(p,{recursive:true});
    writeFileSync(p+"/ledger.sqlite","not a database");
    writeFileSync(p+"/config.json",JSON.stringify({autoCompact:{cardWorkers:"on"}}));
    writeFileSync(p+"/registry.json",JSON.stringify({agents:{reviewer:{status:"active",sessionId:"current"}}}));
    const h=harness([agent({name:"reviewer",status:"active",sessionId:"current",executor:false,ctx:600000})],
      {autoCompact:{cardWorkers:"on",inject:false}});
    await ctxBoundaryTick(h.deps);console.log(JSON.stringify(h.sent));
  `;
  const r = spawnSync(process.execPath, ["--no-env-file", "-e", script], { encoding: "utf8", env: testChildEnv({
    HOME: join(root, "home"), CLAUDESTRA_STATE_DIR: join(root, "state"), CLAUDESTRA_RUNTIME_DIR: join(root, "run"), TMPDIR: root,
  }) });
  expect(r.status).toBe(0);
  expect(JSON.parse(r.stdout).some((s: {line: string}) => s.line === "/save-compact")).toBe(false);
});

test("r2 busy-rescue-bypass: on preserves observe rescue at 950K of a real 1M window", async () => {
  for (const mode of ["observe", "on"]) {
    resetCtxBoundaryState();
    const worker = boundaryAgent({ name: "rescue-reviewer", kind: "worker", status: "active", ctx: 950_000, realWindow: 1_000_000 });
    const h = harness([worker], { autoCompact: { cardWorkers: mode, inject: true } });
    worker.usage = { path: "fixture", sessionId: worker.sessionId, tokens: worker.ctx!, observedAt: h.now, usageTs: h.now, size: 1, mtime: 1 };
    h.deps.verifyCard = async () => true;
    h.win(worker.target).pane = BUSY_PANE;
    const [result] = await ctxBoundaryTick(h.deps);
    expect(result.verdict).toEqual({ fire: true, kind: "hard-cap" });
    expect(h.sent.length).toBe(1);
    if (mode === "on") expect(h.sent[0].line.startsWith("/compact ")).toBe(true);
  }
});

test("r2 rescue adjacency and actual smaller windows retain all safety gates", async () => {
  const cases = [
    { ctx: 929_999, window: 1_000_000, send: false },
    { ctx: 930_000, window: 1_000_000, send: true },
    { ctx: 371_999, window: 400_000, send: false },
    { ctx: 372_000, window: 400_000, send: true },
    { ctx: 162_749, window: 175_000, send: false },
    { ctx: 162_750, window: 175_000, send: true },
    { ctx: 950_000, window: null, send: false },
    { ctx: 950_000, window: 1_000_000, send: false, emergency: false },
  ];
  for (const c of cases) {
    resetCtxBoundaryState();
    const worker = boundaryAgent({ name: "small-window-reviewer", kind: "worker", status: "active", ctx: c.ctx, realWindow: c.window });
    const h = harness([worker], { autoCompact: { cardWorkers: "on", emergency: c.emergency } });
    worker.usage = { path: "fixture", sessionId: worker.sessionId, tokens: c.ctx, observedAt: h.now, usageTs: h.now, size: 1, mtime: 1 };
    h.deps.verifyCard = async () => true;
    h.win(worker.target).pane = BUSY_PANE;
    await ctxBoundaryTick(h.deps);
    expect(h.sent.length).toBe(c.send ? 1 : 0);
  }
  for (const gate of ["draft", "menu", "compacting", "wall", "session", "usage", "acp"]) {
    resetCtxBoundaryState();
    const worker = boundaryAgent({ name: "gated-reviewer", kind: "worker", status: "active", ctx: 950_000, realWindow: 1_000_000 });
    const h = harness([worker], { autoCompact: { cardWorkers: "on" } });
    worker.usage = gate === "usage" ? null
      : { path: "fixture", sessionId: worker.sessionId, tokens: worker.ctx!, observedAt: h.now, usageTs: h.now, size: 1, mtime: 1 };
    if (gate === "acp") worker.transport = "acp";
    h.deps.verifyCard = async () => gate !== "session";
    h.win(worker.target).pane = BUSY_PANE;
    if (["draft", "menu", "compacting", "wall"].includes(gate)) Object.assign(h.state, { [gate]: true });
    await ctxBoundaryTick(h.deps);
    expect(h.sent).toEqual([]);
  }
});

test("r2 rescue below the card soft line alerts rather than bypassing a draft", async () => {
  resetCtxBoundaryState();
  const worker = boundaryAgent({ name: "tiny-window-reviewer", kind: "worker", status: "active", ctx: 162_750, realWindow: 175_000 });
  const h = harness([worker], { autoCompact: { cardWorkers: "on" }, state: { draft: true } });
  worker.usage = { path: "fixture", sessionId: worker.sessionId, tokens: worker.ctx!, observedAt: h.now, usageTs: h.now, size: 1, mtime: 1 };
  h.win(worker.target).pane = BUSY_PANE;
  await ctxBoundaryTick(h.deps);
  expect(h.sent).toEqual([]);
  expect(h.alerts[0].data.cap).toBe(162_750);
});

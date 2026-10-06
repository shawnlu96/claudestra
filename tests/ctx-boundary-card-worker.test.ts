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
import { agent as boundaryAgent, harness } from "./ctx-boundary-harness.js";

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
  const result = await ctxBoundaryTick(h.deps);
  expect(result[0].verdict).toEqual({ fire: false, reason: "blocked-capability" });
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

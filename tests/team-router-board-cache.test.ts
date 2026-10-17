import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { teamRouterTicker } from "../src/bridge/team-router.js";
import { LedgerReader } from "../src/lib/ledger-read.js";
import { closeLedger, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask, deliver, moveStage, recordReview, setMeta } from "../src/lib/ledger-write.js";
import type { RouteNotice } from "../src/lib/team-route.js";

test("team review history uses project/target index and still notifies PM", async () => {
  const dir = mkdtempSync(join(tmpdir(), "board-team-index-")), path = join(dir, "ledger.sqlite");
  const db = openLedger(path), reader = new LedgerReader(path), notices: RouteNotice[] = [], logs: string[] = [];
  const owner = { actor: "owner", now: 1 };
  setMeta(db, owner, { project: "p", key: "pms", value: ["agent-pm"] });
  setMeta(db, owner, { project: "p", key: "team", value: { dispatcher: null, audit: true } });
  createTask(db, owner, { project: "p", id: "T1", title: "One", kind: "code", agent: "agent-one" });
  moveStage(db, owner, { taskId: "T1", from: "spec", to: "restate" });
  moveStage(db, owner, { taskId: "T1", from: "restate", to: "build" });
  deliver(db, { actor: "agent-one", now: 2 }, { taskId: "T1", moveFrom: "build" });
  const tick = teamRouterTicker({ reader, cursorPath: join(dir, "cursor.json"), channelOf: () => "c-pm",
    send: async n => { notices.push(n); return "sent"; }, escalate: async () => null, log: line => { logs.push(line); } });
  await tick();
  const read = reader.get()!;
  const prepare = spyOn(read, "prepare");
  try {
    recordReview(db, { actor: "agent-review", now: 3 }, { taskId: "T1", reviewer: "regular", verdict: "pass", p0: 0, p1: 0, p2: 0 });
    await tick();
    const queries = prepare.mock.calls.map(([sql]) => sql).filter(sql => /SELECT \* FROM events.*target = \?/.test(sql));
    expect(queries.length).toBeGreaterThan(0);
    for (const sql of queries) {
      expect(sql).toContain("project = ? AND target = ?");
      const details = (read.query(`EXPLAIN QUERY PLAN ${sql}`).all("p", "T1") as { detail: string }[]).map(p => p.detail).join(" ");
      expect(details).toContain("events_project_target"); expect(details).not.toContain("SCAN events");
    }
    expect(listEvents(read, { project: "p", target: "T1" })).toEqual(listEvents(read, { target: "T1" }));
    expect(notices.map(n => [n.to, n.kind])).toEqual([["agent-pm", "review-next"]]);
    expect(logs.filter(line => line.includes("失败"))).toEqual([]);
  } finally { prepare.mockRestore(); reader.close(); closeLedger(path); rmSync(dir, { recursive: true, force: true }); }
});

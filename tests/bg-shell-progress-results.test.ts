import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ShellResults } from "../src/lib/bg-shell-results";
import { statePath } from "../src/lib/paths";

const identity = (agentName: string, sessionId = "session-a") => ({
  agentName, sessionId, id: "result-task", startedAt: 100, lastGrowth: 200, exitCode: null as number | null,
});
const pathFor = (a: string, s: string) => statePath("bg-shell-results", createHash("sha256").update(JSON.stringify([a, s])).digest("hex") + ".json");

test("minimal results recover unknown running/missing tasks and isolate agent-session identities", async () => {
  const results = new ShellResults();
  const act = identity("results-isolation");
  await results.load(act.agentName, act.sessionId);
  await results.remember(act);
  const restarted = new ShellResults();
  await restarted.load(act.agentName, act.sessionId);
  expect(restarted.snapshots(act.agentName)[0].end).toMatchObject({ status: "unknown", exitCode: null });
  expect(restarted.snapshots(act.agentName)[0].lines).toEqual([]);
  await restarted.load(act.agentName, "different-session");
  expect(restarted.snapshots(act.agentName)).toEqual([]);
  await restarted.remember({ ...act, exitCode: 1 }, 100, "done");
  expect(restarted.snapshots(act.agentName)).toEqual([]); // old session completion cannot replace the current session's view
  await restarted.load("other-agent", act.sessionId);
  expect(restarted.snapshots("other-agent")).toEqual([]);
  await results.remember({ ...act, exitCode: 1 }, 100, "done");
  const raw = JSON.parse(readFileSync(pathFor(act.agentName, act.sessionId), "utf8"));
  expect(Object.keys(raw[0]).sort()).toEqual(["durationMs", "exitCode", "id", "lastGrowth", "startedAt", "status"]);
  await restarted.load(act.agentName, act.sessionId);
  expect(restarted.snapshots(act.agentName)[0].end.exitCode).toBe(1);
  await restarted.select(act.agentName, "different-session");
  expect(restarted.snapshots(act.agentName)).toEqual([]);
  await restarted.select(act.agentName, act.sessionId);
  expect(restarted.snapshots(act.agentName)[0].end.exitCode).toBe(1);
});

test("corrupt or unreadable persisted results never infer success and corrupt writes are refused", async () => {
  const results = new ShellResults();
  const act = identity("results-corrupt");
  await results.remember({ ...act, exitCode: 0 }, 100, "done");
  const path = pathFor(act.agentName, act.sessionId);
  chmodSync(path, 0o000);
  try {
    await expect(Bun.file(path).text()).rejects.toThrow();
    await results.load(act.agentName, act.sessionId);
    expect(results.snapshots(act.agentName)).toEqual([]);
  } finally {
    chmodSync(path, 0o600);
  }
  writeFileSync(path, "{broken");
  await results.load(act.agentName, act.sessionId);
  expect(results.snapshots(act.agentName)).toEqual([]);
  await results.remember(act);
  expect(readFileSync(path, "utf8")).toBe("{broken");
  expect(results.snapshots(act.agentName)[0].end).toMatchObject({ status: "unknown", exitCode: null });
});

test("overlapping watcher instances merge results under the session lock instead of overwriting a stale cache", async () => {
  const a = new ShellResults(), b = new ShellResults();
  const act = identity("results-overlap");
  await a.load(act.agentName, act.sessionId);
  await b.load(act.agentName, act.sessionId);
  await a.remember({ ...act, id: "first", exitCode: 1 }, 100, "done");
  await b.remember({ ...act, id: "second", exitCode: 0 }, 100, "done");
  const restarted = new ShellResults();
  await restarted.load(act.agentName, act.sessionId);
  expect(restarted.snapshots(act.agentName).map((r) => [r.id, r.end.exitCode])).toEqual([["first", 1], ["second", 0]]);
});

test("stopped（[killed]）结局能持久化、刷新后还原成已停止；旧格式（只有 done / unknown）照读；stopped 带退出码的坏记录拒读", async () => {
  const act = identity("results-stopped");
  const path = pathFor(act.agentName, act.sessionId);
  mkdirSync(dirname(path), { recursive: true });
  const old = (id: string, status: string, exitCode: number | null) => ({ id, startedAt: 1, lastGrowth: 2, status, exitCode, durationMs: 3 });
  writeFileSync(path, JSON.stringify([old("old-done", "done", 0), old("old-unknown", "unknown", null)]));
  const results = new ShellResults();
  await results.load(act.agentName, act.sessionId);
  expect(results.snapshots(act.agentName).map((r) => [r.id, r.end.status, r.end.exitCode])).toEqual([["old-done", "done", 0], ["old-unknown", "unknown", null]]);
  await results.remember({ ...act, exitCode: 9 }, 100, "stopped");
  const restarted = new ShellResults();
  await restarted.load(act.agentName, act.sessionId);
  const snap = restarted.snapshots(act.agentName).find((r) => r.id === act.id)!;
  expect(snap.end).toEqual({ status: "stopped", exitCode: null, durationMs: 100 });
  expect(snap.lines).toEqual(["[killed]"]);
  expect(restarted.snapshots(act.agentName)).toHaveLength(3);
  writeFileSync(path, JSON.stringify([old("bad", "stopped", 0)]));
  await restarted.load(act.agentName, act.sessionId);
  expect(restarted.snapshots(act.agentName)).toEqual([]);
});

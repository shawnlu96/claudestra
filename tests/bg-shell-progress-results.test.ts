import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
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

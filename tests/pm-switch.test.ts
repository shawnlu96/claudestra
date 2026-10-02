import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getMeta, getTask, listEvents } from "../src/lib/ledger-store.js";
import { pmPointer, activeProjectPm } from "../src/lib/pm-role.js";
import { switchProjectPm } from "../src/lib/pm-role-switch.js";
import { pmStatus } from "../src/lib/pm-role-status.js";
import { readPmState } from "../src/lib/pm-role-state.js";
import { isWriteInvocation } from "../src/manager/write-commands.js";
import { A, B, D, P, Q, pmFixture } from "./pm-role-fixture.test.js";

const fixtures: ReturnType<typeof pmFixture>[] = [];
const fixture = () => { const f = pmFixture(); fixtures.push(f); return f; };
afterEach(() => { for (const f of fixtures.splice(0)) f.close(); });

const switchTo = (f: ReturnType<typeof pmFixture>, agent = B, dryRun = false, project = P) =>
  switchProjectPm(f.db, project, agent, { actor: "owner", dryRun, now: 100 }, f.deps);

test("dry run lists each change and leaves every state file and ledger event unchanged", async () => {
  const f = fixture(), bytes = f.bytes(), events = listEvents(f.db);
  const r = await switchTo(f, B, true);
  expect(r.changes.map((c) => c.location)).toEqual([
    "meta.activePm", "meta.pms", "peer-prs.replyTo", "peer-prs.peers[0].agent", "config.autoCompact.policies[0].match.names[0]",
  ]);
  expect(f.bytes()).toEqual(bytes);
  expect(listEvents(f.db)).toEqual(events);
  expect(pmPointer(f.db, P)).toBeNull();
  expect(f.notices).toEqual([]);
});

test("switch writes pointer, ordering and identity references; history, other projects and secrets survive", async () => {
  const f = fixture();
  const before = pmStatus(f.db, P, await f.deps.read());
  expect(before.entries.find((e) => e.location === "tasks.T1.pm")?.value).toBe(A);
  await switchTo(f);
  expect(pmPointer(f.db, P)).toBe(B);
  expect(getMeta(f.db, P).activePm).toBe(B);
  expect(getMeta(f.db, P).pms).toEqual([D, B, A]);
  expect(getTask(f.db, "T1")?.pm).toBe(A);
  expect(activeProjectPm(f.db, Q)).toBe("agent-other");
  const state = await readPmState(f.dir), status = pmStatus(f.db, P, state);
  expect(status.ok).toBe(true);
  expect(status.entries.find((e) => e.location === "tasks.T1.pm")?.via).toBe("redirect");
  expect(status.disabledTokens).toBe(1);
  expect(JSON.stringify(status)).not.toContain("SECRET");
  expect(JSON.stringify(status)).not.toContain("DO-NOT-RETURN");
  expect(state.peerPrs).toMatchObject({ replyTo: `${B}@remote`, peers: [{ agent: B }], extra: "preserve" });
  expect(state.config?.groqApiKey).toBe("CONFIG-SECRET");
  expect(f.notices.map((n) => n.target)).toEqual([B, A, `${A}@remote`]);
  expect(f.notices.every((n) => n.text === `当班 PM 改为 ${B}`)).toBe(true);
  expect(listEvents(f.db, { project: P }).at(-1)).toMatchObject({ kind: "decision", actor: "owner", data: { op: "pm-switch" } });
});

test("missing registration, offline candidate, dispatcher and foreign-project candidate refuse before writing", async () => {
  const f = fixture(), bytes = f.bytes();
  for (const agent of ["agent-missing", D, "agent-other", "agent-task-1"]) await expect(switchTo(f, agent)).rejects.toThrow();
  f.online.delete(B);
  await expect(switchTo(f)).rejects.toThrow("offline");
  expect(f.bytes()).toEqual(bytes);
  expect(pmPointer(f.db, P)).toBeNull();
});

test("active peer token scope is mandatory; disabled token scope is ignored", async () => {
  const f = fixture(), state = await f.deps.read();
  state.principals[0]!.agents = [A];
  f.put("principals.json", { principals: state.principals });
  const bytes = f.bytes();
  await expect(switchTo(f)).rejects.toThrow("lacks agent-beta");
  expect(f.bytes()).toEqual(bytes);
  state.principals[0]!.disabled = true;
  f.put("principals.json", { principals: state.principals });
  await switchTo(f);
  expect(pmPointer(f.db, P)).toBe(B);
});

test("two projects switch independently", async () => {
  const f = fixture(), state = await f.deps.read();
  state.principals[0]!.agents.push("agent-other");
  f.put("principals.json", { principals: state.principals });
  await switchTo(f);
  const bytes = f.bytes();
  await switchTo(f, "agent-other", false, Q);
  expect(activeProjectPm(f.db, P)).toBe(B);
  expect(activeProjectPm(f.db, Q)).toBe("agent-other");
  expect(f.bytes()).toEqual(bytes);
});

test("pending proposals and direct tmux cron targets remain visible manual issues", async () => {
  const f = fixture();
  f.put("team-proposals.json", { pending: { project: P, pms: [A, D], status: "pending" }, applied: { project: P, pms: [A], status: "applied" } });
  f.put("cron.json", { jobs: [{ id: "watch", targetAgent: "alpha", enabled: true }] });
  const proposals = readFileSync(join(f.dir, "team-proposals.json"), "utf8");
  await switchTo(f);
  const status = pmStatus(f.db, P, await f.deps.read());
  expect(status.ok).toBe(false);
  expect(status.entries.filter((e) => !e.follows).map((e) => e.location)).toEqual(["team-proposals.pending.pms", "cron.watch.targetAgent"]);
  expect(readFileSync(join(f.dir, "team-proposals.json"), "utf8")).toBe(proposals);
});

test("file write failure rolls back earlier writes and never commits pointer", async () => {
  const f = fixture(), before = f.bytes();
  f.deps.writeConfig = async () => { throw new Error("disk unavailable"); };
  await expect(switchTo(f)).rejects.toThrow("disk unavailable");
  expect(f.bytes().map((s) => JSON.parse(s))).toEqual(before.map((s) => JSON.parse(s)));
  expect(pmPointer(f.db, P)).toBeNull();
});

test("corrupt authorization file stops switch; read-only invocations do not claim writes", async () => {
  const f = fixture();
  f.put("principals.json", { bad: true });
  await expect(switchTo(f)).rejects.toThrow("authorization");
  expect(isWriteInvocation("ledger", ["pm-status"])).toBe(false);
  expect(isWriteInvocation("ledger", ["pm-switch", B, "--dry-run"])).toBe(false);
  expect(isWriteInvocation("ledger", ["pm-switch", B])).toBe(true);
});


test("switch preflight lists peers missing a notification destination instead of silently omitting them", async () => {
  const f = fixture();
  f.put("peer-prs.json", { project: P, peers: [] });
  const bytes = f.bytes();
  await expect(switchTo(f)).rejects.toThrow("peer remote lacks a PM agent destination");
  expect(f.bytes()).toEqual(bytes);
  expect(pmPointer(f.db, P)).toBeNull();
});


test("autoCompact replaces only identity lists and preserves compact instructions or enum-like strings", async () => {
  const f = fixture();
  f.put("config.json", { autoCompact: { policies: [{ id: A, action: "compact", keep: A, match: { names: [A], projects: [A] } }] } });
  await switchTo(f);
  expect((await f.deps.read()).config).toEqual({ autoCompact: { policies: [{ id: A, action: "compact", keep: A, match: { names: [B], projects: [A] } }] } });
  expect(pmStatus(f.db, P, await f.deps.read()).ok).toBe(true);
});

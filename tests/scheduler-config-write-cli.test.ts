/**
 * i28-W5b `ledger scheduler-remote` (manager/ledger-scheduler-remote-cmds.ts): argument checks, who may switch, output shape.
 * The command runs against a temp scheduler.json via schedulerRemoteCmds(path); runLedger is used only for the scheduler
 * identity, which it refuses before any command runs (so the production path is never reached).
 */
import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LedgerError, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { setMeta } from "../src/lib/ledger-write.js";
import type { Registry } from "../src/manager/core.js";
import { runLedger } from "../src/manager/ledger.js";
import { LedgerCli, type LedgerDeps } from "../src/manager/ledger-context.js";
import { parseLedgerArgs } from "../src/manager/ledger-identity.js";
import { schedulerRemoteCmds } from "../src/manager/ledger-scheduler-remote-cmds.js";
import { isWriteInvocation } from "../src/manager/write-commands.js";
import { tempLedgerPath } from "./ledger-test-helpers.js";

const CFG = {
  enabled: true, pollMs: 6000, autoDispatch: true,
  projects: {
    a: { maxActiveWorkers: 2, requiredChecks: ["ci"], repoDir: "/r/a", remote: { mode: "overflow", roles: ["review"] } },
    b: { maxActiveWorkers: 1, requiredChecks: ["ci"], repoDir: "/r/b" },
  },
};
const PM_A = "agent-pm-a";
const PM_B = "agent-pm-b";
const DISP = "agent-helper";

let db: Database;
let path: string;
const deps = (actor: string): LedgerDeps => ({
  db, actor, projectIds: ["a", "b"], now: () => 9_000,
  loadRegistry: async () => ({ socket: "s", agents: {} }) as Registry, saveRegistry: async () => {},
});

/** Same error mapping as runLedger, on the temp path. */
async function run(actor: string, ...args: string[]): Promise<Record<string, any>> {
  const spec = schedulerRemoteCmds(path)["scheduler-remote"];
  const p = parseLedgerArgs(["scheduler-remote", ...args], spec.valued, spec.bools);
  if ("error" in p) return { ok: false, code: "invalid", error: p.error };
  try { return await spec.run(new LedgerCli(deps(actor), p)); }
  catch (e) { if (e instanceof LedgerError) return { ok: false, code: e.code, error: e.message }; throw e; }
}
const file = () => ({ bytes: readFileSync(path, "utf8"), mtime: statSync(path).mtimeMs });
const decisions = () => listEvents(db, {}).filter((e) => e.kind === "decision");

beforeEach(() => {
  path = join(mkdtempSync(join(tmpdir(), "sched-remote-cli-")), "scheduler.json");
  writeFileSync(path, JSON.stringify(CFG, null, 2) + "\n");
  db = openLedger(tempLedgerPath("sched-remote-cli-db-"));
  const owner = { actor: "owner", now: 1 };
  setMeta(db, owner, { project: "a", key: "pms", value: [PM_A, DISP] });
  setMeta(db, owner, { project: "a", key: "team", value: { dispatcher: DISP, audit: true } });
  setMeta(db, owner, { project: "b", key: "pms", value: [PM_B] });
});

describe("ledger scheduler-remote", () => {
  test("success: one-line JSON with from / changed / event / effective, legacy note when it normalised", async () => {
    const r = await run(PM_A, "a", "balance", "--reason", "规整旧写法");
    expect(r).toEqual({
      ok: true, project: "a", mode: "balance", from: "overflow", changed: true, path, event: decisions()[0].seq,
      effective: "调度器下一轮（≤ 6000 毫秒）生效", note: "旧写法 overflow 已规整为 balance",
    });
    const off = await run("master", "b", "off", "--reason", "b 只用本机");
    expect(off).toMatchObject({ ok: true, project: "b", mode: "off", from: null, changed: true });
    expect(off.note).toBeUndefined();
    expect(await run("owner", "b", "off", "--reason", "再来一次")).toMatchObject({ ok: true, changed: false, event: null });
    expect(decisions().map((e) => [e.actor, e.project, e.text])).toEqual([[PM_A, "a", "规整旧写法"], ["master", "b", "b 只用本机"]]);
  });

  test("--dedup replay → duplicate, no second event", async () => {
    const first = await run(PM_A, "a", "off", "--reason", "r", "--dedup", "k");
    const again = await run(PM_A, "a", "off", "--reason", "r", "--dedup", "k");
    expect(again).toMatchObject({ ok: true, duplicate: true, changed: false, event: first.event });
    expect(decisions()).toHaveLength(1);
  });

  test("bad arguments → invalid, file untouched", async () => {
    const before = file();
    const R = ["--reason", "r"];
    const bad = [[...R], ["a", ...R], ["a", "off", "extra", ...R], ["a", "OFF", ...R], ["a", "overflow", ...R], ["a", "prefer", ...R],
      ["a", "", ...R], ["a", "off"], ["a", "off", "--reason", ""], ["a", "off", "--reason", "两行\n原因"], ["a", "off", "--why", "x"]];
    for (const args of bad) {
      const r = await run(PM_A, ...args);
      expect([args, r.ok, r.code]).toEqual([args, false, "invalid"]);
    }
    expect(file()).toEqual(before);
  });

  test("who may switch: project PM / master / owner yes; executor, dispatcher, other project's PM, unknown no", async () => {
    for (const actor of ["agent-task-i28-x", DISP, PM_B, "unknown"]) {
      const before = file();
      expect([actor, (await run(actor, "a", "off", "--reason", "r")).code]).toEqual([actor, "forbidden"]);
      expect(file()).toEqual(before);
    }
    expect(decisions()).toEqual([]);
    for (const [actor, mode] of [[PM_A, "off"], ["master", "balance"], ["owner", "off"]]) {
      expect(await run(actor, "a", mode, "--reason", "r")).toMatchObject({ ok: true, changed: true });
    }
  });

  test("scheduler identity is refused by runLedger; the command counts as a write", async () => {
    const r = await runLedger(["scheduler-remote", "a", "off", "--reason", "r"], deps("scheduler"));
    expect(r).toMatchObject({ ok: false, code: "forbidden" });
    expect(isWriteInvocation("ledger", ["scheduler-remote", "a", "off", "--reason", "r"])).toBe(true);
  });
});

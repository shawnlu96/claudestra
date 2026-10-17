// SCHEDMEM1 验收线 1：守护一轮不再逐项目整份读 schedulerProjectView，schedulerV2Pass 收到的参数与改前相同。
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as ledgerScheduler from "../src/lib/ledger-scheduler.js";
import { LedgerReader } from "../src/lib/ledger-read.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import type { SchedulerConfig } from "../src/lib/scheduler-config.js";
import { schedulerDaemonPass } from "../src/lib/scheduler-daemon-pass.js";
import type { PassOpts } from "../src/lib/scheduler-pass.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function ledger(): LedgerReader {
  const dir = mkdtempSync(join(tmpdir(), "schedmem1-")), path = join(dir, "ledger.sqlite");
  dirs.push(dir);
  const db = openLedger(path);
  for (const p of ["p", "q"]) createTask(db, { actor: "owner", now: 1_000 }, { project: p, id: `${p}-T1`, title: "t", kind: "code", agent: "agent-a" });
  closeLedger(path);
  return new LedgerReader(path);
}

const config = (enabled: boolean) => ({ enabled, pollMs: 5000, projects: { p: {}, q: {} } }) as unknown as SchedulerConfig;
const opts = (): Omit<PassOpts, "lend"> => ({ assertOwner: () => {}, cursor: {}, singleton: { path: "/x/scheduler.pid", token: "tok" } });

describe("SCHEDMEM1 daemon pass", () => {
  test("[验收线 1] enabled with two projects: no project view is read; the pass gets the reader's db, the config and the opts as they were", async () => {
    const view = spyOn(ledgerScheduler, "schedulerProjectView");
    const reader = ledger(), cfg = config(true), o = opts();
    const calls: unknown[][] = [];
    try {
      await schedulerDaemonPass(reader, cfg, false, o, { pass: async (...a) => { calls.push(a); return { failed: [] } as never; }, lend: () => { throw new Error("no lend"); } });
      expect(view).toHaveBeenCalledTimes(0);
      expect(calls.length).toBe(1);
      expect(calls[0]![0]).toBe(reader.get());
      expect(calls[0]![1]).toBe(cfg);
      expect(calls[0]![2]).toEqual(o);
      expect(Object.keys(calls[0]![2] as object)).not.toContain("lend");
    } finally { view.mockRestore(); reader.close(); }
  });

  test("[验收线 1] lend on: the lend step built from the same reader is added; nothing else changes", async () => {
    const view = spyOn(ledgerScheduler, "schedulerProjectView");
    const reader = ledger(), cfg = config(true), o = opts(), step = async () => ({ failed: [] });
    let built: unknown = null, got: unknown = null;
    try {
      await schedulerDaemonPass(reader, cfg, true, o, { pass: async (_db, _c, p) => { got = p as never; return { failed: [] } as never; },
        lend: ((r: LedgerReader) => { built = r; return step; }) as never });
      expect(view).toHaveBeenCalledTimes(0);
      expect(built).toBe(reader);
      expect(got).toEqual({ ...o, lend: step });
    } finally { view.mockRestore(); reader.close(); }
  });

  test("both switches off: no ledger, no pass; enabled without a ledger still throws; failures still raise", async () => {
    let passes = 0;
    const deps = { pass: async () => { passes++; return { failed: [{ taskId: "T9", error: "boom" }] } as never; }, lend: () => { throw new Error("no lend"); } };
    const missing = new LedgerReader(join(tmpdir(), `schedmem1-missing-${process.pid}.sqlite`));
    await schedulerDaemonPass(missing, config(false), false, opts(), deps);
    expect(passes).toBe(0);
    await expect(schedulerDaemonPass(missing, config(true), false, opts(), deps)).rejects.toThrow("scheduler enabled but ledger is unavailable");
    const reader = ledger();
    try {
      await expect(schedulerDaemonPass(reader, config(true), false, opts(), deps)).rejects.toThrow("tick failed: T9 boom");
    } finally { reader.close(); }
  });
});

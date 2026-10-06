/**
 * dispatch-recovery-SPECG1: spec / material writes preflighted against the real lend write-order builder and peer gate
 * (lib/spec-material-preflight.ts), on a real temp-file ledger. Synthetic inputs only: secrets are built from pieces at run time.
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BorrowEntry } from "../src/lib/lend-config.js";
import { listLendOrders } from "../src/lib/ledger-lend.js";
import { closeLedger, getTask, LedgerError, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask, setMeta, setTask } from "../src/lib/ledger-write.js";
import type { RemoteHead } from "../src/lib/order-deliver.js";
import { recoveryPolicy, type RecoveryPolicyPort } from "../src/lib/recovery-policy.js";
import {
  preflightSpecMaterial, receiptHolds, ruleVersion, useSpecPreflightPolicy,
} from "../src/lib/spec-material-preflight-gate.js";
import { registerSpecPreflight, runSpecPreflight, type PreflightReceipt } from "../src/lib/spec-material-preflight.js";
import { runLedger } from "../src/manager/ledger.js";
import { tempLedgerPath } from "./ledger-test-helpers.js";

const P = "proj-specg1";
const REPO = "acme/widgets";
const SECRET = "sk-" + "Q".repeat(12) + "z".repeat(12);
const CLEAN = "规格：只改 src/lib/x.ts\n验收：单测全绿\n";
const DIRTY = `规格：接入服务\n配置示例 ${SECRET}\n`;
const dir = mkdtempSync(join(tmpdir(), "spec-preflight-"));
let db: Database;
let path: string;
let restore: () => void;
let mode: "on" | "observe" | "off";
const port: RecoveryPolicyPort = () => ({ mode, manualAfterMs: null, source: "config" });

const file = (name: string, text: string): string => {
  const p = join(dir, name);
  writeFileSync(p, text);
  return p;
};
const owner = { actor: "owner", now: 1_000 };
const observed = (): ReturnType<typeof listEvents> => listEvents(db, { target: "T1" }).filter((e) => e.kind === "note" && e.data.op === "recovery_observe");
const newCard = (spec: string, id = "T1") => createTask(db, owner, { project: P, id, title: id, kind: "code", spec, agent: "agent-dev" } as never);

beforeEach(() => {
  path = tempLedgerPath("spec-preflight-");
  db = openLedger(path);
  mode = "observe";
  restore = useSpecPreflightPolicy(port);
  setMeta(db, owner, { project: P, key: "pms", value: ["agent-pm"] });
});
afterEach(() => {
  restore();
  closeLedger(path);
});

describe("preflightSpecMaterial: same builder, same gate", () => {
  test("clean spec passes with a receipt bound to target, specRev, rule version and digest", () => {
    newCard(file("clean.md", CLEAN));
    const r = preflightSpecMaterial(db, getTask(db, "T1")!);
    expect(r.status).toBe("pass");
    const receipt = (r as { receipt: PreflightReceipt }).receipt;
    expect(receipt).toMatchObject({ project: P, taskId: "T1", specRev: 1, ruleVersion: ruleVersion() });
    expect(receipt.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(receiptHolds(receipt, preflightSpecMaterial(db, getTask(db, "T1")!))).toBe(true);
  });

  test("a secret in the spec: category + material index only, the text never appears in the diagnostic", () => {
    newCard(file("dirty.md", DIRTY));
    const r = preflightSpecMaterial(db, getTask(db, "T1")!);
    expect(r).toMatchObject({ status: "blocked", category: "secret", material: 1, kind: "spec", ruleVersion: ruleVersion() });
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(JSON.stringify(r)).not.toContain("Q".repeat(12));
  });

  test("no spec file = unavailable: no receipt, nothing to block", () => {
    newCard(join(dir, "missing.md"));
    expect(preflightSpecMaterial(db, getTask(db, "T1")!)).toMatchObject({ status: "unavailable", reason: "no_spec" });
  });

  test("an old receipt does not carry over: content, specRev, target or rule version changed → not held", () => {
    const spec = file("drift.md", CLEAN);
    newCard(spec);
    const first = preflightSpecMaterial(db, getTask(db, "T1")!);
    const receipt = (first as { receipt: PreflightReceipt }).receipt;
    writeFileSync(spec, CLEAN + "再加一行\n");
    expect(receiptHolds(receipt, preflightSpecMaterial(db, getTask(db, "T1")!))).toBe(false);
    writeFileSync(spec, CLEAN);
    expect(receiptHolds(receipt, first)).toBe(true);
    expect(receiptHolds({ ...receipt, specRev: 2 }, first)).toBe(false);
    expect(receiptHolds({ ...receipt, taskId: "T2" }, first)).toBe(false);
    expect(receiptHolds({ ...receipt, ruleVersion: "0".repeat(64) }, first)).toBe(false);
    expect(ruleVersion()).toBe(ruleVersion());
  });
});

describe("the writer's hook (createTask / setTask) under the one policy port", () => {
  test("on: a refused task-set rolls back — spec, rev, specRev and events unchanged; the foreign file keeps its bytes", () => {
    mode = "on";
    newCard(file("ok.md", CLEAN));
    const before = getTask(db, "T1")!;
    const events = listEvents(db, { target: "T1" }).length;
    const dirty = file("bad.md", DIRTY);
    const raw = readFileSync(dirty);
    let err: unknown;
    try { setTask(db, owner, { id: "T1", rev: before.rev, patch: { spec: dirty } as never }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(LedgerError);
    expect((err as LedgerError).code).toBe("invalid");
    expect((err as Error).message).toContain("类别 secret");
    expect((err as Error).message).not.toContain(SECRET);
    expect(getTask(db, "T1")).toMatchObject({ spec: before.spec, rev: before.rev, specRev: before.specRev });
    expect(listEvents(db, { target: "T1" }).length).toBe(events);
    expect(readFileSync(dirty).equals(raw)).toBe(true);
  });

  test("on: a refused task-new leaves no row", () => {
    mode = "on";
    expect(() => newCard(file("bad2.md", DIRTY))).toThrow(/外发闸/);
    expect(getTask(db, "T1")).toBeNull();
    expect(listEvents(db, { target: "T1" })).toEqual([]);
  });

  test("observe (default): the write goes through, one would-block note per content + rules, no order, no outbound", () => {
    const spec = file("obs.md", DIRTY);
    newCard(spec);
    setTask(db, owner, { id: "T1", rev: 1, patch: { title: "改个标题" } as never }); // not material: no new check
    setTask(db, owner, { id: "T1", rev: 2, patch: { spec: file("obs-copy.md", DIRTY) } as never }); // same content: same dedup
    expect(getTask(db, "T1")!.rev).toBe(3);
    const notes = observed();
    expect(notes.length).toBe(1);
    expect(notes[0]!.data).toMatchObject({ mechanism: "materials", preflight: { status: "blocked", category: "secret", material: 1 } });
    expect(JSON.stringify(notes[0])).not.toContain(SECRET);
    expect(listLendOrders(db, "T1")).toEqual([]);
  });

  test("off, and a policy that cannot be read, keep the old path: no preflight, no note", () => {
    mode = "off";
    newCard(file("off.md", DIRTY));
    expect(observed()).toEqual([]);
    restore();
    const corrupt = file("recovery-policy.json", "{ not json");
    restore = useSpecPreflightPolicy((p, k) => recoveryPolicy(p, k, corrupt));
    setTask(db, owner, { id: "T1", rev: 1, patch: { spec: file("off2.md", DIRTY + "x\n") } as never });
    restore = useSpecPreflightPolicy(() => { throw new Error("boom"); });
    setTask(db, owner, { id: "T1", rev: 2, patch: { spec: file("off3.md", DIRTY + "y\n") } as never });
    expect(getTask(db, "T1")!.rev).toBe(3);
    expect(observed()).toEqual([]);
  });

  test("a process that never armed the hook answers unavailable (unarmed), not off and never a pass", () => {
    mode = "on";
    const prev = registerSpecPreflight(null);
    try {
      const t = newCard(file("unarmed.md", DIRTY));
      expect(t.row.rev).toBe(1);
      expect(runSpecPreflight(db, owner, null, t.row)).toEqual({ status: "unavailable", reason: "unarmed", ruleVersion: "" });
    } finally { registerSpecPreflight(prev); }
  });

  test("observe: a spec that cannot be read keeps the write and leaves one readable unavailable note (fixed words only)", () => {
    const missing = join(dir, "missing-obs.md");
    newCard(missing);
    setTask(db, owner, { id: "T1", rev: 1, patch: { title: "renamed" } as never });
    newCard(missing, "T2");
    const notes = listEvents(db, { target: "T1" }).filter((e) => e.kind === "note" && e.data.op === "spec_preflight_unavailable");
    expect(notes.length).toBe(1);
    expect(notes[0]!.data.preflight).toMatchObject({ status: "unavailable", reason: "no_spec", ruleVersion: ruleVersion(), specRev: 1 });
    expect(notes[0]!.text).toContain("无收据");
    expect(notes[0]!.text).not.toContain(dir);
    expect(observed()).toEqual([]);
  });

  test("on: a spec that cannot be read is refused, card and versions unchanged; a card with no spec at all keeps the old path", () => {
    mode = "on";
    expect(() => newCard(join(dir, "missing-on.md"))).toThrow(/预检不可用（原因 no_spec/);
    expect(getTask(db, "T1")).toBeNull();
    expect(listEvents(db, { target: "T1" })).toEqual([]);
    createTask(db, owner, { project: P, id: "T3", title: "T3", kind: "code", agent: "agent-dev" } as never);
    expect(getTask(db, "T3")!.rev).toBe(1);
    expect(listEvents(db, { target: "T3" }).filter((e) => e.kind === "note")).toEqual([]);
  });

  test("on: the gate failing unexpectedly is unavailable(error) and refused; off records nothing", () => {
    mode = "on";
    newCard(file("err.md", CLEAN));
    const t = getTask(db, "T1")!;
    expect(preflightSpecMaterial(db, t, () => { throw new Error("boom"); })).toMatchObject({ status: "unavailable", reason: "error" });
    mode = "off";
    setTask(db, owner, { id: "T1", rev: 1, patch: { spec: join(dir, "missing-off.md") } as never });
    expect(listEvents(db, { target: "T1" }).filter((e) => e.kind === "note")).toEqual([]);
  });

  test("CAS conflict is the writer's own answer; the preflight neither runs nor records", () => {
    newCard(file("cas.md", CLEAN));
    expect(() => setTask(db, owner, { id: "T1", rev: 7, patch: { spec: file("cas-bad.md", DIRTY) } as never })).toThrow(/rev/);
    expect(observed()).toEqual([]);
  });

  test("file scope update (the ask-default path writes extra.fileGlobs through setTask) shares the same preflight", () => {
    mode = "on";
    newCard(file("scope.md", CLEAN));
    const t = getTask(db, "T1")!;
    const bad = { ...t.extra, fileGlobs: ["src/lib/a.ts", "docs/owner@example.com.md"] };
    let err: unknown;
    try { setTask(db, { actor: "system:ask-default", now: 2_000 }, { id: "T1", rev: t.rev, patch: { extra: bad } as never }); } catch (e) { err = e; }
    expect((err as Error).message).toContain("类别 file_scope");
    expect((err as Error).message).not.toContain("owner@example.com");
    expect(getTask(db, "T1")!.extra).toEqual(t.extra);
    setTask(db, owner, { id: "T1", rev: t.rev, patch: { extra: { ...t.extra, fileGlobs: ["src/lib/a.ts"] } } as never });
    expect(getTask(db, "T1")!.rev).toBe(t.rev + 1);
  });
});

describe("CLI entries and the real offer", () => {
  let borrow: BorrowEntry[];
  const deps = (actor: string) => ({
    db, actor, projectIds: [P], loadRegistry: async () => ({ socket: "", agents: {} }), saveRegistry: async () => {}, now: () => 5_000,
    lend: {
      borrow: async () => borrow, notifyPm: async () => {},
      result: {
        reportDir: () => dir, writeReport: (p: string, b: string) => writeFileSync(p, b), sign: () => "",
        remoteHead: async (): Promise<RemoteHead> => ({ ok: true, head: "b".repeat(40) }),
        peerFp: async () => "abcd-ef01-2345-6789",
      },
    },
  });
  const run = (args: string[], actor = "agent-pm") => runLedger(args, deps(actor) as never) as Promise<Record<string, any>>;
  beforeEach(() => { borrow = [{ peer: "mate", projects: [P], roles: ["review", "write"], maxOpen: 2 }]; });

  test("task-new / task-set under on refuse with the fixed diagnostic and write nothing", async () => {
    mode = "on";
    const bad = file("cli-bad.md", DIRTY);
    const r = await run(["task-new", "T1", "--project", P, "--kind", "code", "--title", "t", "--spec", bad, "--agent", "agent-dev"]);
    expect(r).toMatchObject({ ok: false, code: "invalid" });
    expect(String(r.error)).toContain("类别 secret");
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(getTask(db, "T1")).toBeNull();
    expect(await run(["task-new", "T1", "--project", P, "--kind", "code", "--title", "t", "--spec", file("cli-ok.md", CLEAN), "--agent", "agent-dev"]))
      .toMatchObject({ ok: true });
    expect(await run(["task-set", "T1", "--rev", "1", "--spec", bad])).toMatchObject({ ok: false, code: "invalid" });
    expect(getTask(db, "T1")!.rev).toBe(1);
  });

  test("a passed preflight is not a pass for the offer: material changed after the write → the offer's gate still refuses", async () => {
    mode = "on";
    const spec = file("offer.md", CLEAN);
    newCard(spec);
    const receipt = (preflightSpecMaterial(db, getTask(db, "T1")!) as { receipt: PreflightReceipt }).receipt;
    db.run("UPDATE tasks SET stage = 'build' WHERE id = 'T1'");
    writeFileSync(spec, DIRTY);
    const r = await run(["lend-offer", "T1", "--peer", "mate", "--repo", REPO]);
    expect(r).toMatchObject({ ok: false, code: "invalid" });
    expect(String(r.error)).toContain("外发闸");
    expect(listLendOrders(db, "T1")).toEqual([]);
    expect(receiptHolds(receipt, preflightSpecMaterial(db, getTask(db, "T1")!))).toBe(false);
  });

  test("observe lets the dirty spec in, and the offer still refuses it: preflight never relaxes the gate", async () => {
    newCard(file("obs-offer.md", DIRTY));
    db.run("UPDATE tasks SET stage = 'build' WHERE id = 'T1'");
    expect(await run(["lend-offer", "T1", "--peer", "mate", "--repo", REPO])).toMatchObject({ ok: false, code: "invalid" });
    expect(listLendOrders(db, "T1")).toEqual([]);
  });
});

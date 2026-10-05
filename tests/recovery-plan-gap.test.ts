/**
 * dispatch-recovery-PLAN facts: readiness comes from the real autostart gates on a temp ledger (spec file, deps lanes, file
 * overlap, owner switch, paused feature), the spec-head holds (被替代 / 人工验收 / 本机限定) never count as dispatchable
 * external writes, and peer write seats come from a real lend_peers hello through peerRefusal (freshness, roles, off, quota).
 * Temp ledger only; no production state, bridge or peer.
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setAutostartSwitch } from "../src/lib/ledger-autostart.js";
import { getFeature } from "../src/lib/ledger-feature.js";
import { createFeature, initDag, setFeature } from "../src/lib/ledger-feature-write.js";
import { recordHello } from "../src/lib/ledger-lend-peers.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { setMeta } from "../src/lib/ledger-write.js";
import type { BorrowEntry } from "../src/lib/lend-config.js";
import type { Grant, Slots } from "../src/lib/lend-wire-v2.js";
import { draftCandidates, readPlanGapFacts, specHolds, type DraftFile, type FactsIo } from "../src/lib/recovery-plan-gap.js";
import { SPEC_SETTLE_MS, type SpecFile } from "../src/lib/scheduler-autostart.js";
import type { RemotePolicy } from "../src/lib/scheduler-config.js";

const P = "claude-orchestrator", PM = "agent-pm", FID = "ab12-i28";
const DAY = 86_400_000;
let dir: string, db: Database, now: number, specs: Record<string, SpecFile>, drafts: DraftFile[];
let remote: RemotePolicy | null, borrow: BorrowEntry[], maxWorkers: number, localBlocked: string | null;
const ctx = (actor = PM) => ({ actor, now: now++ });
const ripe = (head = "") => ({ mtimeMs: now - SPEC_SETTLE_MS - 1, text: `# 规格\n模板：code\n${head}\n\n## 目标\n` });
const node = (key: string, globs: string[], deps: string[] = []) => ({ key, oneLine: `节点 ${key}`, fileGlobs: globs, deps });
const WRITE: RemotePolicy = { mode: "balance", roles: ["review", "write"], poolTimeoutMin: 15, repo: "a/b" };
const GRANT: Grant = { until: 0, roles: ["review", "write"], repos: ["a/b"], ordersPerDay: 50, ordersLeftToday: 50 };
const SLOTS: Slots = { codex: { total: 3, busy: 1 }, claude: { total: 2, busy: 0 } };
let seq = 0;
const hello = (peer: string, over: { grant?: Grant | null; slots?: Slots; paused?: { reason: string; until: number } | null; at?: number } = {}) =>
  recordHello(db, peer, null, { v: 1, proto: 2, boot: "b", seq: ++seq, grant: over.grant === undefined ? { ...GRANT, until: now + DAY } : over.grant,
    slots: over.slots ?? SLOTS, paused: over.paused ?? null }, over.at ?? now);

const io = (): FactsIo => ({
  now, svc: { autoDispatch: true, projects: [P], maxWorkers: () => maxWorkers },
  pool: () => ({ remote, borrow }), readSpec: (id) => specs[id] ?? null, drafts: () => drafts, localBlocked: () => localBlocked,
});
const facts = () => readPlanGapFacts(db, P, io());
const byKey = (key: string) => facts().work.find((w) => w.key === key)!;

beforeEach(() => {
  now = 10_000_000; seq = 0;
  dir = mkdtempSync(join(tmpdir(), "recovery-plan-gap-"));
  db = openLedger(join(dir, "ledger.sqlite"));
  db.prepare("INSERT INTO ledger_instance (key, value) VALUES ('origin', 'ab12')").run();
  setMeta(db, { actor: "owner", now: 500 }, { project: P, key: "pms", value: [PM] });
  remote = WRITE; borrow = [{ peer: "mate", projects: [P], roles: ["review", "write"], maxOpen: 5 }]; maxWorkers = 2; localBlocked = null; drafts = [];
  createFeature(db, ctx(), { project: P, slug: "i28", title: "协作底座" });
  initDag(db, ctx(), { id: FID, rev: 1, nodes: [
    node("a", ["src/lib/a.ts"]), node("b", ["src/lib/b.ts"], ["a"]), node("c", ["src/lib/c.ts"]), node("r5", ["src/lib/r5.ts"]),
    node("pageok", ["web/page.tsx"]), node("cl1", ["src/lib/cl1.ts"]), node("w8l", ["src/lib/w8l.ts"]),
  ] });
  specs = {
    "i28-a": ripe(), "i28-b": ripe(), "i28-r5": ripe("被替代：W7"), "i28-pageok": ripe("人工验收：是"), "i28-cl1": ripe("本机限定：是"),
    "i28-w8l": ripe("自动开卡：关"),
  };
});
afterEach(() => {
  closeLedger(join(dir, "ledger.sqlite"));
  rmSync(dir, { recursive: true, force: true });
});

describe("readiness uses the real autostart gates", () => {
  test("each planned node lands in the state its gate says", () => {
    const w = Object.fromEntries(facts().work.map((x) => [x.key, x]));
    expect(w.a).toMatchObject({ state: "ready", external: true, taskId: "i28-a", version: 1 });
    expect(w.b).toMatchObject({ state: "blocked", gate: "lanes" });
    expect(w.c).toMatchObject({ state: "blocked", gate: "spec" });
    expect(w.r5).toMatchObject({ state: "hold", hold: "superseded" });
    expect(w.r5.why).toContain("W7");
    expect(w.pageok).toMatchObject({ state: "hold", hold: "manual_acceptance" });
    expect(w.cl1).toMatchObject({ state: "ready", external: false });
    expect(w.w8l).toMatchObject({ state: "hold", hold: "owner_paused" });
  });

  test("a spec still settling is not ready", () => {
    specs["i28-a"] = { mtimeMs: now - 10, text: specs["i28-a"].text };
    expect(byKey("a")).toMatchObject({ state: "blocked", gate: "spec" });
  });

  test("feature switch off and paused feature are owner holds, not blocked work", () => {
    setAutostartSwitch(db, ctx(), { project: P, on: false, featureId: FID, reason: "owner 暂停" });
    expect(facts().work.every((w) => w.state === "hold" && w.hold === "owner_paused")).toBe(true);
    setAutostartSwitch(db, ctx(), { project: P, on: true, featureId: FID, reason: "恢复" });
    setFeature(db, ctx(), { id: FID, rev: getFeature(db, FID)!.rev, patch: { status: "paused" } });
    expect(facts().work.every((w) => w.state === "hold" && w.hold === "owner_paused")).toBe(true);
  });

  test("project not lent for writes, or no repo: ready work is local only", () => {
    remote = { ...WRITE, roles: ["review"], repo: undefined };
    expect(byKey("a")).toMatchObject({ state: "ready", external: false });
    remote = null;
    expect(byKey("a")).toMatchObject({ state: "ready", external: false });
  });

  test("service not enabled for the project blocks with the service gate", () => {
    const x = readPlanGapFacts(db, P, { ...io(), svc: { autoDispatch: false, projects: [P], maxWorkers: () => 2 } });
    expect(x.work.find((w) => w.key === "a")).toMatchObject({ state: "blocked", gate: "service" });
  });
});

describe("capacity is the real local room and peer refusal", () => {
  test("fresh hello with write grant: seats are the free write-family slots", () => {
    hello("mate");
    const f = facts();
    expect(f.localRoom).toBe(2);
    expect(f.peers).toEqual([{ peer: "mate", seats: 2, why: null }]); // writeFamilies default codex: 3 total − 1 busy
    remote = { ...WRITE, writeFamilies: ["codex", "claude"] };
    expect(facts().peers[0].seats).toBe(4);
  });

  const cases: [string, () => unknown, RegExp][] = [
    ["stale hello", () => hello("mate", { at: now - 200_000 }), /hello/],
    ["grant revoked", () => hello("mate", { grant: null }), /授权/],
    ["borrow entry off", () => { hello("mate"); borrow = [{ ...borrow[0], priority: "off" }]; }, /off/],
    ["borrow without write role", () => { hello("mate"); borrow = [{ ...borrow[0], roles: ["review"] }]; }, /write/],
    ["grant for another repo", () => hello("mate", { grant: { ...GRANT, until: now + DAY, repos: ["x/y"] } }), /仓库/],
    ["codex quota pause", () => hello("mate", { paused: { reason: "codex_quota", until: now + DAY } }), /写代码槽|codex/],
    ["no hello at all", () => undefined, /hello/],
  ];
  test.each(cases)("%s → zero seats with the reason", (_n, arrange, why) => {
    arrange();
    const p = facts().peers[0];
    expect(p.seats).toBe(0);
    expect(p.why ?? "").toMatch(why);
  });

  test("local room: maxWorkers, localPriority off, blocked runtime", () => {
    maxWorkers = 0;
    expect(facts()).toMatchObject({ localRoom: 0 });
    maxWorkers = 3; remote = { ...WRITE, localPriority: "off" };
    expect(facts()).toMatchObject({ localRoom: 0, localWhy: expect.stringContaining("localPriority") });
    remote = WRITE; localBlocked = "Claude 周额度到线";
    expect(facts()).toMatchObject({ localRoom: 0, localWhy: "Claude 周额度到线" });
  });
});

describe("drafts not wired into the DAG", () => {
  const known = { taskIds: new Set(["i28-a"]), keys: new Set(["a", "b"]), titles: new Set(["节点 a"]) };
  const body = "## 目标\n" + "x".repeat(100) + "\n范围：src/lib/x.ts\n";
  test("flags missing spec / deps / duplicate / stale; wired drafts are skipped; nothing is chosen", () => {
    const list = draftCandidates([
      { name: "i28-a", mtimeMs: now, text: `# 已接\n前置节点：无\n${body}` },
      { name: "i28-ok", mtimeMs: now, text: `# 新卡\n前置节点：a\n${body}` },
      { name: "i28-thin", mtimeMs: now, text: "# 薄\n前置节点：无\n" },
      { name: "i28-nodeps", mtimeMs: now, text: `# 无依赖行\n${body}` },
      { name: "i28-ghost", mtimeMs: now, text: `# 幽灵\n前置节点：zz、a\n${body}` },
      { name: "i28-dup", mtimeMs: now, text: `# 节点 a\n前置节点：无\n${body}` },
      { name: "i28-old", mtimeMs: now - 30 * DAY, text: `# 旧\n前置节点：无\n${body}` },
      { name: "i28-formal", mtimeMs: now, text: `# 有正式\n前置节点：无\n${body}` },
    ], known, (id) => id === "i28-formal", now);
    const f = Object.fromEntries(list.map((d) => [d.name, d.flags]));
    expect(Object.keys(f)).not.toContain("i28-a");
    expect(f["i28-ok"]).toEqual([]);
    expect(f["i28-thin"]).toEqual(["missing_spec"]);
    expect(f["i28-nodeps"]).toEqual(["missing_deps"]);
    expect(f["i28-ghost"]).toEqual(["missing_deps"]);
    expect(f["i28-dup"]).toEqual(["duplicate"]);
    expect(f["i28-old"]).toEqual(["stale"]);
    expect(f["i28-formal"]).toEqual(["duplicate"]);
  });

  test("readPlanGapFacts lists drafts against the live DAG", () => {
    drafts = [{ name: "i28-a", mtimeMs: now, text: "# a" }, { name: "i28-new", mtimeMs: now, text: `# 新\n前置节点：b\n${body}` }];
    expect(facts().drafts.map((d) => [d.name, d.flags])).toEqual([["i28-new", []]]);
  });
});

test("spec head holds only read the head block", () => {
  expect(specHolds("# t\n被替代：W7\n人工验收：是\n本机限定：是\n## x")).toEqual({ superseded: "W7", manual: true, localOnly: true });
  expect(specHolds("# t\n\n## 正文\n被替代：W7\n人工验收：是")).toEqual({ superseded: null, manual: false, localOnly: false });
});

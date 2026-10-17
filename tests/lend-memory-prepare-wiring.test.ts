import { afterEach, expect, test } from "bun:test";
import { writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { autoFixture, toBuild, H1 } from "./scheduler-auto-helpers.js";
import { recordMemory } from "../src/lib/ledger-memory.js";
import { listLendOrders, offerLend, cancelLend, renderLendOffer } from "../src/lib/ledger-lend.js";
import { listEvents } from "../src/lib/ledger-store.js";
import { RECOVERY_POLICY_PATH } from "../src/lib/recovery-policy.js";
import { openVectorStore } from "../src/lib/memory-vectors.js";
import { prepareLendOffer, commitLendOffer } from "../src/lib/lend-memory-prepare-wiring.js";
import type { EnsureDeps } from "../src/lib/memory-retrieve-order.js";
import { Database } from "bun:sqlite";
import { recoveryPolicy } from "../src/lib/recovery-policy.js";
import { createTask } from "../src/lib/ledger-write.js";

const fixtures: ReturnType<typeof autoFixture>[] = [];
const vectors: ReturnType<typeof openVectorStore>[] = [];
afterEach(() => {
  for (const db of vectors.splice(0)) db.close();
  for (const f of fixtures.splice(0)) f.close();
  rmSync(RECOVERY_POLICY_PATH, { force: true });
});
function policy(prepare = "on", injection = "on") {
  writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify({ projects: { p: { keys: { memoryLendPrepare: prepare, memoryLendInjection: injection } } } }));
}
function fixture() {
  const f = autoFixture(); fixtures.push(f);
  const spec = join(f.dir, "T1.md"); writeFileSync(spec, "实现功能，验证边界");
  f.db.run("UPDATE tasks SET stage = 'build', spec = ? WHERE id = 'T1'", [spec]);
  f.db.run("UPDATE task_workflows SET mode = 'manual' WHERE taskId = 'T1'");
  const memory = recordMemory(f.db, { actor: "pm", now: 100 }, { project: "p", kind: "pitfall", title: "事务隔离",
    symptom: "并发问题", rule: "事务外准备", files: ["src/lib/x.ts"], fixable: false, via: "tool", authorRole: "reviewer",
    taskId: "T1", specRev: 1, head: H1 }).memory.id;
  const vdb = openVectorStore(join(f.dir, "vectors.sqlite")); vectors.push(vdb);
  const calls: string[][] = [];
  const borrow = [{ peer: "mate", projects: ["p"], roles: ["write", "review"] as ("write" | "review")[], maxOpen: 3 }];
  const memoryPrepare: EnsureDeps = { vectors: vdb, headFiles: null, embedder: { model: "test", remote: false,
    embed: async (texts: string[]) => { expect(f.db.inTransaction).toBe(false); calls.push(texts); return texts.map(() => [1, 0, 0]); } } };
  const lend = { borrow: async () => borrow, notifyPm: async () => {}, result: {
    reportDir: () => f.dir, writeReport: () => {}, sign: () => ({ key: "test", sig: "sig" }), peerFp: async () => "abcd-ef01-2345-6789",
    remoteHead: async () => ({ ok: true as const, head: H1 }),
  }, memoryPrepare };
  const cli = (actor: string, ...args: string[]) => f.cliWith({ lend }, actor, ...args);
  const offer = () => cli("pm", "lend-offer", "T1", "--peer", "mate", "--repo", "o/r");
  const events = () => listEvents(f.db, { target: "T1" });
  const section = () => listLendOrders(f.db, "T1").at(-1)?.wire.inputs.find(s => s.startsWith("项目记忆"));
  const prepare = () => prepareLendOffer(f.db, f.task(), H1, readFileSync(spec, "utf8"), () => readFileSync(spec, "utf8"), memoryPrepare);
  const syncOffer = () => offerLend(f.db, { actor: "pm" }, { taskId: "T1", peer: "mate", family: "codex", repo: "o/r", pr: null,
    spec: readFileSync(spec, "utf8"), borrow: borrow[0]!, write: { fp: "abcd-ef01-2345-6789", base: "main", baseSha: H1, report: null } });
  return { f, memory, calls, lend, cli, spec, offer, events, section, prepare, syncOffer, borrow };
}

test("CLI lend-offer performs semantic preparation outside its write transaction", async () => {
  policy(); const p = fixture();
  expect(await p.cli("pm", "lend-offer", "T1", "--peer", "mate", "--repo", "o/r")).toMatchObject({ ok: true });
  expect(p.calls.length).toBeGreaterThan(0);
  expect(listLendOrders(p.f.db, "T1")[0]!.text).toContain(p.memory);
  expect(listEvents(p.f.db, { target: "T1" }).some(e => e.data.op === "memory_rank" && (e.data.routes as string[]).includes("vector"))).toBe(true);
});

test("scheduler-pool performs semantic preparation outside its write transaction", async () => {
  policy(); const p = fixture();
  // Use the real scheduler lifecycle to produce a review pool intent.
  p.f.db.run("UPDATE tasks SET stage = 'spec' WHERE id = 'T1'");
  p.f.db.run("UPDATE task_workflows SET mode = 'auto' WHERE taskId = 'T1'");
  await toBuild(p.f); await p.f.tick();
  expect(await p.f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H1)).toMatchObject({ ok: true });
  p.f.db.run("UPDATE tasks SET pr = 'https://github.com/o/r/pull/7' WHERE id = 'T1'");
  const { schedulerAutoTick } = await import("../src/lib/scheduler-auto-tick.js");
  const r = await schedulerAutoTick(p.f.db, { p: { maxActiveWorkers: 0, remote: { mode: "prefer", roles: ["review"], poolTimeoutMin: 15 } } },
    { ...p.f.tickDeps, borrow: p.lend.borrow, manager: (...args) => p.cli("scheduler", ...args.slice(1)) });
  expect(r.failed).toEqual([]);
  expect(listLendOrders(p.f.db, "T1")).toHaveLength(1);
  expect(p.calls.length).toBeGreaterThan(0);
});

test("preparation writes no ledger facts and holds no writer lock; success records ranking and attempt once", async () => {
  policy(); const p = fixture(), count = p.events().length;
  const other = new Database(p.f.db.filename);
  p.lend.memoryPrepare.embedder = { model: "writer-check", remote: false, embed: async texts => {
    other.transaction(() => other.run("UPDATE tasks SET title = title WHERE id = 'T1'")).immediate();
    return texts.map(() => [1, 0]);
  } };
  try {
    const prepared = await p.prepare();
    expect(p.events()).toHaveLength(count);
    const o = commitLendOffer(p.f.db, prepared, p.syncOffer);
    const facts = p.events().filter(e => ["memory_rank", "memory_retrieve", "memory_inject_attempt"].includes(e.data.op as string));
    expect(facts).toHaveLength(3);
    expect(() => commitLendOffer(p.f.db, prepared, p.syncOffer)).toThrow("未结的出借单");
    expect(p.events().filter(e => ["memory_rank", "memory_retrieve", "memory_inject_attempt"].includes(e.data.op as string))).toEqual(facts);
    expect(o.text).toContain(p.memory);
  } finally { other.close(); }
});

test.each(["spec", "specRev", "head", "round", "stage"])("%s drift after preparation refuses without memory facts", async field => {
  policy(); const p = fixture(), prepared = await p.prepare(), count = p.events().length;
  if (field === "spec") writeFileSync(p.spec, "规格已经改变");
  else if (field === "head") p.f.db.run("UPDATE tasks SET headSHA = ? WHERE id = 'T1'", ["a".repeat(40)]);
  else if (field === "stage") p.f.db.run("UPDATE tasks SET stage = 'fix' WHERE id = 'T1'");
  else p.f.db.run(`UPDATE tasks SET ${field} = ${field} + 1 WHERE id = 'T1'`);
  expect(() => commitLendOffer(p.f.db, prepared, p.syncOffer)).toThrow("漂移");
  expect(listLendOrders(p.f.db, "T1")).toEqual([]);
  expect(p.events()).toHaveLength(count);
});

test("transaction rollback after memory.commit removes rankings, pushes and attempts", async () => {
  policy(); const p = fixture(), prepared = await p.prepare(), count = p.events().length;
  p.f.db.exec("CREATE TRIGGER fail_lease BEFORE INSERT ON lend_write_leases BEGIN SELECT RAISE(ABORT, 'lease failed'); END");
  expect(() => commitLendOffer(p.f.db, prepared, p.syncOffer)).toThrow("lease failed");
  expect(listLendOrders(p.f.db, "T1")).toEqual([]);
  expect(p.events()).toHaveLength(count);
});

test.each(["off", "observe"])("prepare %s preserves synchronous baseline byte for byte", async mode => {
  policy(mode); const p = fixture(), prepared = await p.prepare(), count = p.events().length;
  const baseline = p.syncOffer(); cancelLend(p.f.db, { actor: "pm" }, { taskId: "T1", reason: "compare" });
  const actual = commitLendOffer(p.f.db, prepared, p.syncOffer);
  expect(actual.text.replaceAll(actual.orderId, baseline.orderId)).toBe(baseline.text);
  expect(p.calls.length > 0).toBe(mode === "observe");
  const samples = p.events().filter(e => e.data.mechanism === "memoryLendPrepare");
  expect(samples).toHaveLength(mode === "observe" ? 1 : 0);
  expect(count).toBeGreaterThan(0);
});

test.each(["on", "observe", "off"])("upstream %s is never promoted by preparation", async upstream => {
  policy("on", upstream); const p = fixture();
  expect(await p.offer()).toMatchObject({ ok: true });
  expect(!!p.section()).toBe(upstream === "on");
  expect(p.calls.length > 0).toBe(upstream !== "off");
  expect(p.events().some(e => e.data.op === "memory_retrieve")).toBe(upstream === "on");
});

test.each(["off", "observe"])("runtime switch on to %s discards prepared injection and uses baseline", async mode => {
  policy(); const p = fixture(), prepared = await p.prepare(); policy(mode);
  const o = commitLendOffer(p.f.db, prepared, p.syncOffer);
  expect(o.text).toContain(p.memory);
  expect(p.events().filter(e => e.data.op === "memory_rank").every(e => e.dedupKey?.endsWith(":fallback"))).toBe(true);
});

test("default is observe and an observe preparation cannot be promoted after a live switch", async () => {
  policy("observe"); const p = fixture(), prepared = await p.prepare(); policy("on");
  commitLendOffer(p.f.db, prepared, p.syncOffer);
  expect(p.events().filter(e => e.data.op === "memory_rank").every(e => e.dedupKey?.endsWith(":fallback"))).toBe(true);
  rmSync(RECOVERY_POLICY_PATH, { force: true });
  expect(recoveryPolicy("p", "memoryLendPrepare").mode).toBe("observe");
});

test("retrieval error and timeout send no memory; late result does not publish ledger facts", async () => {
  policy(); const p = fixture();
  p.lend.memoryPrepare.timeoutMs = 10;
  let resolve!: (v: unknown) => void;
  p.lend.memoryPrepare.embedder = { model: "slow", remote: false, embed: () => new Promise(r => { resolve = r; }) };
  expect(await p.offer()).toMatchObject({ ok: true });
  expect(p.section()).toBeUndefined();
  const facts = p.events(); resolve([[1, 0]]); await Bun.sleep(20);
  expect(p.events()).toEqual(facts);
  expect(facts.find(e => e.data.op === "memory_inject_attempt")?.data.result).toBe("error");
  cancelLend(p.f.db, { actor: "pm" }, { taskId: "T1", reason: "retry" });
  p.lend.memoryPrepare.embedder = null;
  expect(await p.offer()).toMatchObject({ ok: true });
  expect(p.section()).toContain(p.memory);
});

test("embedding failure does not silently fall back to synchronous memory", async () => {
  policy(); const p = fixture();
  p.lend.memoryPrepare.embedder = { model: "broken", remote: false, embed: async () => { throw new Error("offline"); } };
  expect(await p.offer()).toMatchObject({ ok: true }); expect(p.section()).toBeUndefined();
  expect(p.events().find(e => e.data.op === "memory_inject_attempt")?.data.result).toBe("error");
});

test("borrow revocation during preparation is rechecked before the transaction", async () => {
  policy(); const p = fixture();
  p.lend.memoryPrepare.embedder = { model: "revoke", remote: false, embed: async texts => { p.borrow.length = 0; return texts.map(() => [1, 0]); } };
  expect(await p.offer()).toMatchObject({ ok: false, code: "forbidden" });
  expect(listLendOrders(p.f.db, "T1")).toEqual([]);
  expect(p.events().some(e => e.data.op === "memory_rank")).toBe(false);
});

test.each(["write", "fix", "review"])("prepared %s preserves team filtering, caps and the separate outbound gate", async step => {
  policy(); const p = fixture(); p.lend.memoryPrepare.embedder = null;
  if (step === "fix") {
    const build = p.syncOffer(); cancelLend(p.f.db, { actor: "pm" }, { taskId: "T1", reason: "prepare fix" });
    p.f.db.run("UPDATE tasks SET stage = 'fix', headSHA = ?, branch = ?, round = 1 WHERE id = 'T1'", [H1, build.branch]);
  } else if (step === "review") p.f.db.run("UPDATE tasks SET stage = 'review', headSHA = ? WHERE id = 'T1'", [H1]);
  const add = (title: string, visibility: "home" | "team", rule = "规".repeat(100)) => recordMemory(p.f.db, { actor: "pm" }, {
    project: "p", kind: "pitfall", title, visibility, symptom: "症".repeat(100), rule, files: ["src/lib/x.ts"], fixable: false,
    via: "tool", authorRole: "reviewer", taskId: "T1", specRev: 1, head: H1 }).memory.id;
  const home = add("私有内容不要外发", "home");
  for (let i = 0; i < 7; i++) add(`团队规则${i}`, "team");
  const prepared = await p.prepare(), o = commitLendOffer(p.f.db, prepared, p.syncOffer), section = p.section()!;
  expect(o.step).toBe(step);
  expect(o.text).not.toContain(home); expect(o.text).not.toContain("私有内容");
  expect(Buffer.byteLength(section)).toBeLessThanOrEqual(step === "review" ? 1000 : 1600);
  expect(section.split("\n").filter(l => l.startsWith("- [")).length).toBeLessThanOrEqual(step === "review" ? 3 : 4);
});

test("prepared section refused by outbound gate is dropped; no network uses synchronous routes", async () => {
  policy(); const p = fixture(); p.lend.memoryPrepare.embedder = null;
  p.f.db.run("DROP TRIGGER memories_no_update");
  const body = JSON.stringify({ symptom: "症状", rule: `禁止外发 ${"d".repeat(40)}` });
  p.f.db.run("UPDATE memories SET body = ? WHERE id = ?", [body, p.memory]);
  expect(await p.offer()).toMatchObject({ ok: true }); expect(p.section()).toBeUndefined();
  expect(p.events().find(e => e.data.op === "memory_inject_attempt")?.data.result).toBe("error");
});

test("observe semantic differences do not seed fallback cache or alter the next order", async () => {
  policy("observe"); const p = fixture();
  createTask(p.f.db, { actor: "owner" }, { id: "S2", project: "p", kind: "code", title: "unrelated source" });
  // Only the semantic route can find this unrelated card's pitfall.
  const id = recordMemory(p.f.db, { actor: "pm" }, { project: "p", kind: "pitfall", title: "语义额外命中", symptom: "语义额外症状",
    rule: "语义规则", files: ["src/other.ts"], fixable: false, via: "tool", authorRole: "reviewer", taskId: "S2", specRev: 1, head: H1 }).memory.id;
  p.lend.memoryPrepare.embedder = { model: "different", remote: false, embed: async texts => texts.map(t => t.includes("事务隔离") ? [0, 1] : [1, 0]) };
  const o = commitLendOffer(p.f.db, await p.prepare(), p.syncOffer);
  expect(o.text).not.toContain(id);
  const sample = p.events().find(e => e.data.mechanism === "memoryLendPrepare")!;
  expect(sample.data.changed).toBe(true);
  expect((sample.data.prepared as { ids: string[] }).ids).toContain(id);
  expect(p.events().filter(e => e.data.op === "memory_rank").every(e => e.dedupKey?.endsWith(":fallback"))).toBe(true);
  cancelLend(p.f.db, { actor: "pm" }, { taskId: "T1", reason: "compare" }); policy("off");
  const next = p.syncOffer();
  expect(next.text.replaceAll(next.orderId, o.orderId)).toBe(o.text);
  cancelLend(p.f.db, { actor: "pm" }, { taskId: "T1", reason: "enable semantic" }); policy("on");
  const semantic = commitLendOffer(p.f.db, await p.prepare(), p.syncOffer);
  expect(semantic.text).toContain(id);
});

test.each(["on", "observe", "off"])("observe-drift-reject: wrapper drift preserves baseline when current mode is %s", async current => {
  policy("observe"); const p = fixture(), prepared = await p.prepare();
  p.f.db.run("UPDATE tasks SET rev = rev + 1, title = 'changed' WHERE id = 'T1'"); policy(current);
  const o = commitLendOffer(p.f.db, prepared, p.syncOffer);
  expect(o.status).toBe("pooled"); expect(o.text).toContain(p.memory);
});

test.each(["observe", "off"])("observe-drift-reject: upstream %s never adds a drift rejection", async upstream => {
  policy("on", "observe"); const p = fixture(), prepared = await p.prepare();
  p.f.db.run("UPDATE tasks SET round = round + 1 WHERE id = 'T1'"); policy("on", upstream);
  expect(commitLendOffer(p.f.db, prepared, p.syncOffer).status).toBe("pooled");
});

test.each(["on", "observe"])("rev-guard-bypass: real CLI rejects memory-I/O revision changes in %s", async mode => {
  policy(mode); const p = fixture();
  p.lend.memoryPrepare.embedder = { model: "rev-drift", remote: false, embed: async texts => {
    p.f.db.run("UPDATE tasks SET rev = rev + 1 WHERE id = 'T1'"); return texts.map(() => [1, 0]);
  } };
  expect(await p.offer()).toMatchObject({ ok: false, code: "conflict" });
  expect(listLendOrders(p.f.db, "T1")).toEqual([]);
});

test.each(["off", "observe", "on"])("rev-guard-bypass: refreshCliOffer preserves revision CAS in %s", async mode => {
  policy(mode); const p = fixture();
  let calls = 0;
  p.lend.borrow = async () => {
    if (++calls === 2) p.f.db.run("UPDATE tasks SET rev = rev + 1, title = 'changed-by-pm' WHERE id = 'T1'");
    return p.borrow;
  };
  expect(await p.offer()).toMatchObject({ ok: false, code: "conflict" });
  expect(listLendOrders(p.f.db, "T1")).toEqual([]);
});

test("observe-drift-reject: already drifted observation skips preparation and preserves baseline", async () => {
  policy("observe"); const p = fixture(), task = p.f.task();
  writeFileSync(p.spec, "spec changed before prepare");
  const prepared = await prepareLendOffer(p.f.db, task, H1, "old spec", () => readFileSync(p.spec, "utf8"), p.lend.memoryPrepare);
  expect(p.calls).toEqual([]);
  expect(commitLendOffer(p.f.db, prepared, p.syncOffer).status).toBe("pooled");
  expect(p.events().find(e => e.data.mechanism === "memoryLendPrepare")?.data.reason).toContain("漂移");
});

test("observe-drift-reject: canonical material-I/O revision guard remains intact", async () => {
  policy("observe"); const p = fixture();
  p.lend.result.remoteHead = async () => {
    p.f.db.run("UPDATE tasks SET rev = rev + 1 WHERE id = 'T1'"); return { ok: true as const, head: H1 };
  };
  expect(await p.offer()).toMatchObject({ ok: false, code: "conflict" });
  expect(listLendOrders(p.f.db, "T1")).toEqual([]);
});

test("observe-drift-reject: observe spec drift is sampled after success and never hard rejected", async () => {
  policy("observe"); const p = fixture(), prepared = await p.prepare();
  writeFileSync(p.spec, "规格正文已经改变");
  const o = commitLendOffer(p.f.db, prepared, p.syncOffer);
  expect(o.status).toBe("pooled");
  expect(p.events().find(e => e.data.mechanism === "memoryLendPrepare")?.data.reason).toContain("漂移");
});

test("observe-drift-reject: in-transaction drift in observe preserves synchronous rendering", async () => {
  policy("observe"); const p = fixture(), prepared = await p.prepare();
  const input = { taskId: "T1", peer: "mate", family: "codex" as const, repo: "o/r", pr: null, spec: "new spec", borrow: p.borrow[0]!,
    write: { fp: "abcd-ef01-2345-6789", base: "main", baseSha: H1, report: null } };
  const baseline = renderLendOffer(p.f.db, { actor: "pm" }, p.f.task(), "write", "manual-order", input);
  const actual = commitLendOffer(p.f.db, prepared, () => {
    writeFileSync(p.spec, "changed during transaction");
    return renderLendOffer(p.f.db, { actor: "pm" }, p.f.task(), "write", "manual-order", input);
  });
  expect(actual.text).toBe(baseline.text);
});

test("relay-head-discard-no-memory: legitimate head adoption keeps synchronous memory", async () => {
  policy(); const p = fixture(), prepared = await p.prepare();
  const o = commitLendOffer(p.f.db, prepared, () => {
    p.f.db.run("UPDATE tasks SET headSHA = ? WHERE id = 'T1'", ["a".repeat(40)]);
    return p.syncOffer();
  });
  expect(o.text).toContain(p.memory);
  expect(p.events().find(e => e.data.op === "memory_inject_attempt")?.data.result).toBe("injected");
});

/**
 * dispatch-recovery-MATFP1 on a real temp ledger and a real spec file: the gate block's material includes the SHA-256 of the
 * spec body the pool offer actually sends (`ledger scheduler-pool` → specOf), read through the same specPathFor / readTextSoft
 * chain by the planner, the placement view and the patrol (gateInputs). A body edit under the same specRev re-arms exactly one
 * full-gate attempt; the original bytes, a path / mtime / note / hello change, a deleted or unreadable spec and a refusal without
 * a digest never become a fresh material to send again. Advice names only real commands and the lease as it really stands.
 */
import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { auditLedger } from "../src/lib/ledger-audit.js";
import { getWriteLease } from "../src/lib/ledger-lend-lease.js";
import { getTask, listEvents } from "../src/lib/ledger-store.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { placementOf } from "../src/lib/lend-placement-view.js";
import { recordGateRefused } from "../src/lib/order-gate-heads.js";
import { schedulerPoolStep } from "../src/lib/ledger-scheduler-pool.js";
import { blockFindings, gateBlock, gateInputs, specDigestOf } from "../src/lib/scheduler-dispatch-block.js";
import { blockFixture, E2E_MS, MIN, toFix, type Fx } from "./scheduler-dispatch-block-helpers.js";

const secret = () => randomBytes(32).toString("hex");
/** Same length every time: a different secret keeps size and only changes the tail. */
const leakedSpec = (s = secret()) => `规格：只改 src/lib/x.ts\n验收：单测全绿\n别处粘来的 secret ${s}`;
const CLEAN = "规格：只改 src/lib/x.ts\n验收：单测全绿\n（已去掉粘贴的长串）";
const sha = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");

const later = async (p: Fx) => { p.f.advance(MIN); p.hello(); return p.tick(); };
const now = (p: Fx, db: Database = p.f.db) => { const t = getTask(db, "T1")!; return gateBlock(t, listEvents(db, { target: "T1" }), gateInputs(db, t)); };
const view = (p: Fx) => placementOf(p.f.db, getTask(p.f.db, "T1")!, p.policy, [{ peer: "mate", projects: ["p"], roles: ["review", "write"], maxOpen: 3 }], p.f.tickDeps.now());
const audit = (p: Fx) => { const t = p.f.task(); return auditLedger({ project: "p", pms: ["pm"], tasks: [{ task: t, events: p.events(), gate: gateInputs(p.f.db, t) }],
  agents: null, reviewers: null, held: null, ownerInbox: null }, p.f.tickDeps.now()).findings.filter((f) => f.rule === "dispatch_blocked"); };
const specPath = (p: Fx) => p.f.task().spec!;

/** A build card whose spec carries a pasted secret; the pool offer to mate is refused by the outbound gate. */
async function refusedBuild(body = leakedSpec()) {
  const p = await blockFixture();
  writeFileSync(specPath(p), body);
  p.policy.remote.agents = { claude: 0, codex: 0 };
  p.hello();
  expect(await p.tick()).toMatchObject({ step: "pool_refused", detail: expect.stringContaining("外发闸") });
  return { p, body };
}

/** Same size, same mtime: only the last bytes of the body differ. */
function editTail(path: string, next: string) {
  const st = statSync(path);
  expect(Buffer.byteLength(next)).toBe(st.size);
  writeFileSync(path, next);
  utimesSync(path, st.atime, st.mtime);
}

describe("acceptance 1: the fingerprint is the full outbound body, not specRev / path / mtime", () => {
  test("refusal stores the digest of the sent body (no body, no path); a same-size same-mtime tail edit re-arms one attempt, original bytes stay blocked", async () => {
    const { p, body } = await refusedBuild();
    try {
      const [first] = p.refusals();
      expect(first!.data.digest).toBe(sha(body));
      expect(first!.data.material).toContain(`:d${sha(body)}`);
      expect(first!.data.material).toContain(`:h${p.f.task().headSHA ?? "-"}`); // full head, not cut
      expect(JSON.stringify(first!.data)).not.toContain(specPath(p));
      expect(now(p)).toMatchObject({ state: "blocked" });
      for (let i = 0; i < 3; i++) expect(await later(p)).toMatchObject({ step: "waiting", detail: expect.stringContaining("安全材料阻塞") });
      const rev = p.f.task().specRev;
      const edited = leakedSpec();
      editTail(specPath(p), edited);
      expect(p.f.task().specRev).toBe(rev);
      expect(now(p)).toMatchObject({ state: "retry" });
      expect(view(p)).toMatchObject({ block: { state: "retry" } });
      expect(await later(p)).toMatchObject({ step: "pool_refused" }); // full gate again: still leaking
      expect(p.refusals()).toHaveLength(2);
      expect(p.refusals()[1]!.data.digest).toBe(sha(edited));
      for (let i = 0; i < 3; i++) await later(p);
      expect(p.refusals()).toHaveLength(2);
      const fresh = new Database(join(p.f.dir, "ledger.sqlite"), { readonly: true }); // restart: only ledger + file
      try { expect(now(p, fresh)).toMatchObject({ state: "blocked" }); } finally { fresh.close(); }
      editTail(specPath(p), body); // the original bytes were already refused
      expect(now(p)).toMatchObject({ state: "blocked" });
      for (let i = 0; i < 2; i++) await later(p);
      expect(p.refusals()).toHaveLength(2);
      expect(p.orders()).toEqual([]);
    } finally { p.f.close(); }
  }, E2E_MS);

  test("same content: a new path, a touched mtime, a note, a hello and a reassignment do not retry", async () => {
    const { p } = await refusedBuild();
    try {
      const moved = join(p.f.dir, "T1-moved.md");
      copyFileSync(specPath(p), moved);
      expect(await p.cli("pm", "task-set", "T1", "--rev", String(p.f.task().rev), "--spec", moved)).toMatchObject({ ok: true });
      utimesSync(moved, new Date(), new Date(Date.now() + 60_000));
      insertEvent(p.f.db, p.f.at("pm"), { project: "p", target: "T1", kind: "note", text: "看过", data: {} }, true);
      expect(await p.cli("pm", "task-set", "T1", "--rev", String(p.f.task().rev), "--agent", "agent-task-one")).toMatchObject({ ok: true });
      expect(now(p)).toMatchObject({ state: "blocked" });
      for (let i = 0; i < 3; i++) expect(await later(p)).toMatchObject({ step: "waiting" });
      expect(p.refusals()).toHaveLength(1);
    } finally { p.f.close(); }
  }, E2E_MS);

  for (const how of ["deleted", "unreadable"] as const) test(`spec ${how}: unknown digest stays blocked, never sends`, async () => {
    const { p } = await refusedBuild();
    try {
      if (how === "deleted") rmSync(specPath(p));
      else chmodSync(specPath(p), 0o000);
      const intents = p.f.intents().length;
      const b = now(p);
      expect(b).toMatchObject({ state: "blocked", material: "unknown" });
      for (let i = 0; i < 3; i++) await later(p);
      expect(p.f.intents().filter((i) => i.status === "pending")).toEqual([]);
      expect(p.f.intents().length - intents).toBeLessThanOrEqual(0);
      expect(p.refusals()).toHaveLength(1);
      expect(audit(p)).toEqual([expect.objectContaining({ detail: expect.stringContaining("摘要未知") })]);
      if (how === "unreadable") chmodSync(specPath(p), 0o644);
    } finally { p.f.close(); }
  }, E2E_MS);
});

describe("acceptance 2: the real pool path retries once per new digest and closes only on the original evidence", () => {
  test("clean body → one full-gate offer pooled → claim closes the block", async () => {
    const { p } = await refusedBuild();
    try {
      writeFileSync(specPath(p), CLEAN);
      expect(await later(p)).toMatchObject({ step: "pool_pooled" });
      const [order] = p.orders();
      expect(order!.text).toContain("已去掉粘贴的长串");
      expect(now(p)).toMatchObject({ state: "retrying" });
      expect(audit(p)).toEqual([]);
      expect(await p.lendCall("lend-claim", { v: 1, orderId: order!.orderId, worker: "w2" })).toMatchObject({ ok: true });
      expect(now(p)).toBeNull();
    } finally { p.f.close(); }
  }, E2E_MS);

  test("two ticks racing on a new digest create one offer attempt", async () => {
    const { p } = await refusedBuild();
    try {
      await later(p);
      editTail(specPath(p), leakedSpec());
      p.f.advance(MIN);
      p.hello();
      await Promise.all([p.tick(), p.tick()]);
      await later(p);
      expect(p.refusals()).toHaveLength(2);
      expect(now(p)).toMatchObject({ state: "blocked" });
    } finally { p.f.close(); }
  }, E2E_MS);

  test("a refusal recorded without a digest gets at most one re-check of the readable body; unreadable does not spend it", async () => {
    const p = await blockFixture();
    try {
      writeFileSync(specPath(p), leakedSpec());
      recordGateRefused(p.f.db, p.f.at("scheduler"), p.f.task(), "派单没过外发闸（拒绝优先，留在本机做）：inputs[0] 疑似含密钥（长十六进制）");
      chmodSync(specPath(p), 0o000);
      expect(now(p)).toMatchObject({ state: "blocked", material: "unknown" });
      chmodSync(specPath(p), 0o644);
      expect(now(p)).toMatchObject({ state: "retry" });
      p.policy.remote.agents = { claude: 0, codex: 0 };
      p.hello();
      expect(await p.tick()).toMatchObject({ step: "pool_refused" });
      for (let i = 0; i < 3; i++) await later(p);
      expect(p.refusals()).toHaveLength(2);
      expect(now(p)).toMatchObject({ state: "blocked" });
    } finally { p.f.close(); }
  }, E2E_MS);

  test("an earlier handler version and a content change at once still give one attempt", async () => {
    const { p } = await refusedBuild();
    try {
      const last = p.refusals()[0]!;
      insertEvent(p.f.db, p.f.at("scheduler"), { project: "p", target: "T1", kind: "scheduler", text: "旧处理器拒收",
        data: { ...last.data, intentId: "old-handler", material: String(last.data.material).replace(/^g\d+/, "g3") } }, true);
      editTail(specPath(p), leakedSpec());
      expect(now(p)).toMatchObject({ state: "retry" });
      expect(await later(p)).toMatchObject({ step: "pool_refused" });
      for (let i = 0; i < 3; i++) await later(p);
      expect(p.refusals()).toHaveLength(3);
      expect(now(p)).toMatchObject({ state: "blocked" });
    } finally { p.f.close(); }
  }, E2E_MS);
});

describe("acceptance 3: one state and real advice across planner, placement and patrol", () => {
  test("blocked: same wording everywhere, real commands, no body / path / spec-set; held lease → reclaim, ended / none → verify, no reclaim", async () => {
    const { p, body } = await refusedBuild();
    try {
      const tick = await later(p);
      const v = view(p);
      const [row] = audit(p);
      expect(v).toMatchObject({ category: "security_material", block: { state: "blocked" } });
      expect(row!.detail).toBe(`T1 ${v.block!.reason}`);
      expect(tick!.detail).toBe(v.block!.reason);
      for (const text of [v.block!.reason, row!.detail, row!.suggestion]) {
        expect(text).not.toContain("spec-set");
        expect(text).not.toContain(specPath(p));
        expect(text).not.toContain(body.split("secret ")[1]!);
        expect(text).toContain("ledger task-set T1");
        expect(text).toContain("不是自动改写外来原文");
      }
      const lease = getWriteLease(p.f.db, "T1");
      const t = p.f.task(), ev = p.events(), gate = gateInputs(p.f.db, t);
      if (lease?.state === "held") expect(row!.suggestion).toContain("ledger lend-reclaim T1");
      else expect(row!.suggestion).not.toContain("lend-reclaim");
      const ended = blockFindings(t, ev, { ...gate, lease: { state: "ended", peer: "mate" } })!;
      const none = blockFindings(t, ev, { ...gate, lease: "none" })!;
      const unknown = blockFindings(t, ev, { ...gate, lease: "unknown" })!;
      const legacy = blockFindings(t, ev)!; // a caller without gate facts: unknown digest and lease, conservative
      expect(legacy.suggestion).toContain("摘要未知");
      for (const f of [ended, none, unknown, legacy]) {
        expect(f.suggestion).not.toContain("lend-reclaim");
        expect(f.suggestion).toContain("ledger lend-orders T1");
      }
      expect(blockFindings(t, ev, { ...gate, lease: { state: "held", peer: "mate" } })!.suggestion).toContain("ledger lend-reclaim T1 --reason");
      expect(specDigestOf(readFileSync(specPath(p), "utf8"))).toBe(gate.specDigest);
    } finally { p.f.close(); }
  }, E2E_MS);
});

describe("PM batch DAG171: fix material, drift after preparation, lease unknown", () => {
  test("fix: the strategy material is part of the digest; its change re-arms one attempt, its read failure is unknown", async () => {
    const p = await blockFixture();
    try {
      await toFix(p, `# 审查报告\nP1：x\n别处粘来的 secret ${secret()}`);
      expect(await p.tick()).toMatchObject({ step: "pool_refused" });
      const material = join(p.f.dir, "strategy.md");
      writeFileSync(material, "历轮报告原文 v1");
      const t = p.f.task();
      const before = gateInputs(p.f.db, t).specDigest;
      insertEvent(p.f.db, p.f.at("scheduler"), { project: "p", target: "T1", kind: "scheduler", text: "修复策略",
        data: { op: "fix_strategy", specRev: t.specRev, round: t.round, material } }, true);
      const withMaterial = gateInputs(p.f.db, p.f.task()).specDigest;
      expect(withMaterial).not.toBe(before);
      expect(withMaterial).toBe(sha(`${readFileSync(specPath(p), "utf8")}\n\n历轮报告原文 v1`));
      expect(now(p)).toMatchObject({ state: "retry" });
      expect(await later(p)).toMatchObject({ step: "pool_refused" }); // the report still leaks: one attempt, refused
      for (let i = 0; i < 2; i++) await later(p);
      expect(p.refusals()).toHaveLength(2);
      expect(p.refusals()[1]!.data.digest).toBe(withMaterial);
      expect(now(p)).toMatchObject({ state: "blocked" });
      chmodSync(material, 0o000);
      expect(gateInputs(p.f.db, p.f.task()).specDigest).toBeNull();
      expect(now(p)).toMatchObject({ state: "blocked", material: "unknown" });
      chmodSync(material, 0o644);
      writeFileSync(material, "历轮报告原文 v2");
      expect(now(p)).toMatchObject({ state: "retry" });
    } finally { p.f.close(); }
  }, E2E_MS);

  test("the pool writer refuses text that drifted after preparation: nothing offered or recorded, the intent stays pending", async () => {
    const { p, body } = await refusedBuild();
    try {
      editTail(specPath(p), leakedSpec()); // a real change: the planner wants one more attempt
      p.hold.pool = true;
      expect(await later(p)).toMatchObject({ step: "held" });
      const pending = p.f.intents().find((i) => i.status === "pending" && i.recipient?.startsWith("peer:"))!;
      expect(pending).toBeDefined();
      const step = (spec: string | null) => schedulerPoolStep(p.f.db, { actor: "scheduler", now: p.f.tickDeps.now() }, { intentId: pending.id,
        maxWorkers: 2, timeoutMs: 15 * MIN, borrow: p.borrow, remote: p.policy.remote, spec, write: null });
      expect(() => step(body)).toThrow("备料后变了"); // prepared from the old bytes, the file has moved on
      expect(p.f.intents().find((i) => i.id === pending.id)!.status).toBe("pending"); // rolled back: not a spent peer
      expect(p.refusals()).toHaveLength(1); // no gate_refused recorded for a text that was never the current one
      expect(p.orders()).toEqual([]);
      p.hold.pool = false;
      expect(await later(p)).toMatchObject({ step: "pool_refused" }); // the current text, through the full gate
      expect(p.refusals()).toHaveLength(2);
      expect(p.refusals()[1]!.data.digest).toBe(sha(readFileSync(specPath(p), "utf8")));
    } finally { p.f.close(); }
  }, E2E_MS);

  test("lease: held names reclaim; a row of another project is unknown (not none) and suggests no reclaim; restart reads the same", async () => {
    const p = await blockFixture();
    try {
      await toFix(p, `# 审查报告\nP1：x\n别处粘来的 secret ${secret()}`);
      expect(await p.tick()).toMatchObject({ step: "pool_refused" });
      expect(gateInputs(p.f.db, p.f.task()).lease).toEqual({ state: "held", peer: "mate" });
      expect(view(p).block!.reason).toContain("ledger lend-reclaim T1 --reason");
      p.f.db.run("UPDATE lend_write_leases SET project = 'other' WHERE taskId = 'T1'");
      expect(gateInputs(p.f.db, p.f.task()).lease).toBe("unknown");
      const [row] = audit(p);
      expect(row!.suggestion).not.toContain("lend-reclaim");
      expect(row!.suggestion).toContain("写租约状态读不到");
      expect(view(p).block!.reason).not.toContain("lend-reclaim");
      const fresh = new Database(join(p.f.dir, "ledger.sqlite"), { readonly: true });
      try { expect(gateInputs(fresh, getTask(fresh, "T1")!).lease).toBe("unknown"); } finally { fresh.close(); }
      p.f.db.run("UPDATE lend_write_leases SET project = 'p', state = 'ended' WHERE taskId = 'T1'");
      expect(gateInputs(p.f.db, p.f.task()).lease).toEqual({ state: "ended", peer: "mate" });
      expect(audit(p)[0]!.suggestion).toContain("写租约已结束");
    } finally { p.f.close(); }
  }, E2E_MS);
});

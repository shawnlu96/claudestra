/**
 * Scheduling core (generality-BRANCH1): a develop target whose work starts on another branch keeps its start and target
 * through dispatch (write materials), lend (fix offer base), reborrow (source check) and the local author plan.
 * Floka's main path stays byte-for-byte the legacy result. Policy file, probes and the database are all injected.
 */
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import type { LedgerTask } from "../src/lib/ledger-stages.js";
import { closeLedger, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import { writeMaterials, type WriteProbe } from "../src/lib/lend-write-materials.js";
import { prepareReborrowSource, type ReborrowSource } from "../src/lib/lend-reborrow-source.js";
import type { ReborrowFacts } from "../src/lib/lend-reborrow-facts.js";
import { setBranchContextPolicyPath, type BranchContext } from "../src/lib/project-branch.js";
import { fixOrderBase, localAuthorStart } from "../src/lib/project-branch-order.js";

const dir = mkdtempSync(join(tmpdir(), "lend-write-materials-"));
afterAll(() => { setBranchContextPolicyPath(null); rmSync(dir, { recursive: true, force: true }); });
afterEach(() => setBranchContextPolicyPath(join(dir, "absent.json")));
function mode(m: "on" | "observe" | "off" | null): void {
  const path = join(dir, `policy-${m}.json`);
  writeFileSync(path, JSON.stringify({ projects: m ? { p: { keys: { projectBranchContext: m } } } : {} }));
  setBranchContextPolicyPath(path);
}

const START = "a".repeat(40), TARGET_HEAD = "b".repeat(40), OTHER = "c".repeat(40);
const develop: BranchContext = { v: 1, remote: "fixtures/go", defaultBranch: "develop", targetBranch: "develop", workStartRef: "feat/start",
  workStartSha: null, targetHead: TARGET_HEAD, source: "declared" };
const task = (extra: Record<string, unknown> = {}, stage = "build") =>
  ({ id: "T1", project: "p", stage, specRev: 1, round: 0, headSHA: null, extra, pr: null } as unknown as LedgerTask);
const probe = (heads: Record<string, string>, ctx?: WriteProbe["branchContext"]): WriteProbe & { asked: string[] } => {
  const asked: string[] = [];
  return { asked, peerFp: async () => "f".repeat(64), branchContext: ctx,
    remoteHead: async (_repo, branch) => { asked.push(branch); return heads[branch] ? { ok: true, head: heads[branch] } : { ok: false, error: "missing" }; } };
};
const noDb = null as unknown as Database;

describe("dispatch: write materials", () => {
  test("on: develop target with a feature-branch start keeps both", async () => {
    mode("on");
    const p = probe({ "feat/start": START, main: OTHER });
    const w = await writeMaterials(noDb, task({ branchContext: develop }), { peer: "peer", repo: "fixtures/go", base: "main" }, p);
    expect(p.asked).toEqual(["feat/start"]);
    expect(w).toEqual({ fp: "f".repeat(64), base: "develop", baseSha: START, report: null, branchContext: { ...develop, workStartSha: START } });
  });

  test("on: a start that moved after dispatch, a malformed context, or an unknown foreign target stops", async () => {
    mode("on");
    const fixed = { ...develop, workStartSha: OTHER };
    await expect(writeMaterials(noDb, task({ branchContext: fixed }), { peer: "peer", repo: "fixtures/go", base: "main" }, probe({ "feat/start": START })))
      .rejects.toThrow("BASIS_STALE");
    await expect(writeMaterials(noDb, task({ branchContext: { ...develop, v: 2 } }), { peer: "peer", repo: "fixtures/go", base: "main" }, probe({})))
      .rejects.toThrow("CONTEXT_MISSING");
    await expect(writeMaterials(noDb, task(), { peer: "peer", repo: "fixtures/go", base: "main" }, probe({ main: START })))
      .rejects.toThrow("不按 main 猜");
    await expect(writeMaterials(noDb, task({ branchContext: develop }), { peer: "peer", repo: "fixtures/python", base: "main" }, probe({})))
      .rejects.toThrow("REMOTE_MISMATCH");
  });

  test("on: the probe's context must equal the carried one; conflicts from the probe stop", async () => {
    mode("on");
    const moved = async () => ({ ok: true as const, context: { ...develop, targetBranch: "main" } });
    await expect(writeMaterials(noDb, task({ branchContext: develop }), { peer: "peer", repo: "fixtures/go", base: "main" }, probe({ "feat/start": START }, moved)))
      .rejects.toThrow("CONTEXT_CHANGED");
    const conflict = async () => ({ ok: false as const, code: "PR_BASE_CONFLICT" as const, reason: "已有 PR 的 base main 与声明目标 develop 冲突" });
    await expect(writeMaterials(noDb, task(), { peer: "peer", repo: "fixtures/go", base: "main" }, probe({}, conflict))).rejects.toThrow("PR_BASE_CONFLICT");
    const missing = async () => ({ ok: false as const, code: "REMOTE_HEAD_MISSING" as const, reason: "没有 origin/HEAD" });
    await expect(writeMaterials(noDb, task(), { peer: "peer", repo: "fixtures/go", base: "main" }, probe({}, missing))).rejects.toThrow("REMOTE_HEAD_MISSING");
  });

  test("observe (default): legacy result unchanged, the difference is recorded once", async () => {
    mode(null);
    const db = openLedger(join(dir, "ledger.sqlite"));
    createTask(db, { actor: "owner", now: 1 }, { project: "p", id: "T1", title: "fixture", kind: "code", agent: "agent-w", pm: "agent-pm" });
    try {
      const w = await writeMaterials(db, task({ branchContext: develop }), { peer: "peer", repo: "fixtures/go", base: "main" }, probe({ main: START }));
      expect(w).toEqual({ fp: "f".repeat(64), base: "main", baseSha: START, report: null });
      const seen = listEvents(db, { project: "p", target: "T1" }).filter((e) => e.data.mechanism === "projectBranchContext");
      expect(seen.map((e) => e.data.candidate)).toEqual([{ target: "develop", start: "feat/start" }]);
    } finally { closeLedger(join(dir, "ledger.sqlite")); }
  });

  test("off: legacy, but a recorded develop target is not re-defaulted to main", async () => {
    mode("off");
    await expect(writeMaterials(noDb, task({ branchContext: develop }), { peer: "peer", repo: "fixtures/go", base: "main" }, probe({ main: START })))
      .rejects.toThrow("不改回 main");
    expect(await writeMaterials(noDb, task(), { peer: "peer", repo: "fixtures/go", base: "main" }, probe({ main: START })))
      .toEqual({ fp: "f".repeat(64), base: "main", baseSha: START, report: null });
  });

  test("Floka main path: identical legacy bytes under every mode without a context", async () => {
    for (const m of [null, "observe", "off", "on"] as const) {
      mode(m);
      const p = probe({ main: START, "feat/x": OTHER });
      const w = await writeMaterials(noDb, task(), { peer: "peer", repo: "shawnlu96/claudestra", base: "feat/x" }, p);
      const { branchContext: _, ...legacy } = w as NonNullable<typeof w> & { branchContext?: BranchContext };
      expect(JSON.stringify(legacy)).toBe(JSON.stringify({ fp: "f".repeat(64), base: "main", baseSha: OTHER, report: null }));
      expect(p.asked).toEqual(["feat/x"]);
    }
  });

  test("Floka main path, new state: only on adds the configured context", async () => {
    for (const m of [null, "observe", "off", "on"] as const) {
      mode(m);
      const w = await writeMaterials(noDb, task(), { peer: "peer", repo: "shawnlu96/claudestra", base: "feat/x" }, probe({ "feat/x": OTHER }));
      const context = (w as { branchContext?: BranchContext }).branchContext;
      if (m === "on") expect(context).toMatchObject({ targetBranch: "main", workStartRef: "feat/x", workStartSha: OTHER, source: "config" });
      else expect(context).toBeUndefined();
    }
  });
});

describe("lend, reborrow and local author keep the same start and target", () => {
  const orders = () => {
    const db = new Database(":memory:");
    db.run("CREATE TABLE lend_orders (orderId TEXT PRIMARY KEY, taskId TEXT, base TEXT, createdAt INTEGER)");
    db.run("INSERT INTO lend_orders VALUES ('o1', 'T1', 'develop', 1), ('o2', 'T1', NULL, 2)");
    return db;
  };
  test("fix offer base: on keeps develop, legacy keeps main, a missing record stops under on", () => {
    const db = orders();
    mode("on"); expect(fixOrderBase(db, task({}, "fix"))).toBe("develop");
    mode(null); expect(fixOrderBase(db, task({}, "fix"))).toBe("main");
    mode("on"); db.run("DELETE FROM lend_orders");
    expect(() => fixOrderBase(db, task({}, "fix"))).toThrow("CONTEXT_MISSING");
    expect(fixOrderBase(db, task({ branchContext: develop }, "fix"))).toBe("develop");
  });

  const source = (base: string): ReborrowSource => ({ peer: "peer", fp: "f".repeat(64), repo: "fixtures/go", branch: "lend/T1-ffff", remoteHead: START,
    pr: { number: 7, url: "https://github.com/fixtures/go/pull/7", repo: "fixtures/go", branch: "lend/T1-ffff", head: START, base } });
  const facts = (previousBase: string) => ({ lease: { peer: "peer", fp: "f".repeat(64), repo: "fixtures/go", branch: "lend/T1-ffff" },
    previous: { head: START, pr: 7, base: previousBase }, task: { id: "T1", project: "p", headSHA: START, pr: "https://github.com/fixtures/go/pull/7" } }) as unknown as ReborrowFacts;
  const reader = (s: ReborrowSource) => ({ read: async () => structuredClone(s), isAncestor: async () => true });

  test("reborrow: on accepts the carried develop PR base, rejects a drift to main; default still only main", async () => {
    mode("on");
    expect(await prepareReborrowSource(facts("develop"), reader(source("develop")))).toEqual(source("develop"));
    await expect(prepareReborrowSource(facts("develop"), reader(source("main")))).rejects.toThrow("合并目标 base 不符");
    mode(null);
    await expect(prepareReborrowSource(facts("develop"), reader(source("develop")))).rejects.toThrow("合并目标 base 不符");
    expect(await prepareReborrowSource(facts("main"), reader(source("main")))).toEqual(source("main"));
  });

  test("local author: on starts at the carried start, never at the target; legacy unchanged", () => {
    mode("on");
    expect(localAuthorStart({ project: "p", headSHA: null, extra: { branchContext: { ...develop, workStartSha: START } } }, false)).toEqual({ base: START });
    expect(localAuthorStart({ project: "p", headSHA: null, extra: { branchContext: develop } }, false)).toEqual({ base: "origin/feat/start" });
    expect(localAuthorStart({ project: "p", headSHA: null, extra: { branchContext: "bad" } }, false)).toBe("卡上的分支上下文不合法");
    mode(null);
    expect(localAuthorStart({ project: "p", headSHA: null, extra: { branchContext: develop } }, false)).toEqual({ base: "origin/main" });
    expect(localAuthorStart({ project: "p", headSHA: null, extra: {} }, true)).toEqual({ base: "main" });
    expect(localAuthorStart({ project: "p", headSHA: OTHER, extra: {} }, false)).toEqual({ base: OTHER });
  });

  test("whole chain under on: dispatch start/target equal the lend, reborrow and local author views", async () => {
    mode("on");
    const w = await writeMaterials(noDb, task({ branchContext: develop }), { peer: "peer", repo: "fixtures/go", base: "main" }, probe({ "feat/start": START }));
    const carried = (w as { branchContext: BranchContext }).branchContext;
    const db = orders();
    expect([w!.base, fixOrderBase(db, task({ branchContext: carried }, "fix"))]).toEqual(["develop", "develop"]);
    expect((await prepareReborrowSource(facts(w!.base), reader(source(w!.base)))).pr?.base).toBe("develop");
    expect(localAuthorStart({ project: "p", headSHA: null, extra: { branchContext: carried } }, false)).toEqual({ base: w!.baseSha! });
  });
});

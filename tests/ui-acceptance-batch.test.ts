/** Synthetic evidence exercises gates only; owner answers use the real ask API against a temporary ledger. */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { answerFromCard } from "../src/bridge/ask-entry.js";
import { setAsksForTest } from "../src/bridge/asks.js";
import { bindHash, canonicalJson } from "../src/lib/ask-bind.js";
import { getAsk, listAsks, openAskFull } from "../src/lib/ledger-asks.js";
import { bindNode, rewriteDag } from "../src/lib/ledger-dag-write.js";
import { effectiveNodes, getDagVersion, getFeature } from "../src/lib/ledger-feature.js";
import { createFeature, initDag, setFeature } from "../src/lib/ledger-feature-write.js";
import { closeLedger, getTask, openLedger } from "../src/lib/ledger-store.js";
import { createTask, setMeta, setTask } from "../src/lib/ledger-write.js";
import { UiAcceptanceBatch } from "../src/lib/ui-acceptance-batch.js";
import { PAGE_CHECK_KEY, requirePageCheck, withPageCheck } from "../src/lib/ui-acceptance.js";
import { guest, owner } from "./asks-test-kit.js";
import { testChildEnv } from "./test-env.js";

const P = "proof", PM = "agent-pm", H = "a".repeat(40), SH = "b".repeat(64);
const ctx = { actor: PM, actorChannelId: "proof-pm", project: P, instanceId: "instance-proof", mode: "on" as const };
const evidence = () => ({ relay: "fixture relay", device: { width: 390, height: 844, theme: "dark" },
  productionData: "fixture production reference", basis: "fixture same-screen baseline", ledgerComparison: "fixture title/count/status/order", screenshotsHash: SH });
const requests = (ids = ["alpha", "beta"]) => ids.map((id) => ({ featureId: `ab12-${id}`, evidence: evidence() }));
const digest = (x: unknown) => createHash("sha256").update(canonicalJson(x)).digest("hex");
let db: Database, path: string, dir: string, batch: UiAcceptanceBatch;

function fixtureFeature(slug: string): void {
  const f = createFeature(db, { actor: "owner" }, { project: P, slug, title: slug }).row;
  const taskId = `U-${slug}`;
  const spec = join(dir, `${taskId}.md`);
  writeFileSync(spec, "# UI spec\n模板：ui\n## 对照基准\nfixture\n");
  createTask(db, { actor: "owner" }, { id: taskId, project: P, title: slug, kind: "code", spec, headSHA: H, extra: { screenshotsDigest: SH } });
  db.query("UPDATE tasks SET stage = 'live' WHERE id = ?").run(taskId);
  db.query(`INSERT INTO task_workflows (taskId, project, template, templateVersion, mode, authorFamily, fallback, specRev, createdAt, updatedAt)
    VALUES (?, ?, 'ui', 3, 'manual', 'claude', 'fixture', 1, 1, 1)`).run(taskId, P);
  initDag(db, { actor: PM }, { id: f.id, rev: f.rev, nodes: [{ key: "UI", taskId, oneLine: slug, deps: [] }] });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ui-batch-proof-"));
  path = join(dir, "ledger.sqlite");
  mkdirSync(join(dir, "ledger", "docs", "tasks"), { recursive: true });
  db = openLedger(path);
  db.query("INSERT INTO ledger_instance (key, value) VALUES ('origin', 'ab12')").run();
  setMeta(db, { actor: "owner" }, { project: P, key: "pms", value: [PM] });
  fixtureFeature("alpha");
  fixtureFeature("beta");
  batch = new UiAcceptanceBatch(db);
  setAsksForTest({ path, registry: [{ name: PM, projectId: P, channelId: "proof-pm" } as never], ownerChats: ["api:owner:self"],
    deps: { clients: new Map([["proof-pm", { ws: {} as never }]]), controlChannelId: "proof-master", hold: () => {},
      deliver: async (env) => ({ envelope: env, outcome: { kind: "sent" } }) } });
});
afterEach(() => {
  setAsksForTest(undefined);
  closeLedger(path);
  rmSync(dir, { recursive: true, force: true });
});

async function answer(askId: string, approve = true) {
  return answerFromCard(P, askId, { choices: [`[button:project_ui_page_${approve ? "approve" : "reject"}]`] }, owner());
}
async function accept(rs = requests(), revision = 0) {
  const s = batch.propose(ctx, revision, rs);
  expect((await answer(s.askId)).status).toBe(202);
  return batch.verify(ctx, s.revision, s.askId);
}
function taskPatch(id: string, patch: Parameters<typeof setTask>[2]["patch"]): void {
  setTask(db, { actor: "owner" }, { id, rev: getTask(db, id)!.rev, patch });
}

describe("project acceptance proof", () => {
  test("one real owner API answer binds two actual DAG scopes, heads, rounds, digests and five inputs", async () => {
    const s = batch.propose(ctx, 0, requests());
    expect(s.entries.map((e) => e.scope.featureId)).toEqual(["ab12-alpha", "ab12-beta"]);
    expect(s.entries[0]!.scope.ui[0]).toMatchObject({ taskId: "U-alpha", head: H, specRev: 1, round: 0, screenshotsHash: SH });
    expect(s.entries[0]!.scope.ui[0]!.digest).toMatch(/^[a-f0-9]{64}$/);
    const a = getAsk(db, s.askId)!;
    expect(a.taskId).toBeNull();
    expect(a.context).toContain("生产数据");
    expect(a.body).toContain("390");
    expect(batch.check(ctx, "ab12-alpha").ok).toBe(false);
    expect(() => batch.verify(ctx, s.revision, s.askId)).toThrow("owner");
    expect((await answer(s.askId)).status).toBe(202);
    expect(getAsk(db, s.askId)?.answer?.owner).toBe(true);
    expect(batch.verify(ctx, s.revision, s.askId).state).toBe("verified");
    for (const r of requests()) expect(batch.check(ctx, r.featureId)).toEqual({ ok: true });
    expect(() => batch.verify(ctx, s.revision, s.askId)).toThrow("重复");
    expect((await answer(s.askId)).status).toBe(409);
    // Proof deliberately cannot complete production PAGEOK or change the DAG bindings.
    const f = getFeature(db, "ab12-alpha")!;
    expect(() => setFeature(db, { actor: PM }, { id: f.id, rev: f.rev, patch: { status: "done" } })).toThrow(PAGE_CHECK_KEY);
    expect(effectiveNodes(db, getDagVersion(db, f.id, 1)!).find((n) => n.key === PAGE_CHECK_KEY)?.taskId).toBeNull();
  });

  test("default observe and off preserve automatic PAGEOK and completion refusal without writing source state", () => {
    for (const mode of [undefined, "observe", "off"] as const) {
      const c = { ...ctx, mode };
      expect(batch.check(c, "ab12-alpha").ok).toBe(false);
      expect(() => batch.propose(c, 0, requests())).toThrow("observe/off");
      const f = getFeature(db, "ab12-alpha")!;
      const ns = effectiveNodes(db, getDagVersion(db, f.id, 1)!);
      expect(withPageCheck(db, f, ns.filter((n) => n.key !== PAGE_CHECK_KEY), ns).filter((n) => n.key === PAGE_CHECK_KEY)).toHaveLength(1);
      expect(() => requirePageCheck(db, f)).toThrow(PAGE_CHECK_KEY);
    }
    expect(batch.diagnostics({ ...ctx, mode: undefined })).toHaveLength(1);
    expect(batch.diagnostics({ ...ctx, mode: "off" })).toEqual([]);
    expect(batch.diagnostics(ctx)).toEqual([]);
    expect(db.query("SELECT name FROM sqlite_master WHERE name = 'ui_page_batch'").get()).toBeNull();
  });

  for (const drift of ["head", "specRev", "round", "screenshot", "spec", "files", "dag", "new-ui", "stage"] as const) {
    test(`${drift}: live source recheck invalidates only affected feature`, async () => {
      await accept();
      mutate(drift);
      expect(batch.check(ctx, "ab12-alpha").ok).toBe(false);
      expect(batch.check(ctx, "ab12-beta")).toEqual({ ok: true });
    });
  }

  test("a single pending scope drift rejects the complete consumption transaction", async () => {
    const s = batch.propose(ctx, 0, requests());
    await answer(s.askId);
    taskPatch("U-alpha", { headSHA: "c".repeat(40) });
    expect(() => batch.verify(ctx, s.revision, s.askId)).toThrow("漂移");
    expect(db.query("SELECT state FROM ui_page_vectors").get()).toEqual({ state: "pending" });
    expect(db.query("SELECT COUNT(*) AS n FROM ui_page_members").get()).toEqual({ n: 0 });
    expect(batch.check(ctx, "ab12-beta").ok).toBe(false);
  });

  test("late UI feature cannot inherit an already verified project source", async () => {
    await accept();
    fixtureFeature("gamma");
    expect(batch.check(ctx, "ab12-gamma").ok).toBe(false);
    expect(batch.check(ctx, "ab12-alpha")).toEqual({ ok: true });
  });

  test("partial rejection is explicit, keeps history, and never paints the whole vector green", async () => {
    await accept();
    const rs = requests().map((r) => ({ ...r, verdict: r.featureId.endsWith("alpha") ? "reject" as const : "approve" as const }));
    const s = batch.propose(ctx, 1, rs);
    await answer(s.askId);
    batch.verify(ctx, s.revision, s.askId);
    expect(batch.check(ctx, "ab12-alpha")).toMatchObject({ ok: false, reason: "feature 验收拒绝" });
    expect(batch.check(ctx, "ab12-beta")).toEqual({ ok: true });
    expect(db.query("SELECT COUNT(*) AS n FROM ui_page_vectors").get()).toEqual({ n: 2 });
  });

  test("new pending composition keeps unaffected accepted members and supersedes previous owner button", async () => {
    await accept();
    taskPatch("U-alpha", { headSHA: "c".repeat(40) });
    const next = batch.propose(ctx, 1, requests(["alpha"]));
    expect(batch.check(ctx, "ab12-beta")).toEqual({ ok: true });
    expect(batch.check(ctx, "ab12-alpha").ok).toBe(false);
    await answer(next.askId);
    batch.verify(ctx, next.revision, next.askId);
    expect(batch.check(ctx, "ab12-alpha")).toEqual({ ok: true });
    const pending = batch.propose(ctx, 2, requests(["beta"]));
    const newer = batch.propose(ctx, 3, [{ ...requests(["beta"])[0]!, evidence: { ...evidence(), basis: "changed fixture basis" } }]);
    expect(getAsk(db, pending.askId)?.state).toBe("cancelled");
    expect((await answer(pending.askId)).status).toBe(409);
    expect(() => batch.verify(ctx, pending.revision, pending.askId)).toThrow("取代");
    expect(listAsks(db, { project: P, states: ["open"] }).map((a) => a.id)).toEqual([newer.askId]);
  });

  test("CAS duplicates and restart keep a single active owner source", () => {
    const s = batch.propose(ctx, 0, requests());
    expect(() => batch.propose(ctx, 0, requests())).toThrow("CAS");
    expect(batch.propose(ctx, 1, requests()).askId).toBe(s.askId);
    const conn = new Database(path);
    try {
      const restarted = new UiAcceptanceBatch(conn);
      expect(restarted.propose(ctx, 1, requests()).askId).toBe(s.askId);
      expect(() => restarted.propose({ ...ctx, instanceId: "wrong-instance" }, 1, requests())).toThrow("实例");
    } finally { conn.close(); }
    expect(listAsks(db, { project: P, states: ["open"] })).toHaveLength(1);
  });

  test("owner rejection can retry the identical vector once, including after restart", async () => {
    const rejected = batch.propose(ctx, 0, requests());
    await answer(rejected.askId, false);
    const before = getAsk(db, rejected.askId);
    const conn = new Database(path);
    let retry: ReturnType<UiAcceptanceBatch["propose"]>;
    try { retry = new UiAcceptanceBatch(conn).propose(ctx, rejected.revision, requests()); }
    finally { conn.close(); }
    expect(retry.revision).toBe(rejected.revision + 1);
    expect(retry.askId).not.toBe(rejected.askId);
    expect(retry.vectorDigest).toBe(rejected.vectorDigest);
    expect(batch.propose(ctx, retry.revision, requests()).askId).toBe(retry.askId);
    expect(getAsk(db, rejected.askId)).toEqual(before);
    expect(listAsks(db, { project: P, states: ["open"] }).map((a) => a.id)).toEqual([retry.askId]);
    expect(() => batch.verify(ctx, rejected.revision, rejected.askId)).toThrow("取代");
    expect(batch.check(ctx, "ab12-alpha").ok).toBe(false);
    await answer(retry.askId);
    expect(batch.propose(ctx, retry.revision, requests()).askId).toBe(retry.askId);
    batch.verify(ctx, retry.revision, retry.askId);
    expect(batch.check(ctx, "ab12-alpha")).toEqual({ ok: true });
  });

  test("whole-page evidence must reference a screenshot digest on a current UI task", () => {
    const rs = requests();
    rs[0]!.evidence.screenshotsHash = "d".repeat(64);
    expect(() => batch.propose(ctx, 0, rs)).toThrow("截图摘要未关联");
    expect(listAsks(db, { project: P })).toHaveLength(0);
    taskPatch("U-alpha", { extra: { screenshotsDigest: rs[0]!.evidence.screenshotsHash } });
    expect(batch.propose(ctx, 0, rs).entries[0]!.evidence!.screenshotsHash).toBe(rs[0]!.evidence.screenshotsHash);
  });

  test("a verified read can proceed while another WAL connection holds the write lock", async () => {
    await accept();
    const conn = new Database(path);
    db.exec("PRAGMA busy_timeout = 0");
    try {
      conn.exec("BEGIN IMMEDIATE");
      conn.query("UPDATE tasks SET title = 'uncommitted writer' WHERE id = 'U-alpha'").run();
      expect(batch.check(ctx, "ab12-alpha")).toEqual({ ok: true });
    } finally { conn.exec("ROLLBACK"); conn.close(); }
  });

  test("non-manager, wrong caller/project/instance, rejected or expired approval cannot verify any member", async () => {
    expect(() => batch.propose({ ...ctx, actor: "agent-worker" }, 0, requests())).toThrow("PM");
    expect(() => batch.propose({ ...ctx, project: "other" }, 0, requests())).toThrow();
    const s = batch.propose(ctx, 0, requests());
    expect((await answerFromCard(P, s.askId, { choices: ["[button:project_ui_page_approve]"] }, guest("aa11", [PM]))).status).toBe(404);
    expect(getAsk(db, s.askId)?.state).toBe("open");
    await answer(s.askId, false);
    expect(() => batch.verify(ctx, s.revision, s.askId)).toThrow("without approving");
    const s2 = batch.propose(ctx, 1, [{ ...requests(["alpha"])[0]!, evidence: { ...evidence(), relay: "other fixture relay" } }]);
    await answer(s2.askId);
    setMeta(db, { actor: "owner" }, { project: P, key: "pms", value: [PM, "agent-other-pm"] });
    expect(() => batch.verify({ ...ctx, actor: "agent-other-pm" }, s2.revision, s2.askId)).toThrow();
    expect(() => batch.verify({ ...ctx, project: "other" }, s2.revision, s2.askId)).toThrow();
    expect(() => batch.verify({ ...ctx, instanceId: "foreign" }, s2.revision, s2.askId)).toThrow("实例");
    expect(() => batch.verify({ ...ctx, now: getAsk(db, s2.askId)!.expiresAt }, s2.revision, s2.askId)).toThrow("window ended");
    expect(db.query("SELECT COUNT(*) AS n FROM ui_page_members").get()).toEqual({ n: 0 });
  });

  test("expired consumed ask is durable history but revoked/superseded asks are refused", async () => {
    const s = await accept();
    expect(batch.check({ ...ctx, now: getAsk(db, s.askId)!.expiresAt + 100 }, "ab12-alpha")).toEqual({ ok: true });
    db.query("UPDATE asks SET state = 'superseded' WHERE id = ?").run(s.askId);
    expect(batch.check(ctx, "ab12-alpha").ok).toBe(false);
  });

  test("historical evidence stays usable by the project manager after restart or manager handoff", async () => {
    await accept();
    setMeta(db, { actor: "owner" }, { project: P, key: "pms", value: [PM, "agent-next-pm"] });
    expect(batch.check({ ...ctx, actor: "agent-next-pm" }, "ab12-alpha")).toEqual({ ok: true });
    expect(batch.check({ ...ctx, actor: "agent-worker" }, "ab12-alpha").ok).toBe(false);
    const conn = new Database(path);
    try { expect(new UiAcceptanceBatch(conn).check(ctx, "ab12-alpha")).toEqual({ ok: true }); }
    finally { conn.close(); }
  });

  for (const field of ["relay", "device", "productionData", "basis", "ledgerComparison", "screenshotsHash"] as const) {
    test(`missing ${field} cannot create acceptance or owner ask`, () => {
      const rs = requests();
      delete (rs[0]!.evidence as Record<string, unknown>)[field];
      expect(() => batch.propose(ctx, 0, rs)).toThrow();
      expect(listAsks(db, { project: P })).toHaveLength(0);
    });
  }

  test("unbound/unready UI, missing head/hash/spec and duplicate feature ids refuse before owner asks", () => {
    expect(() => batch.propose(ctx, 0, [...requests(), requests()[0]!])).toThrow("重复");
    expect(() => batch.propose(ctx, 0, [])).toThrow("为空");
    taskPatch("U-alpha", { headSHA: null });
    expect(() => batch.propose(ctx, 0, requests())).toThrow("head");
    taskPatch("U-alpha", { headSHA: H, extra: {} });
    expect(() => batch.propose(ctx, 0, requests())).toThrow("截图");
    taskPatch("U-alpha", { extra: { screenshotsDigest: SH } });
    writeFileSync(join(dir, "U-alpha.md"), "");
    expect(() => batch.propose(ctx, 0, requests())).toThrow("规格");
    expect(listAsks(db, { project: P })).toHaveLength(0);
  });

  for (const target of ["vector", "ask-params", "ask-version", "ask-approve", "owner-marker"] as const) {
    test(`${target} drift cannot consume any source`, async () => {
      const s = batch.propose(ctx, 0, requests());
      await answer(s.askId);
      if (target === "vector") {
        const entries = structuredClone(s.entries);
        entries[0]!.evidence!.basis = "tampered fixture";
        db.query("UPDATE ui_page_vectors SET entries = ? WHERE askId = ?").run(JSON.stringify(entries), s.askId);
      } else {
        const a = getAsk(db, s.askId)!;
        if (target === "owner-marker") {
          delete a.answer!.owner;
          db.query("UPDATE asks SET answer = ? WHERE id = ?").run(JSON.stringify(a.answer), a.id);
        } else {
          if (target === "ask-params") (a.bind!.params as Record<string, unknown>).project = "foreign";
          if (target === "ask-version") a.bind!.version = "2";
          if (target === "ask-approve") a.bind!.approve = ["project_ui_page_reject"];
          db.query("UPDATE asks SET bind = ? WHERE id = ?").run(JSON.stringify(a.bind), a.id);
        }
      }
      expect(() => batch.verify(ctx, s.revision, s.askId)).toThrow();
      expect(batch.check(ctx, "ab12-alpha").ok).toBe(false);
    });
  }

  test("raw legacy scope summaries cannot upgrade old PAGEOK to acceptance of a new head", () => {
    const f = getFeature(db, "ab12-alpha")!;
    createTask(db, { actor: "owner" }, { id: "PG", project: P, title: "legacy fixture", kind: "code" });
    bindNode(db, { actor: PM }, { id: f.id, rev: f.rev, key: PAGE_CHECK_KEY, taskId: "PG" });
    db.query("UPDATE tasks SET stage = 'verified' WHERE id = 'PG'").run();
    const rs = [{ featureId: f.id, legacyPageTask: "PG" }];
    expect(() => batch.propose(ctx, 0, rs)).toThrow();
    taskPatch("U-alpha", { headSHA: "c".repeat(40) });
    expect(getTask(db, "PG")!.stage).toBe("verified");
    taskPatch("PG", { extra: { uiPageScopeDigest: digest(batch.snapshot(P, f.id)) } });
    const before = getTask(db, "PG");
    expect(() => batch.propose(ctx, 0, rs)).toThrow("UIACW");
    expect(batch.check(ctx, f.id).ok).toBe(false);
    expect(listAsks(db, { project: P })).toHaveLength(0);
    expect(getTask(db, "PG")).toEqual(before);
  });

  for (const state of ["pending", "verified"] as const) {
    test(`previous-release ${state} legacy vectors are retained but cannot approve a feature`, async () => {
      const s = batch.propose(ctx, 0, requests());
      // Seed the old release's persisted vector, then answer via the real owner API; this never creates production evidence.
      const entries = structuredClone(s.entries);
      entries[0]!.legacy = { taskId: "PG", head: H, specRev: 1, round: 0, digest: digest(entries[0]!.scope) };
      entries[0]!.evidence = null;
      const vectorDigest = digest(entries);
      const a = getAsk(db, s.askId)!;
      (a.bind!.params as Record<string, unknown>).vectorDigest = vectorDigest;
      a.bind!.paramsHash = bindHash(a.bind!, PM);
      db.query("UPDATE asks SET bind = ?, body = 'previous-release legacy fixture' WHERE id = ?").run(JSON.stringify(a.bind), s.askId);
      db.query("UPDATE ui_page_vectors SET entries = ?, vectorDigest = ? WHERE askId = ?").run(JSON.stringify(entries), vectorDigest, s.askId);
      expect((await answer(s.askId)).status).toBe(202);
      if (state === "verified") {
        db.query("UPDATE ui_page_vectors SET state = 'verified', verifiedAt = ? WHERE askId = ?").run(Date.now(), s.askId);
        for (const e of entries) db.query("INSERT INTO ui_page_members VALUES (?, ?, ?, ?)").run(P, e.scope.featureId, s.sourceId, s.revision);
      }
      const before = db.query("SELECT * FROM ui_page_vectors WHERE askId = ?").get(s.askId);
      if (state === "pending") expect(() => batch.verify(ctx, s.revision, s.askId)).toThrow("UIACW");
      expect(batch.check(ctx, "ab12-alpha").ok).toBe(false);
      if (state === "verified") expect(batch.check(ctx, "ab12-beta")).toEqual({ ok: true });
      expect(db.query("SELECT * FROM ui_page_vectors WHERE askId = ?").get(s.askId)).toEqual(before);
    });
  }

  test("foreign authorize ask with same button cannot be used as acceptance source", async () => {
    const s = batch.propose(ctx, 0, requests());
    const a = getAsk(db, s.askId)!;
    const foreign = openAskFull(db, { project: "foreign", source: "system", kind: "authorize", fromAgent: PM, bind: a.bind!,
      title: "foreign fixture", options: a.options }).ask;
    expect(() => batch.verify(ctx, s.revision, foreign.id)).toThrow("错误");
  });
});

function mutate(kind: string): void {
  if (kind === "head") taskPatch("U-alpha", { headSHA: "c".repeat(40) });
  if (kind === "screenshot") taskPatch("U-alpha", { extra: { screenshotsDigest: "c".repeat(64) } });
  if (kind === "files") taskPatch("U-alpha", { extra: { screenshotsDigest: SH, fileGlobs: ["src/changed.ts"] } });
  if (kind === "spec") writeFileSync(join(dir, "U-alpha.md"), "# changed UI fixture\n模板：ui\n");
  if (kind === "specRev" || kind === "round") db.query(`UPDATE tasks SET ${kind} = ${kind} + 1 WHERE id = 'U-alpha'`).run();
  if (kind === "stage") db.query("UPDATE tasks SET stage = 'fix' WHERE id = 'U-alpha'").run();
  if (kind === "dag" || kind === "new-ui") {
    const f = getFeature(db, "ab12-alpha")!;
    const v = getDagVersion(db, "ab12-alpha", 1)!;
    let taskId: string | null = null;
    if (kind === "new-ui") {
      taskId = "U-late";
      createTask(db, { actor: "owner" }, { id: taskId, project: P, title: "late fixture", kind: "code", headSHA: H,
        spec: getTask(db, "U-alpha")!.spec, extra: { screenshotsDigest: SH } });
      db.query("UPDATE tasks SET stage = 'live' WHERE id = ?").run(taskId);
      db.query(`INSERT INTO task_workflows (taskId, project, template, templateVersion, mode, authorFamily, fallback, specRev, createdAt, updatedAt)
        VALUES (?, ?, 'ui', 3, 'manual', 'claude', 'fixture', 1, 1, 1)`).run(taskId, P);
    }
    rewriteDag(db, { actor: PM }, { id: f.id, rev: f.rev, nodes: [...effectiveNodes(db, v), { key: "LATE", taskId, oneLine: "late fixture", deps: [] }],
      reasonKind: "new_issue", reasonText: "fixture scope drift", cancel: new Map(), scopeChange: false, askFrom: { agent: PM, channelId: "proof-pm" } });
  }
}

for (const revision of [0, 1]) test(`two isolated processes racing composition revision ${revision} leave exactly one owner card`, async () => {
  const old = revision === 1 ? batch.propose(ctx, 0, requests()) : null;
  const rs = requests().map((r) => ({ ...r, evidence: { ...r.evidence, basis: `composition fixture ${revision}` } }));
  const code = `import { Database } from 'bun:sqlite';
    import { UiAcceptanceBatch } from './src/lib/ui-acceptance-batch.ts';
    const db = new Database(${JSON.stringify(path)}); db.run('PRAGMA busy_timeout=5000');
    try { new UiAcceptanceBatch(db).propose(${JSON.stringify(ctx)}, ${revision}, ${JSON.stringify(rs)}); console.log('accepted'); }
    catch(e) { console.log(e.message); } finally { db.close(); }`;
  const run = async () => {
    const proc = Bun.spawn([process.execPath, "--no-env-file", "--config=/dev/null", "-e", code], {
      cwd: process.cwd(), env: testChildEnv({ CLAUDESTRA_STATE_DIR: dir }), stdout: "pipe", stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    const err = await new Response(proc.stderr).text();
    expect(await proc.exited).toBe(0);
    expect(err).toBe("");
    return out.trim();
  };
  const results = await Promise.all([run(), run()]);
  expect(results.filter((x) => x === "accepted")).toHaveLength(1);
  expect(results.filter((x) => x.includes("CAS"))).toHaveLength(1);
  expect(listAsks(db, { project: P, states: ["open"] })).toHaveLength(1);
  expect(db.query("SELECT revision FROM ui_page_batch WHERE project = ?").get(P)).toEqual({ revision: revision + 1 });
  if (old) expect(getAsk(db, old.askId)?.state).toBe("cancelled");
});

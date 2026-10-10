/**
 * UIACW：项目整页验收源接到 setFeature(done) 完成闸与 ledger CLI。临时状态目录 + 临时台账，owner 作答走真实 answerFromCard；
 * 合成证据只测闸，不碰生产台账、不伪造 owner 作答、不 raw 改 PAGEOK / 事件。
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { answerFromCard } from "../src/bridge/ask-entry.js";
import { setAsksForTest } from "../src/bridge/asks.js";
import { getAsk, listAsks } from "../src/lib/ledger-asks.js";
import { rewriteDag } from "../src/lib/ledger-dag-write.js";
import { effectiveNodes, getDagVersion, getFeature } from "../src/lib/ledger-feature.js";
import { createFeature, initDag, setFeature } from "../src/lib/ledger-feature-write.js";
import { closeLedger, getTask, openLedger } from "../src/lib/ledger-store.js";
import { createTask, setMeta, setTask } from "../src/lib/ledger-write.js";
import { UiAcceptanceBatch } from "../src/lib/ui-acceptance-batch.js";
import { installPageBatchCheck, pageModePath, readPageMode } from "../src/lib/ui-acceptance-batch-wiring.js";
import { PAGE_CHECK_KEY, requirePageCheck } from "../src/lib/ui-acceptance.js";
import { runLedger } from "../src/manager/ledger.js";
import { guest, owner, PEER } from "./asks-test-kit.js";
import { testChildEnv } from "./test-env.js";

const P = "proof", PM = "agent-pm", H = "a".repeat(40), SH = "b".repeat(64);
const A = "ab12-alpha", B = "ab12-beta";
const evidence = () => ({ relay: "fixture relay", device: { width: 390, height: 844, theme: "dark" },
  productionData: "fixture production reference", basis: "fixture same-screen baseline", ledgerComparison: "fixture title/count/status/order", screenshotsHash: SH });
let db: Database, path: string, dir: string;

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
  dir = mkdtempSync(join(tmpdir(), "ui-batch-wiring-"));
  path = join(dir, "ledger.sqlite");
  mkdirSync(join(dir, "ledger", "docs", "tasks"), { recursive: true });
  db = openLedger(path);
  db.query("INSERT INTO ledger_instance (key, value) VALUES ('origin', 'ab12')").run();
  setMeta(db, { actor: "owner" }, { project: P, key: "pms", value: [PM] });
  fixtureFeature("alpha");
  fixtureFeature("beta");
  setAsksForTest({ path, registry: [{ name: PM, projectId: P, channelId: "proof-pm" } as never], ownerChats: ["api:owner:self"],
    deps: { clients: new Map([["proof-pm", { ws: {} as never }]]), controlChannelId: "proof-master", hold: () => {},
      deliver: async (env) => ({ envelope: env, outcome: { kind: "sent" } }) } });
});
afterEach(() => {
  setAsksForTest(undefined);
  closeLedger(path);
  rmSync(dir, { recursive: true, force: true });
  rmSync(pageModePath(), { force: true });
});

const cli = (args: string[], actor = PM, now = () => Date.now(), conn = db) => runLedger(args, {
  db: conn, actor, actorProject: P, projectIds: [P, "other"], now,
  loadRegistry: async () => ({ socket: "", agents: { [PM]: { channelId: "proof-pm" } } }) as never, saveRegistry: async () => {},
}) as Promise<Record<string, any>>;
function evidenceFile(verdicts: Record<string, "approve" | "reject"> = {}, ids = [A, B]): string {
  const file = join(dir, `evidence-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify(Object.fromEntries(ids.map((id) => [id, { evidence: evidence(), verdict: verdicts[id] ?? "approve" }]))));
  return file;
}
const propose = (rev: number, file = evidenceFile(), ids = [A, B], actor = PM) =>
  cli(["ui-page-propose", "--features", ids.join(","), "--expect-rev", String(rev), "--evidence", file], actor);
const answer = (askId: string, approve = true, who = owner()) =>
  answerFromCard(P, askId, { choices: [`[button:project_ui_page_${approve ? "approve" : "reject"}]`] }, who);
async function accept(rev = 0, file = evidenceFile(), ids = [A, B]) {
  const s = await propose(rev, file, ids);
  expect(s.ok).toBe(true);
  expect((await answer(s.askId)).status).toBe(202);
  const v = await cli(["ui-page-verify", "--rev", String(s.revision), "--ask", s.askId]);
  expect(v).toMatchObject({ ok: true, state: "verified" });
  return v;
}
function done(id: string, now?: number, conn = db) {
  const f = getFeature(conn, id)!;
  return setFeature(conn, { actor: PM, ...(now ? { now } : {}) }, { id, rev: f.rev, patch: { status: "done" } });
}
const mainError = (id: string) => { try { requirePageCheck(db, getFeature(db, id)!); } catch (e) { return (e as Error).message; } return null; };
const taskPatch = (id: string, patch: Parameters<typeof setTask>[2]["patch"]) => setTask(db, { actor: "owner" }, { id, rev: getTask(db, id)!.rev, patch });
const setMode = async (mode: string) => expect(await cli(["ui-page-mode", mode])).toMatchObject({ ok: true, mode });

describe("UIACW 完成闸接线", () => {
  test("1 旧红新绿：mode=on 一张 owner 卡批两个 feature，verify 后两个都能 done；原闸仍拒", async () => {
    await setMode("on");
    const v = await accept();
    expect(v.features.map((f: { featureId: string }) => f.featureId)).toEqual([A, B]);
    for (const id of [A, B]) {
      expect(mainError(id)).toContain(PAGE_CHECK_KEY); // main 的 requirePageCheck 在同一状态下拒
      expect(done(id).row.status).toBe("done");
    }
    const st = await cli(["ui-page-status"]);
    expect(st).toMatchObject({ ok: true, mode: "on", source: { revision: 1, state: "verified" } });
    expect(JSON.stringify(st)).not.toContain("fixture relay"); // 私有证据不进状态输出
  });

  test("2 off / observe 不变：已有 verified 源也要 PAGEOK，错误逐字同原闸，不调 check、不写源表", async () => {
    await setMode("on");
    await accept();
    const tables = () => db.query("SELECT * FROM ui_page_vectors").all().concat(db.query("SELECT * FROM ui_page_members").all());
    const before = JSON.stringify(tables());
    const spy = spyOn(UiAcceptanceBatch.prototype, "check");
    try {
      for (const mode of ["off", "observe"]) {
        await setMode(mode);
        for (const id of [A, B]) expect(() => done(id)).toThrow(mainError(id)!);
        try { done(A); } catch (e) { expect((e as Error).message).toBe(mainError(A)!); }
        const st = await cli(["ui-page-status"]);
        expect(st.diagnostics.length).toBeLessThanOrEqual(1);
      }
      expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
    expect(JSON.stringify(tables())).toBe(before);
    // init 生成的节点与开关无关（init / rewrite 不经本接线）
    const nodes: string[] = [];
    for (const [i, mode] of ["on", "off", "observe"].entries()) {
      await setMode(mode);
      fixtureFeature(`g${i}`);
      nodes.push((db.query("SELECT nodes FROM dag_versions WHERE featureId = ?").get(`ab12-g${i}`) as { nodes: string }).nodes.replaceAll(`g${i}`, "X"));
    }
    expect(new Set(nodes).size).toBe(1);
    expect(nodes[0]).toContain(PAGE_CHECK_KEY);
  });

  test("2b observe 缺省 / 读坏：只出有界诊断，不建源表；读坏拒绝改开关", async () => {
    expect(readPageMode(P)).toEqual({ mode: "observe" });
    const st = await cli(["ui-page-status"]);
    expect(st).toMatchObject({ ok: true, mode: "observe", source: null });
    expect(st.diagnostics).toHaveLength(1);
    expect(await propose(0)).toMatchObject({ ok: false, error: expect.stringContaining("observe/off") });
    writeFileSync(pageModePath(), "{bad");
    expect(readPageMode(P).mode).toBe("observe");
    expect((await cli(["ui-page-status"])).diagnostics[0]).toContain("读坏");
    expect(await cli(["ui-page-mode", "on"])).toMatchObject({ ok: false, code: "conflict" });
    expect(() => done(A)).toThrow(mainError(A)!);
    expect(db.query("SELECT name FROM sqlite_master WHERE name = 'ui_page_batch'").get()).toBeNull();
  });

  test("3 非 owner：guest / peer 作答、非 manager 跑开关 / propose / verify 都拒，任何 feature 不放行", async () => {
    expect(await cli(["ui-page-mode", "on"], "agent-worker")).toMatchObject({ ok: false, code: "forbidden" });
    await setMode("on");
    expect(await propose(0, evidenceFile(), [A, B], "agent-worker")).toMatchObject({ ok: false, code: "forbidden" });
    const s = await propose(0);
    expect((await answer(s.askId, true, guest("aa11", [PM]))).status).not.toBe(202);
    expect((await answer(s.askId, true, PEER)).status).not.toBe(202);
    expect(getAsk(db, s.askId)?.state).toBe("open");
    expect(await cli(["ui-page-verify", "--rev", "1", "--ask", s.askId])).toMatchObject({ ok: false, error: expect.stringContaining("owner") });
    await answer(s.askId);
    expect(await cli(["ui-page-verify", "--rev", "1", "--ask", s.askId], "agent-worker")).toMatchObject({ ok: false, code: "forbidden" });
    for (const id of [A, B]) expect(() => done(id)).toThrow("项目整页验收源也未放行");
  });

  test("4 过期：消费前过期 verify 拒；已 verify 源 7 天后仍有效，卡 cancelled / superseded 后拒", async () => {
    await setMode("on");
    const s = await propose(0);
    await answer(s.askId);
    const exp = getAsk(db, s.askId)!.expiresAt;
    const late = await runLedger(["ui-page-verify", "--rev", "1", "--ask", s.askId], { db, actor: PM, actorProject: P, projectIds: [P], now: () => exp,
      loadRegistry: async () => ({ socket: "", agents: {} }) as never, saveRegistry: async () => {} });
    expect(late).toMatchObject({ ok: false });
    expect(await cli(["ui-page-verify", "--rev", "1", "--ask", s.askId])).toMatchObject({ ok: true, state: "verified" });
    expect(done(A, exp + 100).row.status).toBe("done");
    db.query("UPDATE asks SET state = 'cancelled' WHERE id = ?").run(s.askId);
    expect(() => done(B)).toThrow("项目整页验收源也未放行");
    db.query("UPDATE asks SET state = 'superseded' WHERE id = ?").run(s.askId);
    expect(() => done(B)).toThrow("项目整页验收源也未放行");
  });

  test("5 重复：同向量复用卡、同 expect-rev 只一个成功、verify 二次拒、重启后仍一个有效源", async () => {
    await setMode("on");
    const file = evidenceFile();
    const s = await propose(0, file);
    expect(await propose(0, file)).toMatchObject({ ok: false, error: expect.stringContaining("CAS") });
    expect((await propose(1, file)).askId).toBe(s.askId);
    await answer(s.askId);
    expect((await cli(["ui-page-verify", "--rev", "1", "--ask", s.askId])).ok).toBe(true);
    expect(await cli(["ui-page-verify", "--rev", "1", "--ask", s.askId])).toMatchObject({ ok: false, error: expect.stringContaining("重复") });
    const conn = new Database(path);
    try {
      conn.run("PRAGMA busy_timeout = 5000");
      expect((await cli(["ui-page-check", A], PM, () => Date.now(), conn))).toMatchObject({ ok: true, pass: true });
      expect(done(A, undefined, conn).row.status).toBe("done");
    } finally { conn.close(); }
    expect(listAsks(db, { project: P, states: ["open"] })).toHaveLength(0);
    expect(db.query("SELECT COUNT(*) AS n FROM ui_page_batch").get()).toEqual({ n: 1 });
  });

  test("6 参数漂移：消费前漂移整笔拒；verify 后只 A 漂移 → A done 拒（含漂移），B 仍可 done", async () => {
    await setMode("on");
    const s = await propose(0);
    await answer(s.askId);
    taskPatch("U-alpha", { headSHA: "c".repeat(40) });
    expect(await cli(["ui-page-verify", "--rev", "1", "--ask", s.askId])).toMatchObject({ ok: false, error: expect.stringContaining("漂移") });
    expect(db.query("SELECT COUNT(*) AS n FROM ui_page_members").get()).toEqual({ n: 0 });
    await accept(1);
    for (const drift of [() => taskPatch("U-alpha", { headSHA: "d".repeat(40) }), () => db.query("UPDATE tasks SET round = round + 1 WHERE id = 'U-alpha'").run(),
      () => taskPatch("U-alpha", { extra: { screenshotsDigest: "e".repeat(64) } }), () => writeFileSync(join(dir, "U-alpha.md"), "# changed\n模板：ui\n")]) {
      drift();
      expect(() => done(A)).toThrow("漂移");
    }
    expect(done(B).row.status).toBe("done");
  });

  test("7 晚新增 UI：verify 后给 A 加 UI 节点 → A 失效、PAGEOK 依赖照常重建；不在向量的新 UI feature 未实际验收", async () => {
    await setMode("on");
    await accept();
    const f = getFeature(db, A)!;
    createTask(db, { actor: "owner" }, { id: "U-late", project: P, title: "late", kind: "code", headSHA: H, spec: getTask(db, "U-alpha")!.spec, extra: { screenshotsDigest: SH } });
    db.query(`INSERT INTO task_workflows (taskId, project, template, templateVersion, mode, authorFamily, fallback, specRev, createdAt, updatedAt)
      VALUES ('U-late', ?, 'ui', 3, 'manual', 'claude', 'fixture', 1, 1, 1)`).run(P);
    rewriteDag(db, { actor: PM }, { id: f.id, rev: f.rev, nodes: [...effectiveNodes(db, getDagVersion(db, A, 1)!), { key: "LATE", taskId: "U-late", oneLine: "late", deps: [] }],
      reasonKind: "new_issue", reasonText: "fixture late ui", cancel: new Map(), scopeChange: false, askFrom: { agent: PM, channelId: "proof-pm" } });
    const cur = getFeature(db, A)!;
    expect(effectiveNodes(db, getDagVersion(db, A, cur.currentVersion)!).find((n) => n.key === PAGE_CHECK_KEY)?.deps).toEqual(["LATE", "UI"]);
    expect(() => done(A)).toThrow(PAGE_CHECK_KEY);
    fixtureFeature("gamma");
    expect(() => done("ab12-gamma")).toThrow("未实际验收");
    expect(done(B).row.status).toBe("done");
  });

  test("8 部分拒绝：A approve / B reject → A 可 done、B 拒；owner 点拒绝本次验收 → 全部不放行", async () => {
    await setMode("on");
    const s = await propose(0, evidenceFile({ [B]: "reject" }));
    await answer(s.askId, false);
    expect((await cli(["ui-page-verify", "--rev", "1", "--ask", s.askId])).ok).toBe(false);
    for (const id of [A, B]) expect(() => done(id)).toThrow("项目整页验收源也未放行");
    await accept(1, evidenceFile({ [B]: "reject" }));
    expect(done(A).row.status).toBe("done");
    expect(() => done(B)).toThrow("feature 验收拒绝");
  });

  test("9 错误实例 / 项目：拒", async () => {
    await setMode("on");
    expect(await cli(["ui-page-mode", "on", "--project", "other"])).toMatchObject({ ok: false, code: "forbidden" });
    expect(await cli(["ui-page-mode", "on", "--project", "other"], "owner")).toMatchObject({ ok: true });
    expect(await cli(["ui-page-propose", "--project", "other", "--features", A, "--expect-rev", "0", "--evidence", evidenceFile({}, [A])], "owner"))
      .toMatchObject({ ok: false, error: expect.stringContaining("不在当前项目") });
    await accept();
    expect(await cli(["ui-page-check", A, "--project", "other"])).toMatchObject({ ok: true, pass: false });
    db.query("UPDATE ui_page_batch SET instanceId = 'foreign-instance' WHERE project = ?").run(P);
    expect(() => done(A)).toThrow("实例");
  });

  test("未注入源查询的进程：mode=on 也只走原闸拒，不放行", async () => {
    await setMode("on");
    await accept();
    installPageBatchCheck(null);
    try { expect(() => done(A)).toThrow("本进程未接入项目验收源"); }
    finally { installPageBatchCheck((d, c, id) => new UiAcceptanceBatch(d).check(c, id)); }
    expect(done(A).row.status).toBe("done");
  });

  test("CLI 参数：evidence 多出 / 缺 feature、非整数版本、未知开关都拒", async () => {
    await setMode("on");
    expect(await propose(0, evidenceFile({}, [A, B]), [A])).toMatchObject({ ok: false, error: expect.stringContaining("不在 --features") });
    expect(await propose(0, evidenceFile({}, [A]), [A, B])).toMatchObject({ ok: false, error: expect.stringContaining("缺 feature") });
    expect(await cli(["ui-page-propose", "--features", A, "--expect-rev", "x", "--evidence", evidenceFile({}, [A])])).toMatchObject({ ok: false, code: "invalid" });
    expect(await cli(["ui-page-mode", "maybe"])).toMatchObject({ ok: false, code: "invalid" });
    expect(listAsks(db, { project: P })).toHaveLength(0);
  });
});

describe("ui-page-mode 开关写入（审查 mode-race / mode-audit 回归）", () => {
  const noteCount = () => (db.query("SELECT COUNT(*) AS n FROM events WHERE project = ? AND kind = 'note'").get(P) as { n: number }).n;

  test("重试旧的 --dedup 开启请求：返回 duplicate，不撤销后来的关闭；同键换值 = dedup_mismatch", async () => {
    expect(await cli(["ui-page-mode", "on", "--dedup", "first-on"])).toMatchObject({ ok: true, duplicate: false });
    expect(await cli(["ui-page-mode", "off", "--dedup", "later-off"])).toMatchObject({ ok: true, duplicate: false, previous: "on" });
    const n = noteCount();
    expect(await cli(["ui-page-mode", "on", "--dedup", "first-on"])).toMatchObject({ ok: true, duplicate: true });
    expect(readPageMode(P).mode).toBe("off");
    expect(await cli(["ui-page-mode", "observe", "--dedup", "first-on"])).toMatchObject({ ok: false, code: "dedup_mismatch" });
    expect(readPageMode(P).mode).toBe("off");
    expect(noteCount()).toBe(n);
  });

  test("台账写锁被别的连接占着：返回 busy，事件与开关文件都不变", async () => {
    await setMode("off");
    const n = noteCount();
    const other = new Database(path);
    const conn = new Database(path);
    conn.exec("PRAGMA busy_timeout = 1");
    other.exec("BEGIN IMMEDIATE");
    try {
      expect(await cli(["ui-page-mode", "on"], PM, () => Date.now(), conn)).toMatchObject({ ok: false, code: "busy" });
    } finally { other.exec("ROLLBACK"); other.close(); conn.close(); }
    expect(readPageMode(P).mode).toBe("off");
    expect(noteCount()).toBe(n);
  });

  test("16 个进程同时给不同项目切 on：锁内重读合并，一个都不丢", async () => {
    writeFileSync(pageModePath(), JSON.stringify({ projects: { keep: "off" } }));
    const code = `const { openLedger } = await import('./src/lib/ledger-store.ts');
      const { writePageMode } = await import('./src/lib/ui-acceptance-batch-wiring.ts');
      const db = openLedger(process.argv[1]);
      writePageMode(db, process.argv[2], 'on', () => ({ duplicate: false }));`;
    const procs = Array.from({ length: 16 }, (_, i) => Bun.spawn([process.execPath, "--no-env-file", "--config=/dev/null", "-e", code, path, `p${i}`], {
      cwd: process.cwd(), env: testChildEnv({ CLAUDESTRA_STATE_DIR: join(pageModePath(), "..") }), stdout: "pipe", stderr: "pipe",
    }));
    const codes = await Promise.all(procs.map(async (p) => [await p.exited, await new Response(p.stderr).text()]));
    expect(codes.filter(([c]) => c !== 0)).toEqual([]);
    const projects = JSON.parse(readFileSync(pageModePath(), "utf-8")).projects;
    expect(Object.keys(projects)).toHaveLength(17);
    expect(projects.keep).toBe("off");
    for (let i = 0; i < 16; i++) expect(projects[`p${i}`]).toBe("on");
  }, 30_000);
});

for (const first of ["lib/ledger-feature-write", "lib/ui-acceptance-batch-wiring", "lib/ui-acceptance-batch", "manager/ledger-ui-acceptance"]) {
  test(`冷启动先导入 ${first}：导入环不炸，完成闸可调`, async () => {
    const code = `await import('./src/${first}.ts');
      const w = await import('./src/lib/ui-acceptance-batch-wiring.ts');
      const f = await import('./src/lib/ledger-feature-write.ts');
      const b = await import('./src/lib/ui-acceptance-batch.ts');
      console.log([typeof w.requirePageCheckOrBatch, typeof f.setFeature, typeof b.UiAcceptanceBatch, typeof w.withPageCheck].join(','));`;
    const proc = Bun.spawn([process.execPath, "--no-env-file", "--config=/dev/null", "-e", code], {
      cwd: process.cwd(), env: testChildEnv({ CLAUDESTRA_STATE_DIR: dir }), stdout: "pipe", stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    const err = await new Response(proc.stderr).text();
    expect(await proc.exited).toBe(0);
    expect(err).toBe("");
    expect(out.trim()).toBe("function,function,function,function");
  });
}

/**
 * UIAC2：凭项目整页验收源 done 的 feature，PAGEOK 在 dag-show / show_dag / 协作 DAG 看板 / feature 详情 / 产品板按完成显示。
 * 夹具同 tests/ui-acceptance-batch-wiring.test.ts：临时状态目录 + 临时台账，owner 作答走真实 answerFromCard；PM 手动 ui-page-verify。
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { answerFromCard } from "../src/bridge/ask-entry.js";
import { onAsk, setAsksForTest } from "../src/bridge/asks.js";
import type { Ask } from "../src/lib/ledger-asks.js";
import { boardContext, boardNodes, dagBoard } from "../src/lib/ledger-dag-board.js";
import { nodePhase } from "../src/lib/ledger-dag-rules.js";
import { featureDetail } from "../src/lib/ledger-dag-board-history.js";
import { dagSnapshot } from "../src/lib/ledger-dag-view.js";
import { bindNode, rewriteDag } from "../src/lib/ledger-dag-write.js";
import { effectiveNodes, getDagVersion, getFeature, projectNodes } from "../src/lib/ledger-feature.js";
import { createFeature, initDag, setFeature } from "../src/lib/ledger-feature-write.js";
import { nodeCounts, productBoard } from "../src/lib/ledger-product-board.js";
import { closeLedger, getTask, openLedger } from "../src/lib/ledger-store.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import { pageModePath } from "../src/lib/ui-acceptance-batch-wiring.js";
import { PAGE_CHECK_KEY, requirePageCheck } from "../src/lib/ui-acceptance.js";
import { runLedger } from "../src/manager/ledger.js";
import { owner } from "./asks-test-kit.js";

const P = "proof", PM = "agent-pm", H = "a".repeat(40), SH = "b".repeat(64), NOW = 1_800_000_000_000;
const A = "ab12-alpha", B = "ab12-beta";
const evidence = () => ({ relay: "fixture relay", device: { width: 390, height: 844, theme: "dark" },
  productionData: "fixture production reference", basis: "fixture same-screen baseline", ledgerComparison: "fixture title/count/status/order", screenshotsHash: SH });
let db: Database, path: string, dir: string, answered: Ask[], unsubscribe: () => void;

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
  dir = mkdtempSync(join(tmpdir(), "ui-page-display-"));
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
  // 只听不消费：owner 答复照常投回 PM，监听只记下 answered，证明没有任何代码替 PM 跑 verify
  answered = [];
  unsubscribe = onAsk((a) => { if (a.state === "answered") answered.push(a); });
});
afterEach(() => {
  unsubscribe();
  setAsksForTest(undefined);
  closeLedger(path);
  rmSync(dir, { recursive: true, force: true });
  rmSync(pageModePath(), { force: true });
});

const cli = (args: string[], actor = PM) => runLedger(args, {
  db, actor, actorProject: P, projectIds: [P], now: () => Date.now(),
  loadRegistry: async () => ({ socket: "", agents: { [PM]: { channelId: "proof-pm" } } }) as never, saveRegistry: async () => {},
}) as Promise<Record<string, any>>;
function evidenceFile(ids = [A, B]): string {
  const file = join(dir, `evidence-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify(Object.fromEntries(ids.map((id) => [id, { evidence: evidence(), verdict: "approve" }]))));
  return file;
}
const setMode = async (mode: string) => expect(await cli(["ui-page-mode", mode])).toMatchObject({ ok: true, mode });
/** 整条手动路径：PM propose → owner 真实点批准 → PM verify */
async function accept(ids = [A, B]) {
  const s = await cli(["ui-page-propose", "--features", ids.join(","), "--expect-rev", "0", "--evidence", evidenceFile(ids)]);
  expect(s).toMatchObject({ ok: true, state: "pending" });
  expect(s.next).toContain(`ui-page-verify --rev ${s.revision} --ask ${s.askId}`);
  expect((await answerFromCard(P, s.askId, { choices: ["[button:project_ui_page_approve]"] }, owner())).status).toBe(202);
  expect(answered.map((a) => a.id)).toContain(s.askId);
  expect((await cli(["ui-page-status"])).source.state).toBe("pending"); // 没有自动消费
  expect(await cli(["ui-page-verify", "--rev", String(s.revision), "--ask", s.askId])).toMatchObject({ ok: true, state: "verified" });
  expect((await cli(["ui-page-status"])).source).toMatchObject({ revision: s.revision, state: "verified" });
}
/** UI 卡 live → verified（PM 验收截图后），scope 不含 stage，不算漂移 */
const uiVerified = (...ids: string[]) => { for (const id of ids) db.query("UPDATE tasks SET stage = 'verified' WHERE id = ?").run(`U-${id.slice(5)}`); };
function done(id: string) {
  const f = getFeature(db, id)!;
  return setFeature(db, { actor: PM }, { id, rev: f.rev, patch: { status: "done" } });
}
const mainError = (id: string) => { try { requirePageCheck(db, getFeature(db, id)!); } catch (e) { return (e as Error).message; } return null; };

/** 各显示面的 PAGEOK */
function views(id: string) {
  const f = getFeature(db, id)!;
  const snap = dagSnapshot(db, f).version.nodes.find((n) => n.key === PAGE_CHECK_KEY)!;
  const card = dagBoard(db, P, NOW).features.find((x) => x.id === id)!;
  const detail = featureDetail(db, f, undefined, NOW);
  const prod = productBoard(db, P, NOW).features.find((x) => x.id === id)!;
  return { f, snap, card, board: card.nodes.find((n) => n.key === PAGE_CHECK_KEY)!, detail: detail.snapshot!.nodes.find((n) => n.key === PAGE_CHECK_KEY)!, prod };
}
/** main 的算法（不叠加）：projectNodes 原样、看板阶段按卡、产品板计数按卡 */
function mainViews(id: string) {
  const f = getFeature(db, id)!;
  const nodes = projectNodes(db, effectiveNodes(db, getDagVersion(db, f.id, f.currentVersion)!));
  const own = (taskId: string | null) => (taskId ? getTask(db, taskId) : null);
  return { nodes, phases: nodes.map((n) => nodePhase(n.taskId, own(n.taskId)?.stage ?? null)),
    counts: nodeCounts(effectiveNodes(db, getDagVersion(db, f.id, f.currentVersion)!).map((n) => ({ ...n, task: own(n.taskId) }))) };
}
function expectSameAsMain(id: string) {
  const m = mainViews(id), v = views(id);
  expect(dagSnapshot(db, v.f).version.nodes).toEqual(m.nodes);
  expect(v.card.nodes.map((n) => n.phase)).toEqual(m.phases);
  expect(v.detail.acceptedBy).toBeUndefined();
  expect(v.prod.counts).toEqual(m.counts);
}

describe("UIAC2 PAGEOK 按项目验收源显示完成", () => {
  test("[验收线 1] A 凭源 done → 各显示面 PAGEOK 完成；B 源 verified 未 done 仍 idle", async () => {
    await setMode("on");
    await accept();
    uiVerified(A, B);
    expect(done(A).row.status).toBe("done");
    const a = views(A);
    expect(a.snap).toMatchObject({ satisfied: true, ready: false, acceptedBy: "project_source", status: "planned", taskId: null });
    expect(a.board).toMatchObject({ phase: "done", acceptedBy: "project_source" });
    expect(a.card.counts.done).toBe(a.card.nodes.length);
    expect(a.detail).toMatchObject({ phase: "done", acceptedBy: "project_source" });
    expect(a.prod.counts.completed).toBe(a.prod.counts.total);
    expect(a.prod.eta).toMatchObject({ done: true });
    // dag-show（CLI）同一份快照
    const show = await cli(["dag-show", A]);
    expect(show.version.nodes.find((n: { key: string }) => n.key === PAGE_CHECK_KEY)).toMatchObject({ acceptedBy: "project_source", satisfied: true });
    const b = views(B);
    expect(b.snap.acceptedBy).toBeUndefined();
    expect(b.board.phase).toBe("idle");
    expect(b.prod.counts.completed).toBe(b.prod.counts.total - 1);
    expect(b.prod.eta?.done).toBe(false);
    expectSameAsMain(B);
  });

  test("[验收线 1] A done 后重写出新版本 → 新版 PAGEOK 回到 idle，产品板少 1；按旧版本号看也不叠加", async () => {
    await setMode("on");
    await accept();
    uiVerified(A);
    done(A);
    const f = getFeature(db, A)!;
    const r = rewriteDag(db, { actor: PM }, { id: f.id, rev: f.rev, nodes: [...effectiveNodes(db, getDagVersion(db, A, 1)!), { key: "DOC", taskId: null, oneLine: "doc", deps: [] }],
      reasonKind: "new_issue", reasonText: "fixture doc node", cancel: new Map(), scopeChange: false, askFrom: { agent: PM, channelId: "proof-pm" } });
    expect(r.row.proposal).toBeNull();
    const cur = getFeature(db, A)!;
    expect(cur.currentVersion).toBe(2);
    const v = views(A);
    expect(v.snap.acceptedBy).toBeUndefined();
    expect(v.board.phase).toBe("idle");
    expect(v.prod.counts.completed).toBe(v.prod.counts.total - 2); // DOC 与 PAGEOK 都没完成
    expectSameAsMain(A);
    expect(dagSnapshot(db, cur, 1).version.nodes.find((n) => n.key === PAGE_CHECK_KEY)?.acceptedBy).toBeUndefined();
  });

  test("[验收线 1] PAGEOK 绑卡 verified 的老路径、没有源表的库：显示与 main 相同", async () => {
    expect(db.query("SELECT 1 FROM sqlite_master WHERE name = 'ui_page_members'").get()).toBeNull();
    expectSameAsMain(A);
    expectSameAsMain(B);
    createTask(db, { actor: "owner" }, { id: "PG-alpha", project: P, title: "page", kind: "code", headSHA: H });
    const f = getFeature(db, A)!;
    bindNode(db, { actor: PM }, { id: A, rev: f.rev, key: PAGE_CHECK_KEY, taskId: "PG-alpha" });
    db.query("UPDATE tasks SET stage = 'verified' WHERE id = 'PG-alpha'").run();
    expect(done(A).row.status).toBe("done");
    expectSameAsMain(A);
    const v = views(A);
    expect(v.board.phase).toBe("done");
    expect(v.snap).toMatchObject({ taskId: "PG-alpha", status: "verified" });
    expect(v.snap.acceptedBy).toBeUndefined();
    // 有源表、A 也是源成员：绑卡的 PAGEOK 仍按卡显示
    await setMode("on");
    await accept([B]);
    expectSameAsMain(A);
  });

  test("[验收线 2] 整条手动路径：两个 feature 都能 done；observe / off 的报错与 main 逐字相同", async () => {
    await setMode("on");
    await accept();
    uiVerified(A, B);
    for (const id of [A, B]) expect(done(id).row.status).toBe("done");
    for (const id of [A, B]) {
      const v = views(id);
      expect(v.snap.acceptedBy).toBe("project_source");
      expect(v.prod.counts.completed).toBe(v.prod.counts.total);
    }
    fixtureFeature("gamma");
    for (const mode of ["observe", "off"]) {
      await setMode(mode);
      const msg = mainError("ab12-gamma")!;
      expect(msg).toContain(PAGE_CHECK_KEY);
      let got: string | null = null;
      try { done("ab12-gamma"); } catch (e) { got = (e as Error).message; }
      expect(got).toBe(msg);
    }
  });
});

test("boardNodes 不认 acceptedBy 以外的东西：普通未绑卡节点仍 idle", () => {
  const f = getFeature(db, A)!;
  const nodes = boardNodes(boardContext(db, P, NOW), dagSnapshot(db, f).version.nodes);
  expect(nodes.find((n) => n.key === PAGE_CHECK_KEY)?.phase).toBe("idle");
});

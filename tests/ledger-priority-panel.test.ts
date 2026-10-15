import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import { createFeature, initDag } from "../src/lib/ledger-feature-write.js";
import { answerAsk, getAsk, openAsk, type AskAnswer } from "../src/lib/ledger-asks.js";
import { readPriority, readPriorityOrder, priorityHistory } from "../src/lib/ledger-priority-read.js";
import { setPriority, setPriorityMode } from "../src/lib/ledger-priority-write.js";
import { priorityPanel, panelResult } from "../src/lib/ledger-priority-panel.js";
import { panelAsk, preparePriorityPanelAnswer } from "../src/lib/ledger-priority-panel-write.js";

let db: Database;
const project = "prio", feature = "ab12-work", now = 10000;
const evidence = { ownerWords: "现在做", ownerAt: 1000, sourceRef: "owner:1" };
const target = { kind: "task" as const, id: "T1" };
const answer: AskAnswer = { choices: ["[button:priority_apply]"], labels: ["改为接着做"], text: "owner 原话", principal: "owner:self",
  owner: true, via: "web_card", at: now + 1, final: true };
function mode(value: "off" | "observe" | "on", rev = 0) {
  setPriorityMode(db, { actor: "owner", project, dedupKey: crypto.randomUUID() }, { mechanism: "priorityPanel", mode: value, rev, evidence });
}
function request(operation: "set" | "clear" | "up" | "down" = "set") {
  const snapshot = priorityPanel(db, project, now);
  return openAsk(db, panelAsk(db, project, { target, rev: readPriority(db, project, target).rev,
    operation, band: "next", snapshot: snapshot.version, observedAt: now }, now), now);
}
function apply(a: ReturnType<typeof request>, response = answer) {
  return answerAsk(db, a.id, response, preparePriorityPanelAnswer(db, a, response));
}
beforeEach(() => {
  db = openLedger(":memory:");
  db.query("INSERT INTO ledger_instance(key,value) VALUES ('origin','ab12')").run();
  setMeta(db, { actor: "owner" }, { project, key: "pms", value: ["pm"] });
  createTask(db, { actor: "owner", now: 1000 }, { project, id: "T1", title: "任务", kind: "code" });
  createTask(db, { actor: "owner", now: 1000 }, { project, id: "T2", title: "另一任务", kind: "code" });
  createFeature(db, { actor: "pm" }, { project, slug: "work", title: "主线" });
  initDag(db, { actor: "pm" }, { id: feature, rev: 1, nodes: [{ key: "card", taskId: "T1" }, { key: "planned", oneLine: "未绑卡计划" }] });
  setPriority(db, { actor: "owner", project, dedupKey: "parent" }, { target: { kind: "feature", id: feature }, rev: 0, band: "now", evidence });
});
afterEach(() => closeLedger(":memory:"));

test("读有效 now，继承来源与未绑节点完整；缺数据不能伪装空列表", () => {
  const panel = priorityPanel(db, project, now);
  expect(panel.rows).toHaveLength(2);
  expect(panel.rows[0].priority).toMatchObject({ effective: "now", source: "feature", inheritedFrom: feature });
  expect(panel.rows.find(r => r.target.kind === "node")).toMatchObject({ stage: "planned", since: null, state: "unknown" });
  expect(panel.modes.priorityStall.available).toBe(false);
});

test("未认证 owner、外部成员、PM/agent不能通过作答应用，答案与业务均不落库", () => {
  mode("on");
  const a = request();
  for (const patch of [{ owner: undefined }, { owner: true, external: true }, { owner: undefined, principal: "pm" }, { owner: undefined, principal: "peer:worker" }]) {
    expect(() => apply(a, { ...answer, ...patch } as AskAnswer)).toThrow("owner");
    expect(getAsk(db, a.id)?.state).toBe("open");
    expect(readPriority(db, project, target).effective).toBe("now");
  }
});

test("on：owner 调档经 PRIO1 写入并读回；原话与选择进入优先级历史", () => {
  mode("on");
  const a = request();
  apply(a);
  expect(getAsk(db, a.id)?.state).toBe("answered");
  expect(panelResult(db, project, a.id).verified).toBe(true);
  expect(readPriority(db, project, target)).toMatchObject({ effective: "next", explicit: "next", rev: 1 });
  expect(priorityHistory(db, project, target).at(-1)?.data).toMatchObject({ ownerWords: "改为接着做；owner 原话", sourceRef: `ask:${a.id}` });
  expect(() => apply(a)).toThrow("已处理");
});

test("observe 只记本会应用，off 拒绝开请求；切档后旧按钮失效", () => {
  const a = request();
  apply(a);
  expect(readPriority(db, project, target).rev).toBe(0);
  expect(priorityHistory(db, project).at(-1)?.data.op).toBe("would_apply");
  mode("off");
  expect(() => request()).toThrow("关闭");
  mode("on", 1);
  const old = request();
  mode("observe", 2);
  expect(() => apply(old)).toThrow("版本冲突");
});

test("目标/继承/排序或快照版本变化，CAS 拒绝且不覆盖；过期快照不能提交", () => {
  mode("on");
  const a = request();
  setPriority(db, { actor: "owner", project, dedupKey: "race" }, { target: { kind: "feature", id: feature }, rev: 1, band: "later", evidence });
  expect(() => apply(a)).toThrow("版本冲突");
  expect(getAsk(db, a.id)?.state).toBe("open");
  const snap = priorityPanel(db, project, now);
  expect(() => panelAsk(db, project, { target, rev: 0, operation: "set", band: "now", snapshot: snap.version, observedAt: 1 }, 90000)).toThrow("过期");
});

test("前移后移复用同档顺序；恢复继承且保留审计历史", () => {
  mode("on");
  const node = { kind: "node" as const, id: feature, nodeKey: "planned" };
  const a = request("down");
  apply(a);
  expect(readPriority(db, project, node).order).toBe(0);
  expect(readPriority(db, project, target).order).toBe(1);
  expect(readPriorityOrder(db, project, "project", "now").rev).toBe(1);
  setPriority(db, { actor: "owner", project, dedupKey: "explicit" }, { target, rev: 0, band: "now", evidence });
  apply(request("clear"));
  expect(readPriority(db, project, target)).toMatchObject({ explicit: null, source: "feature", effective: "now", rev: 2 });
});

test("构造越权 HTTP 请求：普通 agent、guest、只读 token 与 peer 均由服务端拒绝", async () => {
  const { handlePriorityPanelApi } = await import("../src/bridge/local-api/ledger-priority-panel.js");
  const base = { id: "token:readonly", role: "owner" as const, agents: ["*"], createdAt: "", manage: true };
  for (const p of [base, { ...base, role: "external" as const }, { ...base, id: "guest:abc", credential: "device" }, { ...base, peer: "other" }]) {
    const res = await handlePriorityPanelApi(new Request("http://localhost/api/v1/ledger/prio/priority/requests", {
      method: "POST", body: JSON.stringify({ actor: "owner", target, rev: 0, operation: "set", band: "now" }),
    }), "/ledger/prio/priority/requests", p);
    expect(res?.status).toBe(403);
  }
});

/** Optional browser evidence uses the existing full work-board harness and production priority projection. */
async function shotFixture() {
  const { generateHomeFixture } = await import("../web/features/collab/shared/home-fixture-gen");
  const home = generateHomeFixture();
  const p = home.project;
  setMeta(db, { actor: "owner" }, { project: p, key: "pms", value: ["pm"] });
  for (const t of home.overview.tasks) {
    createTask(db, { actor: "owner", now: home.now - 3 * 86400000 }, { project: p, id: t.id, title: t.title, kind: "code", stage: t.stage,
      agent: t.agent ?? undefined, spec: "spec.md" });
    db.query(`INSERT INTO task_workflows(taskId,project,template,templateVersion,mode,authorFamily,fallback,specRev,rev,createdAt,updatedAt)
      VALUES (?,?,'code',2,'observe','codex','PM',1,1,0,0)`).run(t.id, p);
  }
  const f = home.features[0]!;
  db.query(`INSERT INTO features(id,project,title,ownerWords,status,currentVersion,rev,createdBy,createdAt,updatedAt)
    VALUES (?,?,?,'现在做','active',1,1,'owner',0,0)`).run(f.id, p, f.title);
  const nodes = f.versions.at(-1)!.nodes;
  db.query(`INSERT INTO dag_versions(featureId,version,reasonKind,reasonText,proposedBy,approvedBy,createdAt,nodes,cancels,scopeChange)
    VALUES (?,1,'initial','','owner','owner',0,?,'[]',0)`).run(f.id, JSON.stringify(nodes));
  db.query("UPDATE tasks SET featureId=? WHERE project=? AND id LIKE 'i28-A%'").run(f.id, p);
  setPriority(db, { actor: "owner", project: p, dedupKey: "shot-now" }, { target: { kind: "feature", id: f.id }, rev: 0, band: "now", evidence });
  const at = Date.now();
  db.query(`INSERT INTO asks(id,project,taskId,source,kind,blocking,title,expiresAt,state,createdAt,updatedAt)
    VALUES ('shot-owner',?,'i28-A7','system','owner_action',1,'待 owner 确认',?,'open',?,?)`).run(p, at + 86400000, at - 86400000, at);
  db.query(`INSERT INTO scheduler_intents(id,taskId,project,node,action,causalSeq,eventSeq,taskRev,specRev,templateVersion,status,reason,createdAt,updatedAt)
    VALUES ('shot-unknown','i28-A4',?,'review','dispatch',1,2,1,1,2,'unknown','结果待核实',?,?)`).run(p, at - 2 * 86400000, at - 86400000);
  db.query(`INSERT INTO lend_orders(orderId,taskId,project,peer,family,step,specRev,round,head,repo,wire,text,sha256,status,leaseMs,createdBy,createdAt,updatedAt)
    VALUES ('shot-pool','i28-A6',?,'fixture','codex','write',1,0,'h','a/b','{}','','s','pooled',1000,'owner',?,?)`).run(p, at - 3600000, at);
  const snapshot = () => ({ ...priorityPanel(db, p, Date.now(), { registry: [], manualRegistry: [], maxWorkers: 2, now: Date.now() }), canWrite: true });
  return { home, snapshot };
}

const shotsDir = process.env.PRIO_PANEL_SHOTS_DIR;
test.skipIf(!shotsDir)("browser: desktop/mobile states, owner changes, CAS, off/observe, navigation and visibility", async () => {
  const { chromium } = await import("playwright-core");
  const { mkdirSync, readdirSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  const { bundleHarness, serve, guardedPage } = await import("./helpers/collab-fixture-serve");
  const { teamFromHome } = await import("./web-team-parity-browser-center.test");
  const { homeWorkBoard } = await import("../web/features/collab/shared/home-fixture-gen");
  const { home, snapshot } = await shotFixture();
  const out = shotsDir!, baseline = process.env.PRIO_PANEL_BASELINE === "1", phase = baseline ? "before" : "after";
  mkdirSync(out, { recursive: true });
  const bundle = process.env.PRIO_PANEL_BUNDLE ?? await bundleHarness(out);
  const { server } = serve(home, await teamFromHome(home), bundle);
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  const evidenceLog: Record<string, unknown> = {};
  try {
    for (const width of [1280, 390]) {
      const height = width === 390 ? 3400 : 2000, size = `${width}x${height}`;
      for (const view of ["mixed", "empty", "failure", "stale"]) {
        const g = await guardedPage(browser, String(server.url), { width });
        const { page, ctx } = g;
        let fail = view === "failure", empty = view === "empty", owner = true, reads = 0;
        await page.setViewportSize({ width, height });
        await page.clock.install();
        await page.route(`**/api/v1/ledger/${home.project}/priority`, route => {
          reads++;
          return route.fulfill({ status: fail ? 503 : 200, json: fail ? { error: "模拟读取失败" } : { ...snapshot(), canWrite: owner, ...(empty ? { rows: [] } : {}) } });
        });
        await page.route(`**/api/v1/ledger/${home.project}/priority/requests`, async route => {
          try {
            const ask = openAsk(db, panelAsk(db, home.project, route.request().postDataJSON(), Date.now()));
            await route.fulfill({ status: 201, json: { askId: ask.id, label: ask.title, choice: "[button:priority_apply]" } });
          } catch (e) { await route.fulfill({ status: 409, json: { error: (e as Error).message } }); }
        });
        await page.route(`**/api/v1/ledger/${home.project}/asks/*/answer`, async route => {
          const id = route.request().url().split("/").at(-2)!;
          try {
            const a = getAsk(db, id)!, response = { ...answer, at: Date.now(), text: route.request().postDataJSON().text, labels: [a.title] };
            apply(a, response);
            await route.fulfill({ json: { ok: true } });
          } catch (e) { await route.fulfill({ status: 409, json: { error: (e as Error).message } }); }
        });
        await page.route(`**/api/v1/ledger/${home.project}/priority/result?*`, route => route.fulfill({
          json: panelResult(db, home.project, new URL(route.request().url()).searchParams.get("askId")!),
        }));
        await page.goto(`${server.url}?side=local&project=${home.project}#chat`);
        await page.getByRole("tab", { name: /谁在干活/ }).first().click();
        await page.locator("[data-work-board]").waitFor();
        if (!baseline) {
          await page.getByRole("heading", { name: "当前现在做" }).waitFor();
          if (view === "stale") { await page.getByText("档位来源：", { exact: false }).first().waitFor(); fail = true; await page.getByRole("button", { name: "刷新", exact: true }).click(); }
          if (fail) {
            await page.getByRole("alert").waitFor();
            expect(await page.locator('[aria-label$="优先级操作"] button:enabled').count()).toBe(0);
          }
          else if (empty) await page.getByText(/当前没有有效 now/).waitFor();
          else await page.locator("[data-priority-panel] article").first().waitFor();
        }
        await page.evaluate("document.fonts.ready");
        expect(await page.evaluate<boolean>("document.documentElement.scrollWidth <= innerWidth + 1")).toBe(true);
        await page.screenshot({ path: resolve(out, `${phase}-${view}-${size}.png`) });
        if (!baseline && view === "mixed") {
          await browserOperations(page, home.project, snapshot, () => { owner = false; }, () => reads);
          evidenceLog[size] = { reads, errors: g.errors, external: g.external, operations: "observe audit, on set/clear/up/down, readback, CAS, non-owner, off, visibility/reconnect, navigation" };
        }
        expect(g.errors).toEqual([]); expect(g.external).toEqual([]);
        await ctx.close();
      }
    }
    if (!baseline) await teamPriorityNavigation(browser, String(server.url), home.project, snapshot);
    const shots = readdirSync(out).filter(f => /^(before|after)-.+-(1280x2000|390x3400)\.png$/.test(f)).map(file => {
      const m = file.match(/^(before|after)-(.+)-(\d+x\d+)\.png$/)!;
      return { phase: m[1], view: m[2], size: m[3], file };
    });
    await Bun.write(resolve(out, "manifest.json"), JSON.stringify({ v: 1, summary: "当前现在做面板：混合阶段、空列表、失败和旧快照，桌面与窄屏对照", shots }, null, 2));
    await Bun.write(resolve(out, `${phase}-operations.json`), JSON.stringify(evidenceLog, null, 2));
  } finally { await browser.close(); server.stop(true); }
}, 180000);

async function browserOperations(page: import("playwright-core").Page, p: string,
  snapshot: () => ReturnType<typeof priorityPanel> & { canWrite: boolean }, readonly: () => void, reads: () => number) {
  db.exec("SAVEPOINT browser_ops");
  const panel = page.locator("[data-priority-panel]"), first = snapshot().rows.find(r => r.target.kind === "task")!;
  const row = () => panel.locator("article").filter({ hasText: first.title });
  const refresh = async () => { await panel.getByRole("button", { name: "刷新", exact: true }).click(); };
  const confirm = async (name: string) => { await panel.getByRole("button", { name, exact: true }).click(); };
  const setMode = (mode: "on" | "observe" | "off") => setPriorityMode(db, { actor: "owner", project: p, dedupKey: crypto.randomUUID() },
    { mechanism: "priorityPanel", mode, rev: snapshot().modes.priorityPanel.rev, evidence });
  try {
    const before = readPriority(db, p, first.target).rev;
    await row().getByRole("button", { name: "记录本会现在做", exact: true }).click();
    await confirm("确认记录");
    await panel.getByText("已记录本会调整，业务档位与顺序未变。", { exact: true }).waitFor();
    expect(readPriority(db, p, first.target).rev).toBe(before);
    setMode("on"); await refresh();
    await row().getByRole("button", { name: "改为现在做", exact: true }).waitFor();
    await row().getByRole("button", { name: "改为现在做", exact: true }).click(); await confirm("确认应用");
    await panel.getByText("已应用，服务端读回一致。", { exact: true }).waitFor();
    expect(readPriority(db, p, first.target).explicit).toBe("now");
    await row().getByRole("button", { name: "恢复继承", exact: true }).click(); await confirm("确认应用");
    await page.waitForFunction("!document.querySelector('[aria-label=\"确认优先级请求\"]')");
    expect(readPriority(db, p, first.target).explicit).toBe(null);
    await row().getByRole("button", { name: "后移", exact: true }).click(); await confirm("确认应用");
    await page.waitForFunction("!document.querySelector('[aria-label=\"确认优先级请求\"]')");
    expect(snapshot().rows[1]!.key).toBe(first.key);
    await row().getByRole("button", { name: "前移", exact: true }).click(); await confirm("确认应用");
    await page.waitForFunction("!document.querySelector('[aria-label=\"确认优先级请求\"]')");
    expect(snapshot().rows[0]!.key).toBe(first.key);
    await row().getByRole("button", { name: "改为接着做", exact: true }).click();
    setMode("observe"); await confirm("确认应用");
    await panel.getByText(/版本冲突或快照过期/).waitFor();
    expect(readPriority(db, p, first.target).effective).toBe("now");
    await refresh();
    readonly(); await refresh();
    await page.waitForFunction("!document.querySelector('[aria-label$=\"优先级操作\"]')");
    setMode("off"); await refresh();
    await page.waitForFunction("!document.querySelector('[data-priority-panel]')");
    setMode("observe");
    await page.evaluate("window.dispatchEvent(new Event('online'))");
    await panel.waitFor();
    await page.evaluate("Object.defineProperty(document, 'hidden', {configurable:true,get:()=>true}); document.dispatchEvent(new Event('visibilitychange'))");
    const hiddenReads = reads();
    await page.clock.fastForward(90000);
    expect(reads()).toBe(hiddenReads);
    await page.evaluate("Object.defineProperty(document, 'hidden', {configurable:true,get:()=>false}); document.dispatchEvent(new Event('visibilitychange'))");
    await panel.locator("article").first().waitFor();
    await row().getByRole("button").first().click();
    await page.locator("aside").filter({ has: page.getByRole("button", { name: "关闭", exact: true }) }).first().waitFor();
    await page.getByRole("button", { name: "关闭", exact: true }).first().click();
    const planned = snapshot().rows.find(r => r.target.kind === "node")!;
    await panel.locator("article").filter({ hasText: planned.title }).getByRole("button").first().click();
    await page.getByText("为什么还没开卡", { exact: true }).waitFor();
  } finally { db.exec("ROLLBACK TO browser_ops; RELEASE browser_ops"); }
}

async function teamPriorityNavigation(browser: import("playwright-core").Browser, url: string, p: string,
  snapshot: () => ReturnType<typeof priorityPanel> & { canWrite: boolean }) {
  const { guardedPage } = await import("./helpers/collab-fixture-serve");
  const g = await guardedPage(browser, url, { width: 390 });
  try {
    await g.page.route(`**/api/v1/ledger/${p}/priority`, route => route.fulfill({ json: snapshot() }));
    await g.page.goto(`${url}?side=team&project=${p}#chat`);
    await g.page.getByRole("tab", { name: /谁在干活/ }).click();
    const planned = snapshot().rows.find(r => r.target.kind === "node")!;
    await g.page.locator("[data-priority-panel] article").filter({ hasText: planned.title }).getByRole("button").first().click();
    const dialog = g.page.getByRole("dialog", { name: "本机计划节点详情" });
    await dialog.getByText("为什么还没开卡", { exact: true }).waitFor();
    expect(g.calls.some(c => c.includes(`/ledger/${p}/dag`))).toBe(true);
    expect(g.errors).toEqual([]); expect(g.external).toEqual([]);
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    expect(await dialog.count()).toBe(0);
  } finally { await g.ctx.close(); }
}

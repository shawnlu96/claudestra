/**
 * team-project-TEAMVIS7：主场是别的机器的卡，团队详情读中心正文后和本机一样显示事件 / 审查 / 规格全文，多一行同步时间；
 * 读不到时写具体原因（403 非成员、无能力位、未同步），参与者列作者 / 审查员 / PM 和所在机器，「参与者」里不再有「仅主场可见」。
 * 「对它说」行为不变（不挂输入框），占位文字改成「对它说只在主场机器上可用」；整页不出现「仅主场可见」。合成数据，fetch 全部拦在本文件、只回环；happy-dom 只在本文件注册、afterAll 注销。
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { setAppConfigForTest } from "../web/lib/app-config";
import type { FeatureDetail, FeatureList } from "../web/lib/api/shared-ledger";

type ReactNS = typeof import("../web/node_modules/@types/react/index");
type ReactDomClient = typeof import("../web/node_modules/@types/react-dom/client");
const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
interface El {
  textContent: string | null; getAttribute(n: string): string | null; parentElement: El;
  querySelector(s: string): El | null; querySelectorAll(s: string): ArrayLike<El>; remove(): void;
}
interface Doc { createElement(tag: string): El; body: El & { appendChild(c: El): void } }
interface Win { happyDOM: { setViewport(v: { width: number; height: number }): void } }

const mod = (p: string) => new URL(`../web/features/${p}`, import.meta.url).href;
let React: ReactNS;
let createRoot: ReactDomClient["createRoot"];
let doc: Doc;
let nav: { openCollab(p: string): void; openCollabTask(t: string | null): void; closeCollab(): void };
let ui: { CollabView: unknown; ChatStoreProvider: unknown; TeamSource: unknown; sharedCollabProject: (i: Identity) => string };
interface Identity { center: string; team: string; person: string; project: string; machine: string; homeInstanceId?: string }

const PROJECT = "body-proj";
const HOME = "f".repeat(32);
const IDENTITY: Identity = { center: "center", team: "team-a", person: "person-a", project: PROJECT, machine: "local", homeInstanceId: "mine-1" };
const NOW = Date.now();
const FOCUS = "R1";
const SPEC = "# 规格\n本卡做什么：团队详情显示正文";
const REVIEW = "审查结论 changes · P0 0 / P1 1 / P2 0\n- [P1] edge-1：空列表越界\n  复现：bun test x";
type Mode = "ok" | "empty" | "403" | "404";
let mode: Mode = "ok";

function center(): { list: FeatureList; detail: FeatureDetail } {
  const caps = { "feature.new": { enabled: true } };
  const feature = { id: "F1", projectId: PROJECT, title: "正文事项", description: "看正文", rev: 1, version: 1,
    authorityMode: "planning" as const, homeInstanceId: HOME, executorInstanceIds: [HOME], status: "active" as const,
    counts: { total: 1, completed: 0, blocked: 0, missing: 0 }, updatedBy: "person-a", updatedAt: NOW,
    projection: { sourceInstanceId: HOME, sourceSeq: 9, observedAt: NOW, receivedAt: NOW } };
  const task = { taskId: "task-1", sourceTaskId: FOCUS, sourceRev: 1, sourceSeq: 9, stage: "review", assigneeCode: "peer-dev", executorInstanceId: HOME,
    pr: null, head: null, deps: [], specSummary: "", specDigest: null, fullText: "home_only" as const, steps: [], asks: [] };
  const detail = { schemaVersion: 1, teamId: "team-a", serverSeq: 9, capabilities: caps, feature,
    dag: { version: 1, nodes: [{ key: FOCUS, oneLine: "在审的卡", deps: [], fileGlobs: [], estimate: "" }], bindings: [{ nodeKey: FOCUS, taskId: "task-1" }] },
    tasks: [task] } as unknown as FeatureDetail;
  return { list: { schemaVersion: 1, teamId: "team-a", serverSeq: 9, capabilities: caps, features: [feature] } as unknown as FeatureList, detail };
}
const rec = (kind: string, sourceKey: string, text: string) =>
  ({ featureId: "F1", taskId: "task-1", kind, sourceKey, text, scrubVersion: 1, maskedSegments: 0, digest: "d".repeat(64) });

const realFetch = globalThis.fetch;
beforeAll(async () => {
  GlobalRegistrator.register({ url: "http://localhost/", width: 1280, height: 900 });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  React = webRequire("react") as ReactNS;
  ({ createRoot } = webRequire("react-dom/client") as ReactDomClient);
  doc = (globalThis as unknown as { document: Doc }).document;
  const c = center();
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost/");
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
    if (url.pathname === "/app-config.json") return json({ mode: "direct", fp: "local", machineName: "fixture", version: "" });
    if (url.pathname === "/api/v1/agents") return json({ ok: true, agents: [] });
    if (url.pathname === "/api/v1/shared-ledger/features") return json(c.list);
    if (url.pathname === "/api/v1/shared-ledger/features/F1") return json(c.detail);
    if (url.pathname === "/api/v1/shared-ledger/team-body/features/F1/tasks/task-1") {
      if (mode === "403") return json({ code: "not_member" }, 403);
      if (mode === "404") return json({ code: "unsupported" }, 404);
      const records = mode === "empty" ? [] : [rec("event", "3", "开工：先写测试"), rec("event", "5", "交付 PR #31"), rec("event", "7", "补了边界用例"),
        rec("review", "8", REVIEW), rec("spec", "2", SPEC)];
      return json({ schemaVersion: 1, teamId: "team-a", projectId: PROJECT, featureId: "F1", taskId: "task-1", records,
        syncedAt: mode === "empty" ? null : NOW - 60_000, homeOnline: true });
    }
    return json({ ok: false, error: "not in fixture" }, 404);
  }) as typeof fetch;
  const view = await import(mod("collab/collab-view.tsx"));
  nav = await import(mod("collab/collab-nav.ts"));
  const store = await import(mod("chat/chat-store.ts"));
  const ops = await import(mod("collab/shared/team-ops.tsx"));
  const sharedNav = await import(mod("collab/dag/shared-navigation.tsx"));
  ui = { CollabView: view.CollabView, ChatStoreProvider: store.ChatStoreProvider, TeamSource: ops.TeamSource, sharedCollabProject: sharedNav.sharedCollabProject };
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  setAppConfigForTest(null);
  nav.closeCollab();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  await GlobalRegistrator.unregister();
});

const tick = (ms = 20) => React.act(() => new Promise<void>((r) => setTimeout(r, ms)));

/** 每次换一个 person：团队源按身份缓存，换模式要新源 */
let n = 0;
async function open(m: Mode, width = 1280) {
  mode = m;
  (globalThis as unknown as { window: Win }).window.happyDOM.setViewport({ width, height: 900 });
  const identity = { ...IDENTITY, person: `person-${++n}` };
  const project = ui.sharedCollabProject(identity);
  nav.openCollab(project);
  nav.openCollabTask(FOCUS);
  const host = doc.createElement("div");
  doc.body.appendChild(host);
  const root = createRoot(host as never);
  const h = React.createElement as (...a: unknown[]) => unknown;
  await React.act(async () => root.render(h(ui.ChatStoreProvider, null, h(ui.TeamSource, { identity }, h(ui.CollabView, { project }))) as never));
  const panel = () => Array.from(doc.body.querySelectorAll("aside")).find((a) => (a.textContent ?? "").includes(FOCUS)) ?? null;
  for (let i = 0; i < 150 && !(/参与者/.test(panel()?.textContent ?? "") && !/正在读取/.test(panel()?.textContent ?? "")); i++) await tick();
  await tick(60);
  const p = panel()!;
  const sec = (title: string) => {
    const hit = Array.from(p.querySelectorAll("h5")).find((x) => (x.textContent ?? "").trim().startsWith(title));
    return hit ? hit.parentElement.textContent ?? "" : null;
  };
  // 审查全文点开才渲染
  const more = Array.from(p.querySelectorAll("button")).find((b) => b.textContent === "审查全文") as unknown as { click(): void } | undefined;
  if (more) await React.act(async () => more.click());
  const fullReview = sec("审查");
  const out = {
    fullReview,
    all: p.textContent ?? "", recent: sec("最近 3 件事"), review: sec("审查"), spec: sec("规格全文"), people: sec("参与者"), say: sec("对它说"),
    homeOnly: Array.from(p.querySelectorAll("[data-home-only]")).map((x) => x.getAttribute("data-home-only")).sort(),
    body: Array.from(p.querySelectorAll("[data-team-body]")).map((x) => x.getAttribute("data-team-body")).sort(),
    titles: Array.from(p.querySelectorAll("[data-team-person] [title]")).map((x) => x.getAttribute("title")),
    textarea: !!p.querySelector("textarea"),
  };
  await React.act(async () => root.unmount());
  host.remove();
  nav.closeCollab();
  return out;
}

for (const width of [1280, 390]) {
  test(`复现测试:${width} 宽 有正文 → 事件 / 审查全文 / 规格全文 / 同步时间，参与者三类带机器名`, async () => {
    const v = await open("ok", width);
    expect(v.recent).toContain("交付 PR #31");
    expect(v.recent).toContain("补了边界用例");
    expect(v.review).toContain("R?");
    expect(v.review).toContain("审查全文");
    expect(v.fullReview).toContain("复现：bun test x");
    expect(v.spec).toContain("本卡做什么：团队详情显示正文");
    expect(v.all).toContain("同步时间");
    expect(v.all).toContain("中心暂未同步阶段明细");
    expect(v.body).toEqual(["no-stage-detail", "spec", "synced"]);
    // 参与者：作者 peer-dev 在其他成员的机器；审查员 / PM 身份现行契约不带，写具体原因（不写「未记录」）；实例 id 只在 title
    expect(v.people).toContain("peer-dev");
    expect(v.people).toContain("其他成员的机器");
    expect(v.people).toMatch(/执行者[\s\S]*中心暂未同步该角色身份[\s\S]*审查员[\s\S]*中心暂未同步该角色身份[\s\S]*PM/);
    expect(v.people).not.toContain("未记录");
    expect(v.people).not.toContain("只在任务所在的机器上能看");
    expect(v.titles).toEqual([HOME]);
    expect(v.all).not.toMatch(/[0-9a-f]{16,}/i);
    // 对它说：行为同 main（不挂输入框），占位写在哪台机器、为什么不行（UXCARD1）
    expect(v.homeOnly).toEqual(["say"]);
    expect(v.say).toBe("对它说这张卡在 其他成员的机器 上执行，对它说要那台机器授权，暂不支持");
    expect(v.all).not.toContain("只在任务所在的机器上能看");
    expect(v.textarea).toBe(false);
  });
}

test("复现测试:中心 403 → 你不在该项目成员里；无能力位 → 中心暂未开放；无正文 → 正文同步中 / 参与者同步中", async () => {
  const forbidden = await open("403");
  expect(forbidden.all).toContain("你不在该项目成员里");
  expect(forbidden.people).toContain("你不在该项目成员里");
  expect(forbidden.recent).toBeNull();
  const off = await open("404");
  expect(off.all).toContain("中心暂未开放");
  expect(off.people).toContain("中心暂未开放");
  const empty = await open("empty");
  expect(empty.all).toContain("正文同步中");
  expect(empty.people).toContain("参与者同步中");
  for (const v of [forbidden, off, empty]) {
    expect(v.all).not.toContain("只在任务所在的机器上能看");
    expect(v.homeOnly).toEqual(["say"]);
  }
});

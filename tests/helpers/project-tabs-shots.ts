/**
 * PROJTABS1 项目页四标签的合成数据与回环夹具（happy-dom 测试与前后截图共用一份）。照规格「对照基准」：时刻 2026-10-14 12:00（Asia/Shanghai），标题全部合成。
 * - proj-map：产品看板 3 个模块（导出 / 通知有子图，同步没有）；在途 6 张卡（P1 返工停 3 小时 = problem，P2 审查停 2 小时 = stuck，P3 等合并 10 分钟，
 *   另 3 张在干活）；今天完成 2 张、更早完成 12 张（总览窗口带 4 张，其余 8 张从 doneCursor 往前翻）；等 owner 的 asks 2 件；有「上次来之后」记录。
 * - proj-plain：没有产品看板（/product 404）也没有子图，只看「项目地图」退回因果线。
 * 机器只有「本机」「机器 B」。纯数据 + Response 构造，不 import web 里带 React 的模块。
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { board, feature, node, rowsFor, workRow } from "../web-collab-dag-fixture";
import { rosterFixture } from "../../web/features/collab/team/roster-fixture";
import type { BoardNode } from "../../web/features/collab/dag/dag-types";

export const PT_NOW = Date.UTC(2026, 9, 14, 4, 0); // 2026-10-14 12:00 Asia/Shanghai
const M = 60_000, H = 60 * M;
export const MAP = "proj-map", PLAIN = "proj-plain";
const PROJECTS = [{ id: MAP, name: "合成项目", emoji: null, dirs: [] }, { id: PLAIN, name: "合成项目 · 无看板", emoji: null, dirs: [] }];
/** 卡住了两行：P1 出问题（返工停满 2 小时），P2 卡住（审查停 2 小时） */
export const STUCK_IDS = ["P1", "P2"];

const META = { pms: ["agent-pm"], docsDir: null, queueFrozen: { frozen: false, reason: "", since: null } };
const task = (id: string, title: string, stage: string, over: object = {}) =>
  ({ id, itemId: null, title, kind: "code", stage, stageBefore: null, round: 0, pm: "agent-pm", updatedAt: PT_NOW - H, metrics: {}, ...over });
const live = (id: string, title: string, stage: string, agent: string, sinceMs: number, over: object = {}) =>
  task(id, title, stage, { agent: `agent-${agent}`, stageSince: PT_NOW - sinceMs, updatedAt: PT_NOW - sinceMs, ...over });
const done = (id: string, title: string, endAgo: number, stage = "done") => task(id, title, stage, { metrics: { endTs: PT_NOW - endAgo }, updatedAt: PT_NOW - endAgo });

const EARLIER = ["导出模板整理", "通知渠道清单", "同步日志字段", "导出分页修正", "通知静默时段", "同步冲突提示", "导出字段排序", "通知频率限制",
  "同步进度条", "导出空态文案", "通知点击落点", "同步重试上限"];
function mapTasks() {
  return [
    live("P1", "导出预览窄屏溢出", "fix", "dev-1", 3 * H, { round: 1,
      lastReview: { round: 1, verdict: "changes", p0: 0, p1: 1, p2: 0, text: "窄屏下预览溢出", ts: PT_NOW - 3 * H } }),
    live("P2", "导出格式校验", "review", "dev-2", 2 * H, { round: 1 }),
    live("P3", "同步失败重试", "merge", "dev-3", 10 * M, { round: 1 }),
    live("P4", "导出按钮改版", "build", "dev-4", 25 * M),
    live("P5", "通知设置页", "build", "dev-5", 40 * M),
    live("P6", "通知文案复述", "restate", "dev-6", 8 * M),
    done("D1", "导出入口文案", H),
    done("D2", "通知开关样式", 2 * H, "verified"),
    ...EARLIER.slice(0, 4).map((t, k) => done(`E${k + 1}`, t, (26 + k * 5) * H)),
  ];
}
/** 窗口外的 8 张：GET /ledger/proj-map/done?before=cursor-1 一页给完 */
const earlierPage = () => ({ tasks: EARLIER.slice(4).map((t, k) => done(`E${k + 5}`, t, (46 + k * 5) * H)), nextCursor: null });
const REST = { n: 8, byItem: {}, groups: [{ stage: "done", kind: "code", blocked: false, p0: false, n: 8, reviewRounds: 0, p0p1: 0 }] };

export function ptLedgers(): Record<string, object> {
  const ov = (tasks: object[], extra: object = {}) => ({ ok: true, exists: true, now: PT_NOW, meta: META, items: [], tasks, deps: [], ...extra });
  const plain = [live("Q1", "同步脚本迁移", "build", "dev-7", 30 * M), live("Q2", "同步脚本验收", "review", "dev-8", 15 * M), done("Q3", "同步脚本草案", 3 * H)];
  return { [MAP]: ov(mapTasks(), { doneCursor: "cursor-1", doneRest: REST }), [PLAIN]: ov(plain, { deps: [{ from: "Q1", to: "Q2", kind: "blocks", when: "合并后",
    state: null, derived: "active", effective: "active", createdBy: "agent-pm", createdAt: PT_NOW - 5 * H, updatedAt: PT_NOW - 5 * H }] }) };
}

/** 子图节点绑卡：key、卡号、标题、阶段；planned 没卡 */
const bound = (key: string, taskId: string | null, title: string, phase: "active" | "done" | "idle", deps: string[], agent?: string, step = "write"): BoardNode =>
  node(key, phase, deps, { taskId, title: taskId ? title : null, oneLine: title, status: phase === "idle" ? "planned" : phase === "done" ? "done" : "build",
    ...(phase === "active" ? { handler: { role: "executor" as const, agent: `agent-${agent}`, since: PT_NOW - H },
      stepLine: { active: { step, round: 1 }, steps: [{ step: "restate", round: 0, state: "done" }, { step, round: 1, state: "assigned" }] }, since: PT_NOW - H } : {}) });

function ptDag() {
  const features = [
    feature("m-export", [bound("a", "E1", "导出模板整理", "done", []), bound("b", "D1", "导出入口文案", "done", ["a"]), bound("c", "P4", "导出按钮改版", "active", ["b"], "dev-4"),
      bound("d", "P2", "导出格式校验", "active", ["b"], "dev-2", "review"), bound("e", "P1", "导出预览窄屏溢出", "active", ["c"], "dev-1", "fix"),
      bound("f", null, "导出批量下载", "idle", ["d", "e"])], { title: "导出", lastActivityAt: PT_NOW - 25 * M }),
    feature("m-notify", [bound("g", "D2", "通知开关样式", "done", []), bound("h", "P5", "通知设置页", "active", ["g"], "dev-5"),
      bound("i", "P6", "通知文案复述", "active", ["g"], "dev-6", "restate"), bound("j", null, "通知历史页", "idle", ["h", "i"])], { title: "通知", lastActivityAt: PT_NOW - 8 * M }),
  ];
  return { ...board(features, rowsFor(features, ["agent-pm"])), project: MAP, now: PT_NOW };
}

function ptProduct() {
  const f = (id: string, title: string, hasDag: boolean, counts: object, cards: [string, string, string][]) => ({ id, title, status: "active", hasDag, version: 1, counts,
    eta: null, cards: cards.map(([cid, t, stage]) => ({ id: cid, title: t, stage })), lastActivityAt: PT_NOW - H });
  return { deps: [], features: [
    f("m-export", "导出", true, { total: 6, completed: 2, active: 3, blocked: 0 }, [["P4", "导出按钮改版", "build"], ["P2", "导出格式校验", "review"], ["P1", "导出预览窄屏溢出", "fix"]]),
    f("m-notify", "通知", true, { total: 4, completed: 1, active: 2, blocked: 0 }, [["P5", "通知设置页", "build"], ["P6", "通知文案复述", "restate"]]),
    f("m-sync", "同步", false, { total: 2, completed: 0, active: 1, blocked: 0 }, [["P3", "同步失败重试", "merge"]]),
  ] };
}

function ptWork(project: string) {
  const row = (key: string, taskId: string, title: string, featureId: string | null, who: string, step: "write" | "review" | "fix" | "merge" | "restate", since: number) =>
    workRow(key, { taskId, title, featureId, who: `agent-${who}`, step, since: PT_NOW - since, machine: "local" });
  if (project === PLAIN) return { now: PT_NOW, asOfSeq: 1, working: [row("q1", "Q1", "同步脚本迁移", null, "dev-7", "write", 30 * M)], waiting: [row("q2", "Q2", "同步脚本验收", null, "dev-8", "review", 15 * M)],
    todo: { ready: [], blocked: [] }, machines: { local: 1 }, completionHours: null, availableSlots: 1 };
  return { now: PT_NOW, asOfSeq: 1, machines: { local: 5 }, completionHours: 6, availableSlots: 1,
    working: [row("c", "P4", "导出按钮改版", "m-export", "dev-4", "write", 25 * M), row("e", "P1", "导出预览窄屏溢出", "m-export", "dev-1", "fix", 3 * H),
      row("d", "P2", "导出格式校验", "m-export", "dev-2", "review", 2 * H), row("h", "P5", "通知设置页", "m-notify", "dev-5", "write", 40 * M),
      row("i", "P6", "通知文案复述", "m-notify", "dev-6", "restate", 8 * M)],
    waiting: [row("s", "P3", "同步失败重试", "m-sync", "dev-3", "merge", 10 * M)],
    todo: { ready: [workRow("f", { taskId: null, featureId: "m-export", title: "导出批量下载", who: null, step: null, machine: "local" })],
      blocked: [workRow("j", { taskId: null, featureId: "m-notify", title: "通知历史页", who: null, step: null, machine: "local" })] } };
}

function ptAgents() {
  const row = (name: string, projectId: string, over: object = {}) => ({ name: `agent-${name}`, displayName: name, purpose: "", cwd: "/repo", status: "active", projectId,
    lastActivityTs: PT_NOW - 10 * M, busy: false, ...over });
  return [...["dev-1", "dev-2", "dev-3", "dev-4", "dev-5", "dev-6"].map((n) => row(n, MAP, { busy: true })), row("pm", MAP), row("dev-7", PLAIN, { busy: true }), row("dev-8", PLAIN)];
}

export function ptAsks() {
  const ask = (id: string, over: object) => ({ id, fromAgent: null, assignee: null, project: MAP, taskId: null, title: id, context: "", body: "", kind: "decide", kindHint: null,
    source: "reply", options: [], allowText: true, blocking: true, urgency: "normal", state: "open", answer: null, createdAt: PT_NOW - H, updatedAt: PT_NOW - H,
    expiresAt: PT_NOW + 24 * H, canAnswer: true, ...over });
  // 挂卡的那件挂在在干活的 P4 上：挂到卡住的卡会把它归成「等你」，卡住了就少一行
  return [ask("ask-1", { taskId: "P4", fromAgent: "agent-dev-4", title: "导出按钮放顶栏还是更多菜单？" }),
    ask("ask-2", { fromAgent: "agent-pm", title: "导出要不要加 CSV 格式？", createdAt: PT_NOW - 2 * H })];
}

/** 上次来是 4 小时前：之后 P3 进了合并、D1 完成、P1 审查要返工 */
function ptLastSeen(project: string) {
  if (project !== MAP) return { lastSeen: null, now: PT_NOW, events: [] };
  const ev = (seq: number, target: string, kind: string, ago: number, data: object) => ({ seq, ts: PT_NOW - ago, actor: "agent-pm", target, kind, text: "", data });
  return { lastSeen: PT_NOW - 4 * H, now: PT_NOW, truncated: false, events: [
    ev(11, "P1", "review", 3 * H, { round: 1, verdict: "changes", p0: 0, p1: 1, p2: 0 }), ev(12, "P1", "stage", 3 * H, { from: "review", to: "fix" }),
    ev(13, "D1", "stage", H, { from: "merge", to: "done" }), ev(14, "P3", "stage", 10 * M, { from: "review", to: "merge" }),
  ] };
}

/** 团队名册（ROSTER4 的 /team/roster）：只有「本机」「机器 B」，卡号换成本夹具的 */
function ptRoster(project: string) {
  const r = rosterFixture(PT_NOW, project);
  const [local, peer] = r.machines;
  peer!.machineKey = "机器 B";
  const ids = ["P4", "P2", "P1"];
  local!.workers = local!.workers.map((w, i) => ({ ...w, taskId: ids[i]!, id: `worker-${ids[i]}`, name: `worker-${ids[i]}` }));
  local!.cards = { ...local!.cards, merge: ["P3"], blocked: [] };
  return { ...r, machines: [local!, peer!] };
}

function ptDetail(project: string, id: string) {
  const ov = ptLedgers()[project] as { tasks: { id: string }[] } | undefined;
  const t = ov?.tasks.find((x) => x.id === id) ?? earlierPage().tasks.find((x) => x.id === id);
  return t ? { ok: true, task: t, events: [], timeline: [], now: PT_NOW } : null;
}

/** 夹具接口：path 去掉 /api/v1 之后的部分；不认的返回 null（调用方 404） */
export function ptRoute(path: string, search: URLSearchParams): Response | null {
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
  if (path === "/agents") return json({ ok: true, agents: ptAgents() });
  if (path === "/projects") return json({ ok: true, projects: PROJECTS });
  if (path === "/asks") return json({ ok: true, asks: ptAsks(), now: PT_NOW, canAnswer: true });
  const m = /^\/ledger\/([\w-]+)(\/.*)?$/.exec(path);
  if (m) {
    const [, project, rest = ""] = m, ledger = ptLedgers()[project!];
    if (!ledger) return null;
    if (rest === "") return json(ledger);
    if (rest === "/product") return project === MAP ? json(ptProduct()) : json({ ok: false, error: "no product board" }, 404);
    if (rest === "/dag") return project === MAP ? json(ptDag()) : json({ ok: false, error: "no dag" }, 404);
    if (rest === "/work") return json(ptWork(project!));
    if (rest === "/done") return json(search.get("before") === "cursor-1" ? earlierPage() : { tasks: [], nextCursor: null });
    const detail = /^\/tasks\/([\w-]+)$/.exec(rest)?.[1];
    if (detail) return ((d) => (d ? json(d) : null))(ptDetail(project!, detail));
  }
  const seen = /^\/me\/last-seen\/([\w-]+)$/.exec(path)?.[1];
  if (seen) return json(ptLastSeen(seen));
  if (path === "/team/roster") return json(ptRoster(search.get("project") ?? MAP));
  return null;
}

/** 截图入口：仓库外写一个入口（按绝对路径引仓库里的模块，改前改后同一个入口）；外壳照生产 chat.tsx 的窄屏横滑，window.__nav 给脚本开项目 / 任务 */
export async function bundleProjectTabs(repo: string, dir: string, fp: string): Promise<string> {
  mkdirSync(dir, { recursive: true });
  const entry = resolve(dir, "entry.ts"), from = (f: string) => JSON.stringify(resolve(repo, f));
  await Bun.write(entry, `import { createElement as h, useEffect, useState } from ${from("web/node_modules/react/index.js")};
import { createRoot } from ${from("web/node_modules/react-dom/client.js")};
import { machines } from ${from("web/lib/machines.ts")};
import { ChatStoreProvider, useChatStoreApi } from ${from("web/features/chat/chat-store.ts")};
import { ChatNavContext } from ${from("web/features/chat/components/nav-context.tsx")};
import { Sidebar } from ${from("web/features/chat/components/sidebar.tsx")};
import { MessageList } from ${from("web/features/chat/components/message-list.tsx")};
import { CollabSwitch, closingCollab } from ${from("web/features/collab/collab-switch.tsx")};
import { openCollab, openCollabTask } from ${from("web/features/collab/collab-nav.ts")};
import { asksStore } from ${from("web/features/asks/asks-store.ts")};
document.documentElement.dataset.theme = "light";
await machines.add({ fp: "${fp}", name: "fixture" });
await machines.setCurrent("${fp}");
let toContent = () => {};
window.__nav = { open: (p, t) => { if (t) openCollabTask(t); openCollab(p); toContent(); }, task: (t) => openCollabTask(t) };
function Seed() {
  const store = useChatStoreApi();
  useEffect(() => { void store.loadAgents(); void store.loadProjects(); return asksStore.start("${fp}"); }, [store]);
  return null;
}
const narrow = matchMedia("(max-width: 639.98px)").matches;
function App() {
  const [content, setContent] = useState(false);
  toContent = () => setContent(true);
  const nav = { showContent: content, toContent: () => setContent(true), toList: () => setContent(false) };
  const side = narrow ? { display: content ? "none" : "flex", width: "100%" } : { display: "flex", flex: "none" };
  const main = { display: narrow && !content ? "none" : "flex", flex: "1 1 0", minWidth: 0, flexDirection: "column", position: "relative", height: "100%" };
  return h(ChatStoreProvider, null, h(ChatNavContext.Provider, { value: nav }, h(Seed),
    h("div", { className: "flex h-screen w-full overflow-hidden bg-base-100 text-base-content" },
      h("div", { style: { ...side, height: "100%" } }, h(Sidebar, { onSelect: closingCollab(() => setContent(true)) })),
      h("main", { style: main }, h(MessageList), h(CollabSwitch)))));
}
createRoot(document.getElementById("root")).render(h(App));
`);
  const build = Bun.spawn([process.execPath, "build", entry, "--target", "browser", "--outdir", resolve(dir, "dist"), "--tsconfig-override", "web/tsconfig.json"],
    { cwd: repo, stdout: "pipe", stderr: "pipe" });
  if (await build.exited) throw new Error(await new Response(build.stderr).text());
  return resolve(dir, "dist");
}

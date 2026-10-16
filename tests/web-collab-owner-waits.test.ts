/**
 * UXINBOX1：协作视图「待你处理」的口径（web/features/collab/owner-waits.ts）与「去处理」。
 * 数据照规格「对照基准」：团队键能解析到本机项目；1 张本人提的待批提案卡（project 为大总管、带 extra.centerProposal）+ 1 张本项目的普通等 owner 的 ask。
 */
import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { askCounts, groupAsks, waitsOnOwner, type WebAsk } from "@/features/asks/asks-model";
import { isProposalWait, ownerWaits, proposalProjectOf, subscribeViewBinding, viewLocalProject } from "@/features/collab/owner-waits";
import { sharedCollabProject } from "@/features/collab/team-source-key";
import { localProjectOf, refreshBindings, setContextRequestForTest } from "@/lib/collab-source-binding";
import { machines } from "@/lib/machines";
import { testChildEnv } from "./test-env";

const LOCAL = "claude-orchestrator";
const ID = { center: "c1", team: "t1", person: "p1", project: "center-proj", machine: "mac-a", homeInstanceId: "inst-a" };
const KEY = sharedCollabProject(ID);
const BINDING = { center: "c1", team: "t1", person: "p1", project: "center-proj", homeInstanceId: "inst-a", localProjectId: LOCAL };

const ask = (id: string, over: Partial<WebAsk> = {}): WebAsk => ({ id, fromAgent: null, project: LOCAL, taskId: null, title: `标题 ${id}`, context: "", body: "",
  kind: "decide", kindHint: null, source: "reply", options: [], allowText: true, blocking: true, urgency: "normal", state: "open", answer: null,
  createdAt: 1, updatedAt: 1, expiresAt: 2, ...over });
const PROPOSAL = ask("ask-prop", { project: "master", kind: "authorize", source: "system", title: "提案待你批准：卡片工作优先级",
  extra: { centerProposal: { localProjectId: LOCAL } } });
const PLAIN = ask("ask-plain", { taskId: "i28-A7", fromAgent: "agent-x" });
const ASKS = [PROPOSAL, PLAIN,
  ask("other-project", { project: "another" }),
  ask("other-proposal", { project: "master", extra: { centerProposal: { localProjectId: "another" } } }),
  ask("master-plain", { project: "master" }),
  ask("answered", { state: "answered" }),
  ask("accept", { kind: "accept" }),
  ask("for-guest", { assignee: "local:guest:1" }),
  ask("closed-proposal", { project: "master", state: "cancelled", extra: { centerProposal: { localProjectId: LOCAL } } })];

const realFp = machines.currentFp;
async function bind(identities: unknown[] | null) {
  machines.currentFp = () => "mac-a";
  setContextRequestForTest(() => Promise.resolve({ identities: identities ?? [] }));
  if (identities) await refreshBindings("mac-a");
}
afterEach(() => { setContextRequestForTest(null); machines.currentFp = realFp; });

test("[验收线 2] 团队键视图：绑定解析出本机项目 → 「待你处理」= 2（本人提案卡 + 本项目的普通 ask），别的项目 / 已答 / 验收 / 指给别人的都不算", async () => {
  await bind([BINDING]);
  expect(localProjectOf(KEY)).toBe(LOCAL);
  expect(viewLocalProject(KEY)).toBe(LOCAL);
  const r = ownerWaits(ASKS, KEY, viewLocalProject(KEY));
  expect(r.unknown).toBe(false);
  expect(r.waits.map((a) => a.id)).toEqual(["ask-prop", "ask-plain"]);
});

test("[验收线 2] 挂在团队键本身上的 ask 也算（project 等于当前视图的项目）", async () => {
  await bind([BINDING]);
  expect(ownerWaits([ask("on-key", { project: KEY })], KEY, LOCAL).waits.map((a) => a.id)).toEqual(["on-key"]);
});

test("[验收线 2] 绑定里没有 localProjectId：本机项目 = 中心项目 id（localProjectOf 的口径）", async () => {
  await bind([{ ...BINDING, localProjectId: undefined }]);
  expect(viewLocalProject(KEY)).toBe("center-proj");
  expect(ownerWaits([ask("a", { project: "center-proj" }), PLAIN], KEY, viewLocalProject(KEY)).waits.map((a) => a.id)).toEqual(["a"]);
});

test("[验收线 2] 去掉绑定（没读过 context / context 里没有这条）→ 未知，不返回 0 条当「没有」", async () => {
  await bind(null);
  expect(viewLocalProject(KEY)).toBeNull(); // 还没读过
  expect(ownerWaits(ASKS, KEY, viewLocalProject(KEY))).toEqual({ waits: [], unknown: true });
  await bind([]);
  expect(viewLocalProject(KEY)).toBeNull();
  await bind([{ ...BINDING, person: "someone-else" }]);
  expect(viewLocalProject(KEY)).toBeNull();
  expect(ownerWaits(ASKS, KEY, viewLocalProject(KEY))).toEqual({ waits: [], unknown: true });
});

test("[验收线 2] 本机项目视图（非团队）与 main 一致：只按 project 过滤，提案卡（挂在大总管上）不算；不订绑定", async () => {
  await bind([BINDING]);
  expect(viewLocalProject(LOCAL)).toBeUndefined();
  const main = ASKS.filter((a) => a.project === LOCAL && a.state === "open" && a.kind !== "accept" && !a.assignee);
  const r = ownerWaits(ASKS, LOCAL, viewLocalProject(LOCAL));
  expect(r).toEqual({ waits: main, unknown: false });
  expect(r.waits.map((a) => a.id)).toEqual(["ask-plain"]);
  let calls = 0;
  setContextRequestForTest(() => (calls++, Promise.resolve({ identities: [] })));
  subscribeViewBinding(LOCAL, () => {})();
  expect(calls).toBe(0);
});

test("[验收线 2] 团队键视图开着时订这台机器的绑定：没读过就读一轮，读到后通知重算", async () => {
  machines.currentFp = () => "mac-a";
  let calls = 0, told = 0;
  setContextRequestForTest(() => (calls++, Promise.resolve({ identities: [BINDING] })));
  const off = subscribeViewBinding(KEY, () => { told++; });
  await Bun.sleep(5);
  off();
  expect(calls).toBe(1);
  expect(told).toBe(1);
  expect(viewLocalProject(KEY)).toBe(LOCAL);
});

test("[验收线 2] 全仓只有 collab-source-binding.ts 定义团队键 → 本机项目的 localProjectOf；team-source-shared.ts 只 import 它", () => {
  const src = (p: string) => readFileSync(resolve(import.meta.dir, "..", p), "utf8");
  const defs = [...new Bun.Glob("web/{features,lib,app}/**/*.{ts,tsx}").scanSync(resolve(import.meta.dir, ".."))]
    .filter((f) => /(?:function|const)\s+localProjectOf\b/.test(src(f)));
  expect(defs).toEqual(["web/lib/collab-source-binding.ts"]);
  const shared = src("web/features/collab/team-source-shared.ts");
  expect(shared).toContain('import { localProjectOf } from "@/lib/collab-source-binding";');
  expect(shared).not.toMatch(/bindingState/);
  // 协作视图各处用同一份结果，不再按团队源的 ownerWaits 声明一刀切成「暂无」
  const view = src("web/features/collab/collab-view.tsx");
  expect(view).toMatch(/const \{ waits, unknown: waitsUnknown \} = useOwnerWaits\(asks, project, \{ loaded: asksLoaded, full: asksFull \}\)/);
  expect(view).not.toMatch(/off\?\.has\("ownerWaits"\)|a\.project === project/);
});

test("[验收线 3] 提案卡识别：带 extra.centerProposal.localProjectId 的才是", () => {
  expect(proposalProjectOf(PROPOSAL)).toBe(LOCAL);
  expect(isProposalWait(PROPOSAL)).toBe(true);
  expect(isProposalWait(PLAIN)).toBe(false);
  expect(isProposalWait(ask("x", { extra: { centerProposal: {} } }))).toBe(false);
});

/** 真组件在子进程里 SSR（同 web-team-work-model.test.ts），免得 React / CSS 加载漏进根测试 */
function render(page: "Overview" | "WaitsPage"): string {
  const script = `
    import { createElement } from 'react';
    import { renderToStaticMarkup } from 'react-dom/server';
    import { Overview, WaitsPage } from './features/collab/v4/v4-props.tsx';
    const tr = (s, v = {}) => s.replace(/\\{(\\w+)\\}/g, (_, k) => String(v[k]));
    const ov = { exists: true, now: 1, tasks: [{ id: 'i28-A7', title: '阻塞提问那张卡', stage: 'build' }], items: [], deps: [] };
    const view = { headline: { advancing: 1, problem: 0, stuck: 0, owner: 1 }, pm: { pm: null, managing: 0, queued: [], frozen: null } };
    const waits = ${JSON.stringify([PROPOSAL, PLAIN])};
    const props = { ov, view, waits, projectName: 'P', onPick() {}, onClose() {}, tr };
    console.log(renderToStaticMarkup(createElement(${page}, props)));
  `;
  const p = Bun.spawnSync([process.execPath, "--no-env-file", "-e", script], { cwd: resolve(import.meta.dir, "../web"), env: testChildEnv(), stdout: "pipe", stderr: "pipe" });
  // 子进程里 CSS module 不是真的类名表（v.link 取到 String.prototype.link），React 会为 TaskLink 的 className 报一行警告：只认这一种
  expect(p.stderr.toString().split("\n").filter((l) => l.trim() && !l.startsWith("Invalid value for prop `className`"))).toEqual([]);
  expect(p.exitCode).toBe(0);
  return p.stdout.toString();
}

test("[验收线 3] 「要你定的」与「待你处理」页：每一行都有「去处理」（UXHOME1 PM 补），有卡号的行照旧是任务链接", () => {
  for (const page of ["Overview", "WaitsPage"] as const) {
    const html = render(page);
    expect(html.match(/去处理/g)?.length).toBe(4); // 按钮文字 + aria-label，各一次 × 两行 = 每行一个按钮
    expect(html).toContain('aria-label="去处理 提案待你批准：卡片工作优先级"');
    expect(html).toContain("i28-A7");
    expect(html).toContain("阻塞提问那张卡");
    expect(html).toContain('aria-label="去处理 标题 ask-plain"');
    expect(html).not.toMatch(/批准<\/button>|驳回<\/button>/); // 协作视图里不另做批准按钮
  }
});

test("[验收线 3] 「去处理」调 asksStore.openDrawer(这张卡的 id)：打开全站收件箱并定位", () => {
  const src = readFileSync(resolve(import.meta.dir, "../web/features/collab/v4/v4-props.tsx"), "utf8");
  expect(src).toMatch(/onClick=\{\(\) => asksStore\.openDrawer\(w\.id\)\}/);
  // openDrawer(focus) 把抽屉打开并记下要定位的卡（真点击在 tests/web-collab-owner-waits-browser.test.ts）
  const store = readFileSync(resolve(import.meta.dir, "../web/features/asks/asks-store.ts"), "utf8");
  expect(store).toMatch(/openDrawer: \(focus: string \| null = null\) => enter\(focus\)/);
});

test("[验收线 3] 手机上全站收件箱开着时整屏页先收起：它的层级在抽屉之上，不收「去处理」点了像没反应", () => {
  const src = readFileSync(resolve(import.meta.dir, "../web/features/collab/collab-view.tsx"), "utf8");
  expect(src).toMatch(/const \{ asks, open: inboxOpen, loaded: asksLoaded, full: asksFull \} = useAsks\(\);/);
  // 只是不渲染整屏页；选中（sel）与它的历史条目不动，从收件箱返回还在「待你处理」页（真点击在 tests/web-collab-owner-waits-browser.test.ts）
  expect(src).toMatch(/pane !== "detail" && page && !inboxOpen && createPortal\(/);
});

test("[验收线 6] UXCARD3 不知道 ≠ 没有：绑定解析不出、待办没读到、不完整且为空，三种都 unknown；有数据时照旧列出", async () => {
  await bind([BINDING]);
  expect(ownerWaits(ASKS, KEY, null, { loaded: true, full: true })).toEqual({ waits: [], unknown: true });
  expect(ownerWaits(ASKS, KEY, LOCAL, { loaded: false })).toEqual({ waits: [], unknown: true });
  expect(ownerWaits([], KEY, LOCAL, { loaded: true, full: false })).toEqual({ waits: [], unknown: true });
  expect(ownerWaits([ask("other", { project: "another" })], KEY, LOCAL, { loaded: true })).toEqual({ waits: [], unknown: true });
  // 不完整但有数据：照旧列出；读全了、一条没有：就是没有
  const partial = ownerWaits(ASKS, KEY, LOCAL, { loaded: true, full: false });
  expect(partial.unknown).toBe(false);
  expect(partial.waits.map((a) => a.id)).toEqual(["ask-prop", "ask-plain"]);
  expect(ownerWaits([], KEY, LOCAL, { loaded: true, full: true })).toEqual({ waits: [], unknown: false });
});

test("[验收线 2][验收线 3] now 停滞提醒归 PM：项目待办、收件箱「等你」、角标都不算；owner 能代答也不收，普通 owner 卡照旧", () => {
  const stallExtra = { mechanism: "priorityStall", pm: "agent-claudestra" } as WebAsk["extra"];
  const legacy = ask("stall-legacy", { kind: "owner_action", source: "system", canAnswer: true, extra: stallExtra });
  const assigned = ask("stall-new", { kind: "owner_action", source: "system", canAnswer: true, assignee: "agent-claudestra", extra: stallExtra });
  const toPm = ask("pm-ask", { fromAgent: "agent-exec", canAnswer: true, assignee: "agent-claudestra" });
  const ownerCard = ask("owner-action", { kind: "owner_action", source: "system" });
  const authorize = ask("authorize", { kind: "authorize" });
  const explicit = ask("explicit-owner", { assignee: "local:owner:self" });
  const all = [legacy, assigned, toPm, ownerCard, authorize, explicit];
  const mine = ["owner-action", "authorize", "explicit-owner"];
  expect(all.filter(waitsOnOwner).map((a) => a.id)).toEqual(mine);
  expect(ownerWaits(all, LOCAL, LOCAL).waits.map((a) => a.id)).toEqual(mine);
  expect(groupAsks(all).waiting.map((a) => a.id).sort()).toEqual([...mine].sort());
  expect(askCounts(all).waiting).toBe(3);
});

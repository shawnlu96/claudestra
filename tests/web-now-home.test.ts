/**
 * UXHOME1：「现在」总览三块的选取（web/features/now/now-model.ts），纯数据不碰网络。数据照规格「对照基准」：
 * 4 个 agent 其中 2 个忙（一个挂台账卡在开发，一个在审另一张卡的第 2 轮）；3 件等 owner 的 asks（1 件是团队提案卡）；
 * 4 个项目：两个已绑定团队（一个成组、一个单成员），一个本机成组，一个本机单成员。
 */
import { expect, test } from "bun:test";
import type { WebAsk } from "@/features/asks/asks-model";
import type { AgentSession, ProjectMeta } from "@/features/chat/type";
import { sharedCollabProject } from "@/features/collab/team-source-key";
import { nowTr } from "@/features/now/now-i18n";
import { doingOf, nowView, PROJECT_FOLD, WAIT_LIMIT, type NowDeps } from "@/features/now/now-model";
import { resolveCollabSource, type ContextIdentity } from "@/lib/collab-source-binding";
import { fillParams } from "@/lib/i18n-fill";
import { BANNED_OWNER_WORDS } from "@/lib/owner-words";

const FP = "mac-a";
const NOW = Date.UTC(2026, 9, 14, 3, 0);
const agent = (name: string, over: Partial<AgentSession> = {}): AgentSession => ({ name, displayName: name, purpose: "", cwd: "/repo", status: "active", ...over });
const AGENTS: AgentSession[] = [
  agent("dev-1", { busy: true, projectId: "team-group", label: "开发一号", ledgerTask: { id: "UXHOME1", stage: "build", round: 0 }, lastActivityTs: NOW - 3 * 60_000 }),
  agent("rv-1", { busy: true, projectId: "local-group", ledgerReview: { id: "UXNUM1", round: 2, verdict: null, p0: 0, p1: 0, p2: 0 } }),
  agent("pm-a", { projectId: "team-group", task: "排期" }),
  agent("solo", { projectId: "team-solo", purpose: "单成员项目里的会话" }),
];
const PROJECTS: ProjectMeta[] = [
  { id: "local-solo", name: "本机单成员", dirs: [] },
  { id: "local-group", name: "本机成组", dirs: [] },
  { id: "team-solo", name: "团队单成员", dirs: [] },
  { id: "team-group", name: "团队成组", dirs: [] },
];
const bound = (project: string, local: string): ContextIdentity => ({ center: "c1", team: "t1", person: "p1", project, homeInstanceId: "inst-a", localProjectId: local });
const IDS = [bound("center-group", "team-group"), bound("center-solo", "team-solo")];
const keyOf = (project: string) => sharedCollabProject({ machine: FP, center: "c1", team: "t1", person: "p1", project, homeInstanceId: "inst-a" });

const ask = (id: string, over: Partial<WebAsk> = {}): WebAsk => ({ id, fromAgent: null, project: "local-group", taskId: null, title: `标题 ${id}`, context: "", body: "",
  kind: "decide", kindHint: null, source: "reply", options: [], allowText: true, blocking: true, urgency: "normal", state: "open", answer: null,
  createdAt: 1, updatedAt: 1, expiresAt: 2, ...over });
const ASKS: WebAsk[] = [
  ask("old", { createdAt: NOW - 3 * 3600_000, title: "接口命名二选一" }),
  ask("proposal", { createdAt: NOW - 600_000, project: "master", kind: "authorize", source: "system", title: "提案待你批准：卡片工作优先级",
    extra: { centerProposal: { localProjectId: "team-solo" } } }),
  ask("mid", { createdAt: NOW - 3600_000, project: "team-group", title: "要不要拆卡" }),
  // 下面三条不算等你：答过的、验收、指给别人的
  ask("answered", { state: "answered" }), ask("accept", { kind: "accept" }), ask("guest", { assignee: "local:guest:1" }),
];

const zh = (s: string, p?: Record<string, string | number>) => fillParams(s, p);
const ago = (ts?: number | null) => (ts ? `${Math.floor((NOW - ts) / 60_000)}分钟前` : "");
const deps = (ids: readonly ContextIdentity[] | null = IDS): NowDeps => ({ lang: "zh", t: nowTr("zh", zh), ago, source: (id) => resolveCollabSource(ids, id, FP) });
const view = (over: Partial<Parameters<typeof nowView>[0]> = {}, d = deps()) => nowView({ agents: AGENTS, projects: PROJECTS, asks: ASKS, ...over }, d);

test("[验收线 1] 在干活 2 行：『卡号 + 阶段短语』和『审 <卡号> 第 2 轮』；名字显示名优先；没有 lastActivityTs 的不写时间", () => {
  expect(view().workers).toEqual([
    { name: "dev-1", label: "开发一号", doing: "UXHOME1 开发中", ago: "3分钟前" },
    { name: "rv-1", label: "rv-1", doing: "审 UXNUM1 第 2 轮", ago: "" },
  ]);
});

test("[验收线 1] 在做什么的取法顺序：台账卡 → 在审 → 任务短名 → 用途截断；审完的不算在审；大总管也算", () => {
  const t = nowTr("zh", zh);
  const both = agent("x", { ledgerTask: { id: "T1", stage: "fix", round: 2 }, ledgerReview: { id: "T2", round: 1, verdict: null, p0: 0, p1: 0, p2: 0 }, task: "短名" });
  expect(doingOf(both, "zh", t)).toBe("T1 返工中");
  expect(doingOf(agent("x", { ledgerReview: { id: "T2", round: 1, verdict: "pass", p0: 0, p1: 0, p2: 0 }, task: "短名" }), "zh", t)).toBe("短名");
  expect(doingOf(agent("x", { purpose: "一".repeat(40) }), "zh", t)).toBe(`${"一".repeat(28)}…`);
  expect(doingOf(agent("x", { purpose: "短用途" }), "zh", t)).toBe("短用途");
  expect(doingOf(agent("x", { ledgerReview: { id: "T2", round: 3, verdict: null, p0: 0, p1: 0, p2: 0 } }), "en", nowTr("en", zh))).toBe("Reviewing T2 round 3");
  const master = agent("__master__", { displayName: "大总管", pinnedMaster: true, busy: true, purpose: "总控" });
  expect(view({ agents: [master, ...AGENTS] }).workers.map((w) => w.name)).toEqual(["__master__", "dev-1", "rv-1"]);
});

test("[验收线 1] 等你的事 3 条，按创建时间倒序，带来自哪个项目（提案卡取它为之开的本机项目）", () => {
  const v = view();
  expect(v.waitTotal).toBe(3);
  expect(v.waits).toEqual([
    { id: "proposal", title: "提案待你批准：卡片工作优先级", where: "团队单成员" },
    { id: "mid", title: "要不要拆卡", where: "团队成组" },
    { id: "old", title: "接口命名二选一", where: "本机成组" },
  ]);
});

test("等你的事超过 5 条只列最新 5 条，总数照实（末行『还有 K 件』用它算）；没有时两处都是空", () => {
  const many = Array.from({ length: 8 }, (_, i) => ask(`a${i}`, { createdAt: i }));
  const v = view({ asks: many });
  expect(v.waits.map((w) => w.id)).toEqual(["a7", "a6", "a5", "a4", "a3"]);
  expect([v.waits.length, v.waitTotal]).toEqual([WAIT_LIMIT, 8]);
  expect(view({ asks: [], agents: [] })).toMatchObject({ waits: [], waitTotal: 0, workers: [] });
});

test("[验收线 1] 各项目：有等你的在前、有在干活的其次、其余在后；单成员项目也在列表里；待你处理数是 owner-waits 口径", () => {
  const v = view();
  expect(v.projects.map((p) => [p.id, p.working, p.waits])).toEqual([
    ["local-group", 1, 1], ["team-solo", 0, 1], ["team-group", 1, 1], ["local-solo", 0, 0],
  ]);
  // 团队单成员项目的那 1 件是挂在大总管上的提案卡：按团队键 + 绑定的本机项目才数得到
  expect(v.projects.find((p) => p.id === "team-solo")).toMatchObject({ team: true, open: keyOf("center-solo"), blocked: null });
  expect(v.projects.find((p) => p.id === "local-solo")).toMatchObject({ team: false, open: "local-solo", blocked: null });
  // 只有在干活、没有等你的排在有等你的后面
  const quiet = view({ asks: [] }).projects.map((p) => p.id);
  expect(quiet).toEqual(["local-group", "team-group", "local-solo", "team-solo"]);
});

test("[验收线 3] 绑定团队的项目开的是中心键，和项目组入口的 resolveCollabSource 给的字节相等；绑定停用的行不可点", () => {
  for (const [local, center] of [["team-group", "center-group"], ["team-solo", "center-solo"]] as const) {
    const choice = resolveCollabSource(IDS, local, FP);
    expect(choice.kind).toBe("center");
    expect(view().projects.find((p) => p.id === local)!.open).toBe(choice.kind === "center" ? choice.key : "");
    expect(view().projects.find((p) => p.id === local)!.open).toBe(keyOf(center));
  }
  // 绑定还没读到（checking）、同一中心项目绑了两次（ambiguous）：停用，不回退本机
  expect(view({}, deps(null)).projects.every((p) => p.open === null && p.blocked === "checking")).toBe(true);
  const twice = view({}, deps([...IDS, bound("center-group", "team-group")])).projects.find((p) => p.id === "team-group")!;
  expect(twice).toMatchObject({ open: null, blocked: "ambiguous", team: true });
});

test("超过 6 个项目时模型照样全给（折叠在界面上做）；新文案不出内部词", () => {
  const lots = Array.from({ length: PROJECT_FOLD + 3 }, (_, i): ProjectMeta => ({ id: `p${i}`, name: `项目 ${i}`, dirs: [] }));
  expect(view({ projects: lots }).projects).toHaveLength(PROJECT_FOLD + 3);
  const t = nowTr("zh", zh);
  const words = ["今天", "{n} 个 agent 在干活", "{n} 件等你", "等你的事", "在干活", "各项目", "没有等你的事", "现在没有 agent 在干活", "还有 {n} 件", "来自 {p}",
    "在干活 {n} 个 agent", "待你处理 {n} 件", "展开全部（共 {n} 个）"].map((w) => t(w, { n: 2, p: "x" }));
  for (const w of words) for (const bad of [...BANNED_OWNER_WORDS, "spec", "parked", "可执行", "就绪可开"]) expect({ w, bad, hit: w.includes(bad) }).toEqual({ w, bad, hit: false });
  // 件数 / 个数写明单位，不和协作视图按卡数的「在干活 a · 在等 b」同形
  expect(t("{n} 个 agent 在干活", { n: 2 })).toBe("2 个 agent 在干活");
  expect(t("{n} 件等你", { n: 3 })).toBe("3 件等你");
  expect(nowTr("en", zh)("{n} 个 agent 在干活", { n: 1 })).toBe("1 agent working");
});

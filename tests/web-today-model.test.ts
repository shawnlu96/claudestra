/**
 * TODAY1：「今天」五块的选取（web/features/now/now-model.ts todayView / stuckRow），纯数据不碰网络。数据照规格「对照基准」（tests/helpers/today-shots.ts）：
 * 项目 A 有产品看板、两个在做模块，1 条出问题 + 1 条卡住 3 小时，今天完成 2 张；项目 B 没有看板，1 个忙 agent、1 条卡住，今天完成 1 张；项目 C 台账 403；
 * 3 件等 owner 的 asks（1 件带 taskId）。时刻 2026-10-14 12:00 Asia/Shanghai（「今天」的零点按本机时区，这里钉死）。
 */
process.env.TZ = "Asia/Shanghai";
import { expect, test } from "bun:test";
import type { WebAsk } from "@/features/asks/asks-model";
import type { AgentSession, ProjectMeta } from "@/features/chat/type";
import type { LedgerOverview } from "@/features/collab/collab-model";
import { nowTr } from "@/features/now/now-i18n";
import { STUCK_LIMIT, stuckRow, todayView, type TodayInput } from "@/features/now/now-model";
import type { ProductBoard } from "@/lib/api/product-board-types";
import { fillParams } from "@/lib/i18n-fill";
import { BANNED_OWNER_WORDS } from "@/lib/owner-words";
import { PROJECTS, TODAY_NOW, todayAgents, todayAsks, todayBoards, todayLedgers } from "./helpers/today-shots";

const zh = (s: string, p?: Record<string, string | number>) => fillParams(s, p);
const t = nowTr("zh", zh);
const deps = { lang: "zh" as const, t, ago: () => "", source: () => ({ kind: "local" as const }) };
const map = <V>(o: Record<string, object>) => new Map(Object.entries(o) as [string, V][]);

function input(over: Partial<TodayInput> = {}): TodayInput {
  return {
    agents: todayAgents() as AgentSession[], projects: PROJECTS as ProjectMeta[], asks: todayAsks() as WebAsk[],
    overviews: map<LedgerOverview>(todayLedgers()), boards: map<ProductBoard>(todayBoards()), denied: new Set(["proj-c"]), now: TODAY_NOW, ...over,
  };
}

test("[验收线 1] 卡住了 3 条：出问题在前，其余按停留时长倒序；每行 任务标题 · 项目名 · 原因 · 停留时长", () => {
  const v = todayView(input(), deps);
  expect(v.stuck.map((r) => [r.project, r.id, r.problem])).toEqual([["proj-a", "A3", true], ["proj-a", "A2", false], ["proj-b", "B1", false]]);
  expect(v.stuck[0]).toMatchObject({ title: "导出预览", projectName: "合成项目 A", reason: "窄屏下预览溢出", dwell: "50分" });
  expect(v.stuck[1]).toMatchObject({ title: "导出格式校验", reason: "已经等了 3小时，超过 30 分钟", dwell: "3小时" });
  expect(v.stuck[2]).toMatchObject({ title: "同步失败重试", projectName: "合成项目 B", dwell: "2小时" });
  expect(v.stuckMore).toEqual([]);
});

test("stuckRow：原因空时用阶段短语；近似停留时长前加 ≈；没有时长不写", () => {
  const line = { id: "X", title: "合成任务", reason: "", stageLabel: "等审查", dwellMs: 90 * 60_000, dwellApprox: true, attention: "stuck" as const };
  expect(stuckRow(line, "p", "项目", t)).toMatchObject({ reason: "等审查", dwell: "≈1小时30分", problem: false });
  expect(stuckRow({ ...line, dwellMs: null }, "p", "项目", t).dwell).toBe("");
});

test("卡住了超过 8 条：前 8 条列出，其余进 stuckMore（界面上「还有 K 条」）", () => {
  const many = Array.from({ length: 11 }, (_, i) => ({ id: `S${i}`, title: `合成 ${i}`, kind: "feature", stage: "review", round: 0, agent: "agent-x",
    stageSince: TODAY_NOW - (i + 1) * 3600_000, updatedAt: TODAY_NOW, metrics: {} }));
  const ov = { exists: true, now: TODAY_NOW, meta: { pms: [], docsDir: null, queueFrozen: { frozen: false, reason: "", since: null } }, items: [], tasks: many };
  const v = todayView(input({ overviews: new Map([["proj-b", ov as LedgerOverview]]), boards: new Map() }), deps);
  expect([v.stuck.length, v.stuckMore.length]).toEqual([STUCK_LIMIT, 3]);
  expect(v.stuck[0]!.id).toBe("S10");
});

test("[验收线 1] 正在做：A 两个模块（进度、在做数、人数对），B 退回 agent 行，C 只出项目行", () => {
  const v = todayView(input(), deps);
  const of = (id: string) => [...v.doing, ...v.rest].find((p) => p.row.id === id)!;
  expect(of("proj-a").modules!.map((m) => ({ id: m.id, done: `${m.completed}/${m.total}`, active: m.active, faces: m.faces.map((f) => f.name) }))).toEqual([
    { id: "f-export", done: "2/6", active: 3, faces: ["a-dev1", "a-dev2"] },
    { id: "f-notify", done: "1/3", active: 1, faces: ["a-dev2"] },
  ]);
  // 头像的 title 用 UXHOME1 的 doingOf：显示名 + 卡号阶段
  expect(of("proj-a").modules![0]!.faces[0]).toEqual({ name: "a-dev1", label: "导出开发", doing: "A1 开发中" });
  expect(of("proj-b")).toMatchObject({ modules: null, doing: true });
  expect(of("proj-b").workers.map((w) => w.name)).toEqual(["b-dev"]);
  expect(of("proj-c")).toMatchObject({ modules: null, workers: [], doing: false });
  expect(v.idle).toBe(false);
  // 产品看板里 done 的模块、active=0 的模块不列
  expect(of("proj-a").modules!.some((m) => m.id === "f-old")).toBe(false);
});

test("对不上模块的 agent 归到「其他」一行；读不了台账的项目即使有看板也不出模块", () => {
  const agents = [...todayAgents(), { name: "a-ops", displayName: "a-ops", purpose: "整理日志", cwd: "/repo", status: "active", projectId: "proj-a", busy: true }];
  const v = todayView(input({ agents: agents as AgentSession[] }), deps);
  const a = v.doing.find((p) => p.row.id === "proj-a")!;
  expect(a.modules!.at(-1)).toMatchObject({ id: null, title: "其他", faces: [{ name: "a-ops", label: "a-ops", doing: "整理日志" }] });
  const denied = todayView(input({ denied: new Set(["proj-a", "proj-c"]) }), deps).doing.find((p) => p.row.id === "proj-a")!;
  expect(denied.modules).toBeNull();
  expect(denied.workers.map((w) => w.name)).toEqual(["a-dev1", "a-dev2"]);
});

test("[验收线 1] 今天完成合计 3（昨天完成的不算）；unknownMetrics 含 todayDone 的项目不计入、单独计数", () => {
  const v = todayView(input(), deps);
  expect(v.doneTotal).toBe(3);
  expect(v.done.map((d) => [d.id, d.tasks.map((x) => x.title)])).toEqual([["proj-a", ["导出权限提示", "导出入口文案"]], ["proj-b", ["同步状态图标"]]]);
  expect(v.doneUnknown).toBe(0);
  const lg = todayLedgers() as Record<string, LedgerOverview>;
  const unknown = { ...lg, "proj-b": { ...lg["proj-b"]!, unknownMetrics: ["todayDone"] as const } };
  const u = todayView(input({ overviews: map<LedgerOverview>(unknown) }), deps);
  expect([u.doneTotal, u.doneUnknown, u.done.map((d) => d.id)]).toEqual([2, 1, ["proj-a"]]);
  // 合计为 0：界面整块不出
  expect(todayView(input({ overviews: new Map() }), deps).doneTotal).toBe(0);
});

test("[验收线 1] 要你处理：带 taskId 的写出『项目 · 模块 · 任务标题』，不带的只写项目；按创建时间倒序", () => {
  const v = todayView(input(), deps);
  expect(v.waitTotal).toBe(3);
  expect(v.waits.map((w) => [w.id, w.where, w.taskId])).toEqual([
    ["ask-task", "合成项目 A · 导出 · 导出按钮改版", "A1"],
    ["ask-b", "合成项目 B", null],
    ["ask-c", "合成项目 C", null],
  ]);
  // 带 taskId 的那条线归「等你」，不算卡住
  expect(v.stuck.some((r) => r.id === "A1")).toBe(false);
});

test("团队与额度：活着按 status=active、在干活按 busy 数", () => {
  const agents = [...todayAgents(), { name: "gone", displayName: "gone", purpose: "", cwd: "/repo", status: "stopped", projectId: null }];
  expect(todayView(input({ agents: agents as AgentSession[] }), deps).team).toEqual({ alive: 4, busy: 3 });
});

test("什么都没在做：idle；新词不出内部词，英文表齐", () => {
  const quiet = todayView(input({ agents: [], overviews: new Map(), boards: new Map() }), deps);
  expect([quiet.idle, quiet.doing.every((p) => !p.doing)]).toEqual([true, true]);
  const words = ["今天", "要你处理", "没有要你处理的", "卡住了", "正在做", "今天完成", "团队与额度", "{n} 件要你处理", "{n} 个在做", "其余 {n} 个项目", "今天完成 {n} 个任务",
    "有 {n} 个项目没有完成时间，未计入", "{n} 个 agent 活着 · {m} 个在干活", "{f} 本周 {n}%", "整页", "去处理", "看任务"];
  const en = nowTr("en", (s) => `MISSING:${s}`);
  for (const w of words) {
    const zhw = t(w, { n: 2, m: 1, f: "Claude" });
    for (const bad of [...BANNED_OWNER_WORDS, "spec", "现在"]) expect({ w, bad, hit: zhw.includes(bad) }).toEqual({ w, bad, hit: false });
    expect(en(w, { n: 2, m: 1, f: "Claude" })).not.toContain("MISSING");
  }
  expect(t("{f} 本周 {n}%", { f: "Claude", n: 62 })).toBe("Claude 本周 62%");
  expect(en("今天")).toBe("Today");
});

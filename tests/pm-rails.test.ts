/**
 * PMR-2（docs/design/pm-intervention-rails.md §5 P0 T1 / T2 / T20）：自动卡上 PM / master 的手工写入打 manual + intervention 标记，
 * pmRails=on 的项目经 `ledger pm-rails-tick` 把干预（同卡 10 分钟合并）、停在 unknown 的意图、每日汇总推给本机 owner。
 * 全程走真实 CLI（runLedger）+ 真实自动 tick（scheduler-auto-helpers.ts）；开关写进隔离状态目录的 recovery-policy.json。
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createTask } from "../src/lib/ledger-write.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { getTask, listEvents } from "../src/lib/ledger-store.js";
import type { LedgerEvent } from "../src/lib/ledger-stages.js";
import { RECOVERY_POLICY_PATH } from "../src/lib/recovery-policy.js";
import { autoFixture, H2, toBuild } from "./scheduler-auto-helpers.js";

type F = ReturnType<typeof autoFixture>;
const PR = "https://github.com/example/repo/pull/9", MERGE = "9".repeat(40), MIN = 60_000;

let saved: Buffer | null = null;
const open: F[] = [];
beforeEach(() => {
  expect(RECOVERY_POLICY_PATH.startsWith(join(homedir(), ".claude-orchestrator"))).toBe(false);
  saved = existsSync(RECOVERY_POLICY_PATH) ? readFileSync(RECOVERY_POLICY_PATH) : null;
});
afterEach(() => {
  if (saved) writeFileSync(RECOVERY_POLICY_PATH, saved);
  else rmSync(RECOVERY_POLICY_PATH, { force: true });
  for (const f of open.splice(0)) f.close();
});

function policy(keys: Record<string, string | null>): void {
  const projects = Object.fromEntries(Object.entries(keys).map(([p, m]) => [p, m === null ? {} : { keys: { pmRails: m } }]));
  writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify({ projects }));
}
function fixture(mode: string): F {
  policy({ p: mode });
  const f = autoFixture();
  open.push(f);
  return f;
}
const marked = (f: F, target = "T1") => listEvents(f.db, { project: "p", target }).filter((e) => e.data.intervention);
/** 一条命令可能写好几条事件（deliver 还写一条 stage），每条都带标记；这里按命令去重 */
const cmds = (es: LedgerEvent[]) => [...new Set(es.map((e) => (e.data.intervention as { cmd: string }).cmd))];
const rev = (f: F) => String(f.task().rev);

/** owner 身份跑 pm-rails-tick；sent 收集给 owner 的推送 */
function ticker(f: F) {
  const sent: string[] = [];
  const statePath = join(f.dir, "pm-rails.json");
  const run = (now?: number) => f.cliWith({ notifyOwner: async (t) => { sent.push(t); return true; }, pmRails: { statePath },
    ...(now !== undefined ? { now: () => now } : {}) }, "owner", "pm-rails-tick");
  return { sent, run };
}

/** 真实 tick 把 T1 带到合并队列，调度身份 claim + 开合并 run；返回合并意图 id */
async function toMergeRun(f: F): Promise<string> {
  await toBuild(f);
  await f.tick();
  expect(await f.cli("agent-task-one", "task-set", "T1", "--rev", rev(f), "--branch", "task/T1", "--pr", PR)).toMatchObject({ ok: true });
  expect(await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H2)).toMatchObject({ ok: true });
  await f.tick();
  await f.tick();
  expect(await f.review("pass", H2, [])).toMatchObject({ ok: true });
  expect(await f.tick()).toMatchObject({ step: "stage", detail: "review→merge" });
  expect(await f.tick()).toMatchObject({ step: "merge_queue" });
  const { id } = f.db.query("SELECT id FROM scheduler_intents WHERE action = 'merge' AND status = 'pending'").get() as { id: string };
  expect(await f.cli("scheduler", "scheduler-settle", id, "--from", "pending", "--to", "submitted", "--receipt", "claimed")).toMatchObject({ ok: true });
  expect(await f.cli("scheduler", "scheduler-merge-begin", id, "--required-checks", "ci")).toMatchObject({ ok: true, run: { phase: "ready" } });
  return id;
}

test("[验收线 2] T1：执行者交单、绑定审查员结论、调度写入都不标；PM 放行复述与 scheduler-merge-step 标 intervention", async () => {
  const f = fixture("observe");
  const id = await toMergeRun(f);
  const step = (actor: string, from: string, to: string, n: number, ...extra: string[]) =>
    f.cli(actor, "scheduler-merge-step", id, "--from", from, "--to", to, "--rev", String(n), "--receipt", `${from}→${to}`, ...extra);
  expect(await step("pm", "ready", "await_ci", 1)).toMatchObject({ ok: true });
  expect(await step("scheduler", "await_ci", "merging", 2)).toMatchObject({ ok: true });
  expect(await step("pm", "merging", "merged", 3, "--merge-sha", MERGE)).toMatchObject({ ok: true });
  const all = listEvents(f.db, { project: "p", target: "T1" });
  for (const e of all.filter((x) => x.actor !== "pm")) expect(e.data.intervention).toBeUndefined();
  expect(all.some((e) => e.actor === "agent-task-one" && e.kind === "deliver")).toBe(true);
  expect(all.some((e) => e.actor === "agent-rv-t1" && e.kind === "review")).toBe(true);
  expect(cmds(marked(f))).toEqual(["restate-approve", "scheduler-merge-step"]);
  expect(marked(f).filter((e) => (e.data.intervention as { cmd: string }).cmd === "scheduler-merge-step").length).toBeGreaterThanOrEqual(2); // PM 走了两步
  for (const e of marked(f)) expect(e.data).toMatchObject({ manual: true, intervention: { by: "pm", role: "pm" } });
});

test("[验收线 2、11] T1：PM 的 stage / task-set / freeze / workflow-set / workflow-resume / deploy、master 的 task-set 都标；纯备注和 ask 不标", async () => {
  const f = fixture("observe");
  await toBuild(f);
  const ok = async (actor: string, ...args: string[]) => expect(await f.cli(actor, ...args)).toMatchObject({ ok: true });
  await ok("pm", "stage", "T1", "--from", "build", "--to", "blocked", "--text", "等 owner");
  await ok("pm", "stage", "T1", "--from", "blocked", "--to", "build");
  await ok("pm", "task-set", "T1", "--rev", rev(f), "--model", "opus");
  await ok("master", "task-set", "T1", "--rev", rev(f), "--model", "sonnet");
  await ok("pm", "freeze", "--reason", "查合并闸", "--project", "p");
  await ok("pm", "unfreeze", "--project", "p");
  await ok("pm", "note", "T1", "只是备注");
  // owner 当面命令 PM 手动上线（样本：Shawn 方 PR #1541）也照标
  await ok("pm", "deploy", "T1", "--version", "v9", "--text", "按 owner 命令手动部署");
  const wfRev = () => String((f.db.query("SELECT rev FROM task_workflows WHERE taskId = 'T1'").get() as { rev: number }).rev);
  await ok("pm", "workflow-set", "T1", "--rev", rev(f), "--workflow-rev", wfRev(), "--template", "code", "--version", "2", "--mode", "manual",
    "--author-family", "claude", "--fallback", "只报错不修", "--reason", "PM 接手", "--reason-code", "owner_hold");
  await ok("pm", "workflow-resume", "T1", "--rev", rev(f), "--workflow-rev", wfRev(), "--reason", "交回");
  expect(cmds(marked(f))).toEqual(["restate-approve", "stage", "task-set", "deploy", "workflow-set", "workflow-resume"]);
  expect(marked(f).find((e) => e.actor === "master")!.data.intervention).toMatchObject({ by: "master", role: "master" });
  expect(cmds(marked(f, ""))).toEqual(["freeze", "unfreeze"]);
  expect(listEvents(f.db, { project: "p", target: "T1" }).find((e) => e.kind === "note" && e.text === "只是备注")!.data.intervention).toBeUndefined();
});

test("[验收线 2] PM 代交 deliver 照标；首次把 spec 卡设成 auto（开卡）不算干预", async () => {
  const f = fixture("observe");
  const born = listEvents(f.db, { project: "p", target: "T1" }).find((e) => e.data.op === "workflow")!;
  expect(born.data.intervention).toBeUndefined();
  await toBuild(f);
  await f.tick();
  expect(await f.cli("agent-task-one", "task-set", "T1", "--rev", rev(f), "--branch", "task/T1", "--pr", PR)).toMatchObject({ ok: true });
  expect(await f.cli("pm", "deliver", "T1", "--from", "build", "--head", H2)).toMatchObject({ ok: true });
  expect(cmds(marked(f))).toEqual(["restate-approve", "deliver"]);
  // 新开一张 spec 卡并首次设 auto：PM 在 CLI 里开卡，不打标记
  createTask(f.db, f.at("owner"), { project: "p", id: "T2", title: "新卡", kind: "code", agent: "agent-task-one" });
  expect(await f.cli("pm", "workflow-set", "T2", "--rev", "1", "--template", "code", "--version", "2", "--mode", "auto", "--author-family", "claude",
    "--fallback", "x")).toMatchObject({ ok: true });
  expect(marked(f, "T2")).toEqual([]);
  // 冒用 start_node 的 dedup 键：同一 attempt 没有 task-new，照标
  expect(await f.cli("pm", "stage", "T1", "--from", "review", "--to", "blocked", "--dedup", "dag-start:T1:fake:restate")).toMatchObject({ ok: true });
  expect(cmds(marked(f))).toEqual(["restate-approve", "deliver", "stage"]);
});

test("[验收线 5] on：同卡 10 分钟内的干预合并成一条推给 owner，满窗口才发、发过不重发", async () => {
  const f = fixture("on");
  const t = ticker(f);
  await toBuild(f);
  expect(await t.run()).toMatchObject({ ok: true, sent: 0, projects: ["p"] }); // 第一次 on：从这一刻起算
  for (const m of ["a", "b", "c"]) expect(await f.cli("pm", "task-set", "T1", "--rev", rev(f), "--model", m)).toMatchObject({ ok: true });
  expect(await t.run()).toMatchObject({ sent: 0 });
  f.advance(10 * MIN);
  expect(await t.run()).toMatchObject({ sent: 1 });
  expect(t.sent[0]).toContain("[人工干预] p · T1");
  expect(t.sent[0]).toContain("pm：task-set×3");
  for (const e of marked(f).slice(-3)) expect(t.sent[0]).toContain(`#${e.seq}`);
  expect(await t.run()).toMatchObject({ sent: 0 });
  // 窗口之后的新干预另起一条
  expect(await f.cli("pm", "deploy", "T1", "--version", "v1")).toMatchObject({ ok: true });
  f.advance(11 * MIN);
  expect(await t.run()).toMatchObject({ sent: 1 });
  expect(t.sent[1]).toContain("pm：deploy×1");
});

test("[验收线 6] observe：只打标记不推送；off：不打标记也不推送", async () => {
  for (const mode of ["observe", "off"] as const) {
    const f = fixture(mode);
    const t = ticker(f);
    await toBuild(f);
    await t.run();
    expect(await f.cli("pm", "task-set", "T1", "--rev", rev(f), "--model", "x")).toMatchObject({ ok: true });
    f.advance(40 * MIN);
    expect(await t.run()).toMatchObject({ ok: true, sent: 0, projects: [] });
    expect(marked(f).length).toBe(mode === "observe" ? 2 : 0);
  }
});

/** 同一串操作在两个开关下各跑一遍，返回事件行（ts / actor / kind / text / data） */
async function script(mode: "off" | "observe") {
  const f = fixture(mode);
  await toBuild(f);
  await f.cli("pm", "stage", "T1", "--from", "build", "--to", "blocked", "--text", "等");
  await f.cli("pm", "task-set", "T1", "--rev", rev(f), "--model", "opus");
  await f.cli("pm", "freeze", "--reason", "查", "--project", "p");
  await f.cli("agent-task-one", "note", "T1", "进度");
  return listEvents(f.db, { project: "p" }).map((e) => ({ ts: e.ts, actor: e.actor, kind: e.kind, target: e.target, text: e.text, data: e.data }));
}

test("[验收线 6] off 与现在逐字一致：和 observe 的唯一差别就是 manual + intervention 两个标记", async () => {
  const off = await script("off");
  const observe = await script("observe");
  expect(off.length).toBe(observe.length);
  for (const e of off) expect(e.data.intervention).toBeUndefined();
  const strip = (d: Record<string, unknown>) => { const { intervention, manual, ...rest } = d; return intervention ? rest : d; };
  const norm = (rows: typeof off) => JSON.stringify(rows.map((r) => ({ ...r, data: strip(r.data) }))).replaceAll(/t68f-auto-[\w]+/g, "<dir>");
  expect(norm(observe)).toBe(norm(off));
  expect(observe.filter((r) => r.data.intervention).length).toBe(4); // restate-approve、stage、task-set、freeze
});

test("[验收线 3] T2：自动卡的意图停在 unknown 满 30 分钟推一次，同一状态版本不重推，状态版本变了再推", async () => {
  const f = fixture("on");
  const t = ticker(f);
  await toBuild(f);
  await f.tick();
  const { id } = f.db.query("SELECT id FROM scheduler_intents WHERE taskId = 'T1' ORDER BY eventSeq DESC LIMIT 1").get() as { id: string };
  const since = Date.UTC(2030, 0, 1);
  f.db.run("UPDATE scheduler_intents SET status = 'unknown', updatedAt = ? WHERE id = ?", [since, id]);
  expect(await t.run(since + 29 * MIN)).toMatchObject({ sent: 0 });
  expect(await t.run(since + 31 * MIN)).toMatchObject({ sent: 1 });
  expect(t.sent[0]).toContain(`[调度停住] p · T1：意图 ${id}`);
  expect(await t.run(since + 90 * MIN)).toMatchObject({ sent: 0 });
  f.db.run("UPDATE scheduler_intents SET updatedAt = ? WHERE id = ?", [since + 60 * MIN, id]);
  expect(await t.run(since + 95 * MIN)).toMatchObject({ sent: 1 });
});

/** 本机时间的下一个 10:05，保证 ts 落在它汇总的 [前一天 10:00, 当天 10:00) 窗口里 */
function digestAfter(ts: number): number {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + (d.getHours() >= 10 ? 1 : 0), 10, 5).getTime();
}

test("[验收线 4] 每日汇总：10:00 后一条，列卡、人、命令、次数和事件号；同一天不重发；没有干预的那天不发", async () => {
  const f = fixture("on");
  const t = ticker(f);
  await toBuild(f);
  await t.run();
  await f.cli("pm", "task-set", "T1", "--rev", rev(f), "--model", "x");
  await f.cli("pm", "freeze", "--reason", "查", "--project", "p");
  const day = digestAfter(f.task().updatedAt);
  await t.run(day);
  const digest = t.sent.filter((s) => s.includes("每日汇总"));
  expect(digest).toHaveLength(1);
  for (const s of ["p · T1（2 次）", "pm：restate-approve×1、task-set×1", "p · (项目)（1 次）", "pm：freeze×1"]) expect(digest[0]).toContain(s);
  await t.run(day + 60 * MIN);
  expect(t.sent.filter((s) => s.includes("每日汇总"))).toHaveLength(1);
  await t.run(day + 24 * 60 * MIN);
  expect(t.sent.filter((s) => s.includes("每日汇总"))).toHaveLength(1);
});

test("[验收线 9、10] 开关按项目：同一份文件 p=on、q=off，各自标记 / 推送；推送只走本进程的 owner 通道", async () => {
  policy({ p: "on", q: "off" });
  const f = autoFixture();
  open.push(f);
  createTask(f.db, f.at("owner"), { project: "q", id: "Q1", title: "q", kind: "code", agent: "agent-task-one" });
  f.db.query("INSERT INTO meta (project, key, value) VALUES ('q', 'pms', '[\"pm\"]')").run();
  setWorkflow(f.db, f.at("owner"), { taskId: "Q1", taskRev: 1, template: "code", templateVersion: 2, mode: "auto", authorFamily: "claude", fallback: "x" });
  const both = { projectIds: ["p", "q"] };
  const t = ticker(f);
  await f.cliWith({ ...both, notifyOwner: async (x) => (t.sent.push(x), true), pmRails: { statePath: join(f.dir, "s.json") } }, "owner", "pm-rails-tick");
  expect(await f.cliWith(both, "pm", "task-set", "T1", "--rev", rev(f), "--model", "x")).toMatchObject({ ok: true });
  expect(await f.cliWith(both, "pm", "task-set", "Q1", "--rev", String(getTask(f.db, "Q1")!.rev), "--model", "x")).toMatchObject({ ok: true });
  expect(marked(f).length).toBe(1);
  expect(listEvents(f.db, { project: "q", target: "Q1" }).filter((e) => e.data.intervention)).toEqual([]);
  f.advance(11 * MIN);
  expect(await f.cliWith({ ...both, notifyOwner: async (x) => (t.sent.push(x), true), pmRails: { statePath: join(f.dir, "s.json") } }, "owner", "pm-rails-tick"))
    .toMatchObject({ ok: true, sent: 1, projects: ["p"] });
  expect(t.sent.join("\n")).not.toContain("Q1");
  // 没有 owner 通道的进程（例如 agent 自己跑）什么都不发、也不报错
  expect(await f.cliWith({ pmRails: { statePath: join(f.dir, "s.json") } }, "owner", "pm-rails-tick")).toMatchObject({ ok: true, sent: 0 });
  expect(await f.cli("pm", "pm-rails-tick")).toMatchObject({ ok: false, code: "forbidden" });
});

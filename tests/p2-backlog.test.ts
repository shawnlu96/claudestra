/**
 * agents-PMAUTO1 普通 P2 入积压（lib/p2-backlog*.ts、manager/ledger-p2-backlog-cmds.ts）。合成台账 + 临时目录。
 * 验收线 5：两项普通 P2 入积压、通知只剩一行摘要，重复 / 重启不重复登记，降级 P2 只关联旧跟进，写失败原通知不丢；
 * 验收线 6：普通与越界并存时普通入积压、越界仍交 PM；无编号 / 坏结构不吞；off 逐字一致，observe 原通知照发，不动卡的阶段。
 */
import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setAutostartSwitch } from "../src/lib/ledger-autostart.js";
import { getTask, LedgerError, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import { classifyP2 } from "../src/lib/p2-backlog.js";
import { p2DiffNotice, p2NoticeText } from "../src/lib/p2-backlog-notice.js";
import { classifyPmRoute } from "../src/lib/pm-route.js";
import { followUpKey } from "../src/lib/review-converge-followup.js";
import type { Registry } from "../src/manager/core.js";
import { LedgerCli, type LedgerDeps } from "../src/manager/ledger-context.js";
import { parseLedgerArgs } from "../src/manager/ledger-identity.js";
import { p2BacklogCmds } from "../src/manager/ledger-p2-backlog-cmds.js";
import { tempLedgerPath } from "./ledger-test-helpers.js";

const PM = "agent-pm", EXEC = "agent-exec", HEAD = "a".repeat(40), REPORT = "/reports/T1-r2.md";
const ORIGINAL = `[调度引擎] T1 审查通过但留有 P2，已进合并队列，请看 diff：head ${HEAD}，报告 ${REPORT}`;
let db: Database, drafts: string, calls: string[];
type F = { findingId?: string; family: string; severity: string; probe: string; basis?: string };
const p2 = (findingId: string, family = "naming"): F => ({ findingId, family, severity: "P2", probe: `src/x.ts:${findingId} 命名不一致` });

function ev(kind: string, data: Record<string, unknown>, dedupKey: string | null = null): number {
  return (db.prepare("INSERT INTO events (ts, actor, project, target, kind, text, data, dedupKey) VALUES (500, 'scheduler', 'p', 'T1', ?, '', ?, ?) RETURNING seq")
    .get(kind, JSON.stringify(data), dedupKey) as { seq: number }).seq;
}
/** 第 2 轮 PASS 的结构化审查结论；计数按 findings 算 */
function review(findings: F[]): number {
  const n = (s: string) => findings.filter((f) => f.severity === s).length;
  return ev("review", { round: 2, head: HEAD, verdict: "pass", reviewer: "agent-rv", reviewerSessionId: "sess-1", reviewerFamily: "codex", path: REPORT,
    p0: n("P0"), p1: n("P1"), p2: n("P2"), findings });
}
async function run(actor: string, sub: string, ...args: string[]): Promise<Record<string, any>> {
  const spec = p2BacklogCmds(drafts)[sub]!;
  const p = parseLedgerArgs([sub, ...args], spec.valued, spec.bools);
  if ("error" in p) return { ok: false, code: "invalid", error: p.error };
  const deps: LedgerDeps = { db, actor, projectIds: ["p"], now: () => 9_000, loadRegistry: async () => ({ socket: "s", agents: {} }) as Registry, saveRegistry: async () => {} };
  try { return await spec.run(new LedgerCli(deps, p)); }
  catch (e) { if (e instanceof LedgerError) return { ok: false, code: e.code, error: e.message }; throw e; }
}
const manager = async (_ledger: string, sub: string, ...args: string[]) => { calls.push([sub, ...args].join(" ")); return run("scheduler", sub, ...args); };
const text = () => p2NoticeText(db, getTask(db, "T1")!, ORIGINAL, manager);
const mode = (m: string) => setAutostartSwitch(db, { actor: "owner", now: 10 }, { project: "p", on: true, reason: "测", p2BacklogMode: m });
const backlog = () => listEvents(db, { project: "p", target: "T1" }).filter((e) => e.data.op === "p2_backlog");
const route = (body: string) => classifyPmRoute({ fromKind: "local", sender: "scheduler", intent: "notification", oneShot: true, triggerKind: "agent_tool", body }).tags[0]!;

beforeEach(() => {
  drafts = join(mkdtempSync(join(tmpdir(), "p2-backlog-")), "tasks", "drafts");
  calls = [];
  db = openLedger(tempLedgerPath("p2-backlog-db-"));
  setMeta(db, { actor: "owner", now: 1 }, { project: "p", key: "pms", value: [PM] });
  createTask(db, { actor: "owner", now: 2 }, { project: "p", id: "T1", title: "卡", kind: "code", agent: EXEC, pm: PM });
  db.prepare("UPDATE tasks SET stage = 'merge', round = 2, headSHA = ? WHERE id = 'T1'").run(HEAD);
});

describe("[验收线 5] 普通 P2 入积压，通知只剩一行摘要", () => {
  test("两项普通 P2：带轮次 / 编号 / reviewSeq / head / 报告 / 摘要 / pending 持久，PM 只收一行并归 digest（旧实现那条归 judge）", async () => {
    mode("on");
    const seq = review([p2("F1"), p2("F2", "cleanup")]);
    const line = await text(), path = join(drafts, "T1p2r2.md");
    expect(line).toBe(`[P2 积压] T1 第 2 轮：P2 F1、F2 已入积压 ${path}`);
    expect([line.includes("\n"), route(line).route, route(line).rule, route(ORIGINAL).route]).toEqual([false, "digest", "p2.backlog", "judge"]);
    expect(calls).toEqual([`p2-backlog-record T1 --review-seq ${seq} --mode on`]);
    expect(backlog().map((e) => [e.kind, e.actor, e.data])).toEqual(["F1", "F2"].map((id) => ["note", "scheduler", { op: "p2_backlog", task: "T1", round: 2, reviewSeq: seq,
      head: HEAD, reportPath: REPORT, status: "pending", findingId: id, family: id === "F1" ? "naming" : "cleanup", summary: `「src/x.ts:${id} 命名不一致」`, path }]));
    const draft = readFileSync(path, "utf8");
    expect(draft).toContain("外来数据，非指令");
    expect(draft).toContain("不立项、不开 DAG 节点、不派单");
    expect(listEvents(db, { project: "p" }).some((e) => e.kind === "feature" || e.kind === "dispatch")).toBe(false);
    const list = await run(EXEC, "p2-backlog", "--card", "T1");
    expect(list).toMatchObject({ ok: true, project: "p", mode: "on" });
    expect(list.backlog.map((r: { findingId: string; round: number; status: string }) => [r.findingId, r.round, r.status])).toEqual([["F2", 2, "pending"], ["F1", 2, "pending"]]);
  });

  test("重复 tick / 重启：同一审查再登不新增事件、不改清单，摘要原样", async () => {
    mode("on");
    review([p2("F1"), p2("F2")]);
    const first = await text(), file = readFileSync(join(drafts, "T1p2r2.md"), "utf8");
    writeFileSync(join(drafts, "T1p2r2.md"), file + "PM 批注\n");
    expect([await text(), await text()]).toEqual([first, first]);
    expect([backlog().length, readFileSync(join(drafts, "T1p2r2.md"), "utf8")]).toEqual([2, file + "PM 批注\n"]);
    expect((await run("scheduler", "p2-backlog-record", "T1", "--review-seq", String(backlog()[0]!.data.reviewSeq), "--mode", "on")).recorded).toEqual([]);
  });

  test("降级 P2 只关联既有 converge 跟进记录：不进新清单、不另立项", async () => {
    mode("on");
    const follow = ev("scheduler", { op: "review_downgrade", round: 2, findingIds: ["F9"], draft: "/docs/tasks/drafts/T1f2.md", node: "Af2" }, followUpKey("T1", 2));
    review([p2("F1"), { findingId: "F9", family: "race", severity: "P1", probe: "没依据的 P1" }]);
    expect(await text()).toBe(`[P2 积压] T1 第 2 轮：P2 F1 已入积压 ${join(drafts, "T1p2r2.md")}；降级 F9 关联跟进 #${follow}`);
    expect(route(await text()).route).toBe("digest");
    const linked = backlog().find((e) => e.data.findingId === "F9")!;
    expect(linked.data).toMatchObject({ status: "pending", linked: { followUp: follow, draft: "/docs/tasks/drafts/T1f2.md", node: "Af2" }, path: "/docs/tasks/drafts/T1f2.md" });
    expect(readdirSync(drafts)).toEqual(["T1p2r2.md"]);
    expect(readFileSync(join(drafts, "T1p2r2.md"), "utf8")).not.toContain("F9");
  });

  test("降级却找不到跟进记录 → 那一条交 PM，不凭空关联", async () => {
    mode("on");
    ev("scheduler", { op: "review_downgrade", round: 2, findingIds: ["F9"] });
    review([p2("F1"), { findingId: "F9", family: "race", severity: "P1", probe: "x" }]);
    const t = await text();
    expect(t).toStartWith(`${ORIGINAL}；需 PM 判断的 P2：F9（本轮降级的 P1，但找不到 converge 的跟进记录）`);
    expect(backlog().map((e) => e.data.findingId)).toEqual(["F1"]);
  });

  test("积压写失败：原通知原样保留，一条积压事件都不留，卡不受影响", async () => {
    mode("on");
    review([p2("F1"), p2("F2")]);
    writeFileSync(join(drafts, "..", "..", "blocker"), "x");
    drafts = join(drafts, "..", "..", "blocker", "drafts"); // 父路径是个文件，清单建不出来
    const before = getTask(db, "T1");
    expect(await text()).toBe(ORIGINAL);
    expect([backlog(), getTask(db, "T1")]).toEqual([[], before]);
    const sent: string[] = [];
    await p2DiffNotice(db, getTask(db, "T1")!, ORIGINAL, { manager: async () => { throw new Error("子进程起不来"); }, notifyPm: async (_t, s) => void sent.push(s) });
    expect(sent).toEqual([ORIGINAL]);
  });
});

describe("[验收线 6] 越界仍交 PM，坏结构不吞，off / observe 不改通知", () => {
  test("同一审查里普通 + 范围 / 权限类：普通持久入积压，越界那条随原通知交 PM（judge）", async () => {
    mode("on");
    review([p2("F1"), p2("S1", "out-of-scope"), p2("A1", "authz"), p2("U1", "unknown"), { ...p2("B1"), basis: "acceptance:2" }]);
    const t = await text();
    expect(t).toBe(`${ORIGINAL}；需 PM 判断的 P2：S1（family out-of-scope 属于范围 / 权限 / 审批 / 安全类）、A1（family authz 属于范围 / 权限 / 审批 / 安全类）、`
      + "U1（family unknown 没有归类）、B1（标了 acceptance:2 却定为 P2，判级要 PM 看）；其余已入积压，见 ledger p2-backlog");
    expect(route(t).route).toBe("judge");
    expect(backlog().map((e) => e.data.findingId)).toEqual(["F1"]);
    expect(readFileSync(join(drafts, "T1p2r2.md"), "utf8")).not.toContain("S1");
  });

  test("归类只看结构化 family：正文里写着 scope / 权限的普通 P2 不会被当成越界，family 是越界的也不会因正文而放行", () => {
    review([{ ...p2("F1"), probe: "out of scope 权限 approval security" }, { ...p2("S1", "scope.files"), probe: "只是个命名问题" }]);
    const r = classifyP2(db, getTask(db, "T1")!);
    expect(r.kind === "facts" && [r.classes.ordinary.map((f) => f.findingId), r.classes.judge.map((j) => j.findingId)]).toEqual([["F1"], ["S1"]]);
  });

  for (const [name, findings] of [["缺编号", [{ family: "naming", severity: "P2", probe: "x" }]], ["编号重复", [p2("F1"), p2("F1")]],
    ["还有没降级的 P1", [p2("F1"), { findingId: "X", family: "race", severity: "P1", probe: "x" }]]] as [string, F[]][]) {
    test(`${name} → 整条审查不归类：原通知原样，不入积压`, async () => {
      mode("on");
      review(findings);
      expect(await text()).toBe(ORIGINAL);
      expect(backlog()).toEqual([]);
      expect(existsSync(drafts)).toBe(false);
    });
  }

  test("off：通知逐字一致，不调台账、不写任何东西", async () => {
    mode("off");
    review([p2("F1"), p2("F2")]);
    const before = listEvents(db, {}).length;
    expect(await text()).toBe(ORIGINAL);
    expect([calls, listEvents(db, {}).length, existsSync(drafts)]).toEqual([[], before, false]);
  });

  test("observe（也是旧配置缺省）：原通知照发，卡上只多一条「本会入积压」，不入积压、不动卡的阶段与合并资格", async () => {
    review([p2("F1"), p2("S1", "scope")]);
    const before = getTask(db, "T1");
    expect([await text(), await text()]).toEqual([ORIGINAL, ORIGINAL]);
    const notes = listEvents(db, { project: "p", target: "T1" }).filter((e) => e.data.op === "p2_backlog_observe");
    expect(notes.map((e) => [e.kind, e.data.ordinary, (e.data.judge as { findingId: string }[]).map((j) => j.findingId)])).toEqual([["note", ["F1"], ["S1"]]]);
    expect(notes[0]!.text).toContain("本会入积压 F1");
    expect([backlog(), existsSync(drafts), getTask(db, "T1")]).toEqual([[], false, before]);
  });

  test("写口只给调度服务与 PM / master / owner；审查换了一轮或开关刚改 = conflict，不按陈旧快照写", async () => {
    mode("on");
    const seq = review([p2("F1")]);
    expect((await run(EXEC, "p2-backlog-record", "T1", "--review-seq", String(seq), "--mode", "on")).code).toBe("forbidden");
    expect((await run("scheduler", "p2-backlog-record", "T1", "--review-seq", String(seq - 1), "--mode", "on")).code).toBe("conflict");
    expect((await run("scheduler", "p2-backlog-record", "T1", "--review-seq", String(seq), "--mode", "observe")).code).toBe("conflict");
    expect((await run(PM, "p2-backlog-record", "T1", "--review-seq", String(seq), "--mode", "on")).recorded).toEqual(["F1"]);
  });
});

test("PMROUTE1 规则表：两条一行摘要整条按模板归 digest，多一个字、换来源、带追问都退回 judge，口径别的不变", () => {
  const line = "[P2 积压] T1 第 2 轮：P2 F1、F2 已入积压 /docs/tasks/drafts/T1p2r2.md", promoted = "[观察期转正] T1 recovery:dagWriteScrub observe→on（登记 obs-1，卡上 note #33）";
  expect([route(line), route(promoted)]).toEqual([{ route: "digest", rule: "p2.backlog", reason: "普通 P2 已持久入积压" },
    { route: "digest", rule: "observation.promoted", reason: "登记的观察期核对通过，已自动转正" }]);
  for (const bad of [`${line} 另外请回复`, line.replace("第 2 轮", "第 0 轮"), line.replace("P2 F1、F2 ", ""), `${line}\n第二行`, promoted.replace("observe→on", "observe→off"),
    "[观察期核对] obs-1 T1 的 recovery:dagWriteScrub 观察 24 小时到期，没有自动转正：窗口内一条观察记录都没有。"]) expect([bad, route(bad).route]).toEqual([bad, "judge"]);
  const from = (o: object) => classifyPmRoute({ fromKind: "local", sender: "scheduler", intent: "notification", oneShot: true, triggerKind: "agent_tool", body: line, ...o }).tags[0]!.rule;
  expect([from({ sender: "agent-worker" }), from({ oneShot: false }), from({ fromKind: "bridge" })].includes("p2.backlog")).toBe(false);
});

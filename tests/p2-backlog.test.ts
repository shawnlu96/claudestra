/**
 * agents-PMAUTO1 普通 P2 入积压（lib/p2-backlog*.ts、manager/ledger-p2-backlog-cmds.ts）。合成台账 + 临时目录。
 * 验收线 5：两项普通 P2 入积压、通知只剩一行摘要，重复 / 重启不重复登记，降级 P2 只关联旧跟进，写失败原通知不丢；
 * 验收线 6：普通与越界并存时普通入积压、越界仍交 PM；无编号 / 坏结构不吞；off 逐字一致，observe 原通知照发，不动卡的阶段。
 */
import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
function review(findings: F[], verdict = "pass"): number {
  const n = (s: string) => findings.filter((f) => f.severity === s).length;
  return ev("review", { round: 2, head: HEAD, verdict, reviewer: "agent-rv", reviewerSessionId: "sess-1", reviewerFamily: "codex", path: REPORT,
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
    const line = await text(), path = join(drafts, `T1p2r2s${seq}.md`);
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
    const path = join(drafts, `T1p2r2s${review([p2("F1"), p2("F2")])}.md`);
    const first = await text(), file = readFileSync(path, "utf8");
    writeFileSync(path, file + "PM 批注\n");
    expect([await text(), await text()]).toEqual([first, first]);
    expect([backlog().length, readFileSync(path, "utf8")]).toEqual([2, file + "PM 批注\n"]);
    expect((await run("scheduler", "p2-backlog-record", "T1", "--review-seq", String(backlog()[0]!.data.reviewSeq), "--mode", "on")).recorded).toEqual([]);
  });

  test("降级 P2 只关联既有 converge 跟进记录：不进新清单、不另立项", async () => {
    mode("on");
    const follow = ev("scheduler", { op: "review_downgrade", round: 2, findingIds: ["F9"], draft: "/docs/tasks/drafts/T1f2.md", node: "Af2" }, followUpKey("T1", 2));
    const name = `T1p2r2s${review([p2("F1"), { findingId: "F9", family: "race", severity: "P1", probe: "没依据的 P1" }])}.md`;
    expect(await text()).toBe(`[P2 积压] T1 第 2 轮：P2 F1 已入积压 ${join(drafts, name)}；降级 F9 关联跟进 #${follow}`);
    expect(route(await text()).route).toBe("digest");
    const linked = backlog().find((e) => e.data.findingId === "F9")!;
    expect(linked.data).toMatchObject({ status: "pending", linked: { followUp: follow, draft: "/docs/tasks/drafts/T1f2.md", node: "Af2" }, path: "/docs/tasks/drafts/T1f2.md" });
    expect(readdirSync(drafts)).toEqual([name]);
    expect(readFileSync(join(drafts, name), "utf8")).not.toContain("F9");
  });

  test("原始结论是 changes、收敛后只剩 P2（真实合并分支）：降级那条关联旧跟进，同审查的普通 P2 照样入积压（第 2 轮审查 p2-downgraded-verdict）", async () => {
    mode("on");
    const follow = ev("scheduler", { op: "review_downgrade", round: 2, findingIds: ["F9"], draft: "/docs/tasks/drafts/T1f2.md", node: "Af2" }, followUpKey("T1", 2));
    const seq = review([p2("F1"), { findingId: "F9", family: "race", severity: "P1", probe: "没依据的 P1" }], "changes");
    const r = classifyP2(db, getTask(db, "T1")!);
    expect(r.kind === "facts" && [r.facts.verdict, r.classes.ordinary.map((f) => f.findingId), r.classes.linked.map((l) => [l.findingId, l.followUp]), r.classes.judge])
      .toEqual(["changes", ["F1"], [["F9", follow]], []]);
    const line = await text();
    expect(line).toBe(`[P2 积压] T1 第 2 轮：P2 F1 已入积压 ${join(drafts, `T1p2r2s${seq}.md`)}；降级 F9 关联跟进 #${follow}`);
    expect(backlog().map((e) => [e.data.findingId, (e.data.linked as { followUp: number } | undefined)?.followUp ?? null])).toEqual([["F1", null], ["F9", follow]]);
    expect(readdirSync(drafts)).toEqual([`T1p2r2s${seq}.md`]);
  });

  test("changes 只有 P2（合并闸同样放行）入积压；changes 还有有效 P1、block 都不归类", async () => {
    mode("on");
    const kinds = (findings: F[], verdict: string) => { review(findings, verdict); const r = classifyP2(db, getTask(db, "T1")!); return r.kind === "facts" ? "facts" : r.why; };
    expect(kinds([p2("F1")], "block")).toBe("审查结论是 block，没过合并闸");
    expect(kinds([p2("F1"), { findingId: "X", family: "race", severity: "P1", probe: "x" }], "changes")).toBe("审查里还有没降级的 P0 / P1，归不了类");
    expect([await text(), backlog()]).toEqual([ORIGINAL, []]);
    const seq = review([p2("F1"), p2("F2")], "changes");
    expect(await text()).toBe(`[P2 积压] T1 第 2 轮：P2 F1、F2 已入积压 ${join(drafts, `T1p2r2s${seq}.md`)}`);
  });

  test("编号 / 清单路径 / 卡号里碰巧带 fail、P0 这类字样仍归 digest：保护只看模板的固定文字，不把结构化字段当正文（第 2 轮审查 p2-notice-wiring）", async () => {
    mode("on");
    drafts = join(mkdtempSync(join(tmpdir(), "p2-backlog-")), "P0", "回滚-failure", "tasks", "drafts");
    const seq = review([p2("typo-failure"), p2("P0-rename", "cleanup")]);
    const line = await text();
    expect(line).toBe(`[P2 积压] T1 第 2 轮：P2 typo-failure、P0-rename 已入积压 ${join(drafts, `T1p2r2s${seq}.md`)}`);
    expect(route(line)).toEqual({ route: "digest", rule: "p2.backlog", reason: "普通 P2 已持久入积压" });
    for (const ok of ["[P2 积压] T1 第 2 轮：P2 F1 已入积压 /docs/P0/tasks/drafts/T1p2r2s9.md", "[P2 积压] agents-FAILOVER1 第 2 轮：降级 fail.F9 关联跟进 #7",
      "[P2 积压] T1 第 2 轮：P2 typo-failure 已入积压 /d/T1p2r2s9.md；降级 P0x 关联跟进 #7",
      "[观察期转正] agents-FAILOVER1 recovery:failScrub observe→on（登记 obs-1，卡上 note #33）"]) expect([ok, route(ok).route]).toEqual([ok, "digest"]);
    // 模板之外多出来的字不是字段：照旧不匹配规则、按正文保护
    for (const bad of ["[P2 积压] T1 第 2 轮：P2 F1 已入积压 /d/x.md 请回复", "[P2 积压] T1 第 2 轮：P2 F1 已入积压 /d/x.md；降级 F9 关联跟进 #7？"]) {
      expect([bad, route(bad).rule]).toEqual([bad, "protect.action"]);
    }
  });

  test("清单目录带 owner决策 字样仍归 digest，不变成 owner 直发；模板外要 owner 拍板的照旧 owner（第 3 轮审查 p2-notice-wiring）", async () => {
    mode("on");
    drafts = join(mkdtempSync(join(tmpdir(), "p2-backlog-")), "owner决策", "drafts");
    const follow = ev("scheduler", { op: "review_downgrade", round: 2, findingIds: ["F9"], draft: "/docs/tasks/drafts/T1f2.md", node: "Af2" }, followUpKey("T1", 2));
    const seq = review([p2("F1"), { findingId: "F9", family: "race", severity: "P1", probe: "没依据的 P1" }]);
    const line = await text();
    expect(line).toBe(`[P2 积压] T1 第 2 轮：P2 F1 已入积压 ${join(drafts, `T1p2r2s${seq}.md`)}；降级 F9 关联跟进 #${follow}`);
    expect(backlog().map((e) => e.data.findingId)).toEqual(["F1", "F9"]);
    const plan = classifyPmRoute({ fromKind: "local", sender: "scheduler", intent: "notification", oneShot: true, triggerKind: "agent_tool", body: line });
    expect(plan).toEqual({ tags: [{ route: "digest", rule: "p2.backlog", reason: "普通 P2 已持久入积压" }], digest: true });
    const dir = "[P2 积压] T1 第 2 轮：P2 F1 已入积压 /docs/需owner拍板/drafts/T1p2r2s9.md";
    expect(route(dir).route).toBe("digest");
    // 模板以外的字（卡号 / 编号的字符集不含中文，对不上模板）、非调度器来源、非一次性消息：owner 决策保护照旧看完整正文
    const owner = { route: "owner" as const, rule: "protect.decision", reason: "明确需要 owner 决策" };
    for (const bad of [`${line}，需 owner 决策`, `${dir} 需owner拍板`, `${ORIGINAL}；需 owner 拍板`, "[P2 积压] owner决策-1 第 2 轮：降级 F9 关联跟进 #7",
      "[P2 积压] T1 第 2 轮：降级 owner拍板.F9 关联跟进 #7"]) expect([bad, route(bad)]).toEqual([bad, owner]);
    for (const from of [{ oneShot: false }, { fromKind: "bridge" as const }]) {
      const m = { fromKind: "local" as const, sender: "scheduler", intent: "notification" as const, oneShot: true, triggerKind: "agent_tool" as const, body: line, ...from };
      expect([from, classifyPmRoute(m)]).toEqual([from, { tags: [owner], immediate: true }]);
    }
    // 其他 agent 的 oneShot 不看正文，只认发送方标的级别（agents-NOTICETYPE1）：没标的进摘要 / pm-todo，要 owner 拍板的由发送方标 action
    const exec = { fromKind: "local" as const, sender: "agent-exec", intent: "notification" as const, oneShot: true, triggerKind: "agent_tool" as const, body: line };
    expect(classifyPmRoute(exec).tags[0]!.rule).toBe("oneshot.unleveled");
    expect(classifyPmRoute({ ...exec, level: "action" })).toMatchObject({ immediate: true });
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

describe("[验收线 5] 清单必须是这次审查的、完整落盘的才算入了积压（第 1 轮审查 p2-draft-validity）", () => {
  const bad: [string, (path: string) => void, string][] = [
    ["路径是个目录", (path) => mkdirSync(path, { recursive: true }), "不是普通文件"],
    ["别的内容占着这个路径", (path) => { mkdirSync(drafts, { recursive: true }); writeFileSync(path, "# 别的文档\n"); }, "不是这次审查的清单"],
    ["清单里少了一条", (path) => { mkdirSync(drafts, { recursive: true }); writeFileSync(path, "## 来源\n- 审查：#SEQ（第 2 轮）\n## 条目\n- F1（「naming」）\n"); }, "缺条目 F2"],
  ];
  for (const [name, arrange, why] of bad) {
    test(`${name} → 不当成已持久：一条事件都不登，通知退回原文，文件原样`, async () => {
      mode("on");
      const seq = review([p2("F1"), p2("F2")]), path = join(drafts, `T1p2r2s${seq}.md`);
      arrange(path);
      if (why.startsWith("缺条目")) writeFileSync(path, readFileSync(path, "utf8").replace("SEQ", String(seq)));
      const r = await run("scheduler", "p2-backlog-record", "T1", "--review-seq", String(seq), "--mode", "on");
      expect([r.code, String(r.error).includes(why)]).toEqual(["invalid", true]);
      expect([await text(), backlog()]).toEqual([ORIGINAL, []]);
    });
  }

  test("空的旧文件按没写过处理：原子写入完整清单后才登记", async () => {
    mode("on");
    const seq = review([p2("F1")]), path = join(drafts, `T1p2r2s${seq}.md`);
    mkdirSync(drafts, { recursive: true });
    writeFileSync(path, "");
    expect(await text()).toBe(`[P2 积压] T1 第 2 轮：P2 F1 已入积压 ${path}`);
    expect(readFileSync(path, "utf8")).toContain(`- 审查：#${seq}（第 2 轮）\n`);
    expect(readdirSync(drafts)).toEqual([`T1p2r2s${seq}.md`]); // 没留临时文件
  });

  test("同一轮来了新的有效审查：另起一份带新 reviewSeq 的清单，新 P2 在里面，旧清单不动", async () => {
    mode("on");
    const first = review([p2("F3")]);
    await text();
    const old = readFileSync(join(drafts, `T1p2r2s${first}.md`), "utf8");
    const second = review([p2("F2"), p2("F3")]);
    expect(await text()).toBe(`[P2 积压] T1 第 2 轮：P2 F2、F3 已入积压 ${join(drafts, `T1p2r2s${second}.md`)}`);
    const fresh = readFileSync(join(drafts, `T1p2r2s${second}.md`), "utf8");
    expect([fresh.includes("- F2（"), fresh.includes(`#${second}（第 2 轮）`), readFileSync(join(drafts, `T1p2r2s${first}.md`), "utf8")]).toEqual([true, true, old]);
    expect(backlog().map((e) => [e.data.reviewSeq, e.data.findingId, e.data.path])).toEqual([[first, "F3", join(drafts, `T1p2r2s${first}.md`)],
      [second, "F2", join(drafts, `T1p2r2s${second}.md`)], [second, "F3", join(drafts, `T1p2r2s${second}.md`)]]);
  });
});

describe("[验收线 6] 越界仍交 PM，坏结构不吞，off / observe 不改通知", () => {
  test("普通是白名单：权限 / 审批类与白名单里没有的新分类都交 PM，不因为「不在黑名单」就入积压（第 1 轮审查 p2-classification）", async () => {
    mode("on");
    review([p2("A1", "authorization"), p2("A2", "access-control"), p2("N1", "new-unrecognized-category"), p2("C1", "concurrency"), p2("T1", "test-permission")]);
    const r = classifyP2(db, getTask(db, "T1")!);
    expect(r.kind === "facts" && [r.classes.ordinary, r.classes.judge.map((j) => [j.findingId, j.why])]).toEqual([[], [
      ["A1", "family authorization 属于范围 / 权限 / 审批 / 安全类"], ["A2", "family access-control 属于范围 / 权限 / 审批 / 安全类"],
      ["N1", "family new-unrecognized-category 不在普通分类白名单里，归不了类"], ["C1", "family concurrency 不在普通分类白名单里，归不了类"],
      ["T1", "family test-permission 属于范围 / 权限 / 审批 / 安全类"]]]);
    const t = await text();
    expect([t.startsWith(`${ORIGINAL}；需 PM 判断的 P2：A1（`), t.includes("其余已入积压"), route(t).route, backlog(), existsSync(drafts)]).toEqual([true, false, "judge", [], false]);
  });

  test("同一审查里普通 + 范围 / 权限类：普通持久入积压，越界那条随原通知交 PM（judge）", async () => {
    mode("on");
    const seq = review([p2("F1"), p2("S1", "out-of-scope"), p2("A1", "authz"), p2("U1", "unknown"), { ...p2("B1"), basis: "acceptance:2" }]);
    const t = await text();
    expect(t).toBe(`${ORIGINAL}；需 PM 判断的 P2：S1（family out-of-scope 属于范围 / 权限 / 审批 / 安全类）、A1（family authz 属于范围 / 权限 / 审批 / 安全类）、`
      + "U1（family unknown 没有归类）、B1（标了 acceptance:2 却定为 P2，判级要 PM 看）；其余已入积压，见 ledger p2-backlog");
    expect(route(t).route).toBe("judge");
    expect(backlog().map((e) => e.data.findingId)).toEqual(["F1"]);
    expect(readFileSync(join(drafts, `T1p2r2s${seq}.md`), "utf8")).not.toContain("S1");
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

  test("observe：原通知照发，卡上只多一条「本会入积压」，不入积压、不动卡的阶段与合并资格", async () => {
    mode("observe"); // PULLTODO1 起缺省 on
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

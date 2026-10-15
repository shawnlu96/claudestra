/**
 * agents-PMAUTO1 生产入口（第 1 轮审查 cli-registration / p2-notice-wiring）：命令经真实的 runLedger 命令表进得去，调度身份只多两条写口，
 * 「审查通过但留有 P2」的通知走真实的调度 tick（scheduler-auto-tick.ts diffNotice → p2-backlog-notice.ts → ledger p2-backlog-record）。
 * 夹具是 T68f 的自动流程（tests/scheduler-auto-helpers.ts）：临时台账、进程内的真 ledger CLI、假 worker。
 */
import { describe, expect, test } from "bun:test";
import { listEvents } from "../src/lib/ledger-store.js";
import { classifyPmRoute } from "../src/lib/pm-route.js";
import { isWriteInvocation } from "../src/manager/write-commands.js";
import { autoFixture, H1, P2, toBuild } from "./scheduler-auto-helpers.js";

type Fixture = ReturnType<typeof autoFixture>;
const ops = (f: Fixture, op: string) => listEvents(f.db, { project: "p", target: "T1" }).filter((e) => e.data.op === op);
const P2B = { findingId: "doc-1", family: "docs", severity: "P2" as const, probe: "README 漏了新参数" };
const SCOPE = { findingId: "scope-1", family: "access-control", severity: "P2" as const, probe: "改了范围外的权限文件" };

/** 卡走到「审查 PASS 但留有 P2」并让调度器把它推进 merge：返回那一轮发给 PM 的通知 */
async function passWithP2(f: Fixture, findings: object[]): Promise<string[]> {
  await toBuild(f);
  await f.tick();
  await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H1);
  await f.tick(); // 审查员会话
  await f.tick(); // 派审
  expect((await f.review("pass", H1, findings)).ok).toBe(true);
  expect(await f.tick()).toMatchObject({ step: "stage", detail: "review→merge" });
  return f.notices;
}
const setMode = async (f: Fixture, m: string) => expect((await f.cli("pm", "autostart-set", "on", "--project", "p", "--p2-backlog", m, "--reason", "测")).ok).toBe(true);

describe("[验收线 1] 命令进了真实的 ledger 入口", () => {
  test("PM / owner 调得到登记、标记、查询；只读的两条按读算", async () => {
    const f = autoFixture();
    try {
      expect(await f.cli("owner", "observation-plans", "--project", "p")).toMatchObject({ ok: true, project: "p", autoMode: "observe", plans: [] });
      expect(await f.cli("agent-task-one", "p2-backlog", "--project", "p")).toMatchObject({ ok: true, mode: "on", backlog: [] }); // PULLTODO1：缺省 on
      // 进得了命令本身：报的是命令自己的参数 / 状态错误，不是「未知子命令」
      const reg = await f.cli("pm", "observation-register", "T1", "--target", "recovery:dagWriteScrub", "--project", "p", "--rule", "v1", "--source", "ledger-events",
        "--hours", "24", "--reason", "x");
      expect([reg.code, String(reg.error)]).toEqual(["invalid", expect.stringContaining("不在 verified")]);
      for (const sub of ["observation-cancel", "observation-mark", "observation-unmark", "observation-recheck"]) {
        const r = await f.cli("pm", sub, "obs-9", "--misjudged", "1", "--reason", "x");
        expect([sub, r.code, String(r.error).includes("未知子命令")]).toEqual([sub, sub === "observation-cancel" || sub === "observation-recheck" ? "invalid" : "not_found", false]);
      }
      expect([isWriteInvocation("ledger", ["observation-plans"]), isWriteInvocation("ledger", ["p2-backlog"])]).toEqual([false, false]);
      for (const sub of ["observation-register", "observation-cancel", "observation-mark", "observation-unmark", "observation-recheck", "observation-due", "p2-backlog-record"]) {
        expect([sub, isWriteInvocation("ledger", [sub])]).toEqual([sub, true]);
      }
    } finally { f.close(); }
  });

  test("调度服务身份只多 observation-due 与 p2-backlog-record 两条；登记 / 撤销 / 标误判 / 清标记 / 放回它调不到", async () => {
    const f = autoFixture();
    try {
      const forbidden = { ok: false, code: "forbidden", error: "调度服务身份只能运行调度专用命令" };
      for (const sub of ["observation-register", "observation-cancel", "observation-mark", "observation-unmark", "observation-recheck", "observation-plans", "p2-backlog"]) {
        expect([sub, await f.cli("scheduler", sub, "T1")]).toEqual([sub, forbidden]);
      }
      expect((await f.cli("scheduler", "observation-due", "T1", "obs-1")).code).toBe("not_found"); // 进了命令：没有这条登记
      expect((await f.cli("scheduler", "p2-backlog-record", "T1", "--review-seq", "1", "--mode", "on")).code).toBe("invalid"); // 进了命令：还没有审查
      expect((await f.cli("agent-task-one", "p2-backlog-record", "T1", "--review-seq", "1", "--mode", "observe")).code).toBe("forbidden");
    } finally { f.close(); }
  });
});

describe("[验收线 5] 真实调度路径：PASS→merge 的 P2 通知", () => {
  test("p2BacklogMode on：两项普通 P2 入积压，PM 只收一行摘要（digest）；再跑几轮不重发、不重复登记", async () => {
    const f = autoFixture();
    try {
      await setMode(f, "on");
      const notices = await passWithP2(f, [P2, P2B]);
      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatch(/^\[P2 积压\] T1 第 1 轮：P2 name-1、doc-1 已入积压 \S+T1p2r1s\d+\.md$/);
      expect(classifyPmRoute({ fromKind: "local", sender: "scheduler", intent: "notification", oneShot: true, triggerKind: "agent_tool", body: notices[0]! }).tags[0])
        .toMatchObject({ route: "digest", rule: "p2.backlog" });
      expect(ops(f, "p2_backlog").map((e) => [e.actor, e.data.findingId, e.data.round, e.data.head, e.data.status])).toEqual([
        ["scheduler", "name-1", 1, H1, "pending"], ["scheduler", "doc-1", 1, H1, "pending"]]);
      for (let i = 0; i < 3; i++) await f.tick();
      expect([f.notices.length, ops(f, "p2_backlog").length, f.task().stage]).toEqual([1, 2, "merge"]);
      expect((await f.cli("pm", "p2-backlog", "--card", "T1") as { backlog: unknown[] }).backlog).toHaveLength(2);
    } finally { f.close(); }
  });

  test("[验收线 6] on：普通的入积压，权限类那条随原通知交 PM（judge）", async () => {
    const f = autoFixture();
    try {
      await setMode(f, "on");
      const [notice] = await passWithP2(f, [P2, SCOPE]);
      expect(notice).toContain("T1 审查通过但留有 P2，已进合并队列，请看 diff");
      expect(notice).toContain("需 PM 判断的 P2：scope-1（family access-control 属于范围 / 权限 / 审批 / 安全类）；其余已入积压");
      expect(ops(f, "p2_backlog").map((e) => e.data.findingId)).toEqual(["name-1"]);
    } finally { f.close(); }
  });

  test("observe：原通知照发，卡上多一条「本会入积压」；off：原通知逐字、不写任何东西", async () => {
    const f = autoFixture(), g = autoFixture();
    try {
      await setMode(f, "observe"); // PULLTODO1 起缺省 on，observe 要显式配
      const [observe] = await passWithP2(f, [P2]);
      expect(observe).toBe(`[调度引擎] T1 审查通过但留有 P2，已进合并队列，请看 diff：head ${H1}，报告 reviews/T1-r1/report.md`);
      expect([ops(f, "p2_backlog_observe").map((e) => e.data.ordinary), ops(f, "p2_backlog")]).toEqual([[["name-1"]], []]);
      await setMode(g, "off");
      expect(await passWithP2(g, [P2])).toEqual([observe]);
      expect([ops(g, "p2_backlog_observe"), ops(g, "p2_backlog")]).toEqual([[], []]);
    } finally { f.close(); g.close(); }
  });
});

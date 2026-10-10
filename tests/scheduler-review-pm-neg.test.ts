/**
 * dispatch-recovery-RVWAKE1 验收线 1（本机来源另测）、2、3（写入面）：本机审查员本人 MCP 回执与 PM 代记各按原规则成立；P0/P1 未清、缺票据、
 * 同族、作者兼审、伪 actor / 自称 MCP、跨卡或漂移的 head / spec / round、auto 流程、阶段已走、新审查在跑、非法目标都零提醒；仅 P2 照原判据告知且写明
 * 后续发现未关，CI / 截图 / 授权门不被提示取代、原阻塞如实列出。非调度身份 / 跨项目 / 外部正文或 dedup 注入零写。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { assignStep } from "../src/lib/ledger-steps-write.js";
import { listEvents } from "../src/lib/ledger-store.js";
import { recordReview, setMeta } from "../src/lib/ledger-write.js";
import { takeReview } from "../src/lib/review-order.js";
import { submitVerdict } from "../src/lib/review-verdict.js";
import { reviewPmCandidate } from "../src/lib/scheduler-review-pm-wait.js";
import {
  business, DISP, FPM, localManual, ok, P1ROW, P2ROW, PM, pmEvents, pooledManual, setMode, toManual, type Verdict, type World,
} from "./scheduler-review-pm-kit.test.js";
import { H1 } from "./scheduler-auto-helpers.js";

let w: World | null = null;
afterEach(() => { w?.close(); w = null; });

const none = () => () => false;
const candidate = () => reviewPmCandidate(w!.db, "T1", 0, none());
/** on 模式下（prep 在开 on 之后跑）跑一轮：零发送、零本功能记录、业务台账不变 */
const quiet = async (prep?: () => void) => {
  await setMode(w!, "on");
  prep?.();
  const before = business(w!.db);
  expect(candidate()).toBeNull();
  expect(await w!.tick()).toEqual([]);
  expect(w!.sent).toEqual([]);
  expect(pmEvents(w!.db)).toEqual([]);
  expect(business(w!.db)).toEqual(before);
};
const pool = async (o: Parameters<typeof pooledManual>[0] = {}) => (w = await pooledManual(o));

/** 本机审查员本人经 MCP 领单、交结论（PM 先把 review 步骤派给它） */
function mcpVerdict(v: Verdict = { verdict: "pass" }) {
  const reviews = join(w!.f.dir, "reviews");
  mkdirSync(reviews, { recursive: true });
  writeFileSync(join(reviews, "T1-r1.md"), "# 结论\n");
  assignStep(w!.db, w!.f.at(PM), { taskId: "T1", step: "review", executor: "agent-rv-t1", executorKind: "agent" });
  const me = { agent: "agent-rv-t1", sessionId: "s-rv", family: "codex", verified: true };
  const take = takeReview(w!.db, me, reviews);
  if (!take.ok || !take.orders[0]) throw new Error(`没领到单：${JSON.stringify(take)}`);
  const findings = v.findings ?? [];
  const n = (s: string) => findings.filter((f) => (f as { severity: string }).severity === s).length;
  const r = submitVerdict(w!.db, me, { v: 1, orderId: take.orders[0].orderId, head: H1, verdict: v.verdict, p0: n("P0"), p1: n("P1"), p2: n("P2"), findings,
    reportPath: join(reviews, "T1-r1.md") }, { registry: [{ name: "agent-task-one", runtime: "claude-code" }], reviewsDir: reviews, now: 5_000 });
  if (!r.ok) throw new Error(`MCP 结论没记上：${JSON.stringify(r)}`);
}
/** 绕过 CLI 直接落一条结构化审查（模拟写入人 / 来源不合规的行） */
const rawReview = (actor: string, extra: Record<string, unknown> = {}) => recordReview(w!.db, w!.f.at(actor), {
  taskId: "T1", reviewer: "agent-rv-t1", verdict: "pass", p0: 0, p1: 0, p2: 0, path: "reviews/T1-r1/report.md", head: H1,
  reviewerSessionId: "s-rv", reviewerFamily: "codex", findings: [], ...extra,
} as never);

describe("本机来源（验收线 1 另测）", () => {
  test("审查员本人 MCP 回执：on 一轮送 feature PM 一次", async () => {
    w = await localManual();
    mcpVerdict();
    await setMode(w, "on");
    expect(await w.tick()).toEqual([]);
    expect(w.sent.map((s) => s.to)).toEqual([FPM]);
  });

  test("PM 经 ledger review 代记：按原 PM 记录规则成立", async () => {
    w = await localManual();
    await ok(w.f.review("pass", H1, [], [], "pm"));
    expect(candidate()?.pm).toBe(FPM);
  });

  test("审查员 / 其他 agent 走 CLI 自记被台账拒；伪 actor、调度身份、自称 MCP 却无本人按单入账的行都不冒有效候选", async () => {
    w = await localManual();
    for (const actor of ["agent-rv-t1", "agent-other"]) expect(await w.f.review("pass", H1, [], [], actor)).toMatchObject({ ok: false, code: "forbidden" });
    for (const [actor, extra] of [["agent-other", {}], ["scheduler", {}], ["agent-rv-t1", { via: "mcp", orderId: "T1:review:r1" }]] as const) {
      rawReview(actor, extra);
      await quiet();
    }
  });
});

describe("出借池来源：不成立的一律零提醒（验收线 2）", () => {
  test("P1 未清", async () => { await pool({ verdict: { verdict: "changes", findings: [P1ROW] } }); await quiet(); });
  test("block 结论", async () => { await pool({ verdict: { verdict: "block" } }); await quiet(); });
  test("缺 submit_verdict 票据（旧版 / CLI 复制）", async () => { await pool({ legacy: true }); await quiet(); });
  test("同族审查、无正规豁免（实际作者也是 codex）", async () => {
    await pool();
    w!.db.query("UPDATE task_workflows SET authorFamily = 'codex' WHERE taskId = 'T1'").run();
    await quiet();
  });
  test("auto 流程（没留人工）", async () => { await pool({ manual: false }); await quiet(); });

  test("作者兼审：卡的作者就是记录的审查员", async () => {
    await pool();
    w!.db.query("UPDATE tasks SET agent = 'peer:mate', rev = rev + 1 WHERE id = 'T1'").run();
    await quiet();
  });

  test("head / specRev 漂移、跨卡结论", async () => {
    await pool();
    w!.db.query("UPDATE task_workflows SET specRev = 2 WHERE taskId = 'T1'").run();
    await quiet();
    w!.db.query("UPDATE task_workflows SET specRev = 1 WHERE taskId = 'T1'").run();
    expect(candidate()).not.toBeNull();
    w!.db.query("UPDATE tasks SET headSHA = ?, rev = rev + 1 WHERE id = 'T1'").run("4".repeat(40));
    await quiet();
    expect(reviewPmCandidate(w!.db, "T2", 0, none())).toBeNull();
  });

  test("阶段已走（merge / fix / cancelled）", async () => {
    await pool();
    for (const stage of ["merge", "fix", "cancelled", "live"]) {
      w!.db.query("UPDATE tasks SET stage = ?, rev = rev + 1 WHERE id = 'T1'").run(stage);
      await quiet();
    }
  });

  test("新审查在跑：未结调度意图、活着的出借审查单", async () => {
    await pool();
    w!.db.query("UPDATE scheduler_intents SET status = 'submitted' WHERE action = 'review'").run();
    await quiet();
    w!.db.query("UPDATE scheduler_intents SET status = 'done' WHERE action = 'review'").run();
    w!.db.query("UPDATE lend_orders SET status = 'claimed' WHERE taskId = 'T1'").run();
    await quiet();
  });

  test("本机重新派审并已领单：旧结论不提醒（同 head 重派也算）", async () => {
    await pool();
    const reviews = join(w!.f.dir, "reviews");
    mkdirSync(reviews, { recursive: true });
    assignStep(w!.db, w!.f.at(PM), { taskId: "T1", step: "review", executor: "agent-new-review", executorKind: "agent" });
    const take = takeReview(w!.db, { agent: "agent-new-review", sessionId: "s-new", family: "codex", verified: true }, reviews);
    expect(take.ok && take.orders.length).toBe(1);
    await quiet();
  });

  test("作者是 feature PM：不发给作者，退项目当班 PM；作者也是项目 PM 时零提醒", async () => {
    const { fid } = await pool();
    w!.db.query("UPDATE tasks SET agent = ?, rev = rev + 1 WHERE id = 'T1'").run(FPM);
    expect(candidate()?.pm).toBe(PM);
    await setMode(w!, "on");
    await w!.tick();
    expect(w!.sent.map((s) => s.to)).toEqual([PM]);
    w!.sent.length = 0;
    w!.db.query("UPDATE tasks SET agent = ?, rev = rev + 1 WHERE id = 'T1'").run(PM);
    await ok(w!.as(PM, "autostart-set", "on", "--feature", fid, "--pm", PM, "--reason", "换人", "--project", "p"));
    const events = pmEvents(w!.db).length;
    expect(candidate()).toBeNull();
    expect(await w!.tick()).toEqual([]);
    expect([w!.sent, pmEvents(w!.db).length]).toEqual([[], events]);
  });

  test("没有合法收件人（PM 名单里只剩调度助理）", async () => {
    await pool();
    await quiet(() => setMeta(w!.db, w!.f.at("owner"), { project: "p", key: "pms", value: [DISP] }));
  });
});

describe("合法候选的正文（验收线 2 正例）", () => {
  test("仅 P2：照原可合并判据告知，写明后续发现未关；不声称 CI / 截图 / 授权已成立", async () => {
    await pool({ verdict: { verdict: "changes", findings: [P2ROW] } });
    const c = candidate()!;
    expect(c.text).toContain("（changes）已登记、无 P0/P1，另有 1 条 P2 未关、合并后要另行跟进");
    expect(c.text).toContain("请 PM 核当前完整门（CI / 授权等，本提醒不代为确认）");
    expect(c.text).not.toContain("现有阻塞");
  });

  test("原有阻塞如实列出、不解除：冻结、PM hold、未答审批", async () => {
    await pool();
    await toManual(w!); // 已是 manual 的卡再 workflow-set manual = 明确 hold
    w!.db.query("INSERT INTO meta (project, key, value) VALUES ('p', 'queueFrozen', ?)").run(JSON.stringify({ frozen: true, reason: "测试", since: 1 }));
    w!.db.query(`INSERT INTO asks (id, project, taskId, source, kind, title, state, createdAt, updatedAt, expiresAt)
      VALUES ('ask-1', 'p', 'T1', 'human', 'authorize', '授权', 'open', 1, 1, 9e15)`).run();
    const c = candidate()!;
    expect(c.text).toMatch(/现有阻塞：项目合并队列冻结中、卡被明确留在人工 #\d+、1 条审批未答（照原规则处置，本提醒不解除）/);
    expect((w!.db.query("SELECT state FROM asks WHERE id = 'ask-1'").get() as { state: string }).state).toBe("open");
  });
});

describe("写入面（验收线 3）", () => {
  test("非调度身份、跨项目、外部正文 / dedup / pm 注入、多余参数一律零写", async () => {
    await pool();
    await setMode(w!, "on");
    const c = candidate()!;
    const before = JSON.stringify(listEvents(w!.db, {}));
    const bad: [string, string[]][] = [
      [PM, ["scheduler-autostart", "review-pm", "T1", "record", c.key, "--mode", "on", "--pm", c.pm]],
      ["scheduler", ["scheduler-autostart", "review-pm", "T1", "record", c.key, "--mode", "on", "--pm", c.pm, "--text", "伪正文"]],
      ["scheduler", ["scheduler-autostart", "review-pm", "T1", "record", c.key, "--mode", "on", "--pm", c.pm, "--dedup", "x"]],
      ["scheduler", ["scheduler-autostart", "review-pm", "T1", "record", c.key, "--mode", "on", "--pm", "agent-evil"]],
      ["scheduler", ["scheduler-autostart", "review-pm", "T1", "record", c.key, "--mode", "on", "--pm", DISP]],
      ["scheduler", ["scheduler-autostart", "review-pm", "T1", "record", "0123456789abcdef", "--mode", "on", "--pm", c.pm]],
      ["scheduler", ["scheduler-autostart", "review-pm", "T1", "record", c.key, "--mode", "off", "--pm", c.pm]],
      ["scheduler", ["scheduler-autostart", "review-pm", "T1", "record", c.key, "extra", "--mode", "on", "--pm", c.pm]],
      ["scheduler", ["scheduler-autostart", "review-pm", "T1", "sent", "1", "--mode", "on", "--pm", c.pm]],
    ];
    for (const [actor, args] of bad) expect(await w!.as(actor, ...args)).toMatchObject({ ok: false });
    w!.db.query("UPDATE tasks SET project = 'q', rev = rev + 1 WHERE id = 'T1'").run();
    expect(await w!.as("scheduler", "scheduler-autostart", "review-pm", "T1", "record", c.key, "--mode", "on", "--pm", c.pm)).toMatchObject({ ok: false });
    expect(JSON.stringify(listEvents(w!.db, {}))).toBe(before);
  });

  test("开关只收 on / observe / off，只有项目 PM / master / owner 能改", async () => {
    await pool();
    expect(await w!.as(PM, "autostart-set", "on", "--review-pm-wait", "maybe", "--reason", "测试", "--project", "p")).toMatchObject({ ok: false, code: "invalid" });
    expect(await w!.as("agent-task-one", "autostart-set", "on", "--review-pm-wait", "on", "--reason", "测试", "--project", "p")).toMatchObject({ ok: false });
    expect((await setMode(w!, "on")).autostart).toMatchObject({ reviewPmWait: "on" });
  });
});

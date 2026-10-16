/**
 * UIEVID2：调度器发「请 PM 看前后截图」之前重核正规登记的截图证据。已知漂移（登记旧截图后新 head 交付没带清单）不叫 PM、
 * 不记 pm_notice 回执，卡上记 note 并以调度器身份退回 fix，修复意见为固定重拍文案；证据有效 / 无正规登记的历史摘要照旧通知；
 * uiDelivery=observe 下 missing 仍允许代码交付。真实 ledger CLI 进程内跑，临时工件根 / 策略文件。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { UI_ARTIFACT_ROOT } from "../src/lib/ledger-deliver-ui-port.js";
import { listEvents } from "../src/lib/ledger-store.js";
import { uiEvidenceDigest, type UiEvidence } from "../src/lib/order-deliver-ui.js";
import { currentOrders, orderWireFor } from "../src/lib/order-take.js";
import { RECOVERY_POLICY_PATH } from "../src/lib/recovery-policy.js";
import { autoSnapshot } from "../src/lib/scheduler-auto-snapshot.js";
import { UI_EVIDENCE_REDO_TEXT } from "../src/lib/scheduler-ui-evidence-notice.js";
import { uiRejectFix } from "../src/lib/scheduler-ui-gate.js";
import { autoFixture, DIGEST, H2, P1, toBuild } from "./scheduler-auto-helpers.js";

type F = ReturnType<typeof autoFixture>;
const H3 = "3".repeat(40);
const png = (s: string) => Buffer.from(`\x89PNG\r\n\x1a\n${s}`);
const policy = (mode: "on" | "observe") => {
  mkdirSync(join(RECOVERY_POLICY_PATH, ".."), { recursive: true });
  writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify({ projects: { p: { keys: { uiDelivery: mode } } } }));
};

/** 本机工件根下本卡目录的一组前后截图与正规清单（绑定 head / 目标轮次） */
function evidence(head: string, round: number): UiEvidence {
  mkdirSync(join(UI_ARTIFACT_ROOT, "T1", "shots"), { recursive: true });
  const shots = (["before", "after"] as const).map((phase) => {
    const b = png(`T1-${phase}-${head.slice(0, 4)}`);
    writeFileSync(join(UI_ARTIFACT_ROOT, "T1", "shots", `home-${phase}.png`), b);
    return { view: "home", size: "1280x800", phase, ref: `shots/home-${phase}.png`, sha256: createHash("sha256").update(b).digest("hex") };
  });
  const e = { v: 1 as const, taskId: "T1", head, specRev: 1, round, source: "local" as const, summary: "首页前后", shots };
  return { ...e, digest: uiEvidenceDigest(e) };
}

/** build 交付时（uiDelivery=on）正规登记 H2 的截图，卡进 review */
async function registered(): Promise<{ f: F; e: UiEvidence }> {
  const f = autoFixture({ template: "ui" });
  await toBuild(f);
  await f.tick();
  policy("on");
  const e = evidence(H2, f.task().round + 1);
  expect(await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H2, "--ui-evidence", JSON.stringify(e))).toMatchObject({ ok: true });
  expect(f.task().extra.screenshotsDigest).toBe(e.digest);
  await f.tick();
  await f.tick();
  return { f, e };
}

/** 旧截图登记后审查打回，observe 下新 head 不带清单交付（照收），再审查通过 */
async function drifted(): Promise<{ f: F; e: UiEvidence }> {
  const r = await registered(), { f } = r;
  await f.review("changes", H2, [P1]);
  expect(await f.tick()).toMatchObject({ step: "stage", detail: "review→fix" });
  await f.tick();
  policy("observe");
  expect(await f.cli("agent-task-one", "deliver", "T1", "--from", "fix", "--head", H3)).toMatchObject({ ok: true }); // [验收线 3] missing 照收
  expect(f.task()).toMatchObject({ stage: "review", headSHA: H3 });
  expect(f.task().extra.screenshotsDigest).toBe(r.e.digest); // 摘要仍绑旧 head
  await f.tick();
  await f.tick();
  expect(await f.review("pass", H3, [])).toMatchObject({ ok: true });
  return r;
}

const screenshotNotices = (f: F) => f.notices.filter((n) => n.includes("请看前后截图"));
const lastAsk = (f: F) => f.db.query("SELECT status, receipt FROM scheduler_intents WHERE action = 'ask' ORDER BY eventSeq DESC LIMIT 1").get() as
  { status: string; receipt: string | null } | null;

beforeEach(() => { rmSync(UI_ARTIFACT_ROOT, { recursive: true, force: true }); });
afterEach(() => { rmSync(RECOVERY_POLICY_PATH, { force: true }); rmSync(UI_ARTIFACT_ROOT, { recursive: true, force: true }); });

describe("PM 截图验收通知前重核", () => {
  test("[验收线 2] 旧截图登记后新 head 不带清单交付并审查通过：不叫 PM、无 pm_notice 回执，记 note、以调度器身份退回 fix，修复意见为固定重拍文案", async () => {
    const { f } = await drifted();
    try {
      expect(await f.tick()).toMatchObject({ step: "replan", detail: expect.stringContaining("截图证据需补交") });
      expect(screenshotNotices(f)).toHaveLength(0);
      expect(lastAsk(f)).toMatchObject({ status: "cancelled" });
      expect(lastAsk(f)?.receipt).not.toContain("pm_notice");
      const events = listEvents(f.db, { target: "T1" });
      const note = events.findLast((e) => e.kind === "note")!;
      expect(note).toMatchObject({ actor: "scheduler", text: expect.stringMatching(/^截图证据需补交：.+/) });
      const redo = events.findLast((e) => e.kind === "decision")!;
      expect(redo).toMatchObject({ actor: "scheduler", data: { op: "ui_rejected", by: "scheduler", head: H3, note: UI_EVIDENCE_REDO_TEXT, code: "evidence_drift" } });
      expect(events.some((e) => e.actor === "pm" && String(e.data.op).startsWith("ui_"))).toBe(false); // 不冒 PM

      expect(await f.tick()).toMatchObject({ step: "stage", detail: "review→fix" });
      const fix = uiRejectFix(autoSnapshot(f.db, f.task(), { registry: [], maxWorkers: 2 }))!;
      expect(fix.findings).toEqual([expect.objectContaining({ severity: "P1", family: "ui_screenshot", probe: UI_EVIDENCE_REDO_TEXT })]);
      expect(fix.reportPath).toContain("调度器截图证据重核");
      expect(fix.reportPath).not.toContain("PM");
      expect(await f.tick()).toMatchObject({ step: "sent" });
      const [order] = currentOrders(f.db, { agent: "agent-task-one", sessionId: "s-one", family: "claude-code", channelId: "ch-one" } as never);
      const pulled = orderWireFor(f.db, order!);
      if (!pulled.ok) throw new Error(pulled.error);
      expect(pulled.order).toMatchObject({ step: "fix", findings: [{ family: "ui_screenshot", probe: UI_EVIDENCE_REDO_TEXT }] });
      expect(screenshotNotices(f)).toHaveLength(0);
    } finally { f.close(); }
  });

  test("[验收线 3] 当前有效的正规登记照常通知 PM", async () => {
    const { f, e } = await registered();
    try {
      expect(await f.review("pass", H2, [])).toMatchObject({ ok: true });
      expect(await f.tick()).toMatchObject({ step: "ask", detail: expect.stringContaining("pm_notice 已发") });
      expect(screenshotNotices(f)).toHaveLength(1);
      expect(screenshotNotices(f)[0]).toContain(e.digest);
      expect(listEvents(f.db, { target: "T1" }).some((x) => x.data.by === "scheduler")).toBe(false);
    } finally { f.close(); }
  });

  test("[验收线 3] 无正规登记的历史 / 手工摘要照旧通知（兼容）", async () => {
    const f = autoFixture({ template: "ui" });
    try {
      await toBuild(f);
      await f.tick();
      await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H2);
      await f.tick();
      await f.tick();
      await f.review("pass", H2, []);
      expect(await f.tick()).toMatchObject({ step: "ask", detail: expect.stringContaining("pm_notice 已发") });
      expect(screenshotNotices(f)[0]).toContain(DIGEST);
    } finally { f.close(); }
  });

  test("写口只给调度器身份，且事务内重核：证据有效时不退回", async () => {
    const { f, e } = await registered();
    try {
      expect(await f.review("pass", H2, [])).toMatchObject({ ok: true });
      const args = ["scheduler-ui-evidence-redo", "T1", "--head", H2, "--digest", e.digest];
      for (const who of ["pm", "agent-task-one"]) expect(await f.cli(who, ...args)).toMatchObject({ ok: false, code: "forbidden" });
      expect(await f.cli("scheduler", ...args)).toMatchObject({ ok: false, code: "conflict" });
      expect(listEvents(f.db, { target: "T1" }).some((x) => x.data.by === "scheduler")).toBe(false);
    } finally { f.close(); }
  });

  test("非管理者伪造的 by=scheduler 退回不算数", async () => {
    const { f } = await drifted();
    try {
      const { appendEvent } = await import("../src/lib/ledger-write.js");
      appendEvent(f.db, f.at("agent-task-one"), { project: "p", target: "T1", kind: "decision",
        data: { op: "ui_rejected", by: "scheduler", head: H3, specRev: 1, round: f.task().round, screenshotsDigest: f.task().extra.screenshotsDigest, note: "x" } });
      expect(uiRejectFix(autoSnapshot(f.db, f.task(), { registry: [], maxWorkers: 2 }))).toBeNull();
      expect(autoSnapshot(f.db, f.task(), { registry: [], maxWorkers: 2 }).pmUiGate).toMatchObject({ state: "none" });
    } finally { f.close(); }
  });
});

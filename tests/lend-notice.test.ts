/**
 * i28-W1 给出借方 owner 的通知（src/lib/lend-notice.ts）：开跑通知交出去才起 worker；交付 / 停止通知随终态记进 journal，
 * 没交出去的每轮补发、进程重启后照补，补到为止只发一次。A 与 worker 都是假的（tests/lend-harness.ts）。
 */
import { describe, expect, test } from "bun:test";
import { workerName } from "../src/lib/lend-drive.js";
import { advance, getOrder } from "../src/lib/lend-journal.js";
import { lendNoticeProblem, lendNoticeText, type LendNoticeParams } from "../src/lib/lend-notice.js";
import { harness, sha, toStarted } from "./lend-harness.js";

const N: LendNoticeParams = { orderId: "o1", peer: "team-a", fp: "abcd-ef01-2345-6789", family: "codex", repo: "shawnlu96/claudestra", pr: 270,
  head: "c".repeat(40), taskId: "T93", step: "review", quota: "今天第 1/5 单", kind: "start", why: null };
const body = { v: 1, orderId: "o1", gen: 1, verdict: { v: 1 }, report: "r", session: { id: "thr-1", family: "codex" } };
const toResult = (h: ReturnType<typeof harness>) => advance(h.db, "o1", "started", "result_pending", { payload: body, payloadSha: sha(JSON.stringify(body)) });

describe("通知正文与参数", () => {
  test("开跑通知写明「这会让发起方的任务在你的用户下随时起 shell」、仓库 / PR / head / 怎么收回；停止通知带原因", () => {
    const start = lendNoticeText(N);
    for (const s of ["出借开跑", "这会让发起方的任务在你的用户下随时起 shell", "https://github.com/shawnlu96/claudestra/pull/270", "c".repeat(40), "随时收回：设置 → Peer 协作 → 收回"]) {
      expect(start).toContain(s);
    }
    const stop = lendNoticeText({ ...N, kind: "stopped", why: "出借授权已收回或失效：已收回" });
    expect(stop).toContain("出借停止");
    expect(stop).toContain("原因：出借授权已收回");
    expect(stop).not.toContain("随时起 shell");
    expect(start).not.toMatch(/manager|lend revoke/); // 不让人去跑命令：收回走网页按钮
    expect(lendNoticeText({ ...N, kind: "acked" })).toContain("出借交付");
  });

  test("参数：种类只认三种、原因是一行字、不认识的字段拒", () => {
    expect(lendNoticeProblem(N)).toBeNull();
    expect(lendNoticeProblem({ ...N, kind: "x" })).toMatch(/kind/);
    expect(lendNoticeProblem({ ...N, why: "a\nb" })).toMatch(/why/);
    expect(lendNoticeProblem({ ...N, extra: 1 })).toMatch(/不认识/);
  });
});

describe("P1-4 开跑通知先交出去才起 worker", () => {
  test("通知一直没交出去：一直不起；交出去之后才起，且只发一次", async () => {
    const h = harness();
    h.inform.ok = false;
    for (let i = 0; i < 8; i++) await h.tick();
    expect(h.log.created).toEqual([]);
    expect(getOrder(h.db, "o1")!.state).toBe("cloned");
    h.inform.ok = true;
    for (let i = 0; i < 3; i++) await h.tick();
    expect(h.log.created).toEqual([workerName("o1")]);
    expect(h.noticeKinds()).toEqual(["start:o1"]);
  });
});

describe("P1-4 交付 / 停止通知丢了，重启后补", () => {
  test("交付：回执验过记 acked，同时发交付通知；没交出去就留着收尾，下一轮补发，补到为止只发一次", async () => {
    const h = harness();
    await toStarted(h);
    toResult(h);
    h.inform.ok = false;
    await h.tick();
    const row = getOrder(h.db, "o1")!;
    expect(row.state).toBe("acked");
    expect(row.notices!.end).toMatchObject({ kind: "acked", sentAt: null });
    expect(row.settle).not.toBeNull(); // 收尾没做完：通知还欠着
    h.inform.ok = true;
    await h.tick();
    expect(h.noticeKinds()).toEqual(["start:o1", "acked:o1"]);
    expect(getOrder(h.db, "o1")).toMatchObject({ settle: null, notices: { end: { kind: "acked", sentAt: expect.any(Number) } } });
    await h.tick();
    expect(h.noticeKinds()).toEqual(["start:o1", "acked:o1"]);
    expect(h.log.receipts.map((r) => r.orderId)).toEqual(["o1"]);
  });

  test("停止：进程在通知发出前退出，换一个进程（同一份 journal）接着跑，补发停止通知", async () => {
    const h = harness();
    await toStarted(h);
    h.inform.ok = false;
    h.liveness.set(workerName("o1"), "no_host");
    h.registry.delete(workerName("o1"));
    for (let i = 0; i < 3; i++) { await h.tick(); h.advanceTime(5 * 60_000); }
    expect(getOrder(h.db, "o1")).toMatchObject({ state: "stopped", notices: { end: { kind: "stopped", sentAt: null } } });
    const fresh = harness(); // 「重启」：新进程、新依赖，同一份 journal
    fresh.d.db = h.db;
    await fresh.tick();
    expect(fresh.noticeKinds()).toEqual(["stopped:o1"]);
    expect(fresh.log.notices[0].why).toBeTruthy();
    expect(getOrder(h.db, "o1")!.settle).toBeNull();
  });

  test("没起过 worker 的单（退回 not_started）不发交付 / 停止通知", async () => {
    const h = harness();
    h.d.clone = async () => ({ ok: false, reason: "head 对不上" });
    for (let i = 0; i < 4; i++) await h.tick();
    expect(getOrder(h.db, "o1")!.state).toBe("released");
    expect(h.log.notices).toEqual([]);
  });
});

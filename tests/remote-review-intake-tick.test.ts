// RRL-1 验收线 3/8/12：调度器一轮内把收件入账、发 PM 通知并记送达；被挡的卡留着文件，拒收的移走并告诉 PM 原文在哪。
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { listInbox } from "../src/lib/remote-review-inbox.js";
import { unsentRemoteNotices } from "../src/lib/remote-review-read.js";
import { remoteReviewStep } from "../src/lib/remote-review-tick.js";
import { SchedulerStopped } from "../src/lib/scheduler-maintenance.js";
import { HEAD, HEAD2, handoffConfig, P0_TEXT, P1_TEXT, pushText, remoteFixture } from "./helpers/remote-review-fixture.js";

let fx: ReturnType<typeof remoteFixture>;
afterEach(() => fx?.cleanup());

function harness(opts: { held?: boolean; failNotify?: number } = {}) {
  const notices: { project: string; text: string }[] = [], calls: string[][] = [];
  let failures = opts.failNotify ?? 0, clock = 10_000_000;
  const manager = async (...args: string[]): Promise<Record<string, unknown>> => {
    calls.push(args);
    if (args[0] !== "ledger" || args[1] !== "scheduler-remote-review") throw new Error(`unexpected ${args.join(" ")}`);
    if (opts.held) return { ok: false, code: "v2_held", held: true, error: "held" };
    return fx.cli("scheduler", ...args.slice(2));
  };
  const notify = async (project: string, text: string) => {
    if (failures > 0) { failures--; throw new Error("bridge down"); }
    notices.push({ project, text });
  };
  const step = (config = handoffConfig()) => remoteReviewStep(fx.db, config, { manager, active: () => {}, notify, dir: fx.inbox, now: () => clock });
  return { step, notices, calls, tick: (ms: number) => { clock += ms; } };
}

describe("RRL-1 tick", () => {
  test("[验收线 3/8] one pass books the file, deletes it, sends the P0 notice once and marks it sent", async () => {
    fx = remoteFixture();
    fx.stash(P0_TEXT);
    const h = harness();
    expect(await h.step()).toEqual([]);
    expect(listInbox(fx.inbox)).toEqual([]);
    expect(fx.remoteEvents().length).toBe(1);
    expect(getWorkflow(fx.db, "T1")!.mode).toBe("manual");
    expect(h.notices.length).toBe(1);
    expect(h.notices[0]!.project).toBe("p");
    expect(h.notices[0]!.text).toContain("T1-remote-PR1600-r1.md");
    expect(unsentRemoteNotices(fx.db, "p")).toEqual([]);
    expect(await h.step()).toEqual([]);
    expect(h.notices.length).toBe(1);
  });

  test("[验收线 4] a resend in the next pass books as duplicate: no new event, no new notice", async () => {
    fx = remoteFixture({ mode: "manual" });
    const h = harness();
    fx.stash(P1_TEXT);
    await h.step();
    fx.stash(P1_TEXT);
    await h.step();
    expect(fx.remoteEvents().length).toBe(1);
    expect(h.notices.length).toBe(1);
    expect(listInbox(fx.inbox)).toEqual([]);
  });

  test("a failed notice is retried after a minute and marked only once sent", async () => {
    fx = remoteFixture();
    fx.stash(P0_TEXT);
    const h = harness({ failNotify: 1 });
    expect((await h.step()).map((f) => f.taskId)).toEqual(["T1"]);
    expect(unsentRemoteNotices(fx.db, "p").length).toBe(1);
    expect(await h.step()).toEqual([]); // inside the spacing: not tried again
    expect(h.notices).toEqual([]);
    h.tick(61_000);
    expect(await h.step()).toEqual([]);
    expect(h.notices.length).toBe(1);
    expect(unsentRemoteNotices(fx.db, "p")).toEqual([]);
  });

  test("[验收线 5/8] a P0 that arrived early acts in the first pass after the card reaches its head", async () => {
    fx = remoteFixture({ head: HEAD2, stage: "build" });
    fx.stash(P0_TEXT);
    const h = harness();
    await h.step();
    expect(getWorkflow(fx.db, "T1")!.mode).toBe("auto");
    expect(h.notices).toEqual([]);
    fx.db.query("UPDATE tasks SET headSHA = ?, stage = 'review' WHERE id = 'T1'").run(HEAD);
    expect(await h.step()).toEqual([]);
    expect(getWorkflow(fx.db, "T1")!.mode).toBe("manual");
    expect(h.notices.length).toBe(1);
    expect(h.notices[0]!.text).toContain("已退回人工");
    await h.step();
    expect(h.notices.length).toBe(1);
  });

  test("a held card keeps its file for a later pass", async () => {
    fx = remoteFixture();
    fx.stash(P1_TEXT);
    expect(await harness({ held: true }).step()).toEqual([]);
    expect(listInbox(fx.inbox).length).toBe(1);
    expect(fx.remoteEvents()).toEqual([]);
  });

  test("a refused file moves to failed/ and PM is told where the raw text is", async () => {
    fx = remoteFixture();
    fx.stash(pushText({}), { taskId: "T9" });
    const h = harness();
    const failed = await h.step();
    expect(failed.length).toBe(1);
    expect(listInbox(fx.inbox)).toEqual([]);
    const parked = readdirSync(join(fx.inbox, "failed"));
    expect(parked.length).toBe(1);
    expect(h.notices.length).toBe(1);
    expect(h.notices[0]!.text).toContain(join(fx.inbox, "failed", parked[0]!));
  });

  test("[验收线 12] without handoffPeer the step does nothing, even with files waiting", async () => {
    fx = remoteFixture();
    fx.stash(P1_TEXT);
    const h = harness();
    expect(await h.step(handoffConfig(null))).toEqual([]);
    expect(h.calls).toEqual([]);
    expect(listInbox(fx.inbox).length).toBe(1);
    expect(existsSync(join(fx.inbox, "failed"))).toBe(false);
  });

  test("a stop during the notice ends the pass instead of being counted as a failure", async () => {
    fx = remoteFixture();
    fx.stash(P0_TEXT);
    const manager = (...args: string[]) => fx.cli("scheduler", ...args.slice(2));
    const stop = async () => { throw new SchedulerStopped("lease lost"); };
    await expect(remoteReviewStep(fx.db, handoffConfig(), { manager, active: () => {}, notify: stop, dir: fx.inbox })).rejects.toBeInstanceOf(SchedulerStopped);
  });
});

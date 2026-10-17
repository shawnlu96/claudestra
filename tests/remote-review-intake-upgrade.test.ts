import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { listEvents } from "../src/lib/ledger-store.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { remoteP1At } from "../src/lib/remote-review-current.js";
import { appliedKey, lateRemoteMatches, unsentRemoteNotices } from "../src/lib/remote-review-read.js";
import { remoteReviewStep } from "../src/lib/remote-review-tick.js";
import { isLegacyRemoteReview, parseRemoteReview } from "../src/lib/remote-review-parse.js";
import { renderRedeliveryPush } from "../src/lib/peer-pr-retry.js";
import { HEAD, PEER, PM, PR, P0_TEXT, pushText, handoffConfig, remoteFixture } from "./helpers/remote-review-fixture.js";

let fx: ReturnType<typeof remoteFixture>;
afterEach(() => fx?.cleanup());

function legacy(matched: boolean, round = 1) {
  return insertEvent(fx.db, { ...fx.at("scheduler"), dedupKey: `scheduler:remote_review:T1:PR${PR}-r${round}:${HEAD.slice(0, 12)}` },
    { project: "p", target: "T1", kind: "scheduler", text: "legacy review", data: { op: "remote_review", peer: PEER,
      reportId: `PR${PR}-r${round}`, number: PR, round, head12: HEAD.slice(0, 12), matched, head: matched ? HEAD : null,
      conclusion: matched ? "p1" : "p0", p1: matched ? 1 : 0, action: null, reportPath: `/reports/PR${PR}-r${round}.md` } }, true);
}

function tick(notify: (project: string, text: string) => Promise<void>, now = Date.now) {
  return remoteReviewStep(fx.db, handoffConfig(), { manager: (...a) => fx.cli("scheduler", ...a.slice(2)),
    active: () => {}, notify, dir: fx.inbox, now });
}

test("P2-1 reproduction: uppercase card head matches the same full commit immediately", async () => {
  fx = remoteFixture({ head: HEAD.toUpperCase() });
  expect(await fx.book(P0_TEXT)).toMatchObject({ ok: true });
  expect(fx.remoteEvents()[0]!.data.matched).toBe(true);
  expect(getWorkflow(fx.db, "T1")!.mode).toBe("manual");
});

test("P2-1 uppercase card head also finds pending P1 and applies an early P0", async () => {
  fx = remoteFixture({ head: null, stage: "build" });
  await fx.book(P0_TEXT);
  const seq = fx.remoteEvents()[0]!.seq;
  fx.db.query("UPDATE tasks SET headSHA = ? WHERE id = 'T1'").run(HEAD.toUpperCase());
  expect(lateRemoteMatches(fx.db, "p")).toEqual([{ taskId: "T1", seq }]);
  expect(await fx.cli("scheduler", "T1", "--apply", String(seq))).toMatchObject({ ok: true });
  await fx.book(pushText({ p1: 1, round: 2 }));
  expect(remoteP1At(fx.remoteEvents(), HEAD.toUpperCase(), fx.task().pr)).not.toBeNull();
});

test("P2-2 reproduction: first upgrade tick lists pending legacy bookings for PM, successful later ticks stay quiet", async () => {
  fx = remoteFixture({ stage: "merge" });
  const early = legacy(false), p1 = legacy(true, 2);
  const notices: string[] = [];
  expect(await tick(async (_p, text) => { notices.push(text); })).toEqual([]);
  expect(notices).toHaveLength(1);
  expect(notices[0]).toContain("不会自动生效");
  expect(notices[0]).toContain("请人工处理");
  for (const e of [early, p1]) {
    expect(notices[0]).toContain(String(e.data.reportId));
    expect(notices[0]).toContain(String(e.data.reportPath));
  }
  expect(getWorkflow(fx.db, "T1")!.mode).toBe("auto");
  expect(await tick(async (_p, text) => { notices.push(text); })).toEqual([]);
  expect(notices).toHaveLength(1);
  expect(unsentRemoteNotices(fx.db, "p")).toEqual([]);
  const reopened = new Database(fx.db.filename);
  try {
    await remoteReviewStep(reopened, handoffConfig(), { manager: (...a) => fx.cli("scheduler", ...a.slice(2)),
      active: () => {}, notify: async (_p, text) => { notices.push(text); }, dir: fx.inbox });
  } finally { reopened.close(); }
  expect(notices).toHaveLength(1);
});

test("P2-2 no upgrade notice for terminal cards or an already applied booking", async () => {
  fx = remoteFixture({ stage: "done" });
  legacy(true);
  const notices: string[] = [];
  await tick(async (_p, text) => { notices.push(text); });
  expect(notices).toEqual([]);
  fx.db.query("UPDATE tasks SET stage = 'merge' WHERE id = 'T1'").run();
  const e = legacy(false, 2);
  insertEvent(fx.db, { ...fx.at("scheduler"), dedupKey: appliedKey(e.seq) }, { project: "p", target: "T1", kind: "scheduler",
    text: "already applied", data: { op: "remote_review_applied", remoteSeq: e.seq } }, true);
  // The P1 was already consumed by a bounce before upgrade.
  const first = listEvents(fx.db, { project: "p", target: "T1" }).find((x) => x.data.op === "remote_review")!;
  insertEvent(fx.db, { ...fx.at("scheduler"), dedupKey: `scheduler:remote_bounce:T1:${first.seq}` },
    { project: "p", target: "T1", kind: "scheduler", text: "already bounced", data: { op: "remote_bounce", remoteSeq: first.seq } }, true);
  await tick(async (_p, text) => { notices.push(text); });
  expect(notices).toEqual([]);
});

test("P2-2 checklist is durably queued before notification; failures retry without a second checklist", async () => {
  fx = remoteFixture();
  legacy(false);
  let attempts = 0, clock = 1_000_000;
  const notices: string[] = [];
  const notify = async (_p: string, text: string) => { if (++attempts === 1) throw new Error("bridge down"); notices.push(text); };
  expect(await tick(notify, () => clock)).toHaveLength(1);
  expect(unsentRemoteNotices(fx.db, "p")).toHaveLength(1);
  await tick(notify, () => clock);
  expect(attempts).toBe(1);
  clock += 61_000;
  expect(await tick(notify, () => clock)).toEqual([]);
  expect(notices).toHaveLength(1);
  expect(unsentRemoteNotices(fx.db, "p")).toEqual([]);
  const rows = listEvents(fx.db, { project: "p", target: "T1" }).filter((e) => e.data.op === "remote_review_legacy_notice");
  expect(rows).toHaveLength(1);
  expect(await fx.cli("scheduler", "T1", "--legacy")).toMatchObject({ ok: true, duplicate: true });
  expect(await fx.cli("agent-task-one", "T1", "--legacy")).toMatchObject({ ok: false, code: "forbidden" });
  expect(await fx.cli(PM, "T1", "--legacy")).toMatchObject({ ok: false, code: "forbidden" });
});

test("P2-4 diagnostics recognize only well-formed legacy originals / redeliveries; they never parse as automatic reviews", () => {
  const old = pushText({ p1: 1 }, { repo: undefined });
  for (const text of [old, renderRedeliveryPush(old, 1, { stage: "build" })!, renderRedeliveryPush(old, 1, { stage: "build" }, true)!]) {
    expect(isLegacyRemoteReview(text)).toBe(true);
    expect(parseRemoteReview(text)).toBeNull();
  }
  expect(isLegacyRemoteReview(old.replace("报告编号：", "编号："))).toBe(false);
  expect(isLegacyRemoteReview(P0_TEXT.replace("head：", "head:"))).toBe(false);
  expect(isLegacyRemoteReview(P0_TEXT)).toBe(false);
});

test("P2-4 reproduction: a parked legacy inbox explicitly asks for manual handling", async () => {
  fx = remoteFixture();
  const text = P0_TEXT.replace("仓库：owner/repo\n", "").replace(`head：${HEAD}`, `head：${HEAD.slice(0, 12)}`);
  mkdirSync(fx.inbox, { recursive: true });
  const name = `1700000000000-T1~PR${PR}-r1~${HEAD.slice(0, 12)}.json`;
  writeFileSync(join(fx.inbox, name), JSON.stringify({ v: 1, peer: PEER, agent: PM, taskId: "T1", receivedAt: 1_700_000_000_000, text }));
  const notices: string[] = [];
  expect(await tick(async (_p, t) => { notices.push(t); })).toHaveLength(1);
  expect(existsSync(join(fx.inbox, "failed", name))).toBe(true);
  expect(notices).toHaveLength(1);
  expect(notices[0]).toContain("旧格式（没有仓库 / 完整 head），请人工处理");
  expect(notices[0]).not.toContain("不是仓库方审查推送的格式");
});

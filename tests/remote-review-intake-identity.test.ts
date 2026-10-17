import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { interceptRemoteReview, type IntakeDeps } from "../src/bridge/remote-review-intake.js";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { lateRemoteMatches, remoteCurrentAt, remoteP1At } from "../src/lib/remote-review-read.js";
import { listEvents } from "../src/lib/ledger-store.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { createTask } from "../src/lib/ledger-write.js";
import { inInbox, listInbox, readInbox, writeInbox } from "../src/lib/remote-review-inbox.js";
import { renderRedeliveryPush } from "../src/lib/peer-pr-retry.js";
import { HEAD, PEER, PM, PR, P0_TEXT, pushText, handoffConfig, remoteFixture } from "./helpers/remote-review-fixture.js";

let fx: ReturnType<typeof remoteFixture>;
afterEach(() => fx?.cleanup());

// Build the pre-upgrade wire independently of the renderer's current default.
const legacy = (text: string): string => text.split("\n").filter((l) => !l.startsWith("仓库："))
  .map((l) => l.startsWith("head：") ? `head：${HEAD.slice(0, 12)}` : l).join("\n");
const wire = (repo: string, head = HEAD): string => {
  const lines = legacy(P0_TEXT).split("\n");
  lines[1] = `head：${head}`;
  lines.splice(5, 0, `仓库：${repo}`);
  return lines.join("\n");
};
function intake() {
  const mirrors: string[] = [];
  const deps: IntakeDeps = { config: () => handoffConfig(), db: () => fx.db, now: () => 1_700_000_000_000,
    stash: (e, k) => writeInbox(e, k, fx.inbox), waiting: (k) => inInbox(k, fx.inbox) };
  return { mirrors, call: (text: string) => interceptRemoteReview({ peer: PEER, agent: PM, text, attachments: 0 }, async (s) => { mirrors.push(s); }, deps) };
}

test("RRL-4 reproduction: legacy original / redelivery / duplicates never capture a same-number foreign review", async () => {
  fx = remoteFixture();
  const h = intake(), old = legacy(P0_TEXT);
  for (const text of [old, renderRedeliveryPush(old, 1, { stage: "build" })!, old]) expect(await h.call(text)).toBeNull();
  expect(listInbox(fx.inbox)).toEqual([]);
  expect(h.mirrors).toEqual([]);
  expect(getWorkflow(fx.db, "T1")!.mode).toBe("auto");
});

test("RRL-4 repo+PR: foreign repo falls through, case-insensitive own repo alone is accepted", async () => {
  fx = remoteFixture();
  const h = intake();
  expect(await h.call(wire("other/repo"))).toBeNull();
  expect(listInbox(fx.inbox)).toEqual([]);
  expect((await h.call(wire("OWNER/REPO")))?.status).toBe(202);
  expect(listInbox(fx.inbox)).toHaveLength(1);
  expect(getWorkflow(fx.db, "T1")!.mode).toBe("auto");
});

test("RRL-4 same PR across repos: each books separately, case-only resend deduplicates", async () => {
  fx = remoteFixture();
  createTask(fx.db, fx.at("owner"), { project: "p", id: "T2", title: "other repo", kind: "code" });
  fx.db.query("UPDATE tasks SET pr = ?, headSHA = ? WHERE id = 'T2'").run(`https://github.com/other/repo/pull/${PR}`, HEAD);
  const h = intake();
  expect((await h.call(wire("owner/repo")))?.status).toBe(202);
  expect((await h.call(wire("OWNER/REPO")))?.status).toBe(202);
  expect((await h.call(wire("other/repo")))?.status).toBe(202);
  const files = listInbox(fx.inbox);
  expect(files).toHaveLength(2);
  for (const f of files) {
    const entry = readInbox(f, fx.inbox);
    expect(await fx.cli("scheduler", entry.taskId, "--inbox", f)).toMatchObject({ ok: true, duplicate: false });
  }
  expect(h.mirrors).toHaveLength(2);
  expect(await fx.book(wire("OWNER/REPO"))).toMatchObject({ ok: true, duplicate: true });
});

test("RRL-4 reproduction: a 12-character prefix collision waits for the exact full SHA, then applies once", async () => {
  const collision = HEAD.slice(0, 12) + "0".repeat(28);
  fx = remoteFixture({ head: collision, stage: "build" });
  expect(await fx.book(pushText({ p0: 1 }))).toMatchObject({ ok: true, notice: null });
  const e = fx.remoteEvents()[0]!;
  expect(e.data.matched).toBe(false);
  expect(getWorkflow(fx.db, "T1")!.mode).toBe("auto");
  expect(await fx.cli("scheduler", "T1", "--apply", String(e.seq))).toMatchObject({ ok: true, event: null });
  fx.db.query("UPDATE tasks SET headSHA = ? WHERE id = 'T1'").run(HEAD);
  expect(await fx.cli("scheduler", "T1", "--apply", String(e.seq))).toMatchObject({ ok: true, duplicate: false });
  expect(await fx.cli("scheduler", "T1", "--apply", String(e.seq))).toMatchObject({ ok: true, duplicate: true });
  expect(getWorkflow(fx.db, "T1")!.mode).toBe("manual");
});

test("RRL-4 manager revalidates a forged legacy inbox and a wrong repo", async () => {
  fx = remoteFixture();
  const file = fx.stash(P0_TEXT);
  const entry = readInbox(file, fx.inbox);
  writeFileSync(file, JSON.stringify({ ...entry, text: legacy(P0_TEXT) }));
  expect(await fx.cli("scheduler", "T1", "--inbox", file)).toMatchObject({ ok: false, code: "invalid" });
  expect(await fx.book(wire("other/repo"))).toMatchObject({ ok: false, code: "conflict" });
  expect(fx.remoteEvents()).toEqual([]);
  expect(getWorkflow(fx.db, "T1")!.mode).toBe("auto");
});

test("RRL-4 full-head identity isolates inbox dedup, ledger dedup and report storage", async () => {
  fx = remoteFixture({ stage: "build" });
  const h = intake(), paths = new Set<string>();
  for (const tail of ["0", "1", "2"]) {
    const head = HEAD.slice(0, 12) + tail.repeat(28);
    const text = wire("owner/repo", head);
    expect((await h.call(text))?.status).toBe(202);
    const file = listInbox(fx.inbox).find((f) => readInbox(f, fx.inbox).text === text)!;
    const result = await fx.cli("scheduler", "T1", "--inbox", file);
    expect(result).toMatchObject({ ok: true, duplicate: false, notice: null });
    paths.add(String((result.event as { data: { reportPath: string } }).data.reportPath));
    expect(await fx.cli("scheduler", "T1", "--inbox", file)).toMatchObject({ ok: true, duplicate: true });
  }
  expect(listInbox(fx.inbox)).toHaveLength(3);
  expect(fx.remoteEvents()).toHaveLength(3);
  expect(paths.size).toBe(3);
  expect(getWorkflow(fx.db, "T1")!.mode).toBe("auto");
});

test("RRL-4 repo is part of stored identity even if the card's PR is reassigned", async () => {
  fx = remoteFixture();
  const first = await fx.book(pushText({}));
  fx.db.query("UPDATE tasks SET pr = ? WHERE id = 'T1'").run(`https://github.com/other/repo/pull/${PR}`);
  const second = await fx.book(pushText({}, { repo: "other/repo" }));
  expect(second).toMatchObject({ ok: true, duplicate: false });
  expect((second.event as { data: unknown }).data).not.toEqual((first.event as { data: unknown }).data);
  const paths = fx.remoteEvents().map((e) => e.data.reportPath);
  expect(new Set(paths).size).toBe(2);
});

test("RRL-4 reassigned PR cannot inherit an old repository's pending or current P1", async () => {
  fx = remoteFixture({ stage: "build" });
  await fx.book(pushText({ p1: 1 }));
  fx.db.query("UPDATE tasks SET pr = ? WHERE id = 'T1'").run(`https://github.com/other/repo/pull/${PR}`);
  const events = listEvents(fx.db, { project: "p", target: "T1" });
  expect(remoteP1At(events, HEAD, fx.task().pr)).toBeNull();
  expect(lateRemoteMatches(fx.db, "p")).toEqual([]);
});

test("RRL-4 an old stored booking without repo / full SHA cannot apply later or enter fix lookup", async () => {
  fx = remoteFixture({ stage: "build", head: null });
  const e = insertEvent(fx.db, { ...fx.at("scheduler"), dedupKey: "scheduler:remote_review:T1:PR1600-r1:abcdef012345" },
    { project: "p", target: "T1", kind: "scheduler", text: "legacy booking", data: { op: "remote_review", matched: false,
      head12: HEAD.slice(0, 12), reportId: "PR1600-r1", round: 1, p1: 1, conclusion: "p1", format: "review" } }, true);
  fx.db.query("UPDATE tasks SET headSHA = ? WHERE id = 'T1'").run(HEAD);
  expect(lateRemoteMatches(fx.db, "p")).toEqual([]);
  expect(remoteCurrentAt(listEvents(fx.db, { project: "p", target: "T1" }), HEAD)).toBeNull();
  expect(await fx.cli("scheduler", "T1", "--apply", String(e.seq))).toMatchObject({ ok: true, event: null });
  expect(getWorkflow(fx.db, "T1")!.mode).toBe("auto");
});

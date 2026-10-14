/**
 * MQ1P2: the MQ1 findings that were downgraded or deferred in review (manual-review-cli, policy-after-claim, approval-expiry,
 * supersede-before-deadline, handoff-visibility), replayed under both sets of switches — the world the MQ1 tests always ran on
 * (train on by default, no direct merge, only manualMergeQueue in the policy file) and the switches claude-orchestrator runs with
 * (`live`: mergeTrain off + manualMergeQueue on + mergeDirect on, so the pass also has mergeNow). Every case is one body run per
 * switch set, on the real ledger CLI + real schedulerPass + fake GitHub (tests/scheduler-merge-reclaim-world.ts). It adds the
 * timing MQ1S's review said was never replayed: the project switching to mergeHandoff after the claim (docs/design/manual-merge-queue.md).
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeAsk, getAsk } from "../src/lib/ledger-asks.js";
import { listEvents } from "../src/lib/ledger-store.js";
import { setMeta } from "../src/lib/ledger-write.js";
import { RECOVERY_POLICY_PATH } from "../src/lib/recovery-policy.js";
import { getMergeRun } from "../src/lib/scheduler-merge.js";
import { reclaimWorld, type ReclaimWorld } from "./scheduler-merge-reclaim-world.js";
import { answer as answerIn, authorize as authorizeIn, ledgerAs, manualCard, manualReviewArgs, requestArgs } from "./manual-merge-queue-world.test.js";

const PM = "agent-pm", DISP = "agent-disp", KEY = "merge-current", OTHER = "b".repeat(40);
const SWITCHES = [
  { name: "旧世界（列车缺省开、无直接合）", live: false },
  { name: "线上开关（列车关 + manualMergeQueue on + mergeDirect on）", live: true },
] as const;
type Mode = "on" | "observe" | "off" | "corrupt";
type Card = { taskId: string; head: string; reviewSeq: number };

let w: ReclaimWorld, live = false;
afterEach(() => { w?.close(); rmSync(RECOVERY_POLICY_PATH, { force: true }); });

/** recovery-policy.json as the pass and the ledger child read it; the live set carries mergeDirect next to manualMergeQueue. */
const policy = (mode: Mode) => writeFileSync(RECOVERY_POLICY_PATH, mode === "corrupt" ? "{not json"
  : JSON.stringify({ projects: { p: { keys: { manualMergeQueue: mode, ...(live ? { mergeDirect: "on" } : {}) } } } }));

function setup(sw: (typeof SWITCHES)[number]) {
  live = sw.live;
  w = reclaimWorld({ store: "memory", live });
  setMeta(w.db, { actor: "owner", now: 1 }, { project: "p", key: "pms", value: [PM, DISP] });
  setMeta(w.db, { actor: "owner", now: 1 }, { project: "p", key: "team", value: { dispatcher: DISP, audit: true } });
  policy("on");
}

const as = (actor: string, ...args: string[]) => ledgerAs(w, actor, ...args);
const request = (m: Card, ...extra: string[]) => as(PM, ...requestArgs(m, ...extra));
/** Merge calls GitHub got for the card: the driver's plain merge, or the train's head-pinned one for a member it verified. */
const merges = (id: string) => w.hub.calls.filter((c) => c === `serial-merge:${id}` || c === `match-head:${id}`).length;
const forms = () => w.events.filter((e) => e.kind === "form").length;
const frozen = () => w.db.query("SELECT value FROM meta WHERE project = 'p' AND key = 'queueFrozen'").get();
const intentStatus = (id: string) => (w.db.query("SELECT status FROM scheduler_intents WHERE id = ?").get(id) as { status: string } | null)?.status ?? null;
const view = async () => (await as(PM, "merge-queue", "--project", "p")) as { manual: { rows: { state: string; phase: string | null; why: string | null }[] }; lines: string[] };
const authorize = (head: string, o: { key?: string; fromAgent?: string } = {}) =>
  authorizeIn(w, "M", "manual_merge", { askKey: o.key ?? KEY, params: { task: "M", head }, fromAgent: o.fromAgent });
const answer = (id: string, button: string) => answerIn(w, id, button);
const overdue = (id: string) => w.db.query("UPDATE asks SET expiresAt = ? WHERE id = ?").run(Date.now() - 1, id);

async function passes(n: number) { for (let i = 0; i < n; i++) await w.pass(); }

/** `id` merges exactly once: passes until merged, then one more that must send nothing. */
async function mergesOnce(id = "M") {
  for (let i = 0; i < 6 && w.phase(id) !== "merged"; i++) await w.pass();
  await w.pass();
  expect([w.phase(id), merges(id)]).toEqual(["merged", 1]);
}

/** The request waits for an approval it does not have, over several real passes: no merge call, no intent, no slot, no freeze. */
async function stillWaits(m: Card, why: RegExp) {
  const r = await request(m, "--reason", "再排");
  await passes(3);
  expect([r.ok, r.state, merges("M"), w.intentOf("M"), w.slot(), frozen()]).toEqual([true, "waiting", 0, null, null, null]);
  expect(String(r.why)).toMatch(why);
}

/** The two moments of a claimed run at which nothing has been sent yet, seen as the pass's own ledger child returns. */
const CUTS = {
  "manual-merge-claim 认领之后": (a: string[], r: Record<string, unknown>) => a[1] === "manual-merge-claim" && r.claimed === true,
  "scheduler-merge-step --to merging 之后": (a: string[], r: Record<string, unknown>) =>
    a[1] === "scheduler-merge-step" && a[a.indexOf("--to") + 1] === "merging" && r.ok === true,
} as const;
type Cut = keyof typeof CUTS;

/** Real passes until the cut is reached; `act` runs right there, before the pass goes on. Returns the claimed intent. */
async function cutAt(cut: Cut, act: () => void) {
  let done = false;
  for (let i = 0; i < 6 && !done; i++) await w.pass({ afterManager: (a, r) => { if (!done && CUTS[cut](a, r)) { done = true; act(); } } });
  expect(done).toBe(true);
  return w.intentOf("M")!;
}

/** The claimed run ended without sending: cancelled, slot free, queue not frozen, zero merge calls. */
const endedUnsent = (intent: string) =>
  expect([getMergeRun(w.db, intent)?.phase, intentStatus(intent), w.slot(), merges("M"), frozen()]).toEqual(["resolved", "cancelled", null, 0, null]);

for (const sw of SWITCHES) describe(sw.name, () => {
  describe("验收线 1：两张 auto 卡 + 一个人工请求跑到全部合并", () => {
    test(sw.live ? "全程不组车（没有 form 事件，train store 为空），三张卡各直接合 1 次" : "对照：同一场景会组车，三张卡各合 1 次", async () => {
      setup(sw);
      for (const id of ["A1", "A2"]) w.card(id);
      const m = await manualCard(w, "M"), all = ["A1", "A2", "M"];
      expect(await request(m)).toMatchObject({ ok: true, state: "queued" });
      for (let i = 0; i < 24 && all.some((id) => w.phase(id) !== "merged"); i++) await w.pass();
      await w.pass();
      expect(all.map((id) => [id, w.phase(id), merges(id)])).toEqual(all.map((id) => [id, "merged", 1]));
      if (!sw.live) return void expect(forms()).toBe(1);
      expect([w.events, w.store.all(), w.notices]).toEqual([[], [], []]);
      // direct merge: no catch-up, no head-pinned train merge — one plain merge per card and nothing else on GitHub
      expect([...w.hub.calls].sort()).toEqual(all.map((id) => `serial-merge:${id}`));
    }, 60_000);
  });

  describe("验收线 2：manual-review-cli（r1 P1，事件 35182 降级）", () => {
    test("reviewer 本人跑 ledger review 被拒（forbidden）；项目 PM 代登的审查进 queued，之后恰好合并 1 次", async () => {
      setup(sw);
      const c = w.card("M");
      w.db.query("DELETE FROM scheduler_sessions WHERE taskId = 'M'").run();
      w.db.query("DELETE FROM scheduler_intents WHERE taskId = 'M'").run();
      w.db.query("UPDATE task_workflows SET mode = 'manual' WHERE taskId = 'M'").run();
      w.db.query("UPDATE tasks SET stage = 'review', rev = rev + 1 WHERE id = 'M'").run();
      const dir = mkdtempSync(join(tmpdir(), "mmq-replay-")), findings = join(dir, "f.json");
      writeFileSync(findings, "[]");
      try {
        expect(await as("agent-review", ...manualReviewArgs("M", c.head, findings))).toMatchObject({ ok: false, code: "forbidden" });
        expect(await as(PM, ...manualReviewArgs("M", c.head, findings))).toMatchObject({ ok: true });
      } finally { rmSync(dir, { recursive: true, force: true }); }
      const review = listEvents(w.db, { project: "p", target: "M" }).findLast((e) => e.kind === "review")!;
      expect([review.actor, review.data.reviewer]).toEqual([PM, "agent-review"]);
      expect(await request({ ...c, reviewSeq: review.seq })).toMatchObject({ ok: true, state: "queued" });
      await mergesOnce();
    }, 30_000);

    test("调度助理代登的审查：排人工合并被拒（conflict，原因含『调度助理除外』），什么都不占", async () => {
      setup(sw);
      const m = await manualCard(w, "M", DISP);
      expect(await request(m)).toMatchObject({ ok: false, code: "conflict", error: expect.stringMatching(/调度助理除外/) });
      await passes(2);
      expect([w.intentOf("M"), w.slot(), merges("M")]).toEqual([null, null, 0]);
    }, 30_000);
  });

  describe("验收线 3：policy-after-claim（r1 / r2 P1，事件 35682 降级）", () => {
    for (const cut of Object.keys(CUTS) as Cut[]) for (const to of ["off", "observe", "corrupt"] as const) {
      test(`${cut}策略 on → ${to}：0 次合并，运行 resolved，意图 cancelled，槽空，不冻结；改回 on 重新请求恰好合并 1 次`, async () => {
        setup(sw);
        const m = await manualCard(w, "M");
        expect(await request(m)).toMatchObject({ ok: true, state: "queued" });
        const intent = await cutAt(cut, () => policy(to));
        await passes(3);
        endedUnsent(intent);
        policy("on");
        await passes(2); // the cancelled run is not picked up again by itself
        expect(merges("M")).toBe(0);
        expect(await request(m)).toMatchObject({ ok: true, state: "queued", duplicate: false });
        await mergesOnce();
      }, 30_000);
    }
  });

  describe("验收线 4：approval-expiry（r1–r4 P1，事件 36904 降级后改回）与截止前 supersede（MQ1S）", () => {
    test("r3 探针：授权过期后，批准别的 key / head / 发起者 / 参数都不解除等待；同一决定重问并批准后合并 1 次", async () => {
      setup(sw);
      const m = await manualCard(w, "M");
      const d1 = authorize(m.head);
      expect(await request(m)).toMatchObject({ ok: true, state: "waiting", why: expect.stringMatching(/审批未答/) });
      closeAsk(w.db, d1.id, "expired", "到期", Date.now());
      answer(authorize("other", { key: "merge-other-head" }).id, "go"); // another key, another head
      answer(authorize(m.head, { fromAgent: "agent-other" }).id, "go"); // another asker, same key and params
      answer(authorize("other").id, "go"); // same asker and key, other params
      await stillWaits(m, /不是批准/);
      expect((await view()).lines.join("\n")).toMatch(/人工#\d+ M｜等前置.*不是批准/);
      answer(authorize(m.head).id, "go"); // the same decision, re-asked and approved
      await mergesOnce();
    }, 30_000);

    for (const scanned of [false, true]) {
      test(`r4：A（请求的 head）逾期${scanned ? "已" : "未"}扫到，B（别的 head）顶替并获批：0 次合并；A 的绑定重问获批后合并 1 次`, async () => {
        setup(sw);
        const m = await manualCard(w, "M");
        const a = authorize(m.head);
        expect(await request(m)).toMatchObject({ ok: true, state: "waiting" });
        overdue(a.id);
        if (scanned) closeAsk(w.db, a.id, "expired", "到期扫描", Date.now());
        answer(authorize(OTHER).id, "go");
        expect(getAsk(w.db, a.id)?.state).toBe(scanned ? "expired" : "superseded");
        await stillWaits(m, new RegExp(a.id));
        answer(authorize(m.head).id, "go");
        await mergesOnce();
      }, 30_000);
    }

    test("r4：A（别的 head）逾期未扫到就被 B（卡的 head）顶替并获批：A 那个决定仍是过期未批，0 次合并，结果不随扫描先后变", async () => {
      setup(sw);
      const m = await manualCard(w, "M");
      const a = authorize(OTHER);
      overdue(a.id);
      const b = authorize(m.head);
      answer(b.id, "go");
      expect([getAsk(w.db, a.id)?.state, b.supersedes]).toEqual(["superseded", a.id]);
      await stillWaits(m, /取代时已过有效期/);
      answer(authorize(OTHER).id, "go"); // that decision re-asked and approved (B, superseded by it while answered, stays approved)
      await mergesOnce();
    }, 30_000);

    test("MQ1S：A（请求的 head）截止前被 B（别的 head）顶替并获批，不交接：0 次合并；A 的绑定重问获批后合并 1 次", async () => {
      setup(sw);
      const m = await manualCard(w, "M");
      const a = authorize(m.head);
      const b = authorize(OTHER);
      answer(b.id, "go");
      const A = getAsk(w.db, a.id)!;
      expect([A.state, A.updatedAt < A.expiresAt, b.supersedes]).toEqual(["superseded", true, a.id]);
      await stillWaits(m, /替代版本的参数 \/ head 不同/);
      answer(authorize(m.head).id, "go");
      await mergesOnce();
    }, 30_000);

    test("MQ1S：A（别的 head）截止前被 B（卡的 head）顶替，交给 B：B 获批后合并 1 次", async () => {
      setup(sw);
      const m = await manualCard(w, "M");
      const a = authorize(OTHER);
      expect(await request(m)).toMatchObject({ ok: true, state: "waiting" });
      const b = authorize(m.head);
      expect([getAsk(w.db, a.id)?.state, b.supersedes]).toEqual(["superseded", a.id]);
      await passes(2);
      expect([w.intentOf("M"), merges("M")]).toEqual([null, 0]); // B is still open
      answer(b.id, "go");
      await mergesOnce();
    }, 30_000);

    test("同毫秒重问 A → B → A'，随机 id 的字典序是 A'、B、A：按创建顺序认 A'，A' 获批后合并 1 次", async () => {
      setup(sw);
      const m = await manualCard(w, "M");
      const ms = Date.now(), uuids = ["cccccccc-cccc-4ccc-8ccc-cccccccccccc", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"];
      const clock = spyOn(Date, "now").mockReturnValue(ms), uuid = spyOn(crypto, "randomUUID").mockImplementation(() => uuids.shift() as never);
      let a, b, a2;
      try { a = authorize(m.head); b = authorize(OTHER); a2 = authorize(m.head); } finally { clock.mockRestore(); uuid.mockRestore(); }
      expect([a.createdAt, b.createdAt, a2.createdAt, a2.id < b.id, b.id < a.id, a2.supersedes]).toEqual([ms, ms, ms, true, true, b.id]);
      answer(a2.id, "go");
      expect(await request(m)).toMatchObject({ ok: true, state: "queued" });
      await mergesOnce();
    }, 30_000);
  });

  describe("验收线 5：认领之后项目切成 mergeHandoff（MQ1S r1 没重放的时机）", () => {
    test("认领之后、驱动之前切：0 次合并，视图这一行带交接原因；切回后恰好合并 1 次", async () => {
      setup(sw);
      const m = await manualCard(w, "M");
      expect(await request(m)).toMatchObject({ ok: true, state: "queued" });
      const intent = await cutAt("manual-merge-claim 认领之后", () => w.setHandoff(true));
      await passes(3);
      // mergeTick skips a handoff project: the claimed run is neither driven nor cancelled and keeps the slot
      expect([getMergeRun(w.db, intent)?.phase, intentStatus(intent), w.slot(), merges("M"), frozen()]).toEqual(["ready", "submitted", "M", 0, null]);
      const v = await view();
      expect(v.manual.rows).toEqual([expect.objectContaining({ state: "running", phase: "ready", why: expect.stringMatching(/mergeHandoff.*仍占着合并槽/) })]);
      expect(v.lines.join("\n")).toMatch(/人工#\d+ M｜合并中\/ready｜.*mergeHandoff.*仓库方/);
      w.setHandoff(false);
      await mergesOnce();
      expect((await view()).manual.rows[0]!.why ?? "").not.toMatch(/mergeHandoff/);
    }, 30_000);

    test("merging 认领之后切：发前作废，cancelled，0 次合并；切回后旧运行不复活，重新请求恰好合并 1 次", async () => {
      setup(sw);
      const m = await manualCard(w, "M");
      expect(await request(m)).toMatchObject({ ok: true, state: "queued" });
      const intent = await cutAt("scheduler-merge-step --to merging 之后", () => w.setHandoff(true));
      await passes(2);
      endedUnsent(intent);
      expect((await view()).manual.rows).toEqual([expect.objectContaining({ state: "ended", why: expect.stringMatching(/mergeHandoff/) })]);
      expect(await request(m)).toMatchObject({ ok: false, error: expect.stringMatching(/mergeHandoff/) }); // still a handoff project
      w.setHandoff(false);
      await passes(2);
      expect(merges("M")).toBe(0);
      expect(await request(m)).toMatchObject({ ok: true, state: "queued", duplicate: false });
      await mergesOnce();
    }, 30_000);
  });
});

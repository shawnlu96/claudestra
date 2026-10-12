/**
 * AUTOACK2 [验收线 2]: switch on, one missing or contradicting piece of evidence at a time. submit_verdict still records the verdict (a bad
 * checkout as checkout.ok=false with why), workflow-resume succeeds without an adoption, reviewSource.refused names the failed rule, and the
 * intent / session / resource tables do not move. PM's `ledger review --dedup verdict:…` copy is only recorded, never adopted.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { adoptedReviewSource } from "../src/lib/scheduler-manual-review-source.js";
import { autoFixture } from "./scheduler-auto-helpers.js";
import { events, finding, H1, H2, plan, resume, sideTables, toManual, toRound2, withPr, type Fx } from "./scheduler-manual-review-source-fixture.test.js";
import {
  addReviewer, adoptEvent, assignRv, cleanup, resumeEvent, RV, RV_SESSION, setAgent, setMode, submit, take, verdictEvent, type SubmitOpts,
} from "./scheduler-manual-review-local-fixture.test.js";

let f: Fx;
afterEach(() => { f?.close(); cleanup(); });
const LOCAL = "本机人工结论缺可核的领单与独立检出证据：";

async function ready(o: { runtime?: string; cwd?: (root: string) => string } = {}): Promise<void> {
  setMode("on");
  f = autoFixture();
  await toRound2(f);
  await toManual(f);
  withPr(f);
  addReviewer(f, { runtime: o.runtime, cwd: o.cwd?.(f.dir) });
  assignRv(f);
}

/** Verdict recorded (with its checkout as given), hand-back ok, no adoption, the refusal names `why`, side tables untouched. */
async function refused(why: RegExp | string, opts: SubmitOpts & { checkout?: RegExp | true } = {}, between?: () => void | Promise<void>) {
  const before = sideTables(f);
  expect(submit(f, opts)).toMatchObject({ ok: true });
  const v = verdictEvent(f);
  if (opts.checkout === true) expect(v.data.checkout).toMatchObject({ ok: true });
  else if (opts.checkout) expect(v.data.checkout).toMatchObject({ ok: false, why: expect.stringMatching(opts.checkout) });
  await between?.();
  expect(await resume(f)).toMatchObject({ ok: true });
  expect(adoptEvent(f)).toBeUndefined();
  const src = resumeEvent(f).data.reviewSource as { refused: string; localObserve?: string };
  if (typeof why === "string") expect(src.refused).toBe(why);
  else expect(src.refused).toMatch(why);
  expect(src.localObserve).toBeUndefined();
  expect(sideTables(f)).toEqual(before);
  expect(adoptedReviewSource(f.db, f.task(), getWorkflow(f.db, "T1")!)).toBeNull();
  return src.refused;
}

describe("AUTOACK2 [验收线 2] incomplete local evidence: zero adoption", () => {
  test("no take recorded", async () => {
    await ready();
    expect(await refused(new RegExp(`^${LOCAL}没有 T1:review:r2 在这次派活之后的领单记录`), { checkout: true })).toContain(LOCAL);
  });

  test("the take's session is not the verdict's session", async () => {
    await ready();
    await take(f);
    setAgent(f, RV, (old) => ({ ...old, sessionId: "s-rvl-2" }));
    await refused(new RegExp(`^${LOCAL}领单记录的审查员、会话`), { session: "s-rvl-2", checkout: true });
  });

  test("the reviewer changed session after the take and the old session submits: checkout.ok is false (会话已换)", async () => {
    await ready();
    await take(f);
    setAgent(f, RV, (old) => ({ ...old, sessionId: "s-rvl-2" }));
    await refused(new RegExp(`^${LOCAL}检出证据不成立（会话已换`), { session: RV_SESSION, checkout: /^会话已换/ });
  });

  test("the take predates a re-assignment (its assignSeq no longer matches)", async () => {
    await ready();
    await take(f);
    assignRv(f);
    await refused(new RegExp(`^${LOCAL}没有 T1:review:r2 在这次派活之后的领单记录`), { checkout: true });
  });

  test("the checkout sits on another head", async () => {
    await ready();
    await take(f);
    await refused(new RegExp(`^${LOCAL}检出证据不成立`), { head: H1, checkout: new RegExp(`不是被审的 head ${H2}`) });
  });

  test("the checkout has uncommitted tracked edits", async () => {
    await ready();
    await take(f);
    await refused(new RegExp(`^${LOCAL}检出证据不成立.*未提交的改动`), { dirty: "M src/lib/x.ts", checkout: /未提交的改动/ });
  });

  test("the review directory is the author's directory", async () => {
    await ready({ cwd: (root) => root });
    await take(f);
    await refused(new RegExp(`^${LOCAL}检出证据不成立.*相同或互相包含`), { checkout: /agent-task-one/ });
  });

  test("the review directory lies inside the author's directory", async () => {
    await ready({ cwd: (root) => { const d = join(root, "rv-inner"); mkdirSync(d, { recursive: true }); return d; } });
    await take(f);
    await refused(new RegExp(`^${LOCAL}检出证据不成立.*相同或互相包含`), { checkout: /相同或互相包含/ });
  });

  test("the registry has no cwd for the reviewer", async () => {
    await ready();
    await take(f);
    setAgent(f, RV, (old) => ({ runtime: old.runtime as string, sessionId: old.sessionId as string }));
    await refused(new RegExp(`^${LOCAL}检出证据不成立`), { checkout: /没有 agent-rv-local 的 cwd/ });
  });

  test("an author is no longer registered", async () => {
    await ready();
    await take(f);
    setAgent(f, "agent-task-one", null);
    await refused(new RegExp(`^${LOCAL}检出证据不成立`), { checkout: /作者 agent-task-one 在 registry 里没有记录/ });
  });

  test("an author has no cwd", async () => {
    await ready();
    await take(f);
    setAgent(f, "agent-task-one", (old) => ({ runtime: old.runtime as string, sessionId: old.sessionId as string }));
    await refused(new RegExp(`^${LOCAL}检出证据不成立`), { checkout: /作者 agent-task-one 在 registry 里没有 cwd/ });
  });

  test("an author's directory cannot be resolved", async () => {
    await ready();
    await take(f);
    setAgent(f, "agent-task-one", (old) => ({ ...old, cwd: join(f.dir, "gone", "away") }));
    await refused(new RegExp(`^${LOCAL}检出证据不成立`), { checkout: /作者 agent-task-one 的目录 .* 解析不了/ });
  });

  test("reviewer and author share a family and there is no exemption", async () => {
    await ready({ runtime: "claude-code" });
    await take(f, RV_SESSION, "claude-code");
    await refused(new RegExp(`^${LOCAL}审查员和作者同家族`), { runtime: "claude-code", checkout: true });
  });

  test("PM's `ledger review` copy with --dedup verdict:… is recorded but never adopted", async () => {
    await ready();
    await take(f);
    const before = sideTables(f);
    const findings = join(f.dir, "f-pm.json");
    writeFileSync(findings, JSON.stringify([finding("name-2", "P2")]));
    const report = join(f.dir, "reviews-pm.md");
    writeFileSync(report, "# 代记\n");
    expect(await f.cli("pm", "review", "T1", "--reviewer", RV, "--verdict", "pass", "--p0", "0", "--p1", "0", "--p2", "1", "--head", H2, "--session", RV_SESSION,
      "--family", "codex", "--findings", findings, "--path", report, "--dedup", `verdict:T1:review:r2@${H2}`)).toMatchObject({ ok: true });
    const v = verdictEvent(f);
    expect(v).toMatchObject({ actor: "pm", dedupKey: `verdict:T1:review:r2@${H2}`, data: { reviewer: RV } });
    expect("checkout" in v.data).toBe(false);
    expect(await resume(f)).toMatchObject({ ok: true });
    expect(adoptEvent(f)).toBeUndefined();
    expect((resumeEvent(f).data.reviewSource as { refused: string }).refused).toMatch(new RegExp(`^${LOCAL}结论不是审查员本人经 submit_verdict 交的`));
    expect(sideTables(f)).toEqual(before);
  });

  test("an open P1 (the common check, its own words)", async () => {
    await ready();
    await take(f);
    await refused("审查结论未通过（有 P0 / P1 或 block），不承接", { rows: [finding("race-2", "P1")], checkout: true });
  });

  test("a review was sent after the verdict", async () => {
    await ready();
    await take(f);
    await refused("结论之后又派了新的审查，可能有审查在跑", { checkout: true }, () => { assignRv(f, "final_review"); });
  });

  test("the original report was deleted after submit_verdict", async () => {
    await ready();
    await take(f);
    await refused("原审查报告读不到，材料无法核", { checkout: true }, () => rmSync(String(verdictEvent(f).data.path)));
    expect(plan(f)).toMatchObject({ kind: "escalate" });
    expect(events(f).filter((e) => e.data.op === "manual_review_taken")).toHaveLength(1);
  });
});

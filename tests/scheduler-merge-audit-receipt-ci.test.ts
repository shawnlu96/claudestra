/**
 * dispatch-recovery-CIFLEN1: the CI rerun receipt, its query prefix and the cached wait reason share closeMergeRun's 600-unit
 * gate. Legal evidence too long for that text (20 long check names, a long run link) reads the run and goes back to fix; it
 * never freezes the project. Synthetic ledger in a temp dir, a fake gh port, no network.
 */
import { describe, expect, test } from "bun:test";
import { advanceMergeRun, getMergeRun } from "../src/lib/scheduler-merge.js";
import { fitRerunReceipt, parseRerunReceipt, RERUN_QUERY, RERUN_WAIT, rerunReceipt, type CiRerunGh } from "../src/lib/scheduler-merge-ci-rerun.js";
import { RECEIPT_MAX } from "../src/lib/scheduler-merge-ci-receipt.js";
import type { MergeExternal, PrSnapshot } from "../src/lib/scheduler-merge-driver.js";
import { parseSchedulerConfig } from "../src/lib/scheduler-config.js";
import { schedulerMergeTick } from "../src/lib/scheduler-service.js";
import { getMeta } from "../src/lib/ledger-store.js";
import { ledgerAs, mergedCard } from "./deploy-test-kit.js";

const HEAD = "c".repeat(40), PR = "https://github.com/example/repo/pull/7";
const SLOW = "tests/local-api-last-seen.test.ts";
const at = (line: string) => `ci\tRun tests\t2026-10-02T11:02:03.1234567Z ${line}`;
const TIMEOUT_ONLY = [at("##[group]tests/a.test.ts:"), at("(pass) fine [1.00ms]"), at("##[endgroup]"), at(`##[group]${SLOW}:`),
  at("(fail) 本机 API last-seen > 过滤在 LIMIT 之前 [6189.00ms]"), at("  ^ this test timed out after 5000ms."), at("##[endgroup]"),
  at(""), at(" 1999 pass"), at(" 1 fail"), at("Ran 2000 tests across 300 files. [90.00s]"), at("##[error]Process completed with exit code 1.")].join("\n");

/** Required check names at the config's 80-unit cap. */
const longChecks = (n: number, width = 80) => Array.from({ length: n }, (_, i) => `ci / shard ${String(i + 1).padStart(2, "0")} / `.padEnd(width, "x"));
const runLink = (repo: string, runId = "98765432101234") => `https://github.com/${repo}/actions/runs/${runId}`;
const LONG_REPO = `example-organisation-with-a-long-name/${"claudestra-long-repository-name-".repeat(3)}x`;

interface Gh { attempt: number; status: string; conclusion: string; lag: boolean; runReads: number; reruns: number }
function card(checks: string[], link: string) {
  const c = mergedCard();
  c.db.query("UPDATE scheduler_merges SET phase='await_ci', mergeSha=NULL, requiredChecks=? WHERE intentId=?").run(checks.join(","), c.intent);
  const config = parseSchedulerConfig({ enabled: true, projects: { p: { maxActiveWorkers: 2, requiredChecks: checks, repoDir: "/tmp/p" } } });
  const gh: Gh = { attempt: 1, status: "completed", conclusion: "failure", lag: false, runReads: 0, reruns: 0 };
  const [, repo, runId] = /^https:\/\/github\.com\/(.+)\/actions\/runs\/(\d+)$/.exec(link)!;
  const port: CiRerunGh = {
    async runAttempt(r, id) {
      expect([r, id]).toEqual([repo, runId]);
      gh.runReads++;
      return { attempt: gh.attempt, status: gh.status, conclusion: gh.conclusion, headSha: HEAD };
    },
    async failedLog() { return TIMEOUT_ONLY; },
    async prFiles() { return ["src/lib/x.ts"]; },
    async rerunFailed(r, id) {
      expect([r, id]).toEqual([repo, runId]);
      gh.reruns++;
      if (!gh.lag) Object.assign(gh, { attempt: gh.attempt + 1, status: "queued", conclusion: "" });
    },
  };
  const snap: PrSnapshot = { state: "OPEN", head: HEAD, branch: "feat/t9", base: "main", draft: false, crossRepository: false,
    mergeState: "UNSTABLE", mergeSha: null, checks: checks.map((name, i) => ({ name, bucket: "fail", link: `${link}/job/${1000 + i}` })) };
  const external = { inspect: async () => snap, freshness: async () => ({ behindBy: 0, mainHead: "e".repeat(40) }),
    carryReview: async () => ({ ok: false, reason: "不沿用" }), updateBranch: async () => {}, merge: async () => { throw new Error("不该合并"); },
    ciRerun: port } as MergeExternal;
  const tick = (now = 200) => schedulerMergeTick(c.db, config, ledgerAs(c.db, "scheduler", () => now), () => external);
  const state = () => ({ run: getMergeRun(c.db, c.intent)?.phase as string | undefined, stage: (c.db.query("SELECT stage FROM tasks WHERE id='T9'").get() as { stage: string }).stage,
    frozen: getMeta(c.db, "p").queueFrozen.frozen });
  const events = (op: string) => (c.db.query(`SELECT data FROM events WHERE target='T9' AND kind='scheduler' AND json_extract(data,'$.op')=?
    ORDER BY seq`).all(op) as { data: string }[]).map((e) => JSON.parse(e.data) as Record<string, unknown>);
  return { ...c, gh, tick, state, events };
}
async function withCard(checks: string[], link: string, body: (c: ReturnType<typeof card>) => Promise<void>) {
  const c = card(checks, link);
  try { await body(c); } finally { c.close(); }
}
const BOUNCED = { run: "resolved", stage: "fix", frozen: false };
const WAITING = { run: "await_ci", stage: "merge", frozen: false };

/** One check name sized so the query (prefix + zero-case receipt) on `link` is exactly `total` units. */
function sized(total: number, link: string): string[] {
  const probe = (checks: string[]) => RERUN_QUERY.length + rerunReceipt(HEAD, { link, checks, cases: [] }).length;
  const base = longChecks(5);
  const pad = total - probe([...base, "y"]);
  expect(pad).toBeGreaterThanOrEqual(0);
  expect(pad).toBeLessThan(80);
  const checks = [...base, "y".repeat(pad + 1)];
  expect(probe(checks)).toBe(total);
  return checks;
}

describe("[验收线 1] 20 legal long check names, a long run link, zero cases: the rerun query never freezes the project", () => {
  test("the run is read, the claim does not fit the gate → back to fix through the ci_fail bounce, no rerun, no freeze", async () => {
    const link = runLink(LONG_REPO);
    await withCard(longChecks(20), link, async (c) => {
      await c.tick();
      expect(c.state()).toEqual(BOUNCED);
      expect(c.gh.runReads).toBeGreaterThan(0);
      expect(c.gh.reruns).toBe(0);
      expect(c.events("merge_ci_rerun")).toEqual([]);
      const [bounce, ...more] = c.events("merge_conflict");
      expect(more).toEqual([]);
      expect(bounce).toMatchObject({ cause: "ci_fail", prHead: HEAD });
      // The bounce names only required checks; none of the cut ones is taken as passed (the card is back in fix).
      expect((bounce!.checks as { name: string }[]).every((x) => longChecks(20).includes(x.name))).toBe(true);
      expect(getMeta(c.db, "p").queueFrozen.frozen).toBe(false);
    });
  });

  test("generators refuse what cannot be expressed instead of handing an over-long receipt to the ledger", () => {
    const link = runLink(LONG_REPO);
    expect(fitRerunReceipt(HEAD, { link, checks: longChecks(20), cases: [] })).toBeNull();
    const fits = fitRerunReceipt(HEAD, { link, checks: longChecks(2), cases: [] });
    expect(fits).not.toBeNull();
    expect(fits!.length + RERUN_QUERY.length).toBeLessThanOrEqual(RECEIPT_MAX);
  });
});

describe("[验收线 2] 599 / 600 / 601: the full budget counts the query prefix; generate and parse round-trip", () => {
  const link = runLink("example/repo", "77");
  for (const total of [599, 600]) {
    test(`${total}: query and claim pass the gate, one rerun, same head/run retried never sends a second`, async () => {
      const checks = sized(total, link);
      const receipt = fitRerunReceipt(HEAD, { link, checks, cases: [] })!;
      expect(RERUN_QUERY.length + receipt.length).toBe(total);
      expect(parseRerunReceipt(receipt)).toEqual({ prHead: HEAD, link, checks, cases: [] });
      // A case that would push the query past the gate is dropped; the structure fields stay whole.
      const withCase = fitRerunReceipt(HEAD, { link, checks, cases: [`${SLOW} > slow`] })!;
      expect(parseRerunReceipt(withCase)).toEqual({ prHead: HEAD, link, checks, cases: [] });
      await withCard(checks, link, async (c) => {
        c.gh.lag = true;
        await c.tick(200);
        expect([c.state(), c.gh.reruns]).toEqual([WAITING, 1]);
        const reason = getMergeRun(c.db, c.intent)?.reason ?? "";
        expect(reason).toStartWith(`${RERUN_WAIT}：`);
        expect(parseRerunReceipt(reason.slice(`${RERUN_WAIT}：`.length))).toEqual({ prHead: HEAD, link, checks, cases: [] });
        // The phase change wipes the cached reason; the query restores it from the claim event without a second rerun.
        c.db.query("UPDATE scheduler_merges SET reason=NULL WHERE intentId=?").run(c.intent);
        await c.tick(300);
        await c.tick(400);
        expect([c.state(), c.gh.reruns]).toEqual([WAITING, 1]);
        expect(c.events("merge_ci_rerun")).toHaveLength(1);
        expect(c.gh.runReads).toBeGreaterThan(1);
      });
    });
  }

  test("601: no receipt is generated, the run is read and goes back to fix; no rerun, no freeze", async () => {
    const checks = sized(601, link);
    expect(fitRerunReceipt(HEAD, { link, checks, cases: [] })).toBeNull();
    await withCard(checks, link, async (c) => {
      await c.tick();
      expect([c.state(), c.gh.reruns]).toEqual([BOUNCED, 0]);
      expect(c.gh.runReads).toBeGreaterThan(0);
    });
  });

  test("illegal head or run in a claim is still refused by the ledger; a malformed one is no claim", async () => {
    const checks = sized(600, link);
    await withCard(checks, link, async (c) => {
      const sch = { actor: "scheduler", now: 500 };
      const wrongHead = fitRerunReceipt("d".repeat(40), { link, checks, cases: [] })!;
      expect(() => advanceMergeRun(c.db, sch, { intentId: c.intent, from: "await_ci", to: "resolved", rev: 4, receipt: wrongHead }))
        .toThrow("head / 检查名与本次合并不符");
      expect(() => advanceMergeRun(c.db, sch, { intentId: c.intent, from: "await_ci", to: "resolved", rev: 4,
        receipt: `${RERUN_QUERY}${wrongHead}` })).toThrow("head / 检查名与本次合并不符");
      const good = fitRerunReceipt(HEAD, { link, checks, cases: [] })!;
      expect(parseRerunReceipt(good.replace(link, "https://example.com/actions/runs/77"))).toBeNull();
      expect(parseRerunReceipt(good.replace(HEAD, "z".repeat(40)))).toBeNull();
      // Over the gate by one unit with the prefix: refused as a receipt, never a freeze of its own making.
      expect(() => advanceMergeRun(c.db, sch, { intentId: c.intent, from: "await_ci", to: "resolved", rev: 4,
        receipt: `${RERUN_QUERY}${good}x` })).toThrow("不超过 600 字");
      expect(c.state()).toEqual(WAITING);
      expect(c.events("merge_ci_rerun")).toEqual([]);
    });
  });
});

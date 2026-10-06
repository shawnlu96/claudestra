/**
 * HOF1: after the merge handoff the repository owner merges main into the PR (update-branch) before merging it. A head moved only
 * by that (parents = followed head + a main commit, net diff byte-identical) is followed: recorded on the ledger, never sent back to
 * PM or re-reviewed here, and the merge lands with the merged PR head + merge commit. A changed net diff or no answer → PM; a read
 * that fails → held and read again. The carry check itself runs on real git, before and after the owner's merge.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { listEvents } from "../src/lib/ledger-store.js";
import { runBounded } from "../src/lib/run-bounded.js";
import { schedulerAutoTick } from "../src/lib/scheduler-auto-tick.js";
import { MAIN_REF, mainMergeCarry, type MainMergeCarry } from "../src/lib/scheduler-main-merge-carry.js";
import { ghPrState, handoffCarry, HANDOFF_POLL_MS, type HandoffCarry, type HandoffPr } from "../src/lib/scheduler-merge-handoff-tick.js";
import { autoFixture, H1, H2, P2, toBuild } from "./scheduler-auto-helpers.js";

const PR = "https://github.com/example/repo/pull/7";
const H3 = "3".repeat(40), M = "a".repeat(40), MP = "b".repeat(40), MH = "c".repeat(40), HASH = "d".repeat(64);
const pure = (mainParent = MP): MainMergeCarry => ({ ok: true, reason: "净 diff 一致", mainParent, mainHead: MH, diffHash: HASH, basis: "net-diff" });

/** The card handed over at H1; `answer` plays GitHub + the carry check for each read and sees what the tick asked to follow. */
async function handed() {
  const f = autoFixture();
  await toBuild(f);
  await f.tick();
  await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H1, "--pr", PR);
  await f.tick();
  await f.tick();
  await f.review("pass", H1, [P2]);
  await f.tick();
  let answer: (follow?: { project: string; head: string }) => HandoffPr = () => ({ state: "OPEN", head: H1, mergeSha: null });
  const follows: (string | undefined)[] = [];
  const pass = async () => {
    f.advance(HANDOFF_POLL_MS);
    const r = await schedulerAutoTick(f.db, { p: { maxActiveWorkers: 2, mergeHandoff: true } }, { ...f.tickDeps,
      prState: async (_ref, follow) => { follows.push(follow?.head); expect(follow?.project ?? "p").toBe("p"); return answer(follow); } });
    if (r.failed.length) throw new Error(JSON.stringify(r.failed));
    return r.cards[0];
  };
  expect(await pass()).toMatchObject({ step: "handoff" });
  const events = () => listEvents(f.db, { project: "p", target: "T1" });
  const carries = () => events().filter((e) => e.data.op === "merge_handoff_carry");
  const landed = () => events().findLast((e) => e.kind === "stage" && e.data.to === "live");
  const handoffSeq = events().find((e) => e.data.op === "merge_handoff")!.seq;
  return { f, pass, follows, carries, landed, handoffSeq, set: (a: typeof answer) => { answer = a; } };
}

describe("HOF1 the tick follows a handed PR that only merged main in", () => {
  test("OPEN at a pure main merge → followed, not PM, not re-reviewed; MERGED there → live with the new head and merge commit", async () => {
    const h = await handed(), { f } = h;
    try {
      const reviews = () => f.intents().filter((i) => i.action === "review").length, before = reviews();
      h.set((follow) => ({ state: "OPEN", head: H2, mergeSha: null, carry: follow?.head === H1 ? pure() : undefined }));
      expect(await h.pass()).toMatchObject({ step: "waiting", detail: expect.stringContaining("PR 只合入了 main") });
      expect(h.carries().map((e) => [e.actor, e.data])).toEqual([["scheduler", { op: "merge_handoff_carry", handoffSeq: h.handoffSeq,
        from: H1, to: H2, mainParent: MP, mainHead: MH, diffHash: HASH, basis: "net-diff" }]]);
      expect(f.task()).toMatchObject({ stage: "merge", headSHA: H1 }); // the card keeps its reviewed head
      expect(getWorkflow(f.db, "T1")?.mode).toBe("auto");
      expect([reviews(), f.intents().filter((i) => i.action === "merge")]).toEqual([before, []]); // no re-review, no local merge

      h.set(() => ({ state: "OPEN", head: H2, mergeSha: null }));
      expect(await h.pass()).toMatchObject({ step: "waiting", detail: "已交仓库方合并，等 PR 结果" });
      h.set(() => ({ state: "MERGED", head: H2, mergeSha: M }));
      expect(await h.pass()).toMatchObject({ step: "landed" });
      expect(h.follows).toEqual([undefined, H1, H2, H2]);
      expect(f.task()).toMatchObject({ stage: "live", headSHA: H1 });
      expect(h.landed()!.data).toMatchObject({ from: "merge", to: "live", head: H2, mergeSha: M, handoffSeq: h.handoffSeq, handedHead: H1,
        carrySeq: h.carries()[0]!.seq });
      expect(f.notices.at(-1)).toContain(`合并时 head ${H2.slice(0, 12)}`);
      expect(h.carries()).toHaveLength(1);
    } finally { f.close(); }
  });

  test("main merged in twice before the merge: each hop is checked from the head followed so far and chained on the ledger", async () => {
    const h = await handed(), { f } = h;
    try {
      const hops: Record<string, string> = { [H1]: H2, [H2]: H3 };
      let at = H1;
      h.set((follow) => ({ state: "OPEN", head: hops[at]!, mergeSha: null, carry: follow?.head === at ? pure(follow.head === H1 ? MP : MH) : undefined }));
      expect(await h.pass()).toMatchObject({ step: "waiting" });
      at = H2;
      expect(await h.pass()).toMatchObject({ step: "waiting" });
      expect(h.carries().map((e) => [e.data.from, e.data.to])).toEqual([[H1, H2], [H2, H3]]);
      h.set(() => ({ state: "MERGED", head: H3, mergeSha: M }));
      expect(await h.pass()).toMatchObject({ step: "landed" });
      expect(h.landed()!.data).toMatchObject({ head: H3, mergeSha: M, handedHead: H1, carrySeq: h.carries()[1]!.seq });
      expect(h.follows).toEqual([undefined, H1, H2, H3]);
    } finally { f.close(); }
  });

  test("merged at a new head before it was ever seen open: one pass records the hop and lands", async () => {
    const h = await handed(), { f } = h;
    try {
      h.set((follow) => ({ state: "MERGED", head: H2, mergeSha: M, carry: follow?.head === H1 ? pure() : undefined }));
      expect(await h.pass()).toMatchObject({ step: "landed" });
      expect(h.carries()).toHaveLength(1);
      expect(h.landed()!.data).toMatchObject({ head: H2, mergeSha: M, handedHead: H1 });
      expect(f.task().stage).toBe("live");
    } finally { f.close(); }
  });

  test("the PR's own change differs after the merge (or nobody could judge) → PM as before; nothing is carried", async () => {
    const refusals: [MainMergeCarry | undefined, string][] = [
      [{ ok: false, reason: "合并 main 后 PR 对 main 的净 diff 变了", mainParent: MP, mainHead: MH }, "净 diff 变了"],
      [{ ok: false, reason: "另一个父提交 bbbbbbbbbbbb 不在 main 上" }, "不在 main 上"],
      [undefined, "没核对是否只合入了 main"],
    ];
    for (const [carry, why] of refusals) {
      for (const state of ["OPEN", "MERGED"] as const) {
        const h = await handed(), { f } = h;
        try {
          h.set(() => ({ state, head: H2, mergeSha: state === "MERGED" ? M : null, carry }));
          expect(await h.pass()).toMatchObject({ step: "manual", detail: expect.stringContaining(why) });
          expect(f.notices.at(-1)).toContain("交接后 PR head 变了");
          expect(h.carries()).toEqual([]);
          expect(f.task()).toMatchObject({ stage: "merge", headSHA: H1 });
          expect(getWorkflow(f.db, "T1")?.mode).toBe("manual");
        } finally { f.close(); }
      }
    }
  }, 30_000); // six full fixtures in one case

  test("a hop after an accepted one that changes the PR still goes to PM; the first hop stays on the ledger", async () => {
    const h = await handed(), { f } = h;
    try {
      h.set((follow) => ({ state: "OPEN", head: H2, mergeSha: null, carry: follow?.head === H1 ? pure() : undefined }));
      await h.pass();
      h.set(() => ({ state: "OPEN", head: H3, mergeSha: null, carry: { ok: false, reason: "合并 main 后 PR 对 main 的净 diff 变了" } }));
      expect(await h.pass()).toMatchObject({ step: "manual", detail: expect.stringContaining(`${H2.slice(0, 12)} → ${H3.slice(0, 12)}`) });
      expect(h.carries().map((e) => e.data.to)).toEqual([H2]);
    } finally { f.close(); }
  });

  test("a read or git step that fails holds the card without writing; the next pass reads again and follows", async () => {
    const h = await handed(), { f } = h;
    try {
      h.set(() => { throw new Error("git fetch 失败：Could not resolve host"); });
      expect(await h.pass()).toMatchObject({ step: "held", detail: expect.stringContaining("git fetch 失败") });
      h.set(() => ({ state: "MERGED", head: H2, mergeSha: null }));
      expect(await h.pass()).toMatchObject({ step: "held", detail: "PR 已合并但还读不到合并提交，下轮再看" });
      expect(h.carries()).toEqual([]);
      expect(getWorkflow(f.db, "T1")?.mode).toBe("auto");
      h.set((follow) => ({ state: "OPEN", head: H2, mergeSha: null, carry: follow?.head === H1 ? pure() : undefined }));
      expect(await h.pass()).toMatchObject({ step: "waiting" });
      expect(h.carries()).toHaveLength(1);
    } finally { f.close(); }
  });

  test("the carry command is the scheduler's alone and rechecks the hop against the ledger in its own transaction", async () => {
    const h = await handed(), { f } = h;
    try {
      const flags = (from: string, to: string, extra: string[] = []) => ["T1", "--head", H1, "--pr", PR, "--carry", to, "--from", from,
        "--main-parent", MP, "--main-head", MH, "--diff-hash", HASH, "--basis", "auto-merge", ...extra];
      const as = (...args: string[]) => f.tickDeps.manager("ledger", "scheduler-merge-handoff", ...args);
      expect(await f.cli("pm", "scheduler-merge-handoff", ...flags(H1, H2))).toMatchObject({ ok: false, code: "forbidden" });
      expect(await as(...flags(H2, H3))).toMatchObject({ ok: false, code: "conflict" }); // not the head followed now
      expect(await as(...flags(H1, H1))).toMatchObject({ ok: false, code: "conflict" });
      expect(await as(...flags(H1, "abc"))).toMatchObject({ ok: false, code: "invalid" });
      expect(await as(...flags(H1, H2, ["--merged", M]))).toMatchObject({ ok: false, code: "invalid" });
      expect(await as(...flags(H1, H2, ["--basis", "trust-me"]))).toMatchObject({ ok: false, code: "invalid" });
      expect(await as("T1", "--head", H2, "--pr", PR, "--carry", H3, "--from", H2, "--main-parent", MP, "--main-head", MH, "--diff-hash", HASH, "--basis", "net-diff"))
        .toMatchObject({ ok: false, code: "conflict" }); // --head is the card's reviewed head, never a followed one
      expect(await as(...flags(H1, H2))).toMatchObject({ ok: true, duplicate: false });
      expect(await as(...flags(H1, H2))).toMatchObject({ ok: true, duplicate: true });
      expect(await as(...flags(H1, H3))).toMatchObject({ ok: false, code: "conflict" }); // H1 is no longer followed
      expect(h.carries()).toHaveLength(1);
      expect(await as("T1", "--head", H2, "--pr", PR, "--merged", M)).toMatchObject({ ok: false, code: "conflict" });
      expect(await as("T1", "--head", H1, "--pr", PR, "--merged", M)).toMatchObject({ ok: true });
      expect(h.landed()!.data).toMatchObject({ head: H2, handedHead: H1 });
    } finally { f.close(); }
  });
});

describe("HOF1 ghPrState asks for a carry only when the followed head moved", () => {
  const gh = (state: string, head: string, merge: string | null) => async () =>
    ({ code: 0, stdout: JSON.stringify({ state, headRefOid: head, mergeCommit: merge ? { oid: merge } : null }), stderr: "", timedOut: false });
  test("moved open / merged → carry with the merge commit only once merged; same head, CLOSED, no merge commit or no repoDir → none", async () => {
    const asked: unknown[][] = [];
    const carry: HandoffCarry = async (...a) => { asked.push(a); return pure(); };
    const read = (state: string, head: string, merge: string | null, project = "p") =>
      ghPrState(gh(state, head, merge), (p) => p === "p" ? carry : null)(PR, { project, head: H1 });
    expect((await read("OPEN", H2, null)).carry).toEqual(pure());
    expect((await read("MERGED", H2, M)).carry).toEqual(pure());
    expect(asked).toEqual([[PR, H1, H2, null], [PR, H1, H2, M]]);
    for (const r of [await read("OPEN", H1, null), await read("CLOSED", H2, null), await read("MERGED", H2, null), await read("OPEN", H2, null, "q")]) {
      expect(r.carry).toBeUndefined();
    }
    expect(await ghPrState(gh("OPEN", H2, null), () => { throw new Error("not asked before the handoff"); })(PR)).toEqual({ state: "OPEN", head: H2, mergeSha: null });
    expect(asked).toHaveLength(2);
  });
});

describe("HOF1 handoffCarry vouches only with an origin on github.com itself", () => {
  test("look-alike hosts, a path or userinfo naming github.com, other ports or schemes are refused before any fetch", async () => {
    const tryOrigin = async (url: string) => {
      const calls: string[][] = [];
      const command: typeof runBounded = async (argv) => {
        calls.push(argv);
        if (argv.includes("config")) return { code: 0, stdout: `${url}\n`, stderr: "", timedOut: false };
        throw new Error("fetch reached");
      };
      const r = await handoffCarry("/nonexistent", command)(PR, H1, H2, null).catch((e: Error) => e.message);
      return { r, fetched: calls.some((a) => a.includes("fetch")) };
    };
    for (const url of ["git@notgithub.com:example/repo.git", "https://evilgithub.com/example/repo.git", "https://github.com@evil.com/example/repo.git",
      "https://evil.com/github.com/example/repo.git", "git@evil.com:github.com/example/repo.git", "http://github.com/example/repo.git",
      "https://github.com:8443/example/repo.git", "https://github.com/example/repo/extra.git", "https://github.com/example/other.git", "file:///github.com/example/repo"]) {
      expect(await tryOrigin(url)).toEqual({ r: { ok: false, reason: "repoDir 的 origin 不是 PR 仓库 example/repo" }, fetched: false });
    }
    for (const url of ["git@github.com:Example/repo.git", "https://github.com/example/repo", "https://github.com/example/repo.git/",
      "ssh://git@github.com/example/repo.git", "https://x-access-token@github.com/Example/Repo.git"]) {
      expect(await tryOrigin(url)).toEqual({ r: "fetch reached", fetched: true });
    }
  });
});

describe("HOF1 handoffCarry against a real repository, before and after the owner merges", () => {
  let root = "", work = "", reviewed = "", n1 = "", n2 = "", m1 = "", m2 = "", merged = "";
  const sh = async (...argv: string[]) => {
    const r = await runBounded(["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...argv],
      { cwd: work, timeoutMs: 30_000 });
    if (r.code !== 0) throw new Error(`git ${argv.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const commitFile = async (file: string, body: string, msg: string) => {
    writeFileSync(join(work, file), body);
    await sh("add", file);
    await sh("commit", "-q", "-m", msg);
    return sh("rev-parse", "HEAD");
  };
  const mainCommit = async (file: string, body: string) => {
    await sh("checkout", "-q", "main");
    const c = await commitFile(file, body, `main ${file}`);
    await sh("push", "-q", "origin", "main");
    return c;
  };
  /** The owner's update-branch: main merged into the PR branch, pushed. */
  const updateBranch = async (main: string) => {
    await sh("checkout", "-q", "feature");
    await sh("merge", "-q", "--no-edit", main);
    await sh("push", "-q", "origin", "feature");
    return sh("rev-parse", "HEAD");
  };
  const carry = () => handoffCarry(work);

  const GIT_MS = 30_000; // real git, several commands per case: a loaded machine overruns bun's 5 s default
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "hof1-carry-"));
    work = join(root, "work");
    await runBounded(["git", "init", "-q", "--bare", "-b", "main", join(root, "origin.git")], { timeoutMs: 30_000 });
    await runBounded(["git", "init", "-q", "-b", "main", work], { timeoutMs: 30_000 });
    // origin as configured is the PR repository; fetches go to the local bare copy
    await sh("remote", "add", "origin", "git@github.com:Example/repo.git");
    await sh("config", `url.${join(root, "origin.git")}.insteadOf`, "git@github.com:Example/repo.git");
    await commitFile("shared.txt", "s\n", "base");
    await sh("push", "-q", "origin", "main");
    await sh("checkout", "-q", "-b", "feature");
    reviewed = await commitFile("feature.txt", "reviewed change\n", "feature");
    await sh("push", "-q", "origin", "feature");
    m1 = await mainCommit("other.txt", "o1\n");
    n1 = await updateBranch(m1);
    m2 = await mainCommit("third.txt", "t\n");
    n2 = await updateBranch(m2);
  }, GIT_MS);
  afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

  test("open: each pure update-branch carries from the head before it, and both hops name the same PR diff", async () => {
    const first = await carry()(PR, reviewed, n1, null), second = await carry()(PR, n1, n2, null);
    expect(first).toMatchObject({ ok: true, mainParent: m1, basis: "auto-merge" });
    expect(second).toMatchObject({ ok: true, mainParent: m2, mainHead: m2, basis: "auto-merge" });
    expect(second.diffHash).toBe(first.diffHash!);
    expect(await carry()(PR, reviewed, n2, null)).toMatchObject({ ok: false, reason: expect.stringContaining("合并提交") }); // two hops at once
  }, GIT_MS);

  test("open, an evil merge (a change folded into the merge commit) is refused with its main parent; another repository vouches for nothing", async () => {
    await sh("checkout", "-q", "-b", "evil", n1);
    await sh("merge", "-q", "--no-commit", "--no-ff", m2);
    writeFileSync(join(work, "feature.txt"), "reviewed change\nsmuggled\n");
    await sh("add", "feature.txt");
    await sh("commit", "-q", "--no-edit");
    const evil = await sh("rev-parse", "HEAD");
    await sh("push", "-q", "origin", "evil");
    expect(await carry()(PR, n1, evil, null)).toMatchObject({ ok: false, reason: "合并 main 后 PR 对 main 的净 diff 变了", mainParent: m2 });
    expect(await carry()("https://github.com/example/other/pull/7", n1, n2, null)).toMatchObject({ ok: false, reason: expect.stringContaining("origin 不是 PR 仓库") });
    await expect(handoffCarry(join(root, "missing"))(PR, n1, n2, null)).rejects.toThrow(); // no clone: held, read again
  }, GIT_MS);

  test("after the owner merges, the check still isolates the PR's own diff against main as it was before that merge", async () => {
    await sh("checkout", "-q", "main");
    await sh("merge", "-q", "--no-ff", "--no-edit", n2);
    merged = await sh("rev-parse", "HEAD");
    await sh("push", "-q", "origin", "main");
    expect(await carry()(PR, n1, n2, merged)).toMatchObject({ ok: true, mainParent: m2, mainHead: m2 });
    expect(await carry()(PR, reviewed, n1, merged)).toMatchObject({ ok: true, mainParent: m1, mainHead: m2 });
  }, GIT_MS);

  test("a side commit smuggled in through the PR is refused after the merge, where current main would have vouched for it", async () => {
    await sh("checkout", "-q", "-b", "side", m2);
    const side = await commitFile("smuggled.txt", "x\n", "not on main");
    await sh("checkout", "-q", "-b", "feature2", n2);
    await sh("merge", "-q", "--no-edit", side);
    const n3 = await sh("rev-parse", "HEAD");
    await sh("checkout", "-q", "main");
    await sh("merge", "-q", "--no-ff", "--no-edit", n3);
    const merged2 = await sh("rev-parse", "HEAD");
    await sh("push", "-q", "origin", "main", "feature2");
    expect(await carry()(PR, n2, n3, merged2)).toMatchObject({ ok: false, reason: expect.stringContaining("不在 main 上") });
    // checked against current main (which now holds the PR) the same side commit would pass
    const git = async (...a: string[]) => sh(...a).then((s) => `${s}\n`);
    expect(await mainMergeCarry(git, runBounded, work, n2, n3, MAIN_REF)).toMatchObject({ ok: true });
  }, GIT_MS);


  test("main and the PR changed the same file: a clean update-branch is followed (its tree is git's merge), an evil one is not", async () => {
    const body = (first: string, eighth: string) => ["one", "2", "3", "4", "5", "6", "7", "eight", "9", "10"]
      .map((l, i) => i === 0 ? first : i === 7 ? eighth : l).join("\n") + "\n";
    await mainCommit("same.txt", body("one", "eight"));
    await sh("checkout", "-q", "-b", "same-pr");
    const pr = await commitFile("same.txt", body("one", "EIGHT (reviewed)"), "PR edits line 8");
    await sh("push", "-q", "origin", "same-pr");
    const main = await mainCommit("same.txt", body("ONE (main)", "eight"));
    await sh("checkout", "-q", "same-pr");
    await sh("merge", "-q", "--no-edit", main);
    const updated = await sh("rev-parse", "HEAD");
    await sh("push", "-q", "origin", "same-pr");
    expect(await carry()(PR, pr, updated, null)).toMatchObject({ ok: true, mainParent: main, basis: "auto-merge" });

    await sh("checkout", "-q", "-b", "same-evil", pr);
    await sh("merge", "-q", "--no-commit", "--no-ff", main);
    writeFileSync(join(work, "same.txt"), body("ONE (main)", "EIGHT (reviewed) + smuggled"));
    await sh("add", "same.txt");
    await sh("commit", "-q", "--no-edit");
    const evil = await sh("rev-parse", "HEAD");
    await sh("push", "-q", "origin", "same-evil");
    expect(await carry()(PR, pr, evil, null)).toMatchObject({ ok: false, reason: "合并 main 后 PR 对 main 的净 diff 变了", mainParent: main });

    await sh("checkout", "-q", "main");
    await sh("merge", "-q", "--no-ff", "--no-edit", updated);
    const landed = await sh("rev-parse", "HEAD");
    await sh("push", "-q", "origin", "main");
    expect(await carry()(PR, pr, updated, landed)).toMatchObject({ ok: true, mainParent: main, mainHead: main, basis: "auto-merge" });
  }, GIT_MS);
  /** The owner's update-branch of `branch` with main, plus `smuggle` folded into the merge commit; returns the pushed head. */
  const evilMerge = async (branch: string, main: string, smuggle: () => Promise<void>) => {
    await sh("checkout", "-q", branch);
    await sh("merge", "-q", "--no-commit", "--no-ff", main);
    await smuggle();
    await sh("commit", "-q", "--no-edit");
    await sh("push", "-q", "origin", branch);
    return sh("rev-parse", "HEAD");
  };

  test("a gitlink swapped in the merge commit is refused although the reviewed .gitmodules says ignore=all", async () => {
    await sh("checkout", "-q", "main");
    await sh("checkout", "-q", "-b", "dep-pr");
    writeFileSync(join(work, ".gitmodules"), '[submodule "dep"]\n\tpath = dep\n\turl = ./dep\n\tignore = all\n');
    await sh("add", ".gitmodules");
    await sh("update-index", "--add", "--cacheinfo", `160000,${m1},dep`);
    await sh("commit", "-q", "-m", "PR pins dep at m1");
    const pr = await sh("rev-parse", "HEAD");
    await sh("push", "-q", "origin", "dep-pr");
    const main = await mainCommit("later.txt", "l\n");
    const evil = await evilMerge("dep-pr", main, () => sh("update-index", "--cacheinfo", `160000,${m2},dep`).then(() => {}));
    expect(await carry()(PR, pr, evil, null)).toMatchObject({ ok: false, reason: "合并 main 后 PR 对 main 的净 diff 变了", mainParent: main });
  }, GIT_MS);

  test("diff.relative in a repoDir below the root cannot hide a change the merge commit made outside it", async () => {
    await sh("checkout", "-q", "main");
    mkdirSync(join(work, "sub"), { recursive: true });
    await mainCommit("sub/a.txt", "a\n");
    await sh("checkout", "-q", "-b", "rel-pr");
    const pr = await commitFile("sub/a.txt", "a reviewed\n", "PR edits sub");
    await sh("push", "-q", "origin", "rel-pr");
    const main = await mainCommit("later2.txt", "x\n");
    const evil = await evilMerge("rel-pr", main, async () => { writeFileSync(join(work, "outside.txt"), "smuggled\n"); await sh("add", "outside.txt"); });
    await sh("config", "diff.relative", "true");
    try {
      expect(await handoffCarry(join(work, "sub"))(PR, pr, evil, null)).toMatchObject({ ok: false, reason: "合并 main 后 PR 对 main 的净 diff 变了" });
    } finally { await sh("config", "--unset", "diff.relative"); }
  }, GIT_MS);
  test("diff.submodule=log cannot make two gitlinks with one short prefix read the same: the swapped one is refused", async () => {
    const link = (n: string) => `abcdef0${n.repeat(33)}`; // three ids, one 7-char prefix, none of them in this object store
    const pinDep = async (id: string) => { await sh("update-index", "--add", "--cacheinfo", `160000,${id},dep2`); await sh("commit", "-q", "-m", `dep2 @ ${id}`); };
    await sh("checkout", "-q", "main");
    await pinDep(link("1"));
    await sh("push", "-q", "origin", "main");
    await sh("checkout", "-q", "-b", "log-pr");
    await pinDep(link("2"));
    const pr = await sh("rev-parse", "HEAD");
    await sh("push", "-q", "origin", "log-pr");
    const main = await mainCommit("later3.txt", "y\n");
    const evil = await evilMerge("log-pr", main, () => sh("update-index", "--cacheinfo", `160000,${link("3")},dep2`).then(() => {}));
    await sh("config", "diff.submodule", "log");
    try {
      expect(await carry()(PR, pr, evil, null)).toMatchObject({ ok: false, reason: "合并 main 后 PR 对 main 的净 diff 变了", mainParent: main });
    } finally { await sh("config", "--unset", "diff.submodule"); }
  }, GIT_MS);
});

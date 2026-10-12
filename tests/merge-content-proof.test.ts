import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  contentIdOf, isFullContentProof, judgeContentEvidence, renderIdOf, reviewContentEvidence, uiContentEvidence, uiScopeCarryEvidence,
  type ContentFacts, type ContentRefusal, type ContentScope, type ReviewContentEvidence, type UiContentEvidence,
} from "../src/lib/merge-content-proof.js";
import { gitIn } from "../src/lib/scheduler-ui-carry-proof.js";
import { runBounded } from "../src/lib/run-bounded.js";

const SCOPE: ContentScope = { repository: "example/proof", taskId: "t-1", pr: 7, specRev: 2, round: 1 };
const SHOTS = "c".repeat(64);
const GLOBS = ["src/a.ts"];
let root = "", work = "";
const h: Record<string, string> = {};

const sh = async (...args: string[]) => {
  const r = await runBounded(["git", "-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args],
    { cwd: work, timeoutMs: 30_000 });
  if (r.code !== 0 || r.timedOut) throw new Error(`${args[0]}: ${r.stderr}`);
  return r.stdout.trim();
};
const file = (path: string, value: string | Buffer) => {
  mkdirSync(join(work, path, ".."), { recursive: true });
  writeFileSync(join(work, path), value);
};
const commit = async (message: string) => { await sh("add", "-A"); await sh("commit", "-qm", message); return sh("rev-parse", "HEAD"); };
const at = async (head: string) => { await sh("reset", "--hard", "-q"); await sh("checkout", "-q", "--detach", head); };
const actualMain = (head: string) => sh("update-ref", "refs/remotes/origin/main", head);
/** One commit on top of oldHead that changes exactly one thing; `staged` commits the index as is (a gitlink has no work tree). */
const variant = async (name: string, change: () => Promise<void> | void, staged = false) => {
  await at(h.old!); await change();
  if (staged) { await sh("commit", "-qm", name); h[name] = await sh("rev-parse", "HEAD"); } else h[name] = await commit(name);
  return h[name]!;
};
const gitlink = (oid: string, path: string) => async () => { await sh("update-index", "--add", "--cacheinfo", `160000,${oid},${path}`); };
const review = (approvedHead: string, currentHead = approvedHead, over: Partial<ContentScope> = {}, mainHead = h.main2!) =>
  reviewContentEvidence({ repoDir: work, scope: { ...SCOPE, ...over }, mainHead, approvedHead, currentHead, sourceReviewSeq: 41 });
const ok = <T,>(r: T | ContentRefusal): T => {
  if ((r as ContentRefusal).ok === false) throw new Error(`refused: ${(r as ContentRefusal).reason}`);
  return r as T;
};
const facts = (over: Partial<ContentFacts> = {}, head = h.two!): ContentFacts =>
  ({ scope: SCOPE, currentHead: head, reviewLive: (s, at) => s === 41 && at === h.old, approvalLive: (s, at) => s === 52 && at === h.old, ...over });
const ui = (ev: ReviewContentEvidence, globs = GLOBS) =>
  uiContentEvidence({ review: ev, read: gitIn(work), fileGlobs: globs, screenshotsDigest: SHOTS, approvalSeq: 52 });

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "merge-content-proof-")); work = join(root, "repo"); mkdirSync(work);
  await sh("init", "-q", "-b", "main");
  await sh("remote", "add", "origin", "https://github.com/example/proof.git");
  file("web/index.html", "<p>hi</p>\n"); file("web/app.css", "p { color: red }\n"); file("styles/shared.css", ".x { margin: 0 }\n");
  file("src/a.ts", "export const a = 1;\n"); file("src/run.sh", "echo run\n"); file("package.json", "{}\n"); file("bun.lock", "lock 1\n");
  file("vite.config.ts", "export default {};\n"); file("img.bin", Buffer.from([0, 1, 2, 255]));
  h.base = await commit("base");
  await sh("checkout", "-qb", "feature");
  file("src/a.ts", "export const a = 2;\n"); file("img.bin", Buffer.from([0, 3, 4, 254]));
  h.old = await commit("reviewed");
  await at(h.base); file("main1", "main one\n"); h.main1 = await commit("main one");
  file("main2", "main two\n"); h.main2 = await commit("main two");
  await at(h.old); await sh("merge", "-q", "--no-edit", h.main1); h.one = await sh("rev-parse", "HEAD");
  await sh("merge", "-q", "--no-edit", h.main2); h.two = await sh("rev-parse", "HEAD");
  await variant("byte", () => file("src/a.ts", "export const a = 3;\n"));
  await variant("mode", () => chmodSync(join(work, "src/run.sh"), 0o755));
  await variant("binary", () => file("img.bin", Buffer.from([0, 3, 4, 253])));
  await variant("gitlink", gitlink(h.main1!, "vendor/sub"), true);
  await variant("gitlink2", gitlink(h.main2!, "vendor/sub"), true);
  await variant("big", () => file("big.txt", "x".repeat(1024 * 1024)));
  await actualMain(h.main2);
});
afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

describe("[验收线 1] content identity: net diff only, no commit ids", () => {
  test("pure-main one-hop / multi-hop carry keeps the content identity of the approved head", async () => {
    await actualMain(h.base);
    const before = ok(await review(h.old!, h.old!, {}, h.base));
    await actualMain(h.main2);
    const same = ok(await review(h.old!));
    const one = ok(await review(h.old!, h.one!)), two = ok(await review(h.old!, h.two!)), self = ok(await review(h.two!));
    expect(new Set([before, same, one, two, self].map((e) => e.contentId)).size).toBe(1);
    expect(new Set([before, same, one, two, self].map((e) => e.diffHash)).size).toBe(1);
    expect(two).toMatchObject({ v: 1, kind: "review", approvedHead: h.old, currentHead: h.two, mainHead: h.main2, sourceReviewSeq: 41,
      chain: [{ head: h.one, previousHead: h.old, mainParent: h.main1 }, { head: h.two, previousHead: h.one, mainParent: h.main2 }] });
    expect(one.chain).toEqual([{ head: h.one!, previousHead: h.old!, mainParent: h.main1! }]);
    expect(Object.isFrozen(two) && Object.isFrozen(two.scope) && Object.isFrozen(two.chain)).toBe(true);
  });
  test("the identity digest never contains a commit id, only scope + diff hash", async () => {
    const two = ok(await review(h.old!, h.two!));
    expect(two.contentId).toBe(contentIdOf(two.scope, two.diffHash));
    expect(contentIdOf({ ...SCOPE, repository: "EXAMPLE/Proof" }, two.diffHash)).toBe(two.contentId);
    for (const sha of [h.old!, h.one!, h.two!, h.main2!]) expect(two.contentId).not.toContain(sha);
  });
  test("one byte, a mode bit, a binary byte, a gitlink oid or the repository makes a different identity", async () => {
    const ids = [ok(await review(h.old!)).contentId];
    for (const k of ["byte", "mode", "binary", "gitlink", "gitlink2"]) ids.push(ok(await review(h[k]!)).contentId);
    const diff = ok(await review(h.old!)).diffHash;
    ids.push(contentIdOf({ ...SCOPE, repository: "example/other" }, diff));
    expect(new Set(ids).size).toBe(ids.length);
  });
  test("scope fields each change the identity (task, PR, spec revision, round)", () => {
    const d = "d".repeat(64);
    const ids = [SCOPE, { ...SCOPE, taskId: "t-2" }, { ...SCOPE, pr: 8 }, { ...SCOPE, specRev: 3 }, { ...SCOPE, round: 2 }].map((s) => contentIdOf(s, d));
    expect(new Set(ids).size).toBe(5);
  });
  test("the local origin must be the scoped repository", async () => {
    expect(await review(h.old!, h.two!, { repository: "example/other" })).toMatchObject({ ok: false, approvedHead: h.old, currentHead: h.two });
    expect(await review(h.two!, h.two!, { repository: "example/other" })).toMatchObject({ ok: false, reason: expect.stringContaining("仓库") });
    const mine = ok(await review(h.old!));
    await sh("remote", "set-url", "origin", "https://github.com/example/other.git");
    try {
      const other = ok(await review(h.old!, h.old!, { repository: "example/other" }));
      expect(other.diffHash).toBe(mine.diffHash);
      expect(other.contentId).not.toBe(mine.contentId);
      expect(await review(h.old!)).toMatchObject({ ok: false, reason: expect.stringContaining("仓库") });
    } finally { await sh("remote", "set-url", "origin", "https://github.com/example/proof.git"); }
  });
});

describe("[验收线 2] full render identity", () => {
  test("shared CSS, a dependency lock or build config changes the render identity with the same screenshots and globs", async () => {
    const base = ok(ui(ok(await review(h.old!)))) as UiContentEvidence;
    expect(base).toMatchObject({ v: 1, kind: "ui", strength: "full", screenshotsDigest: SHOTS, approvalSeq: 52 });
    expect(base.renderId).toBe(renderIdOf(base.review.contentId, base.renderInputs!, SHOTS));
    const ids = [base.renderId];
    for (const [name, path] of [["css", "web/app.css"], ["shared", "styles/shared.css"], ["lock", "bun.lock"], ["cfg", "vite.config.ts"]] as const) {
      const head = await variant(name, () => file(path, `${readFileSync(join(work, path), "utf8")}/* ${name} */\n`));
      const r = ok(await review(head));
      const u = ok(ui(r)) as UiContentEvidence;
      expect(u.screenshotsDigest).toBe(SHOTS);
      ids.push(u.renderId);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });
  test("a main merge touching shared CSS keeps the content identity but refuses the approved render", async () => {
    await at(h.main2!); file("styles/shared.css", ".x { margin: 1px }\n"); const main3 = await commit("main css");
    await at(h.old!); await sh("merge", "-q", "--no-edit", main3); const three = await sh("rev-parse", "HEAD");
    await actualMain(main3);
    try {
      const r = ok(await review(h.old!, three, {}, main3));
      expect(r.contentId).toBe(ok(await review(h.old!, h.old!, {}, main3)).contentId);
      expect(ui(r)).toMatchObject({ ok: false, reason: expect.stringContaining("渲染输入"), approvedHead: h.old, currentHead: three });
    } finally { await actualMain(h.main2!); }
  });
  test("unverifiable render inputs are refused: symlink, submodule, missing web/, truncated or missing objects", async () => {
    const link = await variant("link", () => symlinkSync("index.html", join(work, "web/alias.html")));
    expect(ui(ok(await review(link)))).toMatchObject({ ok: false, reason: expect.stringContaining("符号链接") });
    const sub = await variant("websub", gitlink(h.main1!, "web/sub"), true);
    expect(ui(ok(await review(sub)))).toMatchObject({ ok: false, reason: expect.stringContaining("子模块") });
    const noWeb = await variant("noweb", async () => { await sh("rm", "-rq", "web"); });
    expect(ui(ok(await review(noWeb)))).toMatchObject({ ok: false, reason: expect.stringContaining("web/") });
    const cut = () => { throw new Error("spawnSync git ENOBUFS"); };
    const r = ok(await review(h.old!));
    expect(uiContentEvidence({ review: r, read: cut, fileGlobs: GLOBS, screenshotsDigest: SHOTS, approvalSeq: 52 }))
      .toMatchObject({ ok: false, reason: expect.stringContaining("ENOBUFS"), approvedHead: h.old, currentHead: h.old });
    const gone = { ...r, currentHead: "0".repeat(40) } as ReviewContentEvidence;
    expect(ui(gone)).toMatchObject({ ok: false, currentHead: "0".repeat(40) });
    expect(uiContentEvidence({ review: r, read: gitIn(work), fileGlobs: GLOBS, screenshotsDigest: "nope", approvalSeq: 52 })).toMatchObject({ ok: false });
  });
  test("UICAR3 scope carry is only ever a scope carry, never full content evidence", async () => {
    const r = ok(await review(h.old!, h.two!));
    const s = ok(uiScopeCarryEvidence({ review: r, screenshotsDigest: SHOTS, approvalSeq: 52 })) as UiContentEvidence;
    expect(s).toMatchObject({ strength: "scope_carry", renderInputs: null, renderId: null });
    const v = judgeContentEvidence(s, facts());
    expect(v).toMatchObject({ ok: true, strength: "scope_carry", renderId: null });
    expect(isFullContentProof(v)).toBe(false);
    const forged = { ...s, renderInputs: "e".repeat(64), renderId: renderIdOf(r.contentId, "e".repeat(64), SHOTS) } as UiContentEvidence;
    expect(isFullContentProof(judgeContentEvidence(forged, facts()))).toBe(false);
    const full = ok(ui(r)) as UiContentEvidence;
    expect(isFullContentProof(judgeContentEvidence(full, facts()))).toBe(true);
    expect(judgeContentEvidence({ ...full, strength: "scope_carry" } as UiContentEvidence, facts())).toMatchObject({ ok: false });
  });
});

describe("[验收线 3] no valid evidence on doubt; old-head forensics kept", () => {
  test("a net diff too large to read completely is refused with both heads kept", async () => {
    expect(await review(h.big!)).toMatchObject({ ok: false, reason: expect.stringMatching(/太大|截断|maxBuffer/), approvedHead: h.big, currentHead: h.big });
    const capped: typeof runBounded = async (argv, opts) => runBounded(argv, opts);
    const r = await reviewContentEvidence({ repoDir: work, scope: SCOPE, mainHead: h.main2!, approvedHead: h.big!, currentHead: h.big!,
      sourceReviewSeq: 41 }, capped);
    expect(r).toMatchObject({ ok: false, approvedHead: h.big });
  });
  test("missing objects are refused", async () => {
    const ghost = "1".repeat(40);
    expect(await review(ghost)).toMatchObject({ ok: false, approvedHead: ghost, currentHead: ghost });
    expect(await review(h.old!, ghost)).toMatchObject({ ok: false, approvedHead: h.old, currentHead: ghost });
  });
  test("an ambiguous parent chain is refused and keeps the approved head", async () => {
    const tree = await sh("rev-parse", `${h.two}^{tree}`);
    const both = await sh("commit-tree", tree, "-p", h.main1!, "-p", h.main2!, "-m", "ambiguous");
    expect(await review(h.old!, both)).toMatchObject({ ok: false, reason: expect.stringContaining("父"), approvedHead: h.old, currentHead: both });
    const side = await sh("commit-tree", tree, "-p", h.old!, "-p", h.byte!, "-m", "side");
    expect(await review(h.old!, side)).toMatchObject({ ok: false, approvedHead: h.old, currentHead: side });
  });
  test("main drift and malformed inputs are refused", async () => {
    expect(await review(h.old!, h.two!, {}, h.main1)).toMatchObject({ ok: false, approvedHead: h.old });
    expect(await review("abc")).toMatchObject({ ok: false });
    expect(await review(h.old!, h.old!, { pr: 0 })).toMatchObject({ ok: false });
    expect(await review(h.old!, h.old!, { specRev: -1 })).toMatchObject({ ok: false });
    expect(await review(h.old!, h.old!, { taskId: "" })).toMatchObject({ ok: false });
    expect(await reviewContentEvidence({ repoDir: work, scope: SCOPE, mainHead: h.main2!, approvedHead: h.old!, currentHead: h.old!,
      sourceReviewSeq: 0 })).toMatchObject({ ok: false });
  });
  test("spec, round, task, PR, repository, head, review or approval changes invalidate; old heads stay in the refusal", async () => {
    const r = ok(await review(h.old!, h.two!));
    const u = ok(ui(r)) as UiContentEvidence;
    expect(judgeContentEvidence(r, facts())).toMatchObject({ ok: true, strength: "full", contentId: r.contentId, renderId: null });
    expect(judgeContentEvidence(u, facts())).toMatchObject({ ok: true, strength: "full", renderId: u.renderId });
    const cases: [string, ContentFacts, RegExp][] = [
      ["spec", facts({ scope: { ...SCOPE, specRev: 3 } }), /规格/], ["round", facts({ scope: { ...SCOPE, round: 2 } }), /轮次/],
      ["task", facts({ scope: { ...SCOPE, taskId: "t-9" } }), /卡/], ["pr", facts({ scope: { ...SCOPE, pr: 9 } }), /PR/],
      ["repo", facts({ scope: { ...SCOPE, repository: "example/other" } }), /仓库/], ["head", facts({}, h.one), /head/],
      ["review", facts({ reviewLive: () => false }), /审查/], ["review throws", facts({ reviewLive: () => { throw new Error("db"); } }), /审查/],
    ];
    for (const [, f, why] of cases) {
      for (const ev of [r, u]) {
        expect(judgeContentEvidence(ev, f)).toMatchObject({ ok: false, reason: expect.stringMatching(why), approvedHead: h.old, currentHead: h.two,
          mainHead: h.main2 });
      }
    }
    for (const f of [facts({ approvalLive: () => false }), facts({ approvalLive: undefined }), facts({ approvalLive: () => { throw new Error("x"); } })]) {
      expect(judgeContentEvidence(u, f)).toMatchObject({ ok: false, reason: expect.stringContaining("批准"), approvedHead: h.old });
      expect(judgeContentEvidence(r, f)).toMatchObject({ ok: true });
    }
  });
  test("a wrong digest, a tampered field or an unknown version is not evidence", async () => {
    const r = ok(await review(h.old!, h.two!));
    const u = ok(ui(r)) as UiContentEvidence;
    const bad: unknown[] = [
      { ...r, contentId: "f".repeat(64) }, { ...r, diffHash: "f".repeat(64) }, { ...r, scope: { ...r.scope, round: 9 } }, { ...r, v: 2 },
      { ...r, kind: "other" }, { ...u, renderId: "f".repeat(64) }, { ...u, screenshotsDigest: "f".repeat(64) }, { ...u, renderInputs: "f".repeat(64) },
      { ...u, review: { ...r, contentId: "f".repeat(64) } }, { ...u, approvalSeq: 0 }, null, "x",
    ];
    for (const ev of bad) expect(judgeContentEvidence(ev as ReviewContentEvidence, facts())).toMatchObject({ ok: false });
  });
  test("a render blob missing from the object store is refused even though ls-tree still lists it", async () => {
    const head = await variant("lostblob", () => file("web/lost.html", "<p>only here</p>\n"));
    const r = ok(await review(head));
    const oid = await sh("rev-parse", `${head}:web/lost.html`), loose = join(work, ".git/objects", oid.slice(0, 2), oid.slice(2));
    renameSync(loose, `${loose}.away`);
    try {
      expect(ui(r)).toMatchObject({ ok: false, reason: expect.stringContaining("rev-list"), approvedHead: head, currentHead: head });
    } finally { renameSync(`${loose}.away`, loose); }
    expect(ok(ui(r))).toMatchObject({ strength: "full" });
  });
  test("a render inventory cut before its final NUL is refused", async () => {
    const r = ok(await review(h.old!)), oid = await sh("rev-parse", `${h.old}:web/index.html`), git = gitIn(work);
    const cut = (...args: string[]) => args[0] === "ls-tree" ? Buffer.from(`100644 blob ${oid}\tweb/index.html`) : git(...args);
    expect(uiContentEvidence({ review: r, read: cut, fileGlobs: GLOBS, screenshotsDigest: SHOTS, approvalSeq: 52 }))
      .toMatchObject({ ok: false, reason: expect.stringContaining("NUL"), approvedHead: h.old, currentHead: h.old });
  });
  test("a stored parent chain must link approved head to current head, hop by hop, bounded and acyclic", async () => {
    const r = ok(await review(h.old!, h.two!)), self = ok(await review(h.two!)), [a, b] = r.chain as { head: string; previousHead: string; mainParent: string }[];
    const bad: unknown[] = [
      { ...r, approvedHead: h.byte, chain: [null] }, { ...r, chain: [] }, { ...r, chain: [b, a] }, { ...r, chain: [b] }, { ...r, chain: [a] },
      { ...r, chain: [a, { ...b, mainParent: "x" }] }, { ...r, chain: [a, { ...b, head: h.old }] }, { ...self, chain: [b] },
      { ...r, chain: Array.from({ length: 17 }, () => a) }, { ...r, chain: "x" }, { ...r, chain: [a, b, { ...b, previousHead: h.two }] },
    ];
    for (const ev of bad) expect(judgeContentEvidence(ev as ReviewContentEvidence, facts())).toMatchObject({ ok: false, reason: expect.stringContaining("父链") });
    expect(judgeContentEvidence(r, facts())).toMatchObject({ ok: true });
    expect(judgeContentEvidence(self, facts({ reviewLive: (s, at) => s === 41 && at === h.two }, h.two))).toMatchObject({ ok: true });
    expect(ui({ ...r, chain: [b] } as ReviewContentEvidence)).toMatchObject({ ok: false, reason: expect.stringContaining("父链") });
  });
  test("a well-formed chain from another approved head fails the injected review binding", async () => {
    const r = ok(await review(h.old!, h.two!)), [a, b] = r.chain as { head: string; previousHead: string; mainParent: string }[];
    const moved = { ...r, approvedHead: h.byte!, chain: [{ ...a!, previousHead: h.byte! }, b] } as ReviewContentEvidence;
    expect(judgeContentEvidence(moved, facts())).toMatchObject({ ok: false, reason: expect.stringContaining("审查"), approvedHead: h.byte });
    const u = ok(ui(r)) as UiContentEvidence;
    expect(judgeContentEvidence(u, facts({ approvalLive: (s, at) => s === 52 && at === h.byte }))).toMatchObject({ ok: false, reason: expect.stringContaining("批准") });
  });
});

describe("[验收线 4] coexistence: pure, no production action", () => {
  test("the module imports no ledger / writer / process module and has no switch", () => {
    const src = readFileSync(join(import.meta.dir, "../src/lib/merge-content-proof.ts"), "utf8");
    const imports = [...src.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]).sort();
    expect(imports).toEqual(["./review-main-carry-proof.js", "./run-bounded.js", "./scheduler-ui-carry-proof.js", "./scheduler-ui-review-carry.js",
      "node:crypto"]);
    expect(src).not.toMatch(/recoveryPolicy|insertEvent|writeFile|spawn|execFile|ledger-/);
  });
  test("judging calls only the injected predicates, once each", async () => {
    const r = ok(await review(h.old!, h.two!));
    const u = ok(ui(r)) as UiContentEvidence;
    const seen: string[] = [];
    judgeContentEvidence(u, facts({ reviewLive: (s, at) => { seen.push(`r${s}@${at}`); return true; },
      approvalLive: (s, at) => { seen.push(`a${s}@${at}`); return true; } }));
    expect(seen).toEqual([`r41@${h.old}`, `a52@${h.old}`]);
  });
});

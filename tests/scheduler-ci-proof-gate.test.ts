/**
 * merge-arch-GATE1: the shared CI full-proof decision (src/lib/scheduler-ci-proof-gate.ts) and its read-only GitHub port
 * (src/lib/scheduler-ci-proof-port.ts). What the subject is bound to, every drift that voids a proof, what off / observe / on do
 * with the same facts, and what the port may ask GitHub. The four entries are driven in tests/scheduler-ci-proof-flow.test.ts.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { CiRunEvidence } from "../src/lib/ci-proof.js";
import { CI_PROOF_MANIFEST_VERSION, ciProofManifestDigest, parseCiProofManifest } from "../src/lib/ci-proof-manifest.js";
import { ciReuseDigest } from "../src/lib/ci-proof-reuse.js";
import type { BoundedResult } from "../src/lib/run-bounded.js";
import {
  CI_PROOF_POLICY, type CiProofFacts, type CiProofStage, type CiProofSubject, ciProofAdmits, ciProofPreflight, ciProofReport, ciProofVerdict, resolveCiProof,
} from "../src/lib/scheduler-ci-proof-gate.js";
import {
  CI_PROOF_WORKFLOW, type CiProofCommit, type CiProofPort, type CiProofPull, type CiProofRead, type CiProofRunRow, ghCiProofPort, resetCiProofPortCache,
} from "../src/lib/scheduler-ci-proof-port.js";

const sha = (c: string) => c.repeat(40);
const sha256 = (s: string) => `sha256:${createHash("sha256").update(s).digest("hex")}`;
const REPO = "o/r", HEAD = sha("a"), MAIN = sha("d"), MERGE = sha("e"), TREE = sha("f"), PR_BASE = sha("9"), RUN = 7;
const REQUIRED = ["ci"], LOCK = "lockfile v1\n", YML = "steps:\n  - uses: oven-sh/setup-bun@v2\n    with:\n      bun-version: 1.3.14\n";

const manifestOf = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  version: CI_PROOF_MANIFEST_VERSION, repo: REPO, head: HEAD, base: PR_BASE, checkout: { sha: MERGE, tree: TREE },
  workflow: { path: CI_PROOF_WORKFLOW, sha: MERGE }, policyVersion: CI_PROOF_POLICY, toolchain: { bun: "1.3.14", lockfileDigest: sha256(LOCK) },
  tests: { universeDigest: sha256("all"), selectedDigest: sha256("all"), count: 3 }, scope: "full", checks: [...REQUIRED], ...over,
});
function evidenceOf(content: unknown = manifestOf(), over: Partial<CiRunEvidence> = {}): CiRunEvidence {
  const parsed = parseCiProofManifest(content);
  return {
    origin: "actions-api", repo: REPO, runId: RUN, attempt: 1, latestAttempt: 1, workflow: { path: CI_PROOF_WORKFLOW, sha: MERGE }, headSha: HEAD,
    status: "completed", conclusion: "success", jobs: [{ name: "ci", attempt: 1, conclusion: "success", checkoutSha: MERGE, checkoutTree: TREE }],
    artifact: { runId: RUN, attempt: 1, digest: parsed.ok ? ciProofManifestDigest(parsed.manifest) : "", content }, ...over,
  };
}

/** GitHub as the gate sees it: one open PR at HEAD whose newest pull_request run tested MERGE = MAIN + HEAD. Tests bend one fact each. */
function world() {
  const w = {
    main: MAIN, pull: { head: HEAD, base: PR_BASE, state: "open" } as CiProofPull,
    commits: new Map<string, CiProofCommit>([[MERGE, { sha: MERGE, tree: TREE, parents: [MAIN, HEAD] }]]),
    runs: [{ id: RUN, event: "pull_request", headSha: HEAD, status: "completed" }] as CiProofRunRow[],
    read: { evidence: evidenceOf(), event: "pull_request", checkout: MERGE } as CiProofRead, files: { "bun.lock": LOCK, [CI_PROOF_WORKFLOW]: YML } as Record<string, string>,
    fail: null as string | null, calls: [] as string[],
  };
  const step = <T>(name: string, value: () => T) => async (): Promise<T> => { w.calls.push(name); if (w.fail === name) throw new Error(`${name} down`); return value(); };
  const port: CiProofPort = {
    mainHead: step("mainHead", () => w.main), pull: step("pull", () => w.pull), runs: step("runs", () => w.runs), read: step("read", () => w.read),
    commit: async (_r, s) => { const c = w.commits.get(s); if (!c) throw new Error(`no commit ${s}`); return c; },
    file: async (_r, _s, path) => w.files[path] ?? "",
  };
  return { w, port };
}
const SUBJECT: CiProofSubject = { kind: "pr", repo: REPO, pr: 7, head: HEAD, base: MAIN, requiredChecks: REQUIRED };
const judge = (facts: CiProofFacts, stage: CiProofStage = "merge") => ciProofVerdict(stage, "on", true, facts);

describe("[验收线 1] a related green without a full proof cannot merge under on; the exact full proof restores it", () => {
  test("red side: the bucket check passes a run with no manifest; observe keeps that answer, on denies it, the full proof allows it", async () => {
    const { w, port } = world();
    w.read = { ...w.read, evidence: evidenceOf(manifestOf(), { artifact: null }) };
    const none = await resolveCiProof(SUBJECT, port);
    const bucketGreen = none.evidence!.jobs.every((j) => j.conclusion === "success") && REQUIRED.every((n) => none.evidence!.jobs.some((j) => j.name === n));
    expect(bucketGreen).toBe(true); // what scheduler-merge-driver.ts green() reads today
    expect(ciProofVerdict("merge", "observe", true, none)).toMatchObject({ allow: true, proven: false, reasons: ["run 没有证明工件"] });
    expect(ciProofVerdict("merge", "on", true, none)).toMatchObject({ allow: false, proven: false });
    expect(ciProofVerdict("merge", "off", true, none)).toEqual({ stage: "merge", mode: "off", allow: true, proven: false, reasons: [] });
    w.read = { ...w.read, evidence: evidenceOf() };
    const full = await resolveCiProof(SUBJECT, port);
    expect(full).toMatchObject({ gaps: [], pending: false, runId: RUN, expect: { head: HEAD, base: PR_BASE, checkout: { sha: MERGE, tree: TREE } } });
    expect(judge(full)).toMatchObject({ allow: true, proven: true, reasons: [] });
  });

  test("a bound related manifest is not a full proof; the gate only narrows the path's own answer", async () => {
    const { w, port } = world();
    w.read = { ...w.read, evidence: evidenceOf(manifestOf({ scope: "related" })) };
    expect(judge(await resolveCiProof(SUBJECT, port))).toMatchObject({ allow: false, proven: false, reasons: ["related 证明不授权合并"] });
    w.read = { ...w.read, evidence: evidenceOf() };
    const full = await resolveCiProof(SUBJECT, port);
    expect(ciProofVerdict("merge", "on", false, full)).toMatchObject({ allow: false, proven: true });
    expect(ciProofVerdict("deploy", "observe", false, full).allow).toBe(false);
  });

  test("boarding and planning (admit) never need a proof, whatever the mode", () => {
    for (const mode of ["off", "observe", "on"] as const) expect(ciProofVerdict("admit", mode, true, null)).toMatchObject({ allow: true, reasons: [] });
    expect([ciProofAdmits(), ciProofAdmits(false)]).toEqual([true, false]);
  });
});

describe("[验收线 2] head / base / tree drift, a moved main, a missing artifact and a wrong source never carry a proof over", () => {
  const cases: [string, (w: ReturnType<typeof world>["w"]) => void, RegExp, boolean][] = [
    ["the PR head moved", (w) => { w.pull = { ...w.pull, head: sha("b") }; }, /PR head 已变成/, false],
    ["main moved since the run (the tested merge sits on the old main)", (w) => { w.main = sha("1"); }, /不是 main 111111111111 \+ head/, false],
    ["the run tested a merge of another head", (w) => { w.commits.set(MERGE, { sha: MERGE, tree: TREE, parents: [MAIN, sha("b")] }); }, /不是 main/, false],
    ["the checked-out tree is not the manifest's", (w) => { w.commits.set(MERGE, { sha: MERGE, tree: sha("0"), parents: [MAIN, HEAD] }); }, /实际检出 tree 不符|checkout\.tree 不符/, false],
    ["the manifest names another base", (w) => { w.pull = { ...w.pull, base: sha("8") }; }, /manifest base 不符/, false],
    ["the attempt left no proof archive", (w) => { w.read = { ...w.read, checkout: null, evidence: evidenceOf(manifestOf(), { artifact: null }) }; }, /没有留下本次 attempt 的证明工件/, false],
    ["the archive belongs to an earlier attempt", (w) => { const e = evidenceOf(); w.read = { ...w.read, evidence: { ...e, attempt: 2, latestAttempt: 2 } }; }, /工件来自 run 7 attempt 1/, false],
    ["the evidence is a check run, not the Actions API", (w) => { w.read = { ...w.read, evidence: evidenceOf(manifestOf(), { origin: "check-run" }) }; }, /证据来源 check-run 不受信/, false],
    ["an author-written JSON", (w) => { w.read = { ...w.read, evidence: evidenceOf(manifestOf(), { origin: "author-json" }) }; }, /证据来源 author-json 不受信/, false],
    ["the run is another repository's", (w) => { w.read = { ...w.read, evidence: evidenceOf(manifestOf(), { repo: "x/y" }) }; }, /run 仓库 x\/y/, false],
    ["the lockfile of the tested commit is not the one the run recorded", (w) => { w.files["bun.lock"] = "other\n"; }, /lockfileDigest 不符/, false],
    ["the PR is closed", (w) => { w.pull = { ...w.pull, state: "closed" }; }, /PR 状态 closed/, false],
    ["the run is still in progress", (w) => { w.runs = [{ ...w.runs[0]!, status: "in_progress" }]; }, /未完成/, true],
    ["no pull_request run of this head yet (a push run of the same sha does not count)", (w) => { w.runs = [{ ...w.runs[0]!, event: "push" }]; }, /还没有 pull_request 的 CI run/, true],
    ["GitHub cannot be read", (w) => { w.fail = "read"; }, /证据读取失败：read down/, true],
  ];
  for (const [name, bend, why, pending] of cases) {
    test(`${name}: no proof (${pending ? "may still arrive" : "will not arrive by itself"})`, async () => {
      const { w, port } = world();
      bend(w);
      const facts = await resolveCiProof({ ...SUBJECT, base: w.main }, port), v = judge(facts);
      expect(v).toMatchObject({ allow: false, proven: false });
      expect(v.reasons.join("；")).toMatch(why);
      expect(facts.pending).toBe(pending);
      expect(ciProofVerdict("merge", "observe", true, facts)).toMatchObject({ allow: true, proven: false }); // observe records, never narrows
    });
  }

  test("the proof is bound to the exact subject: the same run does not prove another head, another main or a main push", async () => {
    const { port } = world();
    expect(judge(await resolveCiProof(SUBJECT, port)).proven).toBe(true);
    expect(judge(await resolveCiProof({ ...SUBJECT, head: sha("b") }, port)).proven).toBe(false);
    expect(judge(await resolveCiProof({ ...SUBJECT, base: sha("1") }, port)).proven).toBe(false);
    expect(judge(await resolveCiProof({ kind: "main", repo: REPO, head: MERGE, requiredChecks: REQUIRED }, port), "deploy").proven).toBe(false);
  });

  test("a train car's PR is bound to whatever head it has now and to the train's base", async () => {
    const { w, port } = world();
    const car: CiProofSubject = { kind: "pr", repo: REPO, pr: 90, base: MAIN, requiredChecks: REQUIRED };
    expect(await resolveCiProof(car, port)).toMatchObject({ head: HEAD, gaps: [] });
    w.main = sha("1"); // main advanced by an earlier member's merge: the car's proof still stands on the train's base
    expect(judge(await resolveCiProof(car, port)).proven).toBe(true);
    expect(judge(await resolveCiProof({ ...car, base: sha("1") }, port)).proven).toBe(false);
  });

  test("deploy subject: the main commit itself, proven by its push run; a later main or a pull_request run of it proves nothing", async () => {
    const { w, port } = world();
    const TIP = sha("c"), push = manifestOf({ head: TIP, base: MAIN, checkout: { sha: TIP, tree: TREE }, workflow: { path: CI_PROOF_WORKFLOW, sha: TIP } });
    w.commits.set(TIP, { sha: TIP, tree: TREE, parents: [MAIN, HEAD] });
    w.runs = [{ id: RUN, event: "push", headSha: TIP, status: "completed" }];
    w.read = { event: "push", checkout: TIP, evidence: evidenceOf(push, { headSha: TIP, workflow: { path: CI_PROOF_WORKFLOW, sha: TIP },
      jobs: [{ name: "ci", attempt: 1, conclusion: "success", checkoutSha: TIP, checkoutTree: TREE }] }) };
    const subject: CiProofSubject = { kind: "main", repo: REPO, head: TIP, requiredChecks: REQUIRED };
    expect(judge(await resolveCiProof(subject, port), "deploy")).toMatchObject({ allow: true, proven: true });
    expect(w.calls).not.toContain("pull");
    w.runs = [{ id: RUN, event: "pull_request", headSha: TIP, status: "completed" }];
    expect(judge(await resolveCiProof(subject, port), "deploy")).toMatchObject({ allow: false, reasons: [expect.stringMatching(/还没有 main push 的 CI run/)] });
    w.runs = [{ id: RUN, event: "push", headSha: TIP, status: "completed" }];
    w.read = { ...w.read, evidence: { ...w.read.evidence, conclusion: "failure" } };
    expect(judge(await resolveCiProof(subject, port), "deploy")).toMatchObject({ allow: false, proven: false, reasons: ["run 结论 failure"] });
  });
});

describe("PM 定 6: a manual operation prints the same evidence and gaps; it blocks nothing", () => {
  const policy = (mode: "on" | "observe" | "off") => () => ({ mode, manualAfterMs: null, source: "config" as const });
  test("proven: subject, run, the integration commit and what was only attested by the run", async () => {
    const { port } = world();
    const lines = await ciProofPreflight({ project: "p", prRef: "https://github.com/o/r/pull/7", head: HEAD, requiredChecks: REQUIRED }, port, policy("on"));
    expect(lines).toEqual([
      `CI full 证明（ciCoverageGate=on）：PR #7 head ${HEAD.slice(0, 12)} 合到 main ${MAIN.slice(0, 12)}`, "  run：7 attempt 1，completed/success",
      `  集成提交：${MERGE} tree ${TREE}`, "  取自 run 自述、未独立核对：tests.universeDigest", "  结论：full 证明成立",
    ]);
  });

  test("a gap reads the same under every mode (off still reports, as observe) and says whether it can still close", async () => {
    const { w, port } = world();
    w.main = sha("1");
    const gapped = await ciProofPreflight({ project: "p", prRef: "https://github.com/o/r/pull/7", head: HEAD, requiredChecks: REQUIRED }, port, policy("off"));
    expect(gapped.at(-1)).toMatch(/^ {2}缺口（不会自己补齐）：run 7 测的集成提交 e{12} 不是 main 1{12} \+ head a{12}/);
    w.runs = [];
    expect(ciProofReport(await resolveCiProof({ ...SUBJECT, base: w.main }, port)).at(-1)).toMatch(/缺口（可能还会补齐）：head a{12} 还没有/);
  });
});

/** A scripted `gh` / `unzip` and a scripted fetch: every argv and URL is logged, so the tests can say what the port may ask. */
function fakeGitHub() {
  const zip = new TextEncoder().encode("zip-bytes"), report = { runId: RUN, attempt: 1, checkout: MERGE, manifestDigest: evidenceOf().artifact!.digest };
  const g = {
    argv: [] as string[][], urls: [] as { url: string; auth: boolean }[], members: { "manifest.json": JSON.stringify(manifestOf()), "report.json": JSON.stringify(report) } as Record<string, string>,
    artifactDigest: ciReuseDigest(zip) as string | null, runAttempt: 1, api: {} as Record<string, unknown>,
  };
  const run = { id: RUN, run_attempt: 1, event: "pull_request", head_sha: HEAD, path: CI_PROOF_WORKFLOW, status: "completed", conclusion: "success", repository: { full_name: REPO } };
  const routes = (): Record<string, unknown> => ({
    "repos/o/r/git/ref/heads/main": { object: { sha: MAIN } }, "repos/o/r/pulls/7": { state: "open", head: { sha: HEAD }, base: { sha: PR_BASE } },
    [`repos/o/r/git/commits/${MERGE}`]: { sha: MERGE, tree: { sha: TREE }, parents: [{ sha: MAIN }, { sha: HEAD }] },
    [`repos/o/r/actions/runs?head_sha=${HEAD}&per_page=100`]: { total_count: 2, workflow_runs: [run, { ...run, id: 3, path: ".github/workflows/other.yml" }] },
    "repos/o/r/actions/runs/7": { ...run, run_attempt: g.runAttempt },
    [`repos/o/r/actions/runs/7/attempts/${g.runAttempt}/jobs?per_page=100`]: { total_count: 1, jobs: [{ name: "ci", run_attempt: g.runAttempt, conclusion: "success" }] },
    "repos/o/r/actions/runs/7/artifacts?name=ci-proof&per_page=100": { artifacts: [{ id: 55, name: "ci-proof", expired: false, digest: g.artifactDigest,
      workflow_run: { id: RUN }, archive_download_url: "x" }] },
    "repos/o/r/actions/runs/7/artifacts?name=ci-proof-reuse&per_page=100": { artifacts: [] }, ...g.api,
  });
  const ok = (stdout: string): BoundedResult => ({ code: 0, stdout, stderr: "", timedOut: false });
  const command = async (argv: string[]): Promise<BoundedResult> => {
    g.argv.push(argv);
    if (argv[0] === "unzip") return ok(argv[1] === "-Z1" ? Object.keys(g.members).join("\n") : g.members[argv[3]!] ?? "");
    if (argv.join(" ") === "gh auth token") return ok("tok\n");
    const path = argv.at(-1)!;
    if (path.endsWith("/actions/variables/CI_PROOF_REUSE_REVOKED")) return { code: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)", timedOut: false };
    if (path.includes("/contents/")) return ok(path.includes("bun.lock") ? LOCK : YML);
    const hit = routes()[path];
    return hit === undefined ? { code: 1, stdout: "", stderr: `no route ${path}`, timedOut: false } : ok(JSON.stringify(hit));
  };
  const fetch = async (url: string, init: { headers?: Record<string, string> }): Promise<Response> => {
    g.urls.push({ url, auth: !!init.headers?.authorization });
    return url.startsWith("https://api.github.com/") ? new Response(null, { status: 302, headers: { location: "https://blob.example/zip?sig=1" } }) : new Response(zip);
  };
  return { g, port: ghCiProofPort(command, { fetch, now: () => 1_000 }) };
}

describe("the port: one run read back from the Actions API, GET only", () => {
  beforeEach(() => resetCiProofPortCache());

  test("run → latest attempt → jobs → digest-checked ci-proof archive: the evidence proves the PR's merge onto main", async () => {
    const { g, port } = fakeGitHub();
    const facts = await resolveCiProof(SUBJECT, port);
    expect(facts).toMatchObject({ gaps: [], runId: RUN, evidence: { origin: "actions-api", attempt: 1, latestAttempt: 1, headSha: HEAD, workflow: { sha: MERGE },
      jobs: [{ name: "ci", checkoutSha: MERGE, checkoutTree: TREE }], artifact: { runId: RUN, attempt: 1 }, reuse: { origins: [], unread: [] } } });
    expect(judge(facts)).toMatchObject({ allow: true, proven: true });
    // every GitHub read is `gh api -H Accept … <path>`: no method, field or input flag can reach it
    const gh = g.argv.filter((a) => a[0] === "gh" && a[1] === "api");
    expect(gh.length).toBeGreaterThan(5);
    for (const a of gh) expect(a.filter((x) => /^(-X|--method|-f|-F|--field|--raw-field|--input)$/.test(x))).toEqual([]);
    // the archive: the token goes to api.github.com only, the signed redirect is fetched without it
    expect(g.urls).toEqual([{ url: "https://api.github.com/repos/o/r/actions/artifacts/55/zip", auth: true }, { url: "https://blob.example/zip?sig=1", auth: false }]);
  });

  test("a finished run is read once and reused; other workflows' runs of the same head are not CI runs", async () => {
    const { g, port } = fakeGitHub();
    expect((await port.runs(REPO, HEAD)).map((r) => r.id)).toEqual([RUN]);
    await port.read(REPO, RUN);
    const reads = g.argv.length;
    expect((await port.read(REPO, RUN)).checkout).toBe(MERGE);
    expect(g.argv.length).toBe(reads);
  });

  test("the archive's bytes must match the digest GitHub registered; a mismatch or a missing digest is an unreadable proof, not a proof", async () => {
    for (const digest of [`sha256:${"0".repeat(64)}`, null]) {
      resetCiProofPortCache();
      const { g, port } = fakeGitHub();
      g.artifactDigest = digest;
      const facts = await resolveCiProof(SUBJECT, port);
      expect(facts).toMatchObject({ pending: true, expect: null, gaps: [expect.stringMatching(/证据读取失败：工件 55 下载内容的摘要与登记的不符或缺失/)] });
      expect(judge(facts).allow).toBe(false);
    }
  });

  test("an archive written by an earlier attempt, or one whose commit is not a merge of the run's head, names no checkout", async () => {
    const stale = fakeGitHub();
    stale.g.runAttempt = 2; // the run was re-run; the archive's report still says attempt 1
    expect(await stale.port.read(REPO, RUN)).toMatchObject({ checkout: null, evidence: { attempt: 2, artifact: { attempt: 1 }, jobs: [{ checkoutSha: null, checkoutTree: null }] } });
    resetCiProofPortCache();
    const other = fakeGitHub();
    other.g.api[`repos/o/r/git/commits/${MERGE}`] = { sha: MERGE, tree: { sha: TREE }, parents: [{ sha: MAIN }, { sha: sha("b") }] };
    expect((await other.port.read(REPO, RUN)).checkout).toBeNull();
    expect(judge(await resolveCiProof(SUBJECT, other.port))).toMatchObject({ allow: false, proven: false });
  });

  test("a truncated job or run list, an unsafe repo / sha / path and an artifact it did not list are refused before any request", async () => {
    const { g, port } = fakeGitHub();
    g.api["repos/o/r/actions/runs/7/attempts/1/jobs?per_page=100"] = { total_count: 120, jobs: [{ name: "ci", run_attempt: 1, conclusion: "success" }] };
    await expect(port.read(REPO, RUN)).rejects.toThrow("作业列表不完整");
    g.api[`repos/o/r/actions/runs?head_sha=${HEAD}&per_page=100`] = { total_count: 300, workflow_runs: [] };
    await expect(port.runs(REPO, HEAD)).rejects.toThrow("run 列表不完整");
    const asked = g.argv.length;
    await expect(port.mainHead("o/r/../../user")).rejects.toThrow("仓库名不合法");
    await expect(port.commit(REPO, "main")).rejects.toThrow("不是完整 SHA");
    await expect(port.file(REPO, MERGE, "../../etc/passwd")).rejects.toThrow("文件路径不合法");
    await expect(port.file(REPO, MERGE, "a?ref=x&y")).rejects.toThrow("文件路径不合法");
    await expect(port.pull(REPO, 0)).rejects.toThrow("PR 号不合法");
    expect(g.argv.length).toBe(asked);
    expect(g.urls).toEqual([]);
  });
});

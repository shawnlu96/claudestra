/**
 * Review-evidence v1 producer contract (REX1): synthetic ledger rows written through the real write paths (deliver, submitVerdict),
 * exported, then checked by the local self-check. One case per item the v1 draft lists: tampered report, missing artifact,
 * unclosed P1, head / spec mismatch, same-family / unknown-family identity, incomplete history, duplicate ids, path escape,
 * exact field preservation.
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallerIdentity } from "../src/lib/caller-identity.js";
import { closeLedger, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { assignStep } from "../src/lib/ledger-steps-write.js";
import { appendEvent, createTask, deliver, moveStage, recordReview, setMeta, setTask } from "../src/lib/ledger-write.js";
import { buildBundle, modelFamily, type ExportSource } from "../src/lib/review-evidence.js";
import { computeClosures, type EvidenceRound } from "../src/lib/review-evidence-closures.js";
import { collectSource, writeBundle, type CollectOpts } from "../src/lib/review-evidence-collect.js";
import { verifyBundle } from "../src/lib/review-evidence-verify.js";
import { submitVerdict } from "../src/lib/review-verdict.js";

const P = "proj";
const PM = { actor: "agent-pm", now: 1_100 };
const H1 = "a".repeat(40), H2 = "b".repeat(40), H3 = "c".repeat(40), BASE = "d".repeat(40);
let db: Database, dir: string, reviews: string, sessions: string, opts: CollectOpts;

const me = (agent: string): CallerIdentity => ({ agent, sessionId: `sess-${agent}`, family: "codex", verified: true });
const finding = (id: string, severity: "P0" | "P1" | "P2", extra: Record<string, unknown> = {}) =>
  ({ findingId: id, family: "gate", severity, probe: `复现 ${id}`, description: `说明 ${id}`, ...extra });
type F = ReturnType<typeof finding>;
const count = (fs: F[], s: string) => fs.filter((f) => f.severity === s).length;
const iso = (ms: number) => new Date(ms).toISOString();

function verdict(round: number, head: string, v: "pass" | "changes", findings: F[], now: number) {
  const reportPath = join(reviews, `T50-r${round}.md`);
  writeFileSync(reportPath, `# r${round} 报告\n`);
  assignStep(db, PM, { taskId: "T50", step: "review", executor: "agent-y", executorKind: "agent" });
  const r = submitVerdict(db, me("agent-y"), { v: 1, orderId: `T50:review:r${round}`, head, verdict: v, p0: count(findings, "P0"),
    p1: count(findings, "P1"), p2: count(findings, "P2"), findings, reportPath }, { registry: [{ name: "agent-x", runtime: "claude-code" }], reviewsDir: reviews, now });
  expect(r).toMatchObject({ ok: true });
}

function nextRound(head: string, now: number) {
  moveStage(db, { actor: "agent-pm", now }, { taskId: "T50", from: "review", to: "fix" });
  deliver(db, { actor: "agent-x", now: now + 100 }, { taskId: "T50", headSHA: head, moveFrom: "fix" });
}

/** Two rounds: r1 changes (P1 F1 + P2 F2) at H1, r2 pass at H2 still raising F2 as P2. */
function twoRounds(r2: F[] = [finding("F2", "P2")]) {
  verdict(1, H1, "changes", [finding("F1", "P1", { basis: "acceptance:1" }), finding("F2", "P2")], 2_000);
  nextRound(H2, 2_100);
  verdict(2, H2, "pass", r2, 3_000);
}

function session(id: string, lines: unknown[]) { writeFileSync(join(sessions, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n")); }
const claudeLine = (ms: number, model: string, id: string) => ({ type: "assistant", timestamp: iso(ms), message: { id, model } });
const codexLines = (ms: number, model: string, turn: string) => [{ type: "turn_context", timestamp: iso(ms), payload: { turn_id: turn, model } },
  { type: "token_usage_record", timestamp: iso(ms), payload: { turn_id: turn, response_id: `resp-${turn}` } }];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rex1-"));
  reviews = join(dir, "reviews");
  sessions = join(dir, "sessions");
  mkdirSync(reviews);
  mkdirSync(sessions);
  writeFileSync(join(dir, "T50.md"), "# T50\n\n## 验收\n1. 第一条\n2. 第二条\n");
  db = openLedger(":memory:");
  setMeta(db, { actor: "owner", now: 1_000 }, { project: P, key: "pms", value: ["agent-pm"] });
  createTask(db, { actor: "owner", now: 1_000 }, { project: P, id: "T50", title: "卡", kind: "code" });
  setTask(db, { actor: "owner", now: 1_000 }, { id: "T50", rev: 1, patch: { agent: "agent-x", spec: join(dir, "T50.md"), pr: "https://github.com/o/r/pull/9" } });
  assignStep(db, PM, { taskId: "T50", step: "write", executor: "agent-x", executorKind: "agent" });
  db.run("UPDATE tasks SET stage = 'build' WHERE id = 'T50'");
  deliver(db, { actor: "agent-x", now: 1_200 }, { taskId: "T50", headSHA: H1, moveFrom: "build" });
  session("sx", [claudeLine(1_500, "claude-opus-5-5", "m1"), claudeLine(2_500, "claude-opus-5-5", "m2")]);
  session("sess-agent-y", [...codexLines(1_800, "gpt-5.3-codex", "t1"), ...codexLines(2_900, "gpt-5.3-codex", "t2")]);
  opts = { base: BASE, repoDir: dir, reviewsDir: reviews, fingerprint: "ab12-cd34-ef56-7890", exporter: "agent-pm", bundleId: "T50-test", now: 5_000,
    registry: [{ name: "agent-x", runtime: "claude-code", sessionId: "sx" }, { name: "agent-y", runtime: "codex", sessionId: "sess-agent-y" }],
    sessionFile: (_rt, id) => join(sessions, `${id}.jsonl`) };
});
afterEach(() => {
  closeLedger(":memory:");
  rmSync(dir, { recursive: true, force: true });
});

/** The temp dir is no git repo: scope and bases come from the fixture, the rest from the real collector. */
const source = (over: Partial<ExportSource> = {}): ExportSource =>
  ({ ...collectSource(db, "T50", opts), changedFiles: ["src/a.ts"], roundBase: () => BASE, ...over });

function exportTo(name: string, over: Partial<ExportSource> = {}) {
  const bundle = buildBundle(source(over));
  const root = join(dir, name);
  writeBundle(root, bundle);
  return { root, bundle, m: JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")), check: () => verifyBundle(root) };
}

const editManifest = (root: string, edit: (m: any) => void) => {
  const m = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
  edit(m);
  writeFileSync(join(root, "manifest.json"), JSON.stringify(m));
};
/** Rewrite an artifact and fix its inventory entry: a self-consistent package whose content changed. */
function retouch(root: string, id: string, edit: (v: any) => unknown) {
  editManifest(root, (m) => {
    const a = m.artifacts.find((x: any) => x.id === id);
    const bytes = Buffer.from(JSON.stringify(edit(JSON.parse(readFileSync(join(root, a.path), "utf8")))));
    writeFileSync(join(root, a.path), bytes);
    Object.assign(a, { bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") });
  });
}
const problems = (r: { problems: string[] }) => r.problems.join("\n");

describe("happy path", () => {
  test("two structured rounds export a package the self-check accepts", () => {
    twoRounds();
    const { m, check } = exportTo("ok");
    expect(problems(check())).toBe("");
    expect(m.subject).toEqual({ repo: "o/r", pr: "https://github.com/o/r/pull/9", head: H2, base: BASE, specRev: 1, taskId: "T50",
      specArtifact: "spec", acceptanceArtifact: "acceptance" });
    expect(m.rounds.map((r: any) => [r.status, r.verdict, r.head, r.orderId])).toEqual([["completed", "changes", H1, "T50:review:r1"], ["completed", "pass", H2, "T50:review:r2"]]);
    const reviewer = m.rounds[1].reviewer;
    expect(reviewer).toMatchObject({ agent: "agent-y", sessionId: "sess-agent-y", runtime: "codex", family: "codex", verified: true,
      model: { provider: null, id: "gpt-5.3-codex", family: "gpt" } });
    expect(m.authors).toHaveLength(1);
    expect(m.authors[0]).toMatchObject({ agent: "agent-x", verified: false, family: "unknown", model: { id: "claude-opus-5-5", family: "claude" } });
    expect(m.final).toEqual({ reviewId: m.rounds[1].reviewId, verdict: "pass", openCounts: { p0: 0, p1: 0, p2: 1 },
      retainedP2: [{ reviewId: m.rounds[1].reviewId, findingId: "F2" }] });
    expect(m.scope).toEqual({ paths: ["src/a.ts"], fullPrCovered: true, evidenceArtifact: "scope" });
  });

  test("F1 closes with the fix commit, F2 is retained in both rounds; acceptance comes from the spec", () => {
    twoRounds();
    const { root, m } = exportTo("cl");
    const closures = JSON.parse(readFileSync(join(root, "closures.json"), "utf8"));
    const [r1, r2] = m.rounds.map((r: any) => r.reviewId);
    expect(closures.map((c: any) => [c.reviewId, c.findingId, c.disposition, c.confirmingReviewId, c.fixCommit])).toEqual([
      [r1, "F1", "closed", r2, H2], [r1, "F2", "retained", r2, null], [r2, "F2", "retained", r2, null]]);
    expect(JSON.parse(readFileSync(join(root, "inputs/acceptance.json"), "utf8"))).toEqual({ section: "验收", lines: ["1. 第一条", "2. 第二条"] });
  });

  test("every artifact is listed with its exact bytes and hash, and nothing else is in the package", () => {
    twoRounds();
    const { root, m } = exportTo("inv");
    for (const a of m.artifacts) {
      const b = readFileSync(join(root, a.path));
      expect([a.bytes, a.sha256]).toEqual([b.byteLength, createHash("sha256").update(b).digest("hex")]);
    }
    expect(new Set(m.artifacts.map((a: any) => a.path)).size).toBe(m.artifacts.length);
  });
});

describe("tampering and missing bytes", () => {
  test("a report changed after export fails its hash", () => {
    twoRounds();
    const { root, m, check } = exportTo("tamper");
    writeFileSync(join(root, m.artifacts.find((a: any) => a.id === `${m.rounds[1].reviewId}-report`).path), "# rewritten\n");
    expect(problems(check())).toContain("sha256 does not match");
  });

  test("a deleted artifact is reported missing", () => {
    twoRounds();
    const { root, check } = exportTo("missing");
    unlinkSync(join(root, "closures.json"));
    expect(problems(check())).toMatch(/closures.*missing/);
  });

  test("a report the ledger points at but that no longer exists is not exported, and the final pass is not usable", () => {
    twoRounds();
    unlinkSync(join(reviews, "T50-r2.md"));
    const { bundle, check } = exportTo("noreport");
    expect(bundle.notes.join("\n")).toContain("not a readable file under the reviews directory");
    expect(problems(check())).toContain("final review has no report");
  });
});

describe("unresolved findings", () => {
  test("a P1 a PM-recorded pass still lists stays open", () => {
    verdict(1, H1, "changes", [finding("F1", "P1", { basis: "acceptance:1" })], 2_000);
    nextRound(H2, 2_100);
    writeFileSync(join(reviews, "T50-r2.md"), "# r2\n");
    recordReview(db, { actor: "agent-pm", now: 3_000 }, { taskId: "T50", reviewer: "agent-y", verdict: "pass", p0: 0, p1: 1, p2: 0, path: join(reviews, "T50-r2.md"),
      head: H2, reviewerSessionId: "sess-agent-y", reviewerFamily: "codex", findings: [finding("F1", "P1", { basis: "acceptance:1" })] });
    const { m, check } = exportTo("p1open");
    expect(m.final.openCounts).toEqual({ p0: 0, p1: 1, p2: 0 });
    expect(m.rounds[1].reviewer.verified).toBe(false);
    expect(problems(check())).toContain("unresolved P0/P1");
  });

  test("dropping a P1's closure from the package leaves it open", () => {
    twoRounds();
    const { root, check } = exportTo("strip");
    retouch(root, "closures", (cl) => cl.filter((c: any) => c.findingId !== "F1"));
    expect(problems(check())).toContain("unresolved P0/P1");
  });

  test("a later round with no structured findings cannot close an earlier P1", () => {
    verdict(1, H1, "changes", [finding("F1", "P1", { basis: "acceptance:1" })], 2_000);
    nextRound(H2, 2_100);
    recordReview(db, { actor: "agent-pm", now: 3_000 }, { taskId: "T50", reviewer: "agent-y", verdict: "pass", p0: 0, p1: 0, p2: 0, path: join(reviews, "T50-r1.md") });
    const { m, check } = exportTo("legacy");
    expect(m.final.openCounts).toBeNull();
    expect(problems(check())).toContain("without structured findings");
    expect(problems(check())).toContain("not bridge-verified");
  });

  test("a closure claiming a review that re-raised the finding is refused", () => {
    twoRounds();
    const { root, m, check } = exportTo("badclose");
    retouch(root, "closures", (cl) => cl.map((c: any) => (c.findingId === "F2" && c.reviewId === m.rounds[0].reviewId ? { ...c, disposition: "closed" } : c)));
    expect(problems(check())).toContain(`closure ${m.rounds[0].reviewId}/F2: ["closed"`);
  });

  test("a closure pointing at an unrelated fix commit is refused, closed or retained", () => {
    twoRounds();
    const { root, check } = exportTo("forgedfix");
    retouch(root, "closures", (cl) => cl.map((c: any) => ({ ...c, fixCommit: "e".repeat(40) })));
    const r = check();
    expect(r.ok).toBe(false);
    expect(problems(r).match(/does not match what the findings support/g)).toHaveLength(3);
  });

  test("a chain re-raised under the same id closes when a later round drops it", () => {
    const r = (reviewId: string, round: number, head: string, findings: F[]): EvidenceRound =>
      ({ reviewId, round, head, findings: findings as never, findingsArtifact: `${reviewId}-f`, reportArtifact: `${reviewId}-r` });
    const out = computeClosures([r("a", 1, H1, [finding("F1", "P1")]), r("b", 2, H2, [finding("F1", "P1")]), r("c", 3, H3, [])]);
    expect(out.map((c) => [c.reviewId, c.disposition, c.confirmingReviewId, c.fixCommit])).toEqual([["a", "closed", "c", H3], ["b", "closed", "c", H3]]);
  });
});

describe("subject binding", () => {
  test("exporting a head the final review did not see is refused", () => {
    twoRounds();
    expect(problems(exportTo("head", { head: H3 }).check())).toContain(`final review saw head ${H2}, subject is ${H3}`);
  });

  test("a spec revision after the final review is refused", () => {
    twoRounds();
    db.run("UPDATE tasks SET specRev = 2 WHERE id = 'T50'");
    expect(problems(exportTo("spec").check())).toContain("final review was on specRev 1, subject is 2");
  });
});

describe("identity", () => {
  test("a reviewer whose session shows the author's model family is refused", () => {
    session("sess-agent-y", codexLines(2_900, "claude-opus-5-5", "y1"));
    twoRounds();
    expect(problems(exportTo("same").check())).toContain("share model family claude");
  });

  test("a model family edited in the manifest is checked against the model record, not trusted", () => {
    session("sess-agent-y", codexLines(2_900, "claude-opus-5-5", "y1"));
    twoRounds();
    const { root, check } = exportTo("forgedmodel");
    editManifest(root, (m) => { m.rounds.at(-1).reviewer.model.family = "gpt"; });
    const r = check();
    expect(r.ok).toBe(false);
    expect(problems(r)).toContain("does not follow from its model record");
  });

  test("verified, verdict and counts edited in the manifest must match the ledger records the package carries", () => {
    verdict(1, H1, "changes", [finding("F1", "P1", { basis: "acceptance:1" })], 2_000);
    nextRound(H2, 2_100);
    writeFileSync(join(reviews, "T50-r2.md"), "# r2\n");
    recordReview(db, { actor: "agent-pm", now: 3_000 }, { taskId: "T50", reviewer: "agent-y", verdict: "pass", p0: 0, p1: 0, p2: 0, path: join(reviews, "T50-r2.md"),
      head: H2, reviewerSessionId: "sess-agent-y", reviewerFamily: "codex", findings: [] });
    const { root, check } = exportTo("forgedid");
    expect(problems(check())).toContain("final reviewer identity is not bridge-verified");
    editManifest(root, (m) => { m.rounds[1].reviewer.verified = true; m.authors[0].verified = true; m.rounds[0].verdict = "pass"; });
    const p = problems(check());
    expect(p).not.toContain("final reviewer identity is not bridge-verified");
    expect(p).toContain(`round ${JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")).rounds[1].reviewId}: verified true does not match its ledger record (false)`);
    expect(p).toContain("author 1: verified true does not match its ledger record (false)");
    expect(p).toContain("verdict does not match its review record");
  });

  test("no session records in the review window leaves the family unknown, never guessed from the runtime", () => {
    session("sess-agent-y", []);
    twoRounds();
    const { m, check } = exportTo("unknown");
    expect(m.rounds[1].reviewer.model).toMatchObject({ provider: null, id: null, family: "unknown" });
    expect(problems(check())).toContain("final reviewer model family is unknown");
  });

  test("mixed models in one window are not collapsed to one family", () => {
    session("sess-agent-y", [...codexLines(2_800, "gpt-5.3-codex", "t3"), ...codexLines(2_900, "deepseek-v4", "t4")]);
    twoRounds();
    expect(exportTo("mixed").m.rounds[1].reviewer.model.family).toBe("unknown");
    expect([modelFamily("cc-switch/deepseek-v4.1-flash"), modelFamily("claude-opus-5-5"), modelFamily("???")]).toEqual(["deepseek", "claude", "unknown"]);
  });
});

describe("history", () => {
  test("a dispatch that never got a verdict is exported as incomplete, without a verdict, and no pass is made up for its head", () => {
    twoRounds();
    nextRound(H3, 3_100);
    appendEvent(db, { actor: "agent-pm", now: 3_300 }, { project: P, target: "T50", kind: "dispatch", text: "review r3", data: { reviewer: "adversarial", round: 3, head: H3 } });
    const { m, check } = exportTo("incomplete");
    expect(m.rounds.at(-1)).toMatchObject({ status: "incomplete", verdict: null, head: H3, reportArtifact: null, findingsArtifact: null });
    expect(m.rounds.at(-1)).not.toHaveProperty("p1");
    expect(m.final.reviewId).toBe(m.rounds[1].reviewId);
    expect(problems(check())).toContain(`final review saw head ${H2}, subject is ${H3}`);
  });

  test("an incomplete round edited to carry a verdict is refused", () => {
    twoRounds();
    appendEvent(db, { actor: "agent-pm", now: 3_300 }, { project: P, target: "T50", kind: "dispatch", text: "re-review", data: { reviewer: "adversarial", round: 2, head: H2 } });
    const { root, check } = exportTo("forged");
    editManifest(root, (m) => { m.rounds.at(-1).verdict = "pass"; });
    expect(problems(check())).toContain("carries a verdict or findings");
  });
});

describe("duplicate ids", () => {
  test("a duplicated reviewId or artifact id is refused", () => {
    twoRounds();
    const { root, check } = exportTo("dup");
    editManifest(root, (m) => { m.rounds[1].reviewId = m.rounds[0].reviewId; m.artifacts.push({ ...m.artifacts[0] }); });
    const p = problems(check());
    expect(p).toContain("duplicate reviewId");
    expect(p).toContain("duplicate artifact id spec");
  });

  test("a findings file with a repeated findingId is refused even when its hash was updated", () => {
    twoRounds();
    const { root, m, check } = exportTo("dupf");
    retouch(root, `${m.rounds[0].reviewId}-findings`, (f) => [...f, f[0]]);
    expect(problems(check())).toContain("duplicate findingId F1");
  });
});

describe("path escape", () => {
  test("parent traversal or absolute paths in the inventory are refused", () => {
    twoRounds();
    const { root, check } = exportTo("esc");
    editManifest(root, (m) => { m.artifacts[0].path = "../T50.md"; m.artifacts[1].path = "/etc/hosts"; });
    expect(problems(check()).match(/unsafe path/g)).toHaveLength(2);
  });

  test("a symlink inside the package is refused", () => {
    twoRounds();
    const { root, check } = exportTo("link");
    unlinkSync(join(root, "inputs/spec.md"));
    symlinkSync(join(dir, "T50.md"), join(root, "inputs/spec.md"));
    expect(problems(check())).toContain("symlink");
  });

  test("a ledger report path outside the reviews directory, or a link out of it, is never read", () => {
    writeFileSync(join(dir, "private.md"), "secret\n");
    symlinkSync(join(dir, "private.md"), join(reviews, "link.md"));
    const src = source();
    expect([src.report(join(dir, "private.md")), src.report(join(reviews, "link.md")), src.report(join(reviews, "..", "private.md"))]).toEqual([null, null, null]);
  });

  test("writing never lands in a non-empty directory", () => {
    twoRounds();
    const { root, bundle } = exportTo("once");
    expect(() => writeBundle(root, bundle)).toThrow("不为空");
  });
});

describe("field preservation", () => {
  test("findings and the ledger record are exported exactly as stored", () => {
    twoRounds([finding("F2", "P2", { description: "原样 ✓ \"quoted\"\n第二行", basis: "regression" })]);
    const { root, m } = exportTo("exact");
    const stored = listEvents(db, { target: "T50" }).filter((e) => e.kind === "review");
    const at = (id: string) => JSON.parse(readFileSync(join(root, m.artifacts.find((a: any) => a.id === id).path), "utf8"));
    expect(at(`${m.rounds[1].reviewId}-findings`)).toEqual(stored[1].data.findings);
    expect(at(`${m.rounds[1].reviewId}-submission`).review).toEqual(JSON.parse(JSON.stringify(stored[1])));
    expect(readFileSync(join(root, "inputs/spec.md"))).toEqual(readFileSync(join(dir, "T50.md")));
  });
});

/**
 * Local self-check of a written review-evidence bundle (v1 draft). It reads only the package directory and trusts nothing the
 * producer computed: bytes and hashes, path safety, references, findings counts, closures and the final pass are recomputed
 * from the files. A problem means the package must not be offered as evidence; it is never a verdict and never imports
 * anything. The receiving instance runs its own intake. tests/review-evidence.test.ts.
 */
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { modelClaim, type ModelRecord } from "./review-evidence.js";
import { computeClosures, countOpen, openFindings, type Closure, type EvidenceRound } from "./review-evidence-closures.js";
import type { ReviewFinding } from "./scheduler-review.js";

export interface VerifyResult { ok: boolean; problems: string[] }

type Obj = Record<string, unknown>;
const SHA40 = /^[0-9a-f]{40}$/;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const STATUSES = ["completed", "incomplete", "refused", "cancelled"];

/** Relative, normalized, forward-slash path with no parent segments: anything else could point outside the package. */
function safeRelPath(p: unknown): p is string {
  return typeof p === "string" && p.length > 0 && p.length <= 300 && !p.startsWith("/") && !p.includes("\\") && !p.includes("\0") &&
    posix.normalize(p) === p && !p.split("/").some((s) => s === ".." || s === "." || s === "");
}

/** Every path component must be a real directory / regular file, never a symlink: a link inside the package can escape it. */
function plainFile(root: string, rel: string): { ok: true; bytes: Buffer } | { ok: false; why: string } {
  let at = root;
  const parts = rel.split("/");
  for (const [i, part] of parts.entries()) {
    at = join(at, part);
    const st = lstatSync(at, { throwIfNoEntry: false });
    if (!st) return { ok: false, why: "missing" };
    if (st.isSymbolicLink()) return { ok: false, why: "symlink" };
    if (i < parts.length - 1 ? !st.isDirectory() : !st.isFile()) return { ok: false, why: "not a regular file" };
  }
  return { ok: true, bytes: readFileSync(at) };
}

function walk(root: string, rel = ""): { files: string[]; odd: string[] } {
  const files: string[] = [], odd: string[] = [];
  for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) { const sub = walk(root, p); files.push(...sub.files); odd.push(...sub.odd); } else if (e.isFile()) files.push(p); else odd.push(p);
  }
  return { files, odd };
}

class Check {
  readonly problems: string[] = [];
  readonly bytes = new Map<string, Buffer>();
  constructor(readonly root: string) {}
  fail(msg: string): void { this.problems.push(msg); }
  json(id: unknown, what: string): unknown {
    const b = typeof id === "string" ? this.bytes.get(id) : undefined;
    if (!b) return undefined;
    try { return JSON.parse(b.toString("utf8")); } catch { this.fail(`${what}: artifact ${String(id)} is not valid JSON`); return undefined; }
  }
}

function inventory(c: Check, artifacts: unknown): void {
  if (!Array.isArray(artifacts)) return c.fail("artifacts is not an array");
  const paths = new Set<string>();
  for (const a of artifacts) {
    if (!isObj(a) || typeof a.id !== "string" || !/^[\w.-]{1,120}$/.test(a.id)) { c.fail(`artifact with a bad id: ${JSON.stringify(a)?.slice(0, 120)}`); continue; }
    if (c.bytes.has(a.id)) { c.fail(`duplicate artifact id ${a.id}`); continue; }
    if (!safeRelPath(a.path) || a.path === "manifest.json") { c.fail(`artifact ${a.id}: unsafe path ${JSON.stringify(a.path)}`); continue; }
    if (paths.has(a.path)) { c.fail(`artifact ${a.id}: path ${a.path} listed twice`); continue; }
    paths.add(a.path);
    if (typeof a.mediaType !== "string" || typeof a.kind !== "string") c.fail(`artifact ${a.id}: mediaType / kind missing`);
    const got = plainFile(c.root, a.path);
    if (!got.ok) { c.fail(`artifact ${a.id} (${a.path}): ${got.why}`); continue; }
    if (got.bytes.byteLength !== a.bytes) c.fail(`artifact ${a.id}: ${got.bytes.byteLength} bytes, manifest says ${String(a.bytes)}`);
    else if (createHash("sha256").update(got.bytes).digest("hex") !== a.sha256) c.fail(`artifact ${a.id}: sha256 does not match the delivered bytes`);
    else c.bytes.set(a.id, got.bytes);
  }
  const { files, odd } = walk(c.root);
  for (const p of odd) c.fail(`package holds a non-regular entry ${p}`);
  for (const p of files) if (p !== "manifest.json" && !paths.has(p)) c.fail(`package file ${p} is not in the inventory`);
}

function ref(c: Check, id: unknown, what: string, required: boolean): void {
  if (id === null || id === undefined) { if (required) c.fail(`${what}: no artifact`); return; }
  if (typeof id !== "string" || !c.bytes.has(id)) c.fail(`${what}: artifact ${String(id)} does not resolve to a verified file`);
}

const modelRecord = (v: unknown): ModelRecord | null =>
  isObj(v) && Array.isArray(v.models) && v.models.every((x) => isObj(x) && typeof x.model === "string") ? v as unknown as ModelRecord : null;

/**
 * The model claim must be exactly what its model record yields, and each identity field must equal the ledger record the
 * package carries for it (expect): the cross-family and verified checks below read these fields, so they cannot be free text.
 */
function identity(c: Check, who: unknown, what: string, expect: Obj): void {
  if (!isObj(who)) return c.fail(`${what}: identity missing`);
  ref(c, who.identityReceipt, `${what} identity receipt`, true);
  const model = isObj(who.model) ? who.model : {};
  ref(c, model.sourceArtifact, `${what} model source`, true);
  const want = modelClaim(modelRecord(c.json(model.sourceArtifact, `${what} model`)), str(model.sourceArtifact));
  const got = { provider: model.provider, id: model.id, family: model.family, sourceArtifact: model.sourceArtifact };
  if (!same(got, want)) c.fail(`${what}: model claim ${JSON.stringify(got)} does not follow from its model record (${JSON.stringify(want)})`);
  for (const [k, v] of Object.entries(expect)) {
    if (!same(who[k], v)) c.fail(`${what}: ${k} ${JSON.stringify(who[k])} does not match its ledger record (${JSON.stringify(v)})`);
  }
}

/** What an author's receipt supports: verified only for an MCP delivery of the subject head, session / family only from a bound session. */
function authorRecord(c: Check, a: unknown, head: unknown, what: string): Obj {
  const rec = isObj(a) ? c.json(a.identityReceipt, what) : undefined;
  if (!isObj(rec)) return { agent: null, verified: false };
  const bound = isObj(rec.schedulerSession) ? rec.schedulerSession : {};
  const delivers = Array.isArray(rec.delivers) ? rec.delivers.filter(isObj) : [];
  return { agent: rec.agent ?? null, sessionId: str(bound.sessionId), family: str(bound.family) ?? "unknown",
    verified: delivers.some((e) => isObj(e.data) && e.data.headSHA === head && String(e.dedupKey ?? "").startsWith("mcp-deliver:")) };
}

/** The review record a round's submission carries; a completed round's verdict, counts, head and findings must be its copy. */
function reviewRecord(c: Check, r: Obj, what: string, findings: ReviewFinding[] | null): Obj {
  const sub = c.json(r.submissionArtifact, `${what} submission`);
  const review = isObj(sub) && isObj(sub.review) && sub.review.kind === "review" ? sub.review : null;
  if (r.status === "completed" && !review) c.fail(`${what}: submission holds no review record`);
  if (r.status !== "completed" && review) c.fail(`${what}: a ${String(r.status)} round's submission holds a review record`);
  const d = review && isObj(review.data) ? review.data : {};
  if (review) {
    for (const k of ["verdict", "p0", "p1", "p2"]) if (!same(r[k], d[k] ?? null)) c.fail(`${what}: ${k} does not match its review record`);
    if (findings && (!same(findings, d.findings) || r.head !== d.head)) c.fail(`${what}: findings / head do not match its review record`);
  }
  return { ...(review ? { agent: str(d.reviewer) } : {}), sessionId: str(d.reviewerSessionId), family: str(d.reviewerFamily) ?? "unknown", verified: d.via === "mcp" };
}

function findingsOf(c: Check, r: Obj, what: string): ReviewFinding[] | null {
  const raw = c.json(r.findingsArtifact, what);
  if (raw === undefined) return null;
  if (!Array.isArray(raw)) { c.fail(`${what}: findings is not an array`); return null; }
  const seen = new Set<string>();
  for (const f of raw) {
    if (!isObj(f) || typeof f.findingId !== "string" || typeof f.family !== "string" || typeof f.probe !== "string" || !["P0", "P1", "P2"].includes(String(f.severity))) {
      c.fail(`${what}: finding without findingId / family / severity / probe`); return null;
    }
    if (seen.has(f.findingId)) c.fail(`${what}: duplicate findingId ${f.findingId}`);
    seen.add(f.findingId);
  }
  for (const p of ["p0", "p1", "p2"] as const) {
    if (r[p] !== raw.filter((f: Obj) => f.severity === p.toUpperCase()).length) c.fail(`${what}: ${p} does not match the findings`);
  }
  return raw as ReviewFinding[];
}

function rounds(c: Check, list: unknown): { rounds: Obj[]; evidence: EvidenceRound[] } {
  if (!Array.isArray(list)) { c.fail("rounds is not an array"); return { rounds: [], evidence: [] }; }
  const ids = new Set<string>(), evidence: EvidenceRound[] = [];
  let prev = 0;
  for (const r of list) {
    if (!isObj(r) || typeof r.reviewId !== "string") { c.fail("round without reviewId"); continue; }
    const what = `round ${r.reviewId}`;
    if (ids.has(r.reviewId)) c.fail(`duplicate reviewId ${r.reviewId}`);
    ids.add(r.reviewId);
    if (typeof r.round !== "number" || r.round < prev) c.fail(`${what}: rounds are not in chronological order`);
    prev = typeof r.round === "number" ? r.round : prev;
    if (!STATUSES.includes(String(r.status))) c.fail(`${what}: unknown status ${String(r.status)}`);
    if (typeof r.head !== "string" || !SHA40.test(r.head)) c.fail(`${what}: head is not a full SHA`);
    ref(c, r.submissionArtifact, `${what} submission`, true);
    for (const p of Array.isArray(r.probeArtifacts) ? r.probeArtifacts : [null]) ref(c, p, `${what} probe`, true);
    if (r.status !== "completed") {
      if (r.verdict !== null || r.findingsArtifact || r.reportArtifact) c.fail(`${what}: a ${String(r.status)} round carries a verdict or findings`);
      identity(c, r.reviewer, what, reviewRecord(c, r, what, null));
      continue;
    }
    if (!["pass", "changes", "block"].includes(String(r.verdict))) c.fail(`${what}: completed without a pass / changes / block verdict`);
    ref(c, r.reportArtifact, `${what} report`, false);
    ref(c, r.findingsArtifact, `${what} findings`, false);
    const findings = findingsOf(c, r, what);
    identity(c, r.reviewer, what, reviewRecord(c, r, what, findings));
    evidence.push({ reviewId: r.reviewId, round: r.round as number, head: String(r.head), findings,
      findingsArtifact: r.findingsArtifact as string | null, reportArtifact: r.reportArtifact as string | null });
  }
  return { rounds: list.filter(isObj), evidence };
}

/**
 * Closures are recomputed from the verified findings with the producer's own rule (review-evidence-closures.ts) and must match
 * entry for entry: disposition, confirming review, fix commit (the confirming review's head, null on the same head or when
 * retained) and evidence ids. Only the free-text explanation and a retained entry's followup are taken as written.
 */
function closures(c: Check, id: unknown, done: EvidenceRound[]): Closure[] {
  const raw = c.json(id, "closures");
  if (!Array.isArray(raw)) { c.fail("closures artifact missing or not an array"); return []; }
  const key = (x: Obj | Closure) => `${String(x.reviewId)}/${String(x.findingId)}`;
  const facts = (x: Obj | Closure) => JSON.stringify([x.disposition, x.confirmingReviewId, x.fixCommit ?? null, x.evidenceArtifacts,
    x.disposition === "closed" ? x.followup ?? null : "-"]);
  const want = new Map(computeClosures(done).map((x) => [key(x), x]));
  const seen = new Set<string>();
  for (const x of raw.filter(isObj)) {
    const k = key(x), w = want.get(k);
    if (seen.has(k)) { c.fail(`closure ${k}: listed twice`); continue; }
    seen.add(k);
    for (const e of Array.isArray(x.evidenceArtifacts) ? x.evidenceArtifacts : [null]) ref(c, e, `closure ${k} evidence`, true);
    if (!w) c.fail(`closure ${k}: the findings support no closure for it`);
    else if (facts(x) !== facts(w)) c.fail(`closure ${k}: ${facts(x)} does not match what the findings support ${facts(w)}`);
  }
  for (const [k, w] of want) if (!seen.has(k)) c.fail(`closure ${k}: missing (the findings support ${facts(w)})`);
  return raw.filter(isObj) as unknown as Closure[];
}

function finalPass(c: Check, m: Obj, done: EvidenceRound[], rows: Obj[], cl: Closure[]): void {
  const fin = m.final, subject = isObj(m.subject) ? m.subject : {};
  if (!isObj(fin)) return c.fail("no final pass review");
  const last = rows.filter((r) => r.status === "completed").at(-1);
  if (!last || fin.reviewId !== last.reviewId || fin.verdict !== "pass" || last.verdict !== "pass") return c.fail("final is not the last completed review, or it is not a pass");
  if (last.head !== subject.head) c.fail(`final review saw head ${String(last.head)}, subject is ${String(subject.head)}`);
  if (last.specRev !== subject.specRev) c.fail(`final review was on specRev ${String(last.specRev)}, subject is ${String(subject.specRev)}`);
  if (!last.reportArtifact) c.fail("final review has no report");
  const blind = done.filter((r) => !r.findings).map((r) => r.reviewId);
  if (blind.length) c.fail(`completed rounds without structured findings (${blind.join(", ")}): unresolved findings cannot be computed`);
  else {
    const open = countOpen(openFindings(done, cl), cl.filter((x) => x.disposition === "retained"));
    if (JSON.stringify(fin.openCounts) !== JSON.stringify(open)) c.fail(`final openCounts ${JSON.stringify(fin.openCounts)} != recomputed ${JSON.stringify(open)}`);
    if (open.p0 || open.p1) c.fail(`unresolved P0/P1 across rounds: ${JSON.stringify(open)}`);
  }
  const reviewer = isObj(last.reviewer) ? last.reviewer : {};
  const authors = (Array.isArray(m.authors) ? m.authors : []).filter(isObj);
  const fam = (w: Obj) => (isObj(w.model) ? String(w.model.family ?? "unknown") : "unknown");
  if (reviewer.verified !== true) c.fail("final reviewer identity is not bridge-verified");
  if (fam(reviewer) === "unknown") c.fail("final reviewer model family is unknown");
  if (!authors.length) c.fail("no author identity");
  for (const a of authors) {
    if (a.agent === reviewer.agent) c.fail(`final reviewer ${String(a.agent)} is also an author`);
    if (fam(a) === "unknown") c.fail(`author ${String(a.agent)} model family is unknown`);
    else if (fam(a) === fam(reviewer)) c.fail(`final reviewer and author ${String(a.agent)} share model family ${fam(a)}`);
  }
}

export function verifyBundle(root: string): VerifyResult {
  const c = new Check(root);
  const top = plainFile(root, "manifest.json");
  if (!top.ok) return { ok: false, problems: [`manifest.json: ${top.why}`] };
  let m: unknown;
  try { m = JSON.parse(top.bytes.toString("utf8")); } catch { return { ok: false, problems: ["manifest.json is not valid JSON"] }; }
  if (!isObj(m) || m.format !== "claudestra.review-evidence" || m.version !== 1) return { ok: false, problems: ["not a claudestra.review-evidence v1 manifest"] };
  if (typeof m.bundleId !== "string" || !m.bundleId) c.fail("bundleId missing");
  inventory(c, m.artifacts);
  const s = isObj(m.subject) ? m.subject : {};
  if (typeof s.head !== "string" || !SHA40.test(s.head)) c.fail("subject head is not a full SHA");
  if (typeof s.base !== "string" || !SHA40.test(s.base)) c.fail("subject base is not a full SHA");
  if (typeof s.pr !== "string") c.fail("subject has no PR");
  ref(c, s.specArtifact, "spec", true);
  ref(c, s.acceptanceArtifact, "acceptance", true);
  ref(c, isObj(m.scope) ? m.scope.evidenceArtifact : null, "scope", true);
  (Array.isArray(m.authors) ? m.authors : []).forEach((a, i) => identity(c, a, `author ${i + 1}`, authorRecord(c, a, s.head, `author ${i + 1}`)));
  const r = rounds(c, m.rounds);
  finalPass(c, m, r.evidence, r.rounds, closures(c, m.closuresArtifact, r.evidence));
  return { ok: c.problems.length === 0, problems: c.problems };
}

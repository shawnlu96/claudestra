/**
 * Producer side of the peer review-evidence bundle v1 (draft: ledger/docs/review-evidence-v1/). Pure: the ledger rows, file bytes and
 * runtime lookups come in through ExportSource (review-evidence-collect.ts gathers them), the bundle comes out as manifest + files.
 * Nothing is inferred into a stronger claim than the ledger holds: a round without structured findings exports none, an identity
 * the bridge did not verify says verified:false, a model family the session records do not show is "unknown". The local
 * self-check is review-evidence-verify.ts; exporting never writes the ledger. tests/review-evidence.test.ts.
 */
import { createHash } from "node:crypto";
import { computeClosures, countOpen, openFindings, type EvidenceRound } from "./review-evidence-closures.js";
import { SCOPE_ROUND } from "./review-converge.js";
import type { LedgerEvent, LedgerTask } from "./ledger-stages.js";
import type { SchedulerIntent } from "./ledger-scheduler.js";
import type { ReviewFinding } from "./scheduler-review.js";
import { specSection } from "./review-pack.js";

/** What the session records show for one party in one time window (ai-model-evidence.ts extractors). */
export interface ModelRecord {
  runtime: string;
  sessionId: string;
  /** ledger = the session id the ledger recorded; registry = the agent's registry session, used only to look for records */
  sessionSource: "ledger" | "registry";
  window: { from: string; to: string };
  hits: number;
  models: { model: string; count: number }[];
}

interface ExportLookups {
  /** registry runtime (claude-code / codex / pi); null = not a local agent */
  runtimeOf(agent: string): string | null;
  /** the registry's configured model, a claim only (never used as the actual model) */
  configuredModelOf(agent: string): string | null;
  modelEvidence(agent: string, sessionId: string | null, fromMs: number, toMs: number): ModelRecord | null;
  /** the review report at this ledger path, only when it is a regular file under the reviews directory */
  report(path: string): Uint8Array | null;
  /** the reviewer's dispatch prompt and top-level probe files saved next to the report (<stem>.prompt.md, <stem>-work/*) */
  orderPrompt(reportPath: string): Uint8Array | null;
  probeFiles(reportPath: string): { name: string; bytes: Uint8Array }[];
  roundBase(head: string): string | null;
}

export interface ExportSource extends ExportLookups {
  task: LedgerTask;
  /** the card's events in seq order, ask-family excluded */
  events: readonly LedgerEvent[];
  steps: readonly Record<string, unknown>[];
  reviewIntents: readonly SchedulerIntent[];
  authorSession: { agent: string; sessionId: string; family: string } | null;
  head: string;
  base: string | null;
  baseSource: string;
  changedFiles: string[] | null;
  spec: Uint8Array | null;
  fingerprint: string;
  exporter: string;
  bundleId: string;
  now: number;
}

export interface Bundle { manifest: Record<string, unknown>; files: Map<string, Uint8Array>; notes: string[] }

type Status = "completed" | "incomplete" | "refused" | "cancelled";
interface Entry {
  reviewId: string; round: number; seq: number; ts: number; head: string | null; status: Status;
  review: LedgerEvent | null; attempt: LedgerEvent | SchedulerIntent | null; reviewer: string | null; fromMs: number;
}

const enc = new TextEncoder();
const jsonBytes = (v: unknown): Uint8Array => enc.encode(`${JSON.stringify(v, null, 2)}\n`);
const iso = (ms: number): string => new Date(ms).toISOString();
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const MEDIA: Record<string, string> = { md: "text/markdown", json: "application/json" };

/** Leading letters of the bare model id ("claude-opus-5-5" → claude, "cc/deepseek-v4" → deepseek); a lexical label, not a lookup. */
export function modelFamily(id: string): string {
  return /^[a-z]+/i.exec(id.slice(id.lastIndexOf("/") + 1))?.[0].toLowerCase() ?? "unknown";
}

/** The manifest's model claim, derived only from the model record; the self-check recomputes it the same way. */
export function modelClaim(rec: ModelRecord | null, sourceArtifact: string | null) {
  const only = rec && rec.models.length === 1 ? rec.models[0].model : null;
  const cut = only ? only.indexOf("/") : -1;
  return { provider: only && cut > 0 ? only.slice(0, cut) : null, id: only ? only.slice(cut + 1) : null,
    family: only ? modelFamily(only) : "unknown", sourceArtifact };
}

const enteredReview = (events: readonly LedgerEvent[], round: number) =>
  events.find((e) => e.kind === "stage" && e.data.to === "review" && e.data.round === round) ?? null;
const roundAt = (events: readonly LedgerEvent[], seq: number): number =>
  events.filter((e) => e.kind === "stage" && e.data.to === "review" && e.seq <= seq).at(-1)?.data.round as number ?? 0;
const deliveredHead = (events: readonly LedgerEvent[], round: number): string | null =>
  str(events.findLast((e) => e.kind === "deliver" && e.data.round === round)?.data.headSHA);

/** Every review attempt in ledger order: each verdict claims its order's intent, else the latest earlier dispatch of its round. */
function reviewEntries(src: Pick<ExportSource, "events" | "reviewIntents">): Entry[] {
  const { events } = src;
  const free = new Set<LedgerEvent | SchedulerIntent>([...events.filter((e) => e.kind === "dispatch"), ...src.reviewIntents]);
  const out: Entry[] = [];
  for (const review of events.filter((e) => e.kind === "review")) {
    const round = typeof review.data.round === "number" ? review.data.round : 0;
    const byOrder = src.reviewIntents.find((i) => i.id === review.data.orderId && free.has(i)) ?? null;
    const attempt = byOrder ?? events.findLast((e) => e.kind === "dispatch" && e.data.round === round && e.seq < review.seq && free.has(e)) ?? null;
    if (attempt) free.delete(attempt);
    const head = str(review.data.head) ?? (attempt ? str("seq" in attempt ? attempt.data.head : attempt.head) : null) ?? deliveredHead(events, round);
    const fromMs = attempt ? ("seq" in attempt ? attempt.ts : attempt.createdAt) : enteredReview(events, round)?.ts ?? review.ts;
    out.push({ reviewId: `r${round}-${review.seq}`, round, seq: review.seq, ts: review.ts, head, status: "completed", review, attempt,
      reviewer: str(review.data.reviewer), fromMs });
  }
  for (const a of free) {
    const isEvent = "seq" in a;
    const seq = isEvent ? a.seq : a.eventSeq;
    const round = isEvent && typeof a.data.round === "number" ? a.data.round : roundAt(events, seq);
    const assign = isEvent ? events.find((e) => e.kind === "step" && e.data.op === "assign" && e.data.round === round && e.seq > seq &&
      (e.data.step === "review" || e.data.step === "final_review")) : null;
    out.push({ reviewId: `r${round}-${isEvent ? seq : a.id.replace(/[^\w.-]/g, "_")}`, round, seq, ts: isEvent ? a.ts : a.createdAt,
      head: str(isEvent ? a.data.head : a.head), status: !isEvent && a.status === "cancelled" ? "cancelled" : "incomplete", review: null, attempt: a,
      reviewer: str(assign?.data.executor) ?? (isEvent ? null : a.recipient), fromMs: isEvent ? a.ts : a.createdAt });
  }
  return out.sort((a, b) => a.seq - b.seq || a.ts - b.ts);
}

class Files {
  readonly map = new Map<string, Uint8Array>();
  readonly inventory: Record<string, unknown>[] = [];
  add(id: string, path: string, kind: string, bytes: Uint8Array): string {
    this.map.set(path, bytes);
    const ext = path.slice(path.lastIndexOf(".") + 1);
    this.inventory.push({ id, path, bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex"),
      mediaType: MEDIA[ext] ?? "text/plain", kind });
    return id;
  }
  json(id: string, path: string, kind: string, value: unknown): string { return this.add(id, path, kind, jsonBytes(value)); }
}

const SAFE_NAME = /^[\w][\w.-]{0,100}$/;

function identityOf(src: ExportSource, f: Files, id: string, dir: string, p: {
  agent: string | null; sessionId: string | null; family: string | null; verified: boolean; observedAt: number;
  fromMs: number; toMs: number; receipt: Record<string, unknown>;
}) {
  const runtime = p.agent ? src.runtimeOf(p.agent) : null;
  const rec = p.agent ? src.modelEvidence(p.agent, p.sessionId, p.fromMs, p.toMs) : null;
  const receipt = f.json(`${id}-identity`, `${dir}/identity.json`, "identity", { ...p.receipt,
    registry: p.agent ? { runtime, configuredModel: src.configuredModelOf(p.agent) } : null });
  const model = f.json(`${id}-model`, `${dir}/model.json`, "model", rec ?? { found: false, searched: p.agent ? { agent: p.agent, sessionId: p.sessionId,
    window: { from: iso(p.fromMs), to: iso(p.toMs) } } : null });
  return { agent: p.agent, sessionId: p.sessionId, runtime, family: p.family ?? "unknown", verified: p.verified,
    observedAt: iso(p.observedAt), identityReceipt: receipt, model: modelClaim(rec, model) };
}

function roundOf(src: ExportSource, f: Files, e: Entry, notes: string[]) {
  const dir = `rounds/${e.reviewId}`, d = e.review?.data ?? {};
  const path = str(d.path);
  const report = path ? src.report(path) : null;
  if (e.review && !report) notes.push(`${e.reviewId}: report ${path ?? "(none recorded)"} is not a readable file under the reviews directory; not exported`);
  const findings = Array.isArray(d.findings) ? d.findings as ReviewFinding[] : null;
  if (e.review && !findings) notes.push(`${e.reviewId}: the ledger holds no structured findings for this round (legacy record); none exported`);
  const prompt = path ? src.orderPrompt(path) : null;
  const probes = (path ? src.probeFiles(path) : []).filter((p) => SAFE_NAME.test(p.name))
    .map((p, i) => f.add(`${e.reviewId}-probe-${i + 1}`, `artifacts/${e.reviewId}/${p.name}`, "probe-source", p.bytes));
  const order = prompt ? f.add(`${e.reviewId}-order`, `${dir}/order-prompt.md`, "order-prompt", prompt) : null;
  const step = src.steps.find((s) => (s.step === "review" || s.step === "final_review") && s.round === e.round) ?? null;
  const reviewer = identityOf(src, f, e.reviewId, dir, { agent: e.reviewer, sessionId: str(d.reviewerSessionId), family: str(d.reviewerFamily),
    verified: d.via === "mcp", observedAt: e.ts, fromMs: e.fromMs, toMs: e.ts,
    receipt: { agent: e.reviewer, recordedBy: e.review?.actor ?? null, via: d.via ?? null, ledgerEventSeq: e.review?.seq ?? null, step } });
  const stage = enteredReview(src.events, e.round);
  return {
    reviewId: e.reviewId, round: e.round, head: e.head, base: e.head ? src.roundBase(e.head) : null,
    specRev: typeof stage?.data.specRev === "number" ? stage.data.specRev : null, orderId: str(d.orderId) ?? (e.attempt && !("seq" in e.attempt) ? e.attempt.id : null),
    status: e.status, verdict: e.review ? d.verdict ?? null : null,
    ...(e.review ? { p0: d.p0 ?? null, p1: d.p1 ?? null, p2: d.p2 ?? null } : {}),
    reviewer,
    reportArtifact: report ? f.add(`${e.reviewId}-report`, `${dir}/report.md`, "report", report) : null,
    findingsArtifact: findings ? f.json(`${e.reviewId}-findings`, `${dir}/findings.json`, "findings", findings) : null,
    submissionArtifact: f.json(`${e.reviewId}-submission`, `${dir}/submission.json`, "submission",
      { review: e.review, attempt: e.attempt, orderPromptArtifact: order }),
    probeArtifacts: probes,
  };
}

function authorsOf(src: ExportSource, f: Files): Record<string, unknown>[] {
  const delivers = src.events.filter((e) => e.kind === "deliver");
  const names = new Set<string>(delivers.map((e) => e.actor));
  for (const s of src.steps) if ((s.step === "write" || s.step === "fix") && s.executorKind === "agent" && !s.derived) names.add(String(s.executor));
  if (src.authorSession) names.add(src.authorSession.agent);
  const start = src.events[0]?.ts ?? src.now;
  return [...names].sort().map((agent, i) => {
    const mine = delivers.filter((e) => e.actor === agent);
    const bound = src.authorSession?.agent === agent ? src.authorSession : null;
    const last = mine.at(-1)?.ts ?? src.now;
    return identityOf(src, f, `author-${i + 1}`, `identities/author-${i + 1}`, { agent, sessionId: bound?.sessionId ?? null,
      family: bound?.family ?? null, verified: mine.some((e) => e.data.headSHA === src.head && e.dedupKey?.startsWith("mcp-deliver:")),
      observedAt: last, fromMs: start, toMs: last, receipt: { agent, delivers: mine, steps: src.steps.filter((s) => s.executor === agent), schedulerSession: bound } });
  });
}

export function buildBundle(src: ExportSource): Bundle {
  const f = new Files(), notes: string[] = [];
  const { task } = src;
  const spec = src.spec ? f.add("spec", "inputs/spec.md", "spec", src.spec) : null;
  if (!spec) notes.push("spec card not readable; not exported");
  const acceptance = f.json("acceptance", "inputs/acceptance.json", "acceptance", acceptanceOf(src.spec));
  f.json("ledger-events", "inputs/ledger-events.json", "ledger-events", { task, events: src.events, steps: src.steps, reviewIntents: src.reviewIntents });
  const authors = authorsOf(src, f);
  const entries = reviewEntries(src);
  const rounds = entries.map((e) => roundOf(src, f, e, notes));
  const done = rounds.filter((r) => r.status === "completed");
  const evRounds: EvidenceRound[] = done.map((r) => ({ reviewId: r.reviewId, round: r.round, head: r.head ?? "",
    findings: r.findingsArtifact ? entries.find((e) => e.reviewId === r.reviewId)!.review!.data.findings as ReviewFinding[] : null,
    findingsArtifact: r.findingsArtifact, reportArtifact: r.reportArtifact, downgraded: downgradeOf(src.events, r.round) }));
  const closures = computeClosures(evRounds);
  const closuresArtifact = f.json("closures", "closures.json", "closures", closures);
  const last = done.at(-1);
  const retained = closures.filter((c) => c.disposition === "retained");
  // a round without structured findings could have left anything open: no count is better than a count that looks clean
  const openCounts = evRounds.every((r) => r.findings) ? countOpen(openFindings(evRounds, closures), retained) : null;
  const final = last && last.verdict === "pass" ? { reviewId: last.reviewId, verdict: "pass", openCounts,
    retainedP2: [...new Map(retained.map((c) => [c.findingId, { reviewId: c.confirmingReviewId, findingId: c.findingId }])).values()] } : null;
  if (!final) notes.push("the last completed review is not a pass; final is null");
  const fullPrCovered = !!last && last.round < SCOPE_ROUND && last.head === src.head && src.changedFiles !== null;
  const scope = f.json("scope", "inputs/scope.json", "scope", { head: src.head, base: src.base, baseSource: src.baseSource,
    command: src.base ? `git diff --name-only --no-renames ${src.base}...${src.head}` : null, files: src.changedFiles,
    reviewScope: last ? (last.round < SCOPE_ROUND ? "final review round covers the whole head" : `round ${last.round} >= ${SCOPE_ROUND}: fix diff plus open findings only (review-converge)`) : null });
  const pr = task.pr?.match(/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/\d+/);
  const manifest = {
    format: "claudestra.review-evidence", version: 1, bundleId: src.bundleId, createdAt: iso(src.now),
    origin: { instanceFingerprint: src.fingerprint, agent: src.exporter },
    subject: { repo: pr?.[1] ?? null, pr: pr ? task.pr : null, head: src.head, base: src.base, specRev: task.specRev, taskId: task.id,
      specArtifact: spec, acceptanceArtifact: acceptance },
    scope: { paths: src.changedFiles ?? [], fullPrCovered, evidenceArtifact: scope },
    authors, rounds, closuresArtifact, final, artifacts: f.inventory,
  };
  return { manifest, files: f.map, notes };
}

function downgradeOf(events: readonly LedgerEvent[], round: number): EvidenceRound["downgraded"] {
  const e = events.findLast((x) => x.kind === "scheduler" && x.data.op === "review_downgrade" && x.data.round === round);
  return e && Array.isArray(e.data.findingIds) ? { seq: e.seq, ids: e.data.findingIds.filter((x): x is string => typeof x === "string") } : null;
}

/** The spec's 「验收线」 section (falls back to 「验收」): the same reading the review order gives the reviewer (review-order.ts). */
function acceptanceOf(spec: Uint8Array | null): { section: string; lines: string[] } {
  const text = spec ? new TextDecoder().decode(spec) : "";
  const lines = specSection(text, "验收线");
  return lines.length ? { section: "验收线", lines } : { section: "验收", lines: specSection(text, "验收") };
}

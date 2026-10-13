/**
 * Home-side upload of card body text (team-project-TEAMVIS4), hosted by the mirror pass (shared-ledger-mirror-loop.ts)
 * after its projections, under the same push lock and ledger connection. For each mirrored feature: new event text,
 * review conclusions and the current spec of its cards, each scrubbed (scrubTeamBody) before it leaves.
 * - Switch: teamBodyMode of the local project. off: nothing sent, nothing recorded. observe: no request at all; one
 *   recordObserved note per feature per hour with what would go. on: upload when the center has the teamBody capability.
 * - State is its own file (team-body-sync.json): the projection watermark and the mirror entry are never read for
 *   writing nor touched, so a failed body upload cannot move or hold them. Failures back off per feature, bounded.
 * - Backlog: at most TEAM_BODY_SYNC_PER_PASS records a pass, resumed from the body watermark; a newer
 *   TEAM_BODY_SCRUB_VERSION starts the watermark over, and the center answers unchanged records as unchanged.
 * - A center without the capability (404 / teamBody false): nothing is sent, one ledger note a day per center.
 * - Event meta and its backfill only toward a center that says eventMeta: team-body-sync-meta.ts.
 * tests/team-body-sync.test.ts.
 */
import type { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { basename, join } from "node:path";
import { STATE_DIR } from "./paths.js";
import { readJsonStateSync, writeJsonAtomicSync } from "./state-file.js";
import { instanceKeySync } from "./instance-key.js";
import { realScrub } from "./dag-write-scrub.js";
import { effectiveNodes, getDagVersion, getFeature } from "./ledger-feature.js";
import { getMeta, listTasks, openLedger } from "./ledger-store.js";
import { appendEvent } from "./ledger-write.js";
import { recordObserved } from "./recovery-policy.js";
import { readTextSoft, specPathFor } from "./task-spec.js";
import { requestSharedLedger, sharedLedgerCenterUrl, sharedLedgerNotBefore, SharedLedgerRemoteError } from "./shared-ledger-client-transport.js";
import { resolveMirrorCredential } from "./shared-ledger-mirror.js";
import { mirrorErrorSummary, mirrorTaskHeads, type MirrorEntry } from "./shared-ledger-projector.js";
import type { SharedLedgerScrubContext } from "./shared-ledger-scrub.js";
import type { SharedLedgerLocalCredential } from "./shared-ledger-mode.js";
import {
  TEAM_BODY_BATCH_MAX_BYTES, TEAM_BODY_BATCH_MAX_RECORDS, TEAM_BODY_PATHS, TEAM_BODY_TEXT_MAX_BYTES,
  parseTeamBodyCapability, parseTeamBodyRecord, parseTeamBodyUpload, parseTeamBodyUploadReceipt, teamBodyDigest, teamBodyReceiptMatches, teamBodyUploadBytes,
  type TeamBodyEventMeta, type TeamBodyKind, type TeamBodyRecord, type TeamBodyUpload,
} from "./shared-ledger-contract-team-body.js";
import { scrubTeamBody, TEAM_BODY_MASK, TEAM_BODY_SCRUB_VERSION, type TeamBodyScrub } from "./team-body-scrub.js";
import { teamBodyMode } from "./team-body-switch.js";
import { eventMetaOf, eventSelection, metaLags, passEvent } from "./team-body-sync-meta.js";

/** Records (uploaded or refused) handled in one pass, over all features. */
const TEAM_BODY_SYNC_PER_PASS = 200;
export const TEAM_BODY_TRUNCATED = "(正文过长,已截断,全文在主场)";
const HOUR_MS = 3_600_000, DAY_MS = 24 * HOUR_MS;
/** How long a capability answer is trusted, either way. */
const CAPABILITY_TTL_MS = HOUR_MS;
const BACKOFF_BASE_MS = 10_000, BACKOFF_MAX_MS = 10 * 60_000;
const REFUSED_KEPT = 50;
const REQUEST_GAP_MS = 600;
const teamBodyBackoffMs = (failures: number): number => Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1));

export interface TeamBodySyncDeps {
  stateDir?: string;
  ledgerPath?: string;
  now?: () => number;
  /** Transport of the real signed requests (tests: a fake center). */
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  requestGapMs?: number;
  scrub?: (heads: readonly string[]) => Promise<SharedLedgerScrubContext>;
}

/** by: scrub = the gate refused the text; invalid = the contract would not carry the record (e.g. a NUL); center = the center refused it. */
interface RefusedNote { taskId: string; kind: TeamBodyKind; sourceKey: string; by: "scrub" | "invalid" | "center"; at: number }
interface FeatureState {
  batchId: string; centerFeatureId: string; scrubVersion: number;
  /** Highest seq of this feature's event text handled (uploaded or refused). */
  eventSeq: number;
  /** Highest seq handled while the center took meta (team-body-sync-meta.ts); absent = 0. */
  metaSeq?: number;
  /** taskId → the specRev whose text was handled. */
  specs: Record<string, number>;
  failures: number; nextAttemptAt: number; lastError: string | null;
  /** Hour (epoch ms / 1 h) of the last observe note. */
  observedHour: number | null;
  refusedTotal: number; refused: RefusedNote[];
}
interface CenterState { supported: boolean; eventMeta?: boolean; checkedAt: number; notedDay: number | null }
/**
 * cooldowns: center origin hash → epoch ms before which no body request goes there, from a 429 on a body request. Kept
 * here, not in the origin cooldown the projections share (shared-ledger-client-transport.ts), so a body 429 never holds
 * back a projection; the body pass still honours that shared one.
 */
interface SyncFile { schemaVersion: 1; features: Record<string, FeatureState>; centers: Record<string, CenterState>; cooldowns?: Record<string, number> }
const originKey = (baseUrl: string): string => createHash("sha256").update(sharedLedgerCenterUrl(baseUrl).origin).digest("hex");

const statePath = (dir: string) => join(dir, "team-body-sync.json");
const isSyncFile = (v: unknown): v is SyncFile => !!v && typeof v === "object" && (v as SyncFile).schemaVersion === 1
  && !!(v as SyncFile).features && typeof (v as SyncFile).features === "object" && !!(v as SyncFile).centers && typeof (v as SyncFile).centers === "object";
/** Corrupt state starts over: every record is sent again and the center answers what it holds as unchanged. */
export function readTeamBodySync(dir = STATE_DIR): SyncFile {
  const state = readJsonStateSync(statePath(dir), isSyncFile);
  return state.status === "ok" ? state.data as SyncFile : { schemaVersion: 1, features: {}, centers: {} };
}

function featureState(file: SyncFile, featureId: string, entry: MirrorEntry): FeatureState {
  const cur = file.features[featureId];
  if (cur && cur.batchId === entry.batchId && cur.centerFeatureId === entry.centerFeatureId && cur.scrubVersion === TEAM_BODY_SCRUB_VERSION) return cur;
  // Another batch / center feature, or a newer scrub: everything is sent again; failures and notes carry over.
  const fresh: FeatureState = { batchId: entry.batchId, centerFeatureId: entry.centerFeatureId, scrubVersion: TEAM_BODY_SCRUB_VERSION,
    eventSeq: 0, specs: {}, failures: cur?.failures ?? 0, nextAttemptAt: cur?.nextAttemptAt ?? 0, lastError: cur?.lastError ?? null,
    observedHour: cur?.observedHour ?? null, refusedTotal: cur?.refusedTotal ?? 0, refused: cur?.refused ?? [] };
  return file.features[featureId] = fresh;
}

/** The cards of a mirrored feature, as the projector counts them (shared-ledger-projector.ts ownTasks). */
function featureTasks(db: Database, featureId: string, localProject: string) {
  const feature = getFeature(db, featureId);
  if (!feature || feature.project !== localProject) throw new Error("mirror feature unavailable");
  const dags = Array.from({ length: feature.currentVersion }, (_, i) => getDagVersion(db, featureId, i + 1));
  const bound = new Set(dags.flatMap((dag) => dag ? effectiveNodes(db, dag).flatMap((n) => n.taskId ? [n.taskId] : []) : []));
  return listTasks(db, localProject).filter((t) => t.featureId === featureId || bound.has(t.id)).sort((a, b) => a.id.localeCompare(b.id));
}

/** One source text before scrubbing; seq for event / review, specRev for spec. */
interface Pending { taskId: string; kind: TeamBodyKind; sourceKey: string; raw: string; seq?: number; specRev?: number; meta?: TeamBodyEventMeta }

/**
 * A review event as people read it. A verdict submitted through submit_verdict carries no text: verdict, counts and
 * findings (each with its description and probe) sit in data, so they are written out here. The report is named, not read: its path is the reviewer's.
 */
function reviewText(text: string, data: string): string {
  let d: Record<string, unknown> = {};
  try { const parsed = JSON.parse(data); if (parsed && typeof parsed === "object") d = parsed; } catch { /* text alone */ }
  const lines: string[] = [];
  if (typeof d.verdict === "string") lines.push(`审查结论 ${d.verdict} · P0 ${Number(d.p0) || 0} / P1 ${Number(d.p1) || 0} / P2 ${Number(d.p2) || 0}`);
  if (Array.isArray(d.findings)) for (const f of d.findings as Record<string, unknown>[]) {
    if (!f || typeof f !== "object") continue;
    const desc = typeof f.description === "string" && f.description ? `：${f.description}` : "";
    lines.push(`- [${String(f.severity ?? "?")}] ${String(f.findingId ?? "")}${desc}`);
    // probe is required and, for older / CLI records without a description, the finding's only text.
    if (typeof f.probe === "string" && f.probe) lines.push(`  复现：${f.probe}`);
  }
  if (typeof d.path === "string" && d.path) lines.push(`报告：${basename(d.path)}（全文在主场）`);
  if (text) lines.push(lines.length ? `\n${text}` : text);
  return lines.join("\n");
}

/**
 * Events with text and every review (seq order), then current specs not handled at their rev; at most `limit`.
 * withMeta: each event carries its meta, stage events go up even without text, from the meta cursor (team-body-sync-meta.ts).
 */
function pendingOf(db: Database, featureId: string, entry: MirrorEntry, st: FeatureState, limit: number, withMeta = false): Pending[] {
  if (limit <= 0) return [];
  const tasks = featureTasks(db, featureId, entry.localProject);
  if (!tasks.length) return [];
  const { after, stageClause } = eventSelection(st, withMeta);
  const rows = db.prepare(`SELECT seq, ts, target, kind, text, data FROM events WHERE project = ? AND seq > ? AND (text != '' OR kind = 'review'${stageClause})
    AND target IN (${tasks.map(() => "?").join(",")}) ORDER BY seq LIMIT ?`)
    .all(entry.localProject, after, ...tasks.map((t) => t.id), limit) as { seq: number; ts: number; target: string; kind: string; text: string; data: string }[];
  const out: Pending[] = rows.map((r) => {
    const meta = withMeta ? eventMetaOf(r) : undefined;
    return { taskId: r.target, kind: r.kind === "review" ? "review" as const : "event" as const, sourceKey: String(r.seq),
      raw: r.kind === "review" ? reviewText(r.text, r.data) : r.text, seq: r.seq, ...(meta ? { meta } : {}) };
  });
  const docsDir = tasks.some((t) => st.specs[t.id] !== t.specRev) ? getMeta(db, entry.localProject).docsDir : null;
  for (const task of tasks) {
    if (out.length >= limit) break;
    if (st.specs[task.id] === task.specRev) continue;
    const raw = readTextSoft(specPathFor(task, docsDir));
    if (raw !== null) out.push({ taskId: task.id, kind: "spec", sourceKey: String(task.specRev), raw, specRev: task.specRev });
  }
  return out;
}

const maskCount = (text: string): number => text.split(TEAM_BODY_MASK).length - 1;
/** The first `n` characters, never half a mask and never half a surrogate pair. */
function head(text: string, n: number): string {
  const max = Math.min(n, text.length);
  let end = max;
  for (let part = 1; part < TEAM_BODY_MASK.length; part++) if (text.startsWith(TEAM_BODY_MASK, max - part)) end = max - part;
  const code = text.charCodeAt(end - 1);
  if (end > 0 && code >= 0xd800 && code <= 0xdbff) end--;
  return text.slice(0, end);
}

/**
 * Scrubbed text that fits one record and, alone, one batch. Longer text is cut after scrubbing the whole of it, the head
 * judged once more (a cut leaves a key head no rule knows, team-body-scrub.ts) and the truncation note appended.
 */
export function teamBodyText(raw: string, context: SharedLedgerScrubContext, fits: (text: string) => boolean): TeamBodyScrub {
  const whole = scrubTeamBody(raw, context);
  if (whole.refused || fits(whole.text)) return whole;
  const tail = `\n${TEAM_BODY_TRUNCATED}`;
  let text = whole.text, masked = whole.maskedSegments;
  for (let round = 0; round < 3; round++) {
    let low = 0, high = text.length;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (fits(head(text, middle) + tail)) low = middle;
      else high = middle - 1;
    }
    const cut = head(text, low);
    const again = scrubTeamBody(cut, context);
    if (again.refused) return again;
    // Masks the first pass wrote and the cut kept, plus whatever the second pass still had to mask.
    masked = Math.min(maskCount(cut), masked) + again.maskedSegments;
    if (fits(again.text + tail)) return { ...again, text: again.text + tail, maskedSegments: masked };
    text = again.text;
  }
  return { text: "", maskedSegments: masked, refused: true, scrubVersion: TEAM_BODY_SCRUB_VERSION };
}

interface Prepared { pending: Pending; record: TeamBodyRecord | null; maskedSegments: number; invalid?: true }
function prepare(items: readonly Pending[], entry: MirrorEntry, context: SharedLedgerScrubContext): Prepared[] {
  const base = (text: string): TeamBodyRecord => ({ featureId: entry.centerFeatureId, taskId: "", kind: "event", sourceKey: "0", text,
    scrubVersion: TEAM_BODY_SCRUB_VERSION, maskedSegments: 0, digest: teamBodyDigest(text) });
  const recordBytes = (r: TeamBodyRecord) => Buffer.byteLength(JSON.stringify(r), "utf8");
  const emptyBatch = teamBodyUploadBytes(uploadOf(entry, []));
  return items.map((pending) => {
    const meta = pending.meta ? { meta: pending.meta } : {};
    const overhead = recordBytes({ ...base(""), taskId: pending.taskId, kind: pending.kind, sourceKey: pending.sourceKey, maskedSegments: Number.MAX_SAFE_INTEGER, ...meta }) - 2;
    const fits = (text: string) => Buffer.byteLength(text, "utf8") <= TEAM_BODY_TEXT_MAX_BYTES
      && emptyBatch + overhead + Buffer.byteLength(JSON.stringify(text), "utf8") <= TEAM_BODY_BATCH_MAX_BYTES;
    const s = teamBodyText(pending.raw, context, fits);
    if (s.refused) return { pending, record: null, maskedSegments: s.maskedSegments };
    const record = { ...base(s.text), taskId: pending.taskId, kind: pending.kind,
      sourceKey: pending.sourceKey, scrubVersion: s.scrubVersion, maskedSegments: s.maskedSegments, ...meta };
    // Checked one by one: a record the contract cannot carry is refused here, never failing its whole batch every pass.
    try { parseTeamBodyRecord(record); } catch { return { pending, record: null, maskedSegments: s.maskedSegments, invalid: true }; }
    return { pending, maskedSegments: s.maskedSegments, record };
  });
}

function uploadOf(entry: MirrorEntry, records: TeamBodyRecord[]): TeamBodyUpload {
  return { schemaVersion: 1, projectId: entry.projectId, sourceInstanceId: entry.sourceInstanceId, batchId: randomBytes(16).toString("hex"), records };
}
/** Contiguous runs of `prepared` (refused ones ride along unsent), each under the record and byte caps; `upto` is the run's end index. */
function batchesOf(entry: MirrorEntry, prepared: readonly Prepared[]): { upload: TeamBodyUpload; upto: number }[] {
  const empty = teamBodyUploadBytes(uploadOf(entry, []));
  const out: { upload: TeamBodyUpload; upto: number }[] = [];
  let records: TeamBodyRecord[] = [], bytes = empty;
  prepared.forEach((p, i) => {
    if (!p.record) return;
    // JSON.stringify of the array is "[" + records joined by "," + "]": the batch's bytes add up exactly.
    const size = Buffer.byteLength(JSON.stringify(p.record), "utf8");
    if (records.length && (records.length >= TEAM_BODY_BATCH_MAX_RECORDS || bytes + 1 + size > TEAM_BODY_BATCH_MAX_BYTES)) {
      out.push({ upload: uploadOf(entry, records), upto: i });
      records = [];
      bytes = empty;
    }
    bytes += size + (records.length ? 1 : 0);
    records.push(p.record);
  });
  if (records.length) out.push({ upload: uploadOf(entry, records), upto: prepared.length });
  return out;
}

class Stop extends Error {}
/** The switch left on between the start of a feature and a request: nothing more is sent for it, and it is no failure. */
class SwitchedOff extends Error {}
interface Pass {
  dir: string; now: () => number; deps: TeamBodySyncDeps; file: SyncFile; budget: { left: number };
  send: <T>(baseUrl: string, action: () => Promise<T>) => Promise<T>;
  ledger: () => Database;
}

const teamPath = (template: string, teamId: string): string => {
  if (!/^[A-Za-z0-9_.:-]+$/.test(teamId)) throw new Error("invalid team");
  return template.replace("{teamId}", teamId);
};

type Capability = { supported: boolean; eventMeta: boolean };
const fresh = (c: CenterState, now: number): boolean => now - c.checkedAt < CAPABILITY_TTL_MS && c.checkedAt <= now;
async function capability(p: Pass, entry: MirrorEntry, credential: SharedLedgerLocalCredential, key: NonNullable<ReturnType<typeof instanceKeySync>>): Promise<Capability> {
  const id = `${entry.centerId}:${credential.teamId}`;
  const cur = p.file.centers[id];
  if (cur && fresh(cur, p.now())) return { supported: cur.supported, eventMeta: cur.eventMeta === true };
  let answer: Capability;
  try {
    const raw = await p.send(credential.baseUrl, () => requestSharedLedger(credential, key, { fetch: p.deps.fetch, now: p.now, stateDir: p.dir },
      "GET", teamPath(TEAM_BODY_PATHS.capability, credential.teamId)));
    answer = parseTeamBodyCapability(200, raw);
  } catch (error) {
    if (!(error instanceof SharedLedgerRemoteError && error.status === 404)) throw error;
    answer = parseTeamBodyCapability(404, null);
  }
  p.file.centers[id] = { supported: answer.supported, ...(answer.eventMeta ? { eventMeta: true } : {}), checkedAt: p.now(), notedDay: cur?.notedDay ?? null };
  return answer;
}

/** At most one note a day per center; best effort, the state still says not supported. */
function noteUnsupported(p: Pass, entry: MirrorEntry, teamId: string): void {
  const c = p.file.centers[`${entry.centerId}:${teamId}`]!, day = Math.floor(p.now() / DAY_MS);
  if (c.notedDay === day) return;
  c.notedDay = day;
  try {
    appendEvent(p.ledger(), { actor: "scheduler", now: p.now(), dedupKey: `team-body-unsupported:${entry.centerId}:${teamId}:${day}` },
      { project: entry.localProject, target: "", kind: "note", text: `团队正文：中心 ${entry.centerId} 没有 teamBody 能力，本机停在不上传`,
        data: { op: "team-body-unsupported", centerId: entry.centerId, day } });
  } catch { console.warn("团队正文：中心不支持的记录没写进台账"); }
}

/** withMeta: the pass sent meta (moves metaSeq too). A backfill resend that is refused again is not counted twice. */
function handled(st: FeatureState, items: readonly Prepared[], now: number, withMeta: boolean, centerRefused: ReadonlySet<number> = new Set()): void {
  items.forEach((p, i) => {
    const { pending } = p;
    const firstTime = pending.seq === undefined || passEvent(st, pending.seq, withMeta);
    if (pending.specRev !== undefined) st.specs[pending.taskId] = pending.specRev;
    if ((p.record && !centerRefused.has(i)) || !firstTime) return;
    st.refusedTotal++;
    const by = p.record ? "center" as const : p.invalid ? "invalid" as const : "scrub" as const;
    st.refused = [...st.refused, { taskId: pending.taskId, kind: pending.kind, sourceKey: pending.sourceKey, by, at: now }].slice(-REFUSED_KEPT);
  });
}

async function syncFeature(p: Pass, featureId: string, entry: MirrorEntry, db: Database): Promise<void> {
  const modeNow = () => teamBodyMode(entry.localProject, join(p.dir, "recovery-policy.json"));
  const mode = modeNow();
  if (mode === "off") return;
  const st = featureState(p.file, featureId, entry), now = p.now();
  if (mode === "observe") {
    const hour = Math.floor(now / HOUR_MS);
    if (st.observedHour === hour) return;
    const items = pendingOf(db, featureId, entry, st, TEAM_BODY_SYNC_PER_PASS);
    if (!items.length) return;
    const prepared = prepare(items, entry, await (p.deps.scrub ?? realScrub)(mirrorTaskHeads(db, featureId, entry.localProject)));
    if (modeNow() !== "observe") return; // Switched while the scrub ran: the note is observe's alone.
    const n = prepared.filter((x) => x.record).length, k = prepared.length - n, m = prepared.reduce((sum, x) => sum + (x.record ? x.maskedSegments : 0), 0);
    recordObserved(p.ledger(), { project: entry.localProject, mechanism: "teamBody", target: "", actionKey: `team-body:${featureId}:${hour}`,
      action: `上传团队正文 ${n} 条、遮蔽 ${m} 段、拒绝 ${k} 条`, data: { featureId, upload: n, masked: m, refused: k } }, now);
    st.observedHour = hour;
    return;
  }
  if (st.nextAttemptAt > now || p.budget.left <= 0) return;
  // Meta unless this center said otherwise. A stale "no" is asked again (hourly) while meta lags, so an idle feature backfills too.
  const known = p.file.centers[`${entry.centerId}:${entry.teamId}`];
  let withMeta = !known || known.eventMeta === true || (!fresh(known, now) && metaLags(st));
  let items = pendingOf(db, featureId, entry, st, p.budget.left, withMeta);
  if (!items.length) return;
  // Read again right before each request (after the pacing wait): an owner who turns it off stops the next request.
  const paced = p.send;
  p = { ...p, send: (baseUrl, action) => paced(baseUrl, () => {
    if (modeNow() !== "on") throw new SwitchedOff();
    return action();
  }) };
  const credential = resolveMirrorCredential(entry, p.dir);
  const key = instanceKeySync(p.dir);
  if (!credential || credential.instanceId !== entry.sourceInstanceId || !key) throw new Error("credential unavailable");
  const cap = await capability(p, entry, credential, key);
  if (!cap.supported) {
    // The answer is kept (the request went out); the note is on's alone, so a switch turned meanwhile writes none.
    if (modeNow() === "on") noteUnsupported(p, entry, credential.teamId);
    return;
  }
  if (cap.eventMeta !== withMeta) {
    withMeta = cap.eventMeta;
    items = pendingOf(db, featureId, entry, st, p.budget.left, withMeta);
    if (!items.length) return;
  }
  const scrub = await (p.deps.scrub ?? realScrub)(mirrorTaskHeads(db, featureId, entry.localProject));
  // The bearer is a secret wherever it turns up in body text, as in the ledger client's own scrub.
  const prepared = prepare(items, entry, { ...scrub, knownSecrets: [...(scrub.knownSecrets ?? []), credential.bearer] });
  p.budget.left -= prepared.length;
  let from = 0;
  for (const { upload, upto } of batchesOf(entry, prepared)) {
    const payload = parseTeamBodyUpload(upload);
    const receipt = parseTeamBodyUploadReceipt(await p.send(credential.baseUrl, () => requestSharedLedger(credential, key,
      { fetch: p.deps.fetch, now: p.now, stateDir: p.dir }, "POST", teamPath(TEAM_BODY_PATHS.upload, credential.teamId), payload)));
    if (!teamBodyReceiptMatches(payload, receipt)) throw new Error("team body receipt mismatch");
    const slice = prepared.slice(from, upto);
    const refusedAt = new Set<number>();
    let r = 0;
    slice.forEach((x, i) => { if (x.record && receipt.results[r++]!.status === "refused") refusedAt.add(i); });
    handled(st, slice, p.now(), withMeta, refusedAt);
    from = upto;
  }
  handled(st, prepared.slice(from), p.now(), withMeta); // Trailing records the scrub refused.
  Object.assign(st, { failures: 0, nextAttemptAt: 0, lastError: null });
}

/**
 * One body pass over the features the mirror pass just handled. Never throws: a feature's failure backs off that
 * feature's body upload only, a 429 records the center's body cooldown (not the projections' one) and ends the body pass.
 */
export async function syncTeamBodies(db: Database, features: readonly (readonly [string, MirrorEntry])[], deps: TeamBodySyncDeps = {}): Promise<void> {
  const dir = deps.stateDir ?? STATE_DIR, now = deps.now ?? Date.now;
  try {
    let lastSent: number | null = null, ledger: Database | undefined;
    const file = readTeamBodySync(dir), before = JSON.stringify(file);
    const p: Pass = { dir, now, deps, file, budget: { left: TEAM_BODY_SYNC_PER_PASS },
      // Spaced like the projections before it (pacedClients), and never inside the center's recorded cooldown.
      send: async (baseUrl, action) => {
        const gap = deps.requestGapMs ?? REQUEST_GAP_MS;
        const wait = lastSent === null ? gap : Math.max(0, lastSent + gap - now());
        if (wait) await (deps.sleep ?? Bun.sleep)(wait);
        if (Math.max(sharedLedgerNotBefore(baseUrl, dir), file.cooldowns?.[originKey(baseUrl)] ?? 0) > now()) throw new Stop();
        lastSent = now();
        return action();
      },
      ledger: () => ledger ??= openLedger(deps.ledgerPath ?? join(dir, "ledger.sqlite")) };
    try {
      for (const [featureId, entry] of features) {
        try { await syncFeature(p, featureId, entry, db); }
        catch (error) {
          if (error instanceof Stop) break;
          if (error instanceof SwitchedOff) continue;
          if (error instanceof SharedLedgerRemoteError && error.status === 429) {
            const credential = resolveMirrorCredential(entry, dir);
            if (credential) {
              const k = originKey(credential.baseUrl), until = now() + Math.min(60_000, Math.max(0, error.retryAfterMs));
              file.cooldowns = { ...file.cooldowns, [k]: Math.max(file.cooldowns?.[k] ?? 0, until) };
            }
            break;
          }
          const st = p.file.features[featureId];
          if (!st) continue;
          st.failures++;
          st.nextAttemptAt = now() + teamBodyBackoffMs(st.failures);
          st.lastError = error instanceof Error && error.message === "credential unavailable" ? "本机 service 凭据或实例密钥不可用" : mirrorErrorSummary(error);
        }
      }
    } finally { if (JSON.stringify(file) !== before) writeJsonAtomicSync(statePath(dir), file, { mode: 0o600 }); }
  } catch {
    console.error("团队正文上传本轮失败（已隔离，不影响镜像推送）");
  }
}

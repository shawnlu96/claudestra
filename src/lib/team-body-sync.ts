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
 * tests/team-body-sync.test.ts.
 */
import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { STATE_DIR } from "./paths.js";
import { readJsonStateSync, writeJsonAtomicSync } from "./state-file.js";
import { instanceKeySync } from "./instance-key.js";
import { realScrub } from "./dag-write-scrub.js";
import { effectiveNodes, getDagVersion, getFeature } from "./ledger-feature.js";
import { getMeta, listTasks, openLedger } from "./ledger-store.js";
import { appendEvent } from "./ledger-write.js";
import { recordObserved } from "./recovery-policy.js";
import { readTextSoft, specPathFor } from "./task-spec.js";
import { deferSharedLedger, requestSharedLedger, sharedLedgerNotBefore, SharedLedgerRemoteError } from "./shared-ledger-client-transport.js";
import { resolveMirrorCredential } from "./shared-ledger-mirror.js";
import { mirrorErrorSummary, type MirrorEntry } from "./shared-ledger-projector.js";
import type { SharedLedgerScrubContext } from "./shared-ledger-scrub.js";
import type { SharedLedgerLocalCredential } from "./shared-ledger-mode.js";
import {
  TEAM_BODY_BATCH_MAX_BYTES, TEAM_BODY_BATCH_MAX_RECORDS, TEAM_BODY_PATHS, TEAM_BODY_TEXT_MAX_BYTES,
  parseTeamBodyCapability, parseTeamBodyUpload, parseTeamBodyUploadReceipt, teamBodyDigest, teamBodyReceiptMatches, teamBodyUploadBytes,
  type TeamBodyKind, type TeamBodyRecord, type TeamBodyUpload,
} from "./shared-ledger-contract-team-body.js";
import { scrubTeamBody, TEAM_BODY_MASK, TEAM_BODY_SCRUB_VERSION, type TeamBodyScrub } from "./team-body-scrub.js";
import { teamBodyMode } from "./team-body-switch.js";

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

interface RefusedNote { taskId: string; kind: TeamBodyKind; sourceKey: string; by: "scrub" | "center"; at: number }
interface FeatureState {
  batchId: string; centerFeatureId: string; scrubVersion: number;
  /** Highest seq of this feature's event text handled (uploaded or refused). */
  eventSeq: number;
  /** taskId → the specRev whose text was handled. */
  specs: Record<string, number>;
  failures: number; nextAttemptAt: number; lastError: string | null;
  /** Hour (epoch ms / 1 h) of the last observe note. */
  observedHour: number | null;
  refusedTotal: number; refused: RefusedNote[];
}
interface CenterState { supported: boolean; checkedAt: number; notedDay: number | null }
interface SyncFile { schemaVersion: 1; features: Record<string, FeatureState>; centers: Record<string, CenterState> }

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
  const bound = new Set<string>();
  for (let version = 1; version <= feature.currentVersion; version++) {
    const dag = getDagVersion(db, featureId, version);
    if (dag) for (const n of effectiveNodes(db, dag)) if (n.taskId) bound.add(n.taskId);
  }
  return listTasks(db, localProject).filter((t) => t.featureId === featureId || bound.has(t.id)).sort((a, b) => a.id.localeCompare(b.id));
}

/** Heads the scrub may need to recognise as real commits (shared-ledger-projector.ts mirrorTaskHeads). */
const headsOf = (db: Database, featureId: string, entry: MirrorEntry): string[] =>
  featureTasks(db, featureId, entry.localProject).flatMap((t) => t.headSHA ? [t.headSHA.toLowerCase()] : []);

/** One source text before scrubbing; seq for event / review, specRev for spec. */
interface Pending { taskId: string; kind: TeamBodyKind; sourceKey: string; raw: string; seq?: number; specRev?: number }

/** Events with text first (seq order), then current specs not handled at their rev; at most `limit`. */
function pendingOf(db: Database, featureId: string, entry: MirrorEntry, st: FeatureState, limit: number): Pending[] {
  if (limit <= 0) return [];
  const tasks = featureTasks(db, featureId, entry.localProject);
  if (!tasks.length) return [];
  const rows = db.prepare(`SELECT seq, target, kind, text FROM events WHERE project = ? AND seq > ? AND text != ''
    AND target IN (${tasks.map(() => "?").join(",")}) ORDER BY seq LIMIT ?`)
    .all(entry.localProject, st.eventSeq, ...tasks.map((t) => t.id), limit) as { seq: number; target: string; kind: string; text: string }[];
  const out: Pending[] = rows.map((r) => ({ taskId: r.target, kind: r.kind === "review" ? "review" : "event", sourceKey: String(r.seq), raw: r.text, seq: r.seq }));
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

interface Prepared { pending: Pending; record: TeamBodyRecord | null; maskedSegments: number }
function prepare(items: readonly Pending[], entry: MirrorEntry, context: SharedLedgerScrubContext): Prepared[] {
  const base = (text: string): TeamBodyRecord => ({ featureId: entry.centerFeatureId, taskId: "", kind: "event", sourceKey: "0", text,
    scrubVersion: TEAM_BODY_SCRUB_VERSION, maskedSegments: 0, digest: teamBodyDigest(text) });
  const recordBytes = (r: TeamBodyRecord) => Buffer.byteLength(JSON.stringify(r), "utf8");
  const emptyBatch = teamBodyUploadBytes(uploadOf(entry, []));
  return items.map((pending) => {
    const overhead = recordBytes({ ...base(""), taskId: pending.taskId, kind: pending.kind, sourceKey: pending.sourceKey, maskedSegments: Number.MAX_SAFE_INTEGER }) - 2;
    const fits = (text: string) => Buffer.byteLength(text, "utf8") <= TEAM_BODY_TEXT_MAX_BYTES
      && emptyBatch + overhead + Buffer.byteLength(JSON.stringify(text), "utf8") <= TEAM_BODY_BATCH_MAX_BYTES;
    const s = teamBodyText(pending.raw, context, fits);
    if (s.refused) return { pending, record: null, maskedSegments: s.maskedSegments };
    return { pending, maskedSegments: s.maskedSegments, record: { ...base(s.text), taskId: pending.taskId, kind: pending.kind,
      sourceKey: pending.sourceKey, scrubVersion: s.scrubVersion, maskedSegments: s.maskedSegments } };
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
interface Pass {
  dir: string; now: () => number; deps: TeamBodySyncDeps; file: SyncFile; budget: { left: number };
  send: <T>(baseUrl: string, action: () => Promise<T>) => Promise<T>;
  ledger: () => Database;
}

const teamPath = (template: string, teamId: string): string => {
  if (!/^[A-Za-z0-9_.:-]+$/.test(teamId)) throw new Error("invalid team");
  return template.replace("{teamId}", teamId);
};

async function capability(p: Pass, entry: MirrorEntry, credential: SharedLedgerLocalCredential, key: NonNullable<ReturnType<typeof instanceKeySync>>): Promise<boolean> {
  const id = `${entry.centerId}:${credential.teamId}`;
  const cur = p.file.centers[id];
  if (cur && p.now() - cur.checkedAt < CAPABILITY_TTL_MS && cur.checkedAt <= p.now()) return cur.supported;
  let supported: boolean;
  try {
    const raw = await p.send(credential.baseUrl, () => requestSharedLedger(credential, key, { fetch: p.deps.fetch, now: p.now, stateDir: p.dir },
      "GET", teamPath(TEAM_BODY_PATHS.capability, credential.teamId)));
    supported = parseTeamBodyCapability(200, raw).supported;
  } catch (error) {
    if (!(error instanceof SharedLedgerRemoteError && error.status === 404)) throw error;
    supported = false;
  }
  p.file.centers[id] = { supported, checkedAt: p.now(), notedDay: cur?.notedDay ?? null };
  return supported;
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

function handled(st: FeatureState, items: readonly Prepared[], now: number, centerRefused: ReadonlySet<number> = new Set()): void {
  items.forEach((p, i) => {
    const { pending } = p;
    if (pending.seq !== undefined) st.eventSeq = Math.max(st.eventSeq, pending.seq);
    if (pending.specRev !== undefined) st.specs[pending.taskId] = pending.specRev;
    if (p.record && !centerRefused.has(i)) return;
    st.refusedTotal++;
    st.refused = [...st.refused, { taskId: pending.taskId, kind: pending.kind, sourceKey: pending.sourceKey, by: p.record ? "center" as const : "scrub" as const, at: now }]
      .slice(-REFUSED_KEPT);
  });
}

async function syncFeature(p: Pass, featureId: string, entry: MirrorEntry, db: Database): Promise<void> {
  const mode = teamBodyMode(entry.localProject, join(p.dir, "recovery-policy.json"));
  if (mode === "off") return;
  const st = featureState(p.file, featureId, entry), now = p.now();
  if (mode === "observe") {
    const hour = Math.floor(now / HOUR_MS);
    if (st.observedHour === hour) return;
    const items = pendingOf(db, featureId, entry, st, TEAM_BODY_SYNC_PER_PASS);
    if (!items.length) return;
    const prepared = prepare(items, entry, await (p.deps.scrub ?? realScrub)(headsOf(db, featureId, entry)));
    const n = prepared.filter((x) => x.record).length, k = prepared.length - n, m = prepared.reduce((sum, x) => sum + (x.record ? x.maskedSegments : 0), 0);
    recordObserved(p.ledger(), { project: entry.localProject, mechanism: "teamBody", target: "", actionKey: `team-body:${featureId}:${hour}`,
      action: `上传团队正文 ${n} 条、遮蔽 ${m} 段、拒绝 ${k} 条`, data: { featureId, upload: n, masked: m, refused: k } }, now);
    st.observedHour = hour;
    return;
  }
  if (st.nextAttemptAt > now || p.budget.left <= 0) return;
  const items = pendingOf(db, featureId, entry, st, p.budget.left);
  if (!items.length) return;
  const credential = resolveMirrorCredential(entry, p.dir);
  const key = instanceKeySync(p.dir);
  if (!credential || credential.instanceId !== entry.sourceInstanceId || !key) throw new Error("credential unavailable");
  if (!(await capability(p, entry, credential, key))) return noteUnsupported(p, entry, credential.teamId);
  const scrub = await (p.deps.scrub ?? realScrub)(headsOf(db, featureId, entry));
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
    handled(st, slice, p.now(), refusedAt);
    from = upto;
  }
  handled(st, prepared.slice(from), p.now()); // Trailing records the scrub refused.
  Object.assign(st, { failures: 0, nextAttemptAt: 0, lastError: null });
}

/**
 * One body pass over the features the mirror pass just handled. Never throws: a feature's failure backs off that
 * feature's body upload only, a 429 records the center's cooldown and ends the body pass.
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
        if (sharedLedgerNotBefore(baseUrl, dir) > now()) throw new Stop();
        lastSent = now();
        return action();
      },
      ledger: () => ledger ??= openLedger(deps.ledgerPath ?? join(dir, "ledger.sqlite")) };
    try {
      for (const [featureId, entry] of features) {
        try { await syncFeature(p, featureId, entry, db); }
        catch (error) {
          if (error instanceof Stop) break;
          if (error instanceof SharedLedgerRemoteError && error.status === 429) {
            const credential = resolveMirrorCredential(entry, dir);
            if (credential) await deferSharedLedger(credential.baseUrl, now() + Math.min(60_000, Math.max(0, error.retryAfterMs)), dir).catch(() => {});
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

/**
 * Project PAGEOK evidence primitives. Production callers: the ui-page-* ledger CLI (src/manager/ledger-ui-acceptance.ts) and
 * the feature completion gate, which receives check() by injection (installPageBatchCheck in ui-acceptance-batch-wiring.ts).
 * No owner-button auto consumer: the owner's answer goes back to the proposing PM, who runs ui-page-verify (like dag-approve).
 * Read-side display of source-accepted PAGEOK lives in ui-page-display.ts. Snapshots are read from the ledger, never supplied by a caller.
 * Evidence references stay in the private ledger; this module neither creates screenshots nor changes task stages.
 */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { bindHash, canonicalJson, checkAsk, paramsProblem } from "./ask-bind.js";
import { closeAsk, getAsk, openAskFull, ownerAnswered, type Ask } from "./ledger-asks.js";
import { isSatisfied } from "./ledger-deps.js";
import { effectiveNodes, getDagVersion, getFeature } from "./ledger-feature.js";
import { requireManager } from "./ledger-feature-write.js";
import { busyAsLedgerError, getMeta, getTask, LedgerError } from "./ledger-store.js";
import { DIGEST_RE } from "./scheduler-ui-merge-refusal.js";
import { readTextSoft, specPathFor } from "./task-spec.js";
import { isUiNode, PAGE_CHECK_KEY, PAGE_CHECK_LIST, uiScope } from "./ui-acceptance.js";

type Mode = "on" | "observe" | "off";
type Scope = { featureId: string; dagVersion: number; ui: {
  key: string; taskId: string; head: string; specRev: number; round: number; digest: string; screenshotsHash: string;
}[] };
type Evidence = {
  relay: string; device: { width: number; height: number; theme: string }; productionData: string;
  basis: string; ledgerComparison: string; screenshotsHash: string;
};
type Legacy = { taskId: string; head: string | null; specRev: number; round: number; digest: string };
type Entry = { scope: Scope; evidence: Evidence | null; verdict: "approve" | "reject"; legacy: Legacy | null };
type Request = { featureId: string; evidence?: Evidence; verdict?: "approve" | "reject"; legacyPageTask?: string };
type Source = { sourceId: string; revision: number; askId: string; vectorDigest: string; entries: Entry[]; state: "pending" | "verified" };
type Context = { instanceId: string; project: string; actor: string; actorChannelId?: string | null; mode?: Mode; now?: number };

const ACTION = "project_ui_page_accept", APPROVE = "project_ui_page_approve", REJECT = "project_ui_page_reject";
const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const fail = (reason: string): never => { throw new LedgerError("conflict", reason); };
const validText = (s: unknown): s is string => typeof s === "string" && s.trim().length > 0 && s.length <= 1000;

/** Full current UI identity, including spec content and screenshot hash; stage readiness is rechecked independently. */
function scopeOf(db: Database, project: string, featureId: string): Scope {
  const f = getFeature(db, featureId);
  if (!f || f.project !== project) return fail("feature 不在当前项目");
  const v = getDagVersion(db, f.id, f.currentVersion);
  if (!v) return fail("feature 没有当前 DAG");
  const ui = effectiveNodes(db, v).filter((n) => n.key !== PAGE_CHECK_KEY && isUiNode(db, f, n)).sort((a, b) => a.key.localeCompare(b.key));
  if (!ui.length) return fail("feature 没有 UI 范围");
  return { featureId, dagVersion: v.version, ui: ui.map((n) => {
    const t = n.taskId ? getTask(db, n.taskId) : null;
    if (!t || t.project !== project || (t.featureId && t.featureId !== featureId)) return fail("UI 任务缺失或不属于当前范围");
    if (!isSatisfied(t) || t.stage === "blocked") return fail(`UI 任务 ${t.id} 尚未完成`);
    if (!t.headSHA || !/^[a-f0-9]{40}$/i.test(t.headSHA)) return fail(`UI 任务 ${t.id} 缺精确 head`);
    const screenshotsHash = t.extra.screenshotsDigest;
    if (typeof screenshotsHash !== "string" || !DIGEST_RE.test(screenshotsHash)) return fail(`UI 任务 ${t.id} 缺截图摘要`);
    const spec = readTextSoft(specPathFor(t, getMeta(db, project).docsDir));
    if (spec === null || !spec.trim()) return fail(`UI 任务 ${t.id} 缺规格内容`);
    return { key: n.key, taskId: t.id, head: t.headSHA, specRev: t.specRev, round: t.round, screenshotsHash,
      digest: hash({ node: uiScope(n), taskFileGlobs: t.extra.fileGlobs ?? null, spec }) };
  }) };
}

function checkEvidence(e: Evidence | undefined, scope: Scope): Evidence {
  if (!e || ![e.relay, e.productionData, e.basis, e.ledgerComparison].every(validText) || !DIGEST_RE.test(e.screenshotsHash)) {
    return fail("缺整页真实输入或截图摘要");
  }
  const d = e.device;
  if (!d || !Number.isSafeInteger(d.width) || !Number.isSafeInteger(d.height) || d.width <= 0 || d.height <= 0 || !validText(d.theme)) {
    return fail("缺 owner 设备尺寸 / 主题");
  }
  // The whole-page reference must already belong to a current UI card. Private file resolution belongs to the consumer.
  if (!scope.ui.some((n) => n.screenshotsHash === e.screenshotsHash)) return fail("整页截图摘要未关联当前 UI 任务");
  return JSON.parse(JSON.stringify(e)) as Evidence;
}

// PAGEOK task extras are mutable and cannot prove historical head-bound acceptance; UIACW must add a trusted record reader.
const refuseLegacy = (): never => fail("旧 PAGEOK 历史证据接线待 UIACW，pureproof 不接受事后摘要");

/** Explicit initialization in the proof adapter only; no ledger-store migration or production side effects on import. */
function initialize(db: Database): void {
  const schema = [
    `CREATE TABLE IF NOT EXISTS ui_page_batch (
      project TEXT PRIMARY KEY, instanceId TEXT NOT NULL, sourceId TEXT NOT NULL UNIQUE, revision INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ui_page_vectors (
      sourceId TEXT NOT NULL, revision INTEGER NOT NULL, askId TEXT NOT NULL UNIQUE, vectorDigest TEXT NOT NULL,
      entries TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('pending','verified')), verifiedAt INTEGER,
      PRIMARY KEY (sourceId, revision))`,
    `CREATE TABLE IF NOT EXISTS ui_page_members (
      project TEXT NOT NULL, featureId TEXT NOT NULL, sourceId TEXT NOT NULL, revision INTEGER NOT NULL,
      PRIMARY KEY (project, featureId))`,
  ];
  for (const sql of schema) db.run(sql);
}

function sourceOf(db: Database, sourceId: string, revision: number): Source | null {
  const row = db.query("SELECT * FROM ui_page_vectors WHERE sourceId = ? AND revision = ?").get(sourceId, revision) as
    (Omit<Source, "entries"> & { entries: string }) | null;
  return row ? { ...row, entries: JSON.parse(row.entries) as Entry[] } : null;
}

type ProjectSource = { instanceId: string; sourceId: string; revision: number };
function current(db: Database, c: Context): ProjectSource | null {
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ui_page_batch'").get()) return null;
  const p = db.query("SELECT * FROM ui_page_batch WHERE project = ?").get(c.project) as ProjectSource | null;
  if (p && p.instanceId !== c.instanceId) return fail("验收源实例不匹配");
  return p;
}

function binding(c: Context, sourceId: string, revision: number, vectorDigest: string, entries: Entry[]) {
  // The digest binds every full scope and private evidence field without exceeding ask's 4096-character params limit.
  return { action: ACTION, version: "1", approve: [APPROVE], params: {
    instanceId: c.instanceId, project: c.project, sourceId, revision, vectorDigest, featureIds: entries.map((e) => e.scope.featureId),
  } };
}

function liveEntry(db: Database, project: string, e: Entry): void {
  const scope = scopeOf(db, project, e.scope.featureId);
  if (hash(scope) !== hash(e.scope)) return fail(`feature ${e.scope.featureId} 验收范围已漂移`);
  if (e.legacy) refuseLegacy();
  checkEvidence(e.evidence ?? undefined, scope);
}

/**
 * Explicit proof adapter. Trusted runtime must supply its real instance/project/actor and configured mode when wiring it.
 * check() is evidence only; production must call it inside its completion transaction, alongside existing UI/head guards.
 */
export class UiAcceptanceBatch {
  constructor(private readonly db: Database) {}

  snapshot(project: string, featureId: string): Scope { return scopeOf(this.db, project, featureId); }

  /** Observe is read-only, bounded, and cannot turn a diagnostic into feature completion. */
  diagnostics(c: Context): string[] {
    if ((c.mode ?? "observe") !== "observe") return [];
    const rows = this.db.query("SELECT id FROM features WHERE project = ? AND currentVersion > 0 ORDER BY id LIMIT 33").all(c.project) as { id: string }[];
    const ids = rows.filter(({ id }) => {
      const f = getFeature(this.db, id)!;
      const v = getDagVersion(this.db, id, f.currentVersion);
      return v && effectiveNodes(this.db, v).some((n) => n.key !== PAGE_CHECK_KEY && isUiNode(this.db, f, n));
    }).map(({ id }) => id);
    return ids.length > 1 ? [`可合并整页验收：${ids.slice(0, 8).join("、")}${ids.length > 8 ? "…" : ""}（仅建议，原 PAGEOK 闸不变）`] : [];
  }

  propose(c: Context, expectedRevision: number, requests: Request[]): Source {
    this.requireOn(c);
    return this.transaction(() => {
      requireManager(this.db, c.actor, c.project);
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) return fail("无效源版本");
      if (!requests.length || requests.length > 32 || new Set(requests.map((r) => r.featureId)).size !== requests.length) return fail("验收向量为空、重复或超界");
      initialize(this.db);
      const prev = current(this.db, c);
      if ((prev?.revision ?? 0) !== expectedRevision) return fail("验收组合 CAS 冲突");
      const entries: Entry[] = [...requests].sort((a, b) => a.featureId.localeCompare(b.featureId)).map((r) => {
        const scope = scopeOf(this.db, c.project, r.featureId);
        if (r.verdict !== undefined && r.verdict !== "approve" && r.verdict !== "reject") return fail("无效逐项结论");
        if (r.legacyPageTask !== undefined) refuseLegacy();
        return { scope, verdict: r.verdict ?? "approve", evidence: checkEvidence(r.evidence, scope), legacy: null };
      });
      const vectorDigest = hash(entries);
      const old = prev ? sourceOf(this.db, prev.sourceId, prev.revision) : null;
      const oldAsk = old ? getAsk(this.db, old.askId) : null;
      if (old?.vectorDigest === vectorDigest && oldAsk?.fromAgent === c.actor && oldAsk.expiresAt > this.now(c) &&
        this.reusable(c, old, oldAsk)) return old;
      const sourceId = prev?.sourceId ?? `page_${crypto.randomUUID()}`;
      const revision = (prev?.revision ?? 0) + 1;
      const bind = binding(c, sourceId, revision, vectorDigest, entries);
      const problem = paramsProblem(bind.params);
      if (problem) return fail(problem);
      if (oldAsk) closeAsk(this.db, oldAsk.id, "cancelled", "项目验收向量更新", this.now(c));
      const ask = this.open(c, bind, entries);
      this.db.query(`INSERT INTO ui_page_batch (project, instanceId, sourceId, revision) VALUES (?, ?, ?, ?)
        ON CONFLICT(project) DO UPDATE SET revision = excluded.revision`).run(c.project, c.instanceId, sourceId, revision);
      this.db.query(`INSERT INTO ui_page_vectors (sourceId, revision, askId, vectorDigest, entries, state)
        VALUES (?, ?, ?, ?, ?, 'pending')`).run(sourceId, revision, ask.id, vectorDigest, JSON.stringify(entries));
      return sourceOf(this.db, sourceId, revision)!;
    });
  }

  /** One authenticated owner button attests the complete vector; any pre-consumption drift rejects the whole write. */
  verify(c: Context, revision: number, askId: string): Source {
    this.requireOn(c);
    return this.transaction(() => {
      requireManager(this.db, c.actor, c.project);
      const p = current(this.db, c);
      if (!p || p.revision !== revision) return fail("验收源已被取代");
      const s = sourceOf(this.db, p.sourceId, revision);
      if (!s || s.askId !== askId || s.state !== "pending") return fail("重复或错误验收源");
      this.authorized(c, s, this.now(c));
      for (const e of s.entries) liveEntry(this.db, c.project, e);
      this.db.query("UPDATE ui_page_vectors SET state = 'verified', verifiedAt = ? WHERE sourceId = ? AND revision = ? AND state = 'pending'")
        .run(this.now(c), s.sourceId, revision);
      for (const e of s.entries) {
        this.db.query(`INSERT INTO ui_page_members (project, featureId, sourceId, revision) VALUES (?, ?, ?, ?)
          ON CONFLICT(project, featureId) DO UPDATE SET sourceId = excluded.sourceId, revision = excluded.revision`)
          .run(c.project, e.scope.featureId, s.sourceId, revision);
      }
      return sourceOf(this.db, s.sourceId, revision)!;
    });
  }

  /** A verified source never approves future scope. Each member keeps its own current scope and explicit verdict. */
  check(c: Context, featureId: string): { ok: boolean; reason?: string } {
    if ((c.mode ?? "observe") !== "on") return { ok: false, reason: "使用原单 feature PAGEOK 闸" };
    try {
      return busyAsLedgerError("读取项目整页验收", () => this.db.transaction(() => {
        requireManager(this.db, c.actor, c.project);
        const p = current(this.db, c);
        if (!p) return fail("缺项目验收源");
        const m = this.db.query("SELECT sourceId, revision FROM ui_page_members WHERE project = ? AND featureId = ?").get(c.project, featureId) as
          { sourceId: string; revision: number } | null;
        if (!m || m.sourceId !== p.sourceId) return fail("feature 未实际验收");
        const s = sourceOf(this.db, m.sourceId, m.revision);
        if (!s || s.state !== "verified") return fail("源未 verified");
        const e = s.entries.find((x) => x.scope.featureId === featureId);
        if (!e || e.verdict !== "approve") return fail("feature 验收拒绝");
        const row = this.db.query("SELECT verifiedAt FROM ui_page_vectors WHERE sourceId = ? AND revision = ?").get(s.sourceId, s.revision) as { verifiedAt: number };
        // Expiry rejects delayed consumption, not already accepted historical evidence. Cancellation/supersession still revokes it.
        this.authorized(c, s, row.verifiedAt, true);
        liveEntry(this.db, c.project, e);
        return { ok: true };
      }).deferred());
    } catch (e) {
      if (!(e instanceof LedgerError)) throw e;
      return { ok: false, reason: e.message }; // Evidence refusal is a result; unexpected storage faults remain visible.
    }
  }

  private reusable(c: Context, s: Source, a: Ask): boolean {
    if (a.state === "open") return true;
    if (a.state !== "answered") return false;
    try { this.authorized(c, s, this.now(c)); return true; }
    catch (e) {
      if (!(e instanceof LedgerError)) throw e;
      return false; // A declined or invalid answer needs a fresh owner card; storage faults must still surface.
    }
  }

  private authorized(c: Context, s: Source, at: number, historical = false): void {
    if (s.vectorDigest !== hash(s.entries)) return fail("验收向量摘要漂移");
    const a = getAsk(this.db, s.askId);
    if (!a || a.project !== c.project || a.taskId !== null || a.bind?.action !== ACTION || !ownerAnswered(a.answer)) return fail("缺真实 owner 验收批准");
    const bind = binding(c, s.sourceId, s.revision, s.vectorDigest, s.entries);
    // A historical evidence read checks its original asker; consuming a new answer still requires that exact caller.
    const caller = historical ? a.fromAgent ?? "" : c.actor;
    if (bindHash(a.bind, caller) !== a.bind.paramsHash || canonicalJson(a.bind.params) !== canonicalJson(bind.params) || a.bind.version !== bind.version) {
      return fail("验收绑定参数漂移");
    }
    const check = checkAsk(a, bindHash(bind, caller), caller, at);
    if (!check.ok) return fail(check.reason);
    if (canonicalJson(a.bind.approve) !== canonicalJson(bind.approve)) return fail("验收按钮漂移");
  }

  private open(c: Context, bind: ReturnType<typeof binding>, entries: Entry[]): Ask {
    const body = entries.map((e) => `${e.scope.featureId} DAG v${e.scope.dagVersion}：${e.legacy ? `引用旧 PAGEOK ${e.legacy.taskId}` : e.verdict}\n` +
      e.scope.ui.map((n) => `${n.key} / ${n.taskId} head ${n.head} specRev ${n.specRev} round ${n.round} digest ${n.digest} 截图 ${n.screenshotsHash}`).join("\n") +
      (e.evidence ? `\n实际整页输入：${canonicalJson(e.evidence)}` : "")).join("\n");
    return openAskFull(this.db, {
      project: c.project, source: "system", kind: "authorize", fromAgent: c.actor, fromChannelId: c.actorChannelId ?? null, blocking: true, allowText: false,
      title: "项目整页验收（逐项结论）", context: PAGE_CHECK_LIST.join("；"), body,
      options: [{ type: "buttons", buttons: [{ id: APPROVE, label: "确认以上逐项真实验收结论", style: "success" },
        { id: REJECT, label: "拒绝本次验收", style: "danger" }] }],
      bind: { ...bind, paramsHash: bindHash(bind, c.actor) }, expiresAt: this.now(c) + 7 * 24 * 3600_000,
    }, this.now(c)).ask;
  }

  private requireOn(c: Context): void {
    if ((c.mode ?? "observe") !== "on") return fail("observe/off 不改变原 PAGEOK 执行");
    if (![c.instanceId, c.project, c.actor].every(validText)) return fail("缺实际实例 / 项目 / 调用者");
  }
  private now(c: Context): number { return c.now ?? Date.now(); }
  private transaction<T>(fn: () => T): T { return busyAsLedgerError("项目整页验收", () => this.db.transaction(fn).immediate()); }
}

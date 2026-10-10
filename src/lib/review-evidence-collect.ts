/**
 * IO half of the review-evidence export (review-evidence.ts is the pure half): reads the card from the ledger (read-only), the
 * reports / prompts / probe files the reviewers left under the reviews directory, the git diff for scope, and the model each
 * party's session records show. Reads only: report-like files must resolve inside the reviews directory (a recorded path pointing
 * elsewhere is not exported), session files are reduced to a model count and never copied. writeBundle refuses a non-empty
 * target so a package is never half-overwritten. tests/review-evidence.test.ts.
 */
import type { Database } from "bun:sqlite";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { claudeHits, codexHits, piHits, type ModelHit } from "./ai-model-evidence.js";
import type { SchedulerIntent } from "./ledger-scheduler.js";
import { isAskEvent } from "./ledger-stages.js";
import { getMeta, getTask, LedgerError, listEvents } from "./ledger-store.js";
import { stepsOf } from "./ledger-steps.js";
import { agentRuntime, type RegistryAgent } from "./registry.js";
import type { Bundle, ExportSource, ModelRecord } from "./review-evidence.js";
import { getSchedulerSession } from "./scheduler-sessions.js";
import { findSessionJsonlBySessionId } from "./session-source.js";
import { specPathFor } from "./task-spec.js";

const SHA40 = /^[0-9a-f]{40}$/;
const REPORT_MAX = 8 * 1024 * 1024;
const PROBE_MAX = 1024 * 1024;
const PROBES_PER_ROUND = 20;
/** ponytail: only the session file's last 64 MiB is scanned; a review older than that window reports no model, add a seek-by-time reader if that bites */
const SESSION_TAIL = 64 * 1024 * 1024;

export interface CollectOpts {
  head?: string;
  base?: string;
  repoDir: string;
  reviewsDir: string;
  registry: readonly Pick<RegistryAgent, "name" | "runtime" | "sessionId" | "model">[];
  fingerprint: string;
  exporter: string;
  bundleId: string;
  now: number;
  /** session file lookup; tests inject one so nothing outside the fixture is read */
  sessionFile?(runtime: string, sessionId: string): string | null;
}

function git(dir: string, args: string[]): string | null {
  const r = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  return r.exitCode === 0 ? r.stdout.toString() : null;
}

/** A regular file whose real path stays inside root (no symlink or `..` escape), at most max bytes. */
function fileInside(root: string, path: string, max: number): Uint8Array | null {
  try {
    const real = realpathSync(path), base = realpathSync(root);
    const st = statSync(real);
    return real.startsWith(base + sep) && st.isFile() && st.size <= max ? readFileSync(real) : null;
  } catch {
    return null; // missing / unreadable: the producer notes the gap per round, absence is the useful answer here
  }
}

const stem = (reportPath: string): string => reportPath.replace(/\.md$/, "");

function probeFiles(reviewsDir: string, reportPath: string): { name: string; bytes: Uint8Array }[] {
  const dir = `${stem(reportPath)}-work`;
  const st = lstatSync(dir, { throwIfNoEntry: false });
  if (!st?.isDirectory()) return [];
  return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && !e.name.startsWith(".")).map((e) => e.name).sort()
    .slice(0, PROBES_PER_ROUND).flatMap((name) => {
      const bytes = fileInside(reviewsDir, join(dir, name), PROBE_MAX);
      return bytes ? [{ name, bytes }] : [];
    });
}

const EXTRACT: Record<string, (lines: string[]) => ModelHit[]> = { pi: piHits, codex: codexHits, "claude-code": claudeHits };

function modelEvidence(o: CollectOpts, agent: string, sessionId: string | null, fromMs: number, toMs: number): ModelRecord | null {
  const row = o.registry.find((a) => a.name === agent);
  const sid = sessionId ?? row?.sessionId ?? null;
  if (!row || !sid) return null;
  const runtime = agentRuntime(row);
  const file = (o.sessionFile ?? ((rt, id) => findSessionJsonlBySessionId(rt, id)))(runtime, sid);
  if (!file) return null;
  const size = statSync(file).size;
  const text = new TextDecoder().decode(readFileSync(file).subarray(Math.max(0, size - SESSION_TAIL)));
  const seen = new Set<string>(), counts = new Map<string, number>();
  for (const h of EXTRACT[runtime](text.split("\n"))) {
    if (!(h.ts >= fromMs && h.ts <= toMs) || (h.id && seen.has(h.id))) continue;
    if (h.id) seen.add(h.id);
    counts.set(h.model, (counts.get(h.model) ?? 0) + 1);
  }
  return { runtime, sessionId: sid, sessionSource: sessionId ? "ledger" : "registry", window: { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() },
    hits: [...counts.values()].reduce((a, b) => a + b, 0), models: [...counts].map(([model, count]) => ({ model, count })).sort((a, b) => b.count - a.count) };
}

const reviewIntents = (db: Database, taskId: string): SchedulerIntent[] =>
  db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'scheduler_intents'").get()
    ? db.query("SELECT * FROM scheduler_intents WHERE taskId = ? AND action = 'review' ORDER BY eventSeq, createdAt").all(taskId) as SchedulerIntent[] : [];

/** --base, else the base the deliver-scope note recorded from the PR for this head, else the fork point from origin/main. */
function baseOf(o: CollectOpts, events: ExportSource["events"], head: string): { base: string | null; source: string } {
  if (o.base) return { base: o.base, source: "--base" };
  const note = events.findLast((e) => e.kind === "note" && e.data.op === "deliver_scope" && e.data.head === head && typeof e.data.base === "string");
  if (note) return { base: note.data.base as string, source: `ledger deliver_scope note #${note.seq} (PR baseRefOid)` };
  const mb = git(o.repoDir, ["merge-base", head, "origin/main"])?.trim() ?? null;
  return { base: mb && SHA40.test(mb) ? mb : null, source: "git merge-base <head> origin/main" };
}

export function collectSource(db: Database, taskId: string, o: CollectOpts): ExportSource {
  const task = getTask(db, taskId);
  if (!task) throw new LedgerError("not_found", `没有任务 ${taskId}`);
  const head = o.head ?? task.headSHA ?? "";
  if (!SHA40.test(head)) throw new LedgerError("invalid", `head 要是完整 40 位小写 SHA（${head || "卡上没有 head"}）`);
  const events = listEvents(db, { project: task.project, target: task.id }).filter((e) => !isAskEvent(e));
  const { base, source } = baseOf(o, events, head);
  const files = base ? git(o.repoDir, ["diff", "--name-only", "--no-renames", "-z", `${base}...${head}`, "--"]) : null;
  const specPath = specPathFor(task, getMeta(db, task.project).docsDir);
  const bound = getSchedulerSession(db, task.id, "author");
  const row = (name: string) => o.registry.find((a) => a.name === name);
  return {
    task, events, steps: stepsOf(db, task) as unknown as Record<string, unknown>[], reviewIntents: reviewIntents(db, task.id),
    authorSession: bound ? { agent: bound.agent, sessionId: bound.sessionId, family: bound.family } : null,
    head, base, baseSource: source, changedFiles: files === null ? null : files.split("\0").filter(Boolean),
    spec: specPath ? readFileSync(specPath) : null,
    fingerprint: o.fingerprint, exporter: o.exporter, bundleId: o.bundleId, now: o.now,
    runtimeOf: (a) => (row(a) ? agentRuntime(row(a)) : null),
    configuredModelOf: (a) => row(a)?.model ?? null,
    modelEvidence: (a, sid, from, to) => modelEvidence(o, a, sid, from, to),
    report: (p) => fileInside(o.reviewsDir, p, REPORT_MAX),
    orderPrompt: (p) => fileInside(o.reviewsDir, `${stem(p)}.prompt.md`, REPORT_MAX),
    probeFiles: (p) => (fileInside(o.reviewsDir, p, REPORT_MAX) ? probeFiles(o.reviewsDir, p) : []),
    roundBase: (h) => { const mb = git(o.repoDir, ["merge-base", h, "origin/main"])?.trim(); return mb && SHA40.test(mb) ? mb : null; },
  };
}

/** Files 0600 under 0700 directories (reports quote our repository); the target must not exist or be empty. */
export function writeBundle(dir: string, bundle: Bundle): void {
  if (existsSync(dir) && readdirSync(dir).length) throw new LedgerError("conflict", `${dir} 已存在且不为空，换个目录`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  for (const [rel, bytes] of bundle.files) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, rel), bytes, { mode: 0o600, flag: "wx" });
  }
  writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(bundle.manifest, null, 2)}\n`, { mode: 0o600, flag: "wx" });
}

/**
 * Known flaky tests (dispatch-recovery-CIF8): a per-project list of test files that go red at random while a registered node is
 * fixing them, so the merge gate re-runs CI once instead of bouncing unrelated cards to fix (ci-known-flaky-rerun.ts).
 * - The list is ledger events only (project level, kind decision, op ci_known_flaky_add / ci_known_flaky_revoke) written through
 *   appendEvent: no table, no direct SQL write. The latest event per file wins.
 * - An entry names the node fixing the test (feature + node key). It is judged on every read, nothing is swept: once that
 *   node's card is verified / done the entry no longer counts; so does a node that is cancelled, unbound from its card or gone
 *   from the feature's current DAG (nobody is fixing the test then, and every doubt must bounce).
 * - The switch is the recovery policy key `ciKnownFlaky` (`ledger scheduler-recovery <project> on|observe|off --key ciKnownFlaky`),
 *   absent = observe; an unreadable policy file answers off.
 * tests/ci-known-flaky.test.ts.
 */
import type { Database } from "bun:sqlite";
import { effectiveNodes, getDagVersion, getFeature } from "./ledger-feature.js";
import { actorMayConfigure, textOneLine } from "./ledger-scheduler-settle.js";
import { getEventByDedup, getTask, LedgerError } from "./ledger-store.js";
import { appendEvent, type WriteCtx } from "./ledger-write.js";
import { recoveryPolicy, type RecoveryMode } from "./recovery-policy.js";

const ADD_OP = "ci_known_flaky_add", REVOKE_OP = "ci_known_flaky_revoke";
/** The shape parseFailedLog reports a bun test file in (repo-relative, no `..`); anything else could never match a failure. */
const TEST_FILE = /^(?!.*\.\.)[\w-][\w./-]{0,190}\.test\.[cm]?[jt]sx?$/;
const NODE_KEY = /^[\w.-]{1,80}$/;
const REASON_MAX = 200;

export const isKnownFlakyFile = (v: unknown): v is string => typeof v === "string" && TEST_FILE.test(v);

let source: ((project: string) => RecoveryMode) | null = null;
/** Tests only: answer the mode without a recovery-policy.json; null restores the file. */
export function setKnownFlakyModeSource(fn: ((project: string) => RecoveryMode) | null): void { source = fn; }
/** Read every time, never throws (recoveryPolicy answers off for a file it cannot read). */
export const knownFlakyMode = (project: string): RecoveryMode => source ? source(project) : recoveryPolicy(project, "ciKnownFlaky").mode;

export interface KnownFlakyEntry {
  file: string;
  featureId: string;
  node: string;
  reason: string;
  /** who registered it, when, and the seq of that event */
  by: string;
  at: number;
  seq: number;
}
export interface KnownFlakyView extends KnownFlakyEntry {
  /** false = the entry no longer excuses a red CI; `state` says why either way */
  active: boolean;
  state: string;
}

/** Entries not revoked, oldest first. A re-registration replaces the file's entry; a revoke removes it. */
function knownFlakyEntries(db: Database, project: string): KnownFlakyEntry[] {
  const rows = db.query(`SELECT seq, ts, actor, data FROM events WHERE project=? AND target='' AND kind='decision'
    AND json_extract(data,'$.op') IN (?, ?) ORDER BY seq`).all(project, ADD_OP, REVOKE_OP) as { seq: number; ts: number; actor: string; data: string }[];
  const byFile = new Map<string, KnownFlakyEntry>();
  for (const r of rows) {
    const d = JSON.parse(r.data) as { op?: string; file?: unknown; featureId?: unknown; node?: unknown; reason?: unknown };
    if (!isKnownFlakyFile(d.file)) continue;
    byFile.delete(d.file);
    if (d.op === ADD_OP && typeof d.featureId === "string" && typeof d.node === "string") {
      byFile.set(d.file, { file: d.file, featureId: d.featureId, node: d.node, reason: typeof d.reason === "string" ? d.reason : "", by: r.actor, at: r.ts, seq: r.seq });
    }
  }
  return [...byFile.values()];
}

/** Whether the node is still fixing the test, from the feature's current DAG and the card bound to the node. */
function fixerState(db: Database, project: string, featureId: string, node: string): { active: boolean; state: string } {
  const gone = (state: string) => ({ active: false, state });
  const f = getFeature(db, featureId);
  if (!f || f.project !== project) return gone(`项目 ${project} 里没有 feature ${featureId}`);
  const v = f.currentVersion ? getDagVersion(db, f.id, f.currentVersion) : null;
  const n = v ? effectiveNodes(db, v).find((x) => x.key === node) : undefined;
  if (!n) return gone(`feature ${featureId} 的当前 DAG 里没有节点 ${node}`);
  if (!n.taskId) return { active: true, state: "修复节点计划中（未开工）" };
  const t = getTask(db, n.taskId);
  if (!t) return gone(`修复节点绑的卡 ${n.taskId} 找不到`);
  if (t.stage === "verified" || t.stage === "done") return gone(`修复节点 ${t.id} 已 ${t.stage}，条目自动失效`);
  if (t.stage === "cancelled") return gone(`修复节点 ${t.id} 已取消，没有人在修`);
  return { active: true, state: `修复节点 ${t.id} 在 ${t.stage}` };
}

/** Every entry with its validity as of now (`ledger ci-known-flaky list`). */
export function knownFlakyList(db: Database, project: string): KnownFlakyView[] {
  return knownFlakyEntries(db, project).map((e) => ({ ...e, ...fixerState(db, project, e.featureId, e.node) }));
}

/** Entries that excuse a red CI right now, by test file. */
export function activeKnownFlaky(db: Database, project: string): Map<string, KnownFlakyEntry> {
  return new Map(knownFlakyEntries(db, project).filter((e) => fixerState(db, project, e.featureId, e.node).active).map((e) => [e.file, e]));
}

const mayWrite = (db: Database, ctx: WriteCtx, project: string): void => {
  if (!actorMayConfigure(db, ctx.actor, project)) {
    throw new LedgerError("forbidden", `已知偶发测试清单只有项目 ${project} 的 PM / master / owner 能改（你是 ${ctx.actor}）`);
  }
};
const fileOf = (file: string): string => {
  if (!isKnownFlakyFile(file)) throw new LedgerError("invalid", `测试文件要是仓库相对路径的 *.test.ts（和 CI 日志里的写法一致），收到 ${JSON.stringify(file)}`);
  return file;
};

export interface KnownFlakyAdd { project: string; file: string; featureId: string; node: string; reason: string }
/** Register (or re-register) a test file. The node must be fixing it now: an entry that is dead on arrival is refused. */
export function addKnownFlaky(db: Database, ctx: WriteCtx, input: KnownFlakyAdd): { entry: KnownFlakyView; duplicate: boolean } {
  mayWrite(db, ctx, input.project);
  const file = fileOf(input.file), reason = textOneLine(input.reason, "原因", REASON_MAX);
  if (!NODE_KEY.test(input.node)) throw new LedgerError("invalid", `节点 key 不合法：${JSON.stringify(input.node)}`);
  const fixer = fixerState(db, input.project, input.featureId, input.node);
  if (!fixer.active) throw new LedgerError("invalid", `不能登记：${fixer.state}`);
  const { event, duplicate } = appendEvent(db, ctx, { project: input.project, target: "", kind: "decision",
    text: `已知偶发测试登记：${file}（修复节点 ${input.featureId}/${input.node}）：${reason}`,
    data: { op: ADD_OP, file, featureId: input.featureId, node: input.node, reason } });
  return { entry: { file, featureId: input.featureId, node: input.node, reason, by: event.actor, at: event.ts, seq: event.seq, ...fixer }, duplicate };
}

/** Manual revoke of a listed file (whatever its node's state); a file not on the list is an error, not a silent no-op. */
export function revokeKnownFlaky(db: Database, ctx: WriteCtx, input: { project: string; file: string; reason: string }): { revoked: KnownFlakyEntry | null; duplicate: boolean } {
  mayWrite(db, ctx, input.project);
  const file = fileOf(input.file), reason = textOneLine(input.reason, "原因", REASON_MAX);
  const entry = knownFlakyEntries(db, input.project).find((e) => e.file === file);
  if (!entry) {
    const prev = ctx.dedupKey ? getEventByDedup(db, ctx.dedupKey) : null; // a retried revoke finds its own event: same answer, nothing written
    if (prev?.data.op !== REVOKE_OP || prev.data.file !== file) throw new LedgerError("not_found", `已知偶发测试清单里没有 ${file}`);
    return { revoked: null, duplicate: true };
  }
  const { duplicate } = appendEvent(db, ctx, { project: input.project, target: "", kind: "decision",
    text: `已知偶发测试撤销：${file}（修复节点 ${entry.featureId}/${entry.node}）：${reason}`, data: { op: REVOKE_OP, file, reason } });
  return { revoked: entry, duplicate };
}

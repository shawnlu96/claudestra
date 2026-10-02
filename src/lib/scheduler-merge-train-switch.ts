/**
 * Merge train switch (i28-MT1sw): per project `mergeTrain` in scheduler.json, absent = on (MT1 as it was).
 * - on: the train runs as before.
 * - observe: formTrain still lists files and picks the batch, but only writes an `observe` event (members, CI runs a train
 *   would have saved); no train state, no branch, no draft PR, no CI, and trainGate answers null so serial merges never wait.
 * - off: formTrain returns before touching GitHub; nothing is written.
 * Switching away from on voids a testing / settling train on its next step with reason TRAIN_CLOSED (stepTrain), its cleanup
 * closes the PRs and deletes the branches, and its members merge serially from then on (trainGate / clearedMember ignore it).
 * Writes go through scheduler-config-write.ts (lock, whole-file validation, audit; PM / master / owner): `ledger scheduler-merge-train`.
 */
import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { textOneLine } from "./ledger-scheduler-settle.js";
import { LedgerError } from "./ledger-store.js";
import type { WriteCtx } from "./ledger-write.js";
import { readSchedulerConfig } from "./scheduler-config.js";
import { finish, projectOf, writeProject } from "./scheduler-config-write.js";
import { isMergeTrainMode, MERGE_TRAIN_MODES, type MergeTrainMode } from "./scheduler-merge-train-switch-config.js";
import type { TrainDeps, TrainEvent } from "./scheduler-merge-train.js";
import { readJsonStateSync } from "./state-file.js";
import { stateDir } from "./state-dir.js";

export const TRAIN_CLOSED = "列车已关闭";
const MERGE_TRAIN_OP = "scheduler_merge_train";

let source: ((project: string) => MergeTrainMode) | null = null;
/** Tests only: answer the mode without a scheduler.json; null restores the file. */
export function setTrainModeSource(fn: ((project: string) => MergeTrainMode) | null): void { source = fn; }

/** Read every time (the scheduler re-reads its config each pass); an unreadable file keeps today's behaviour (on). */
export function trainMode(project: string, path?: string): MergeTrainMode {
  if (source) return source(project);
  try { return readSchedulerConfig(path).projects[project]?.mergeTrain ?? "on"; }
  catch { return "on"; } // a broken scheduler.json idles the whole scheduler anyway
}

const batchKey = (b: readonly { taskId: string; head: string }[]) => b.map((m) => `${m.taskId}:${m.head.toLowerCase()}`).sort().join(",");
/** Last batch observed per project: the same batch every pass is one would-be train, not one event per pass. */
const lastObserved = new Map<string, string>();

/**
 * observe: one event per distinct batch. A train costs one CI run where merging the same cards serially costs one per card
 * (each update-branch reruns CI), so the estimate saved is members - 1. Always null: no train is formed.
 */
export async function observeBatch(project: string, batch: readonly { taskId: string; head: string; files: string[] }[],
  deps: Pick<TrainDeps, "store" | "now">): Promise<null> {
  const key = batchKey(batch);
  if (lastObserved.get(project) === key) return null;
  const n = batch.length, savedCi = n - 1;
  deps.store.event(project, { at: deps.now(), train: "observe", seq: 0, kind: "observe",
    text: `观察：本可组车 ${n} 张：${batch.map((m) => m.taskId).join("、")}，预计省 CI ${savedCi} 次（列车 1 次 / 串行 ${n} 次）`,
    data: { members: batch.map((m) => ({ taskId: m.taskId, head: m.head, files: m.files.length })), ciTrain: 1, ciSerial: n, savedCi } });
  lastObserved.set(project, key);
  return null;
}

export interface ObserveSummary {
  project: string; count: number; members: number; savedCi: number;
  recent: { at: string; members: string[]; savedCi: number }[];
}
/** The last `last` observe events of a project's train file (merge-train/<project>.json, same name rule as fileTrainStore). */
export function observeSummary(project: string, last = 20, dir = join(stateDir(), "merge-train")): ObserveSummary {
  const r = readJsonStateSync(join(dir, `${project.replace(/[^A-Za-z0-9._-]/g, "_")}.json`));
  if (r.status === "corrupt") throw new LedgerError("invalid", `合并列车状态文件损坏：${r.error}`);
  const events = r.status === "missing" ? [] : ((r.data as { events?: TrainEvent[] }).events ?? []);
  const recent = events.filter((e) => e.kind === "observe").slice(-last).map((e) => {
    const d = (e.data ?? {}) as { members?: { taskId: string }[]; savedCi?: number };
    return { at: new Date(e.at).toISOString(), members: (d.members ?? []).map((m) => m.taskId), savedCi: d.savedCi ?? 0 };
  });
  return { project, count: recent.length, members: recent.reduce((a, x) => a + x.members.length, 0),
    savedCi: recent.reduce((a, x) => a + x.savedCi, 0), recent };
}

/** Pure: edit one project's mergeTrain in the raw JSON text (absent = on). */
function patchMergeTrainMode(raw: string, project: string, mode: MergeTrainMode) {
  if (!isMergeTrainMode(mode)) throw new LedgerError("invalid", `合并列车模式只能是 ${MERGE_TRAIN_MODES.join(" / ")}，收到 ${String(mode)}`);
  const { doc, p } = projectOf(raw, project);
  const from = p.mergeTrain === undefined ? null : String(p.mergeTrain);
  const changed = (from ?? "on") !== mode;
  if (changed) p.mergeTrain = mode;
  return { ...finish(raw, doc, changed), from, to: mode, changed };
}

/** Same lock, whole-file validation, permission (PM / master / owner) and audit event as setRemoteMode. */
export async function setMergeTrainMode(db: Database, ctx: WriteCtx, input: { project: string; mode: string; reason: string },
  opts: { path?: string; lockMs?: number } = {}) {
  const reason = textOneLine(input.reason, "原因", 600);
  const mode = input.mode;
  if (!isMergeTrainMode(mode)) throw new LedgerError("invalid", `合并列车模式只能是 ${MERGE_TRAIN_MODES.join(" / ")}，收到 ${mode}`);
  return writeProject(db, ctx, { op: MERGE_TRAIN_OP, project: input.project, reason, what: "切合并列车模式",
    patch: (raw) => patchMergeTrainMode(raw, input.project, mode) }, opts);
}
